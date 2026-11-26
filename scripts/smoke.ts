/*
 * Runs the client against a live Zoho Books organisation.
 *
 *   bun run smoke exchange <code>   trade a Self Client code for a refresh token, saved to .env.smoke
 *   bun run smoke                   read-only checks
 *   bun run smoke --write           also create, change, download and delete records, and clean up after
 *   bun run smoke --sweep           also call every list operation that needs no input, and report decode mismatches
 *
 * .env.smoke holds ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_DATA_CENTER, ZOHO_REFRESH_TOKEN, and
 * optionally ZOHO_ORGANIZATION_ID. Results go to smoke-report.json.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as Books from '../src/books/index.ts'
import { ChartOfAccounts, Contacts, Expenses, Invoices, Items, Organizations, paginate, ZohoBooksClient, type Operation } from '../src/books/index.ts'
import { ZohoAccessToken, ZohoDataCenter, ZohoError, ZohoOAuth, zohoDataCenterFromApiDomain } from '../src/index.ts'

const envFile = new URL('../.env.smoke', import.meta.url)
const reportFile = new URL('../smoke-report.json', import.meta.url)

const env = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is not set in .env.smoke`)
  return value
}

const args = process.argv.slice(2)
const dataCenter = Schema.decodeUnknownSync(ZohoDataCenter)(env('ZOHO_DATA_CENTER'))
const oauthClient = { clientId: env('ZOHO_CLIENT_ID'), clientSecret: Redacted.make(env('ZOHO_CLIENT_SECRET')), dataCenter }

type Status = 'pass' | 'fail' | 'skip'
interface Outcome {
  readonly name: string
  readonly status: Status
  readonly detail: string
}
const outcomes: Array<Outcome> = []

const record = (name: string, status: Status, detail: string) =>
  Effect.sync(() => {
    outcomes.push({ name, status, detail })
    console.log(`${{ pass: 'PASS', fail: 'FAIL', skip: 'SKIP' }[status]}  ${name}: ${detail}`)
  })

const describeFailure = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause)
  if (error instanceof ZohoError) return `${error.reason._tag}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

const check = <A, R>(
  name: string,
  effect: Effect.Effect<A, unknown, R>,
  summary: (value: A) => string,
): Effect.Effect<Option.Option<A>, never, R> =>
  Effect.flatMap(Effect.exit(effect), (exit) =>
    Exit.isSuccess(exit)
      ? Effect.as(record(name, 'pass', summary(exit.value)), Option.some(exit.value))
      : Effect.as(record(name, 'fail', describeFailure(exit.cause)), Option.none()))

const ensure = (condition: boolean, message: string): Effect.Effect<void, Error> =>
  condition ? Effect.void : Effect.fail(new Error(message))

const present = <A>(value: A | null | undefined, what: string): Effect.Effect<A, Error> =>
  value === null || value === undefined ? Effect.fail(new Error(`${what} is missing`)) : Effect.succeed(value)

const isPdf = (bytes: Uint8Array) => new TextDecoder().decode(bytes.subarray(0, 5)) === '%PDF-'

const exchange = Effect.gen(function* () {
  const code = args[1]
  if (code === undefined) return yield* Effect.fail(new Error('usage: bun run smoke exchange <code>'))
  const grant = yield* ZohoOAuth.exchangeCode({ ...oauthClient, code })
  const refreshToken = yield* present(grant.refresh_token, 'the refresh token (ask for offline access)')
  const kept = readFileSync(envFile, 'utf8').split('\n').filter((line) => line.trim() !== '' && !line.startsWith('ZOHO_REFRESH_TOKEN='))
  writeFileSync(envFile, `${[...kept, `ZOHO_REFRESH_TOKEN=${Redacted.value(refreshToken)}`].join('\n')}\n`)
  const granted = grant.api_domain === undefined ? Option.none() : zohoDataCenterFromApiDomain(grant.api_domain)
  console.log(`Saved the refresh token to .env.smoke. api_domain ${grant.api_domain ?? '(none)'} is data centre ${Option.getOrElse(granted, () => 'unknown')}; ZOHO_DATA_CENTER is ${dataCenter}.`)
  console.log(`Granted scopes: ${grant.scope ?? '(not reported)'}`)
})

const chooseOrganization = (organizations: ReadonlyArray<{ readonly organization_id?: string | null; readonly name?: string | null }>) => {
  const wanted = process.env['ZOHO_ORGANIZATION_ID']
  const listing = organizations.map((org) => `${org.name} (${org.organization_id})`).join(', ')
  const chosen = wanted === undefined || wanted === ''
    ? (organizations.length === 1 ? organizations[0] : undefined)
    : organizations.find((org) => org.organization_id === wanted)
  return chosen?.organization_id
    ? Effect.succeed({ id: chosen.organization_id, name: chosen.name ?? '' })
    : Effect.fail(new Error(`set ZOHO_ORGANIZATION_ID to one of: ${listing || 'none found'}`))
}

const readChecks = (organizationId: string) => Effect.gen(function* () {
  yield* check('get organisation', Organizations.getOrganization({ organization_id: organizationId }), (r) =>
    `${r.organization?.name}, currency ${r.organization?.currency_code}`)
  yield* check('list contacts', Contacts.listContacts({ per_page: 5 }), (r) => `${r.contacts?.length ?? 0} on the first page`)
  yield* check('list items', Items.listItems({ per_page: 5 }), (r) => `${r.items?.length ?? 0} on the first page`)
  yield* check('list chart of accounts', ChartOfAccounts.listChartOfAccounts(), (r) => `${r.chartofaccounts?.length ?? 0} accounts`)
  yield* check(
    'an unknown invoice fails as ZohoApiError',
    Effect.flip(Invoices.getInvoice({ invoice_id: '1' })).pipe(
      Effect.flatMap((error) => error.reason._tag === 'ZohoApiError'
        ? Effect.succeed(error.reason)
        : Effect.fail(new Error(`got ${error.reason._tag}: ${error.message}`)))),
    (reason) => `HTTP ${reason.status}, code ${reason.code}, "${reason.detail}"`,
  )
})

type Cleanup = { readonly name: string; readonly run: Effect.Effect<unknown, ZohoError, ZohoBooksClient> }

const keysZohoAddsTo = (raw: unknown, decoded: unknown, depth = 0, path = ''): Array<string> => {
  const first = (value: unknown) => (Array.isArray(value) ? value[0] : value)
  const sent = first(raw)
  const kept = first(decoded)
  if (typeof sent !== 'object' || sent === null || typeof kept !== 'object' || kept === null) return []
  return Object.entries(sent).flatMap(([key, value]) =>
    value === null || value === '' ? [] : key in kept
      ? (depth < 2 ? keysZohoAddsTo(value, (kept as Record<string, unknown>)[key], depth + 1, `${path}${key}.`) : [])
      : [`${path}${key}`])
}

const writeChecks = Effect.gen(function* () {
  const cleanups: Array<Cleanup> = []
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
  const today = new Date().toISOString().slice(0, 10)

  const body = Effect.gen(function* () {
    const contact = yield* check('create contact', Effect.flatMap(
      Contacts.createContact({ body: { contact_name: `effect-zoho smoke ${stamp}` } }),
      (r) => present(r.contact?.contact_id, 'contact.contact_id'),
    ), (id) => id)
    if (Option.isSome(contact)) cleanups.push({ name: 'delete contact', run: Contacts.deleteContact({ contact_id: contact.value }) })

    const item = yield* check('create item', Effect.flatMap(
      Items.createItem({ body: { name: `effect-zoho smoke ${stamp}`, rate: 12.5 } }),
      (r) => present(r.item?.item_id, 'item.item_id'),
    ), (id) => id)
    if (Option.isSome(item)) cleanups.push({ name: 'delete item', run: Items.deleteItem({ item_id: item.value }) })

    if (Option.isNone(contact) || Option.isNone(item)) return yield* record('invoice checks', 'skip', 'no contact or item')
    const lineItems = [{ item_id: item.value, quantity: 2 }]

    const invoiceIds: Array<string> = []
    for (const n of [1, 2]) {
      const created = yield* check(`create invoice ${n}`, Effect.flatMap(
        Invoices.createInvoice({ body: { customer_id: contact.value, line_items: lineItems } }),
        (r) => Effect.zip(present(r.invoice?.invoice_id, 'invoice.invoice_id'), Effect.succeed(r.invoice)),
      ), ([, invoice]) => `${invoice?.invoice_number}, total ${JSON.stringify(invoice?.total)} (${typeof invoice?.total})`)
      if (Option.isSome(created)) {
        invoiceIds.push(created.value[0])
        cleanups.push({ name: `delete invoice ${n}`, run: Invoices.deleteInvoice({ invoice_id: created.value[0] }) })
      }
    }
    const [invoiceId] = invoiceIds
    if (invoiceId === undefined) return yield* record('invoice checks', 'skip', 'no invoice was created')

    yield* check('paginate one invoice per page', paginate(Invoices.listInvoices, { per_page: 1 }).pipe(Stream.take(3), Stream.runCollect, Effect.tap((pages) =>
      ensure(pages.length >= 2, `expected at least 2 pages, got ${pages.length}`))), (pages) => `${pages.length} pages read`)

    yield* check('update invoice', Invoices.updateInvoice({
      invoice_id: invoiceId,
      body: { customer_id: contact.value, line_items: lineItems, reference_number: `smoke-${stamp}` },
    }), () => 'accepted')
    yield* check('read the update back', Effect.flatMap(Invoices.getInvoice({ invoice_id: invoiceId }), (r) =>
      ensure(r.invoice?.reference_number === `smoke-${stamp}`, `reference_number is ${r.invoice?.reference_number}`)), () => 'reference_number matches')
    yield* check('fields Zoho sends beyond the documents', Effect.gen(function* () {
      const raw = yield* Invoices.getInvoice.raw({ invoice_id: invoiceId })
      const decoded = yield* Invoices.getInvoice({ invoice_id: invoiceId })
      return keysZohoAddsTo(raw, decoded)
    }), (extra) => extra.length === 0 ? 'none' : `${extra.length}: ${extra.slice(0, 15).join(', ')}${extra.length > 15 ? ', …' : ''}`)

    const pdf = yield* check('download invoice PDF', Effect.tap(Invoices.getInvoice.binary({ invoice_id: invoiceId, accept: 'pdf' }), (file) =>
      ensure(isPdf(file.bytes), `content-type ${file.contentType}, starts ${JSON.stringify(new TextDecoder().decode(file.bytes.subarray(0, 40)))}`)),
    (file) => `${file.bytes.length} bytes, ${file.contentType}`)
    if (Option.isNone(pdf)) return yield* record('upload checks', 'skip', 'no PDF to upload')
    const file = { bytes: pdf.value.bytes, fileName: 'smoke.pdf', contentType: 'application/pdf' }

    const attached = yield* check('attach a file to the invoice (multipart, file only)',
      Invoices.addInvoiceAttachment({ invoice_id: invoiceId, attachment: file }), (r) => r.message ?? 'accepted')
    if (Option.isSome(attached)) {
      yield* check('download the attachment', Effect.tap(Invoices.getInvoiceAttachment({ invoice_id: invoiceId }), (got) =>
        ensure(isPdf(got.bytes), `content-type ${got.contentType}`)), (got) => `${got.bytes.length} bytes, ${got.contentType}`)
      yield* check('delete the attachment', Invoices.deleteInvoiceAttachment({ invoice_id: invoiceId }), () => 'deleted')
    }

    const accounts = yield* check('find an expense account and a cash or bank account', Effect.gen(function* () {
      const { chartofaccounts } = yield* ChartOfAccounts.listChartOfAccounts({ filter_by: 'AccountType.Active' })
      const of = (types: ReadonlyArray<string>) => chartofaccounts?.find((account) => types.includes(account.account_type ?? ''))?.account_id
      return { expense: yield* present(of(['expense']), 'an expense account'), paidThrough: yield* present(of(['cash', 'bank']), 'a cash or bank account') }
    }), (found) => `${found.expense} and ${found.paidThrough}`)
    if (Option.isNone(accounts)) return
    const expense = yield* check('create expense with a receipt (multipart, record in JSONString)', Effect.flatMap(
      Expenses.createExpense({
        receipt: file,
        body: { account_id: accounts.value.expense, paid_through_account_id: accounts.value.paidThrough, date: today, amount: 9.99, description: `effect-zoho smoke ${stamp}` },
      }),
      (r) => present(r.expense?.expense_id, 'expense.expense_id'),
    ), (id) => id)
    if (Option.isNone(expense)) return
    cleanups.push({ name: 'delete expense', run: Expenses.deleteExpense({ expense_id: expense.value }) })
    yield* check('the expense kept its record fields', Effect.flatMap(Expenses.getExpense({ expense_id: expense.value }), (r) =>
      ensure(r.expense?.amount === 9.99 && r.expense?.description === `effect-zoho smoke ${stamp}`,
        `amount ${r.expense?.amount}, description ${r.expense?.description}`)), () => 'amount and description match')
    yield* check('download the receipt', Effect.tap(Expenses.getExpenseReceipt({ expense_id: expense.value }), (got) =>
      ensure(isPdf(got.bytes), `content-type ${got.contentType}`)), (got) => `${got.bytes.length} bytes, ${got.contentType}`)
  })

  const cleanUp = Effect.suspend(() => Effect.forEach(cleanups.reverse(), ({ name, run }) => check(name, run, () => 'done'), { discard: true }))
  yield* Effect.ensuring(body, cleanUp)
})

type AnyOperation = Operation<unknown, Schema.Top | undefined>

const listOperations = (): ReadonlyArray<readonly [string, AnyOperation]> =>
  Object.entries(Books).flatMap(([module, exports]) =>
    typeof exports === 'object' && exports !== null
      ? Object.entries(exports as Record<string, unknown>)
          .filter((entry): entry is [string, AnyOperation] => typeof entry[1] === 'function' && 'definition' in entry[1])
          .map(([name, op]) => [`${module}.${name}`, op] as const)
      : [])

interface SweepEntry {
  readonly operation: string
  readonly outcome: 'decoded' | 'mismatch' | 'refused' | 'error'
  readonly detail?: string
  readonly undocumented?: ReadonlyArray<string>
}

const sweep = Effect.gen(function* () {
  const entries: Array<SweepEntry> = []
  const candidates = listOperations().filter(([, op]) =>
    op.definition.method === 'GET' && !op.definition.path.includes('{') && op.definition.response !== undefined)
  console.log(`\nSweeping ${candidates.length} list operations, about 1.5 a second to stay under Zoho's 100 a minute`)
  for (const [name, op] of candidates) {
    const exit = yield* Effect.exit(op.raw())
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause)
      if (error instanceof ZohoError && error.reason._tag === 'ZohoRateLimitError') {
        entries.push({ operation: name, outcome: 'error', detail: 'rate limited; sweep stopped' })
        break
      }
      const refused = error instanceof ZohoError && (error.reason._tag === 'ZohoApiError' || error.reason._tag === 'ZohoUnauthorizedError')
      entries.push({ operation: name, outcome: refused ? 'refused' : 'error', detail: describeFailure(exit.cause) })
    } else {
      const decoded = yield* Effect.exit(Schema.decodeUnknownEffect(op.definition.response as Schema.Codec<unknown>)(exit.value))
      entries.push(Exit.isSuccess(decoded)
        ? { operation: name, outcome: 'decoded', undocumented: keysZohoAddsTo(exit.value, decoded.value) }
        : { operation: name, outcome: 'mismatch', detail: String(Cause.squash(decoded.cause)).slice(0, 600) })
    }
    yield* Effect.sleep('650 millis')
  }
  const count = (outcome: SweepEntry['outcome']) => entries.filter((entry) => entry.outcome === outcome).length
  yield* record('sweep', count('mismatch') + count('error') === 0 ? 'pass' : 'fail',
    `${count('decoded')} decoded, ${count('mismatch')} mismatched, ${count('refused')} refused by Zoho, ${count('error')} other errors`)
  for (const entry of entries.filter((e) => e.outcome === 'mismatch' || e.outcome === 'error')) console.log(`      ${entry.operation}: ${entry.detail}`)
  return entries
})

const smoke = () => Effect.gen(function* () {
  const discovery = yield* ZohoBooksClient.make({ organizationId: '', dataCenter, requestTimeout: '30 seconds' })
  const listed = yield* check('list organisations', Organizations.listOrganizations().pipe(Effect.provideService(ZohoBooksClient, discovery)),
    (r) => `${r.organizations?.length ?? 0} organisation(s)`)
  if (Option.isNone(listed)) return []
  const organization = yield* check('choose organisation', chooseOrganization(listed.value.organizations ?? []), (org) => `${org.name} (${org.id})`)
  if (Option.isNone(organization)) return []

  const client = yield* ZohoBooksClient.make({ organizationId: organization.value.id, dataCenter, requestTimeout: '30 seconds' })
  return yield* Effect.gen(function* () {
    yield* readChecks(organization.value.id)
    if (args.includes('--write')) yield* writeChecks
    return args.includes('--sweep') ? yield* sweep : []
  }).pipe(Effect.provideService(ZohoBooksClient, client))
}).pipe(
  Effect.tap((sweepEntries) => Effect.sync(() => {
    writeFileSync(reportFile, `${JSON.stringify({ ranAt: new Date().toISOString(), dataCenter, outcomes, sweep: sweepEntries }, null, 2)}\n`)
    const failed = outcomes.filter((outcome) => outcome.status === 'fail').length
    console.log(`\n${outcomes.length - failed} passed, ${failed} failed. Report: smoke-report.json`)
    if (failed > 0) process.exitCode = 1
  })),
  Effect.provide(ZohoAccessToken.layerRefreshToken({ ...oauthClient, refreshToken: Redacted.make(env('ZOHO_REFRESH_TOKEN')) })),
)

const program = args[0] === 'exchange' ? exchange : smoke()

Effect.runPromise(program.pipe(Effect.provide(FetchHttpClient.layer))).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
