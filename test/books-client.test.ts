import { expect, it } from '@effect/vitest'
import * as Config from 'effect/Config'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import { flow } from 'effect/Function'
import * as HttpClient from 'effect/http/HttpClient'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as RateLimiter from 'effect/persistence/RateLimiter'
import * as Redacted from 'effect/Redacted'
import * as Stream from 'effect/Stream'
import { ZohoAccessToken, ZohoDataCenter, ZohoError, ZohoTransportError } from '../src/index.ts'
import {
  BankAccounts, Bills, Contacts, DeliveryChallans, Expenses, Invoices, Organizations, paginate, Projects, ReportingTags, ZohoBooksClient,
} from '../src/books/index.ts'
import { fakeZoho, json, type Reply } from './fake-zoho.ts'

function books(...replies: ReadonlyArray<Reply>) {
  const zoho = fakeZoho(...replies)
  const layer = ZohoBooksClient.layer({ organizationId: '20100000', dataCenter: 'eu' }).pipe(
    Layer.provide([zoho.layer, ZohoAccessToken.layerStatic(Redacted.make('token-1'))]),
  )
  return { ...zoho, layer }
}

it.effect('sends a list request to the data centre with the organisation, token and filters', () => {
  const zoho = books(json({ code: 0, message: 'success', invoices: [], page_context: { page: 2, has_more_page: false } }))
  return Effect.gen(function* () {
    yield* Invoices.listInvoices({ customer_id: '7001', page: 2, per_page: 25 })

    const [request] = zoho.requests
    expect(request?.method).toBe('GET')
    expect(`${request?.url.origin}${request?.url.pathname}`).toBe('https://www.zohoapis.eu/books/v3/invoices')
    expect(Object.fromEntries(request!.url.searchParams)).toEqual({
      customer_id: '7001', organization_id: '20100000', page: '2', per_page: '25',
    })
    expect(request?.authorization).toBe('Zoho-oauthtoken token-1')
  }).pipe(Effect.provide(zoho.layer))
})

it.effect('decodes what Zoho sends into the documented types, whatever scalar form it arrives in', () => {
  const zoho = books(json({
    code: 0,
    message: 'success',
    invoice: {
      invoice_id: 982000000567114,
      invoice_number: 'INV-00003',
      total: 10000.5,
      due_date: '',
      is_viewed_by_client: 'true',
      line_items: [{ line_item_id: '1', quantity: '2', rate: 120 }],
      undocumented_field: 'kept only by raw',
    },
  }))
  return Effect.gen(function* () {
    const { invoice } = yield* Invoices.getInvoice({ invoice_id: '982000000567114' })

    expect(invoice).toMatchObject({
      invoice_id: '982000000567114',
      invoice_number: 'INV-00003',
      total: '10000.5',
      is_viewed_by_client: true,
      line_items: [{ line_item_id: '1', quantity: 2, rate: 120 }],
    })
    expect(invoice).not.toHaveProperty('undocumented_field')
    expect(zoho.requests[0]?.url.pathname).toBe('/books/v3/invoices/982000000567114')
  }).pipe(Effect.provide(zoho.layer))
})

it.effect('returns the response as sent, with undocumented fields, through raw', () => {
  const zoho = books(json({ code: 0, invoice: { invoice_id: 1, undocumented_field: 'here' } }))
  return Effect.gen(function* () {
    expect(yield* Invoices.getInvoice.raw({ invoice_id: '1' })).toEqual({
      code: 0, invoice: { invoice_id: 1, undocumented_field: 'here' },
    })
  }).pipe(Effect.provide(zoho.layer))
})

it.effect('sends a JSON body, encodes path values, and serialises structured query values', () => {
  const zoho = books(json({ code: 0, message: 'updated', invoice: {} }), json({ code: 0, message: 'success', contacts: [] }))
  return Effect.gen(function* () {
    yield* Invoices.updateInvoice({
      invoice_id: 'a/b',
      ignore_auto_number_generation: true,
      body: { customer_id: '7001', line_items: [{ item_id: '9', quantity: 2 }] },
    })
    yield* Contacts.listContacts({ contact_name: 'Serenity & Co' })

    const [update, list] = zoho.requests
    expect(update?.method).toBe('PUT')
    expect(update?.url.pathname).toBe('/books/v3/invoices/a%2Fb')
    expect(update?.url.searchParams.get('ignore_auto_number_generation')).toBe('true')
    expect(update?.body).toEqual({ customer_id: '7001', line_items: [{ item_id: '9', quantity: 2 }] })
    expect(list?.url.searchParams.get('contact_name')).toBe('Serenity & Co')
  }).pipe(Effect.provide(zoho.layer))
})

it.effect('fills a path segment Zoho documents as a regular expression', () => {
  const zoho = books(json({ message: 'The option has been marked as active.' }))
  return Effect.gen(function* () {
    yield* ReportingTags.activeTagOption({ tag_id: '11', option_id: '22' })
    expect(zoho.requests[0]?.url.pathname).toBe('/books/v3/reportingtags/11/option/22/active')
  }).pipe(Effect.provide(zoho.layer))
})

it.effect('reports an error status, a non-zero result code, and a rate limit as typed failures', () => {
  const zoho = books(
    json({ code: 1002, message: 'Invoice does not exist.' }, { status: 404 }),
    json({ code: 4, message: 'Invalid value passed for customer_id' }),
    json({ code: 45, message: 'Too many requests' }, { status: 429, headers: { 'retry-after': '30' } }),
  )
  return Effect.gen(function* () {
    const missing = yield* Effect.flip(Invoices.getInvoice({ invoice_id: '1' }))
    const invalid = yield* Effect.flip(Invoices.listInvoices({ customer_id: 'x' }))
    const limited = yield* Effect.flip(Invoices.listInvoices())

    expect(missing).toMatchObject({ operation: 'get_invoice', reason: { _tag: 'ZohoApiError', status: 404, code: 1002, detail: 'Invoice does not exist.' } })
    expect(invalid).toMatchObject({ reason: { _tag: 'ZohoApiError', status: 200, code: 4 } })
    expect(limited).toMatchObject({ reason: { _tag: 'ZohoRateLimitError', code: 45, retryAfterSeconds: 30 } })
  }).pipe(Effect.provide(zoho.layer))
})

it.effect('fails with the operation and the offending field when a response breaks its documented shape', () => {
  const zoho = books(json({ code: 0, invoice: { line_items: 'not a list' } }))
  return Effect.gen(function* () {
    const error = yield* Effect.flip(Invoices.getInvoice({ invoice_id: '1' }))
    expect(error).toMatchObject({ operation: 'get_invoice', reason: { _tag: 'ZohoResponseError' } })
    expect(error.message).toContain('line_items')
  }).pipe(Effect.provide(zoho.layer))
})

it.effect('refuses an empty or dot path value before anything is sent', () => {
  const zoho = books()
  return Effect.gen(function* () {
    for (const invoice_id of ['', '.', '..']) {
      expect(yield* Effect.flip(Invoices.deleteInvoice({ invoice_id }))).toMatchObject({
        operation: 'delete_invoice', reason: { _tag: 'ZohoInvalidRequestError' },
      })
    }
    expect(zoho.requests).toHaveLength(0)
  }).pipe(Effect.provide(zoho.layer))
})

it.effect('sends documented header parameters as headers and list filters as comma-separated text', () => {
  const zoho = books(json({ code: 0 }), json({ code: 0, invoices: [] }))
  return Effect.gen(function* () {
    yield* Invoices.updateInvoiceUsingCustomField({
      'X-Unique-Identifier-Key': 'cf_job', 'X-Unique-Identifier-Value': 'J-7', 'X-Upsert': true, body: { customer_id: '7001', line_items: [] },
    })
    yield* ZohoBooksClient.use((client) => client.json({
      operation: 'list_invoices', method: 'GET', path: '/invoices', query: { invoice_ids: ['1', '2'].join(',') },
    }))

    expect(zoho.requests[0]?.headers).toMatchObject({ 'x-unique-identifier-key': 'cf_job', 'x-unique-identifier-value': 'J-7', 'x-upsert': 'true' })
    expect(zoho.requests[0]?.url.searchParams.has('X-Upsert')).toBe(false)
    expect(zoho.requests[1]?.url.searchParams.get('invoice_ids')).toBe('1,2')
  }).pipe(Effect.provide(zoho.layer))
})

it.effect('reports a successful response that is not JSON as a response failure, not a transport one', () => {
  const zoho = books(new Response('<html>Maintenance</html>', { headers: { 'content-type': 'text/html' } }))
  return Effect.gen(function* () {
    expect(yield* Effect.flip(Invoices.listInvoices())).toMatchObject({ reason: { _tag: 'ZohoResponseError', detail: 'expected JSON but received text/html' } })
  }).pipe(Effect.provide(zoho.layer))
})

it.effect('passes on why no access token could be obtained instead of calling it unauthorised', () => {
  const zoho = fakeZoho()
  const outage = new ZohoError({ operation: 'oauth.refreshAccessToken', reason: new ZohoTransportError({ cause: 'ECONNRESET' }) })
  const tokens = Layer.succeed(ZohoAccessToken, ZohoAccessToken.of({ get: Effect.fail(outage), replace: () => Effect.succeed(Option.none()) }))
  return Effect.gen(function* () {
    expect(yield* Effect.flip(Invoices.listInvoices())).toBe(outage)
    expect(zoho.requests).toHaveLength(0)
  }).pipe(Effect.provide(ZohoBooksClient.layer({ organizationId: '1', dataCenter: 'us' }).pipe(Layer.provide([zoho.layer, tokens]))))
})

it.effect('does not retry a 401 when the token service has no replacement to offer', () => {
  const zoho = books(json({ code: 57, message: 'You are not authorized to perform this operation' }, { status: 401 }))
  return Effect.gen(function* () {
    expect(yield* Effect.flip(Invoices.listInvoices())).toMatchObject({ reason: { _tag: 'ZohoUnauthorizedError', code: 57 } })
    expect(zoho.requests).toHaveLength(1)
  }).pipe(Effect.provide(zoho.layer))
})

it.effect('retries once with a replacement token after a 401, and gives up after a second', () => {
  const zoho = fakeZoho(
    json({ code: 57, message: 'You are not authorized to perform this operation' }, { status: 401 }),
    json({ code: 0, invoices: [] }),
    json({ code: 14, message: 'Invalid value passed for authtoken.' }, { status: 401 }),
    json({ code: 14, message: 'Invalid value passed for authtoken.' }, { status: 401 }),
  )
  const replaced: string[] = []
  const tokens = Layer.succeed(ZohoAccessToken, ZohoAccessToken.of({
    get: Effect.succeed(Redacted.make('stale')),
    replace: (rejected) => Effect.sync(() => {
      replaced.push(Redacted.value(rejected))
      return Option.some(Redacted.make('fresh'))
    }),
  }))
  return Effect.gen(function* () {
    yield* Invoices.listInvoices()
    const error = yield* Effect.flip(Invoices.listInvoices())

    expect(zoho.requests.map((request) => request.authorization)).toEqual([
      'Zoho-oauthtoken stale', 'Zoho-oauthtoken fresh', 'Zoho-oauthtoken stale', 'Zoho-oauthtoken fresh',
    ])
    expect(replaced).toEqual(['stale', 'stale'])
    expect(error).toMatchObject({ reason: { _tag: 'ZohoUnauthorizedError', detail: 'Invalid value passed for authtoken.' } })
  }).pipe(Effect.provide(ZohoBooksClient.layer({ organizationId: '1', dataCenter: 'us' }).pipe(Layer.provide([zoho.layer, tokens]))))
})

it.effect('returns a file as bytes, a JSON file included, and a JSON error answer to a download as a failure', () => {
  const pdf = new TextEncoder().encode('%PDF-1.7')
  const zoho = books(
    new Response(pdf, { headers: { 'content-type': 'application/pdf' } }),
    json({ code: 1002, message: 'Invoice does not exist.' }),
    new Response(pdf, { headers: { 'content-type': 'image/png' } }),
    json({ exported: [1, 2] }),
  )
  return Effect.gen(function* () {
    const file = yield* Invoices.getInvoice.binary({ invoice_id: '1', accept: 'pdf' })
    const refused = yield* Effect.flip(Invoices.getInvoice.binary({ invoice_id: '2', accept: 'pdf' }))
    const attachment = yield* DeliveryChallans.getDeliveryChallanAttachment({ deliverychallan_id: '3', document_id: '4' })

    expect(file).toEqual({ bytes: pdf, contentType: 'application/pdf' })
    expect(zoho.requests[0]?.url.searchParams.get('accept')).toBe('pdf')
    expect(refused).toMatchObject({ reason: { _tag: 'ZohoApiError', code: 1002 } })
    expect(attachment.contentType).toBe('image/png')
    const jsonFile = yield* DeliveryChallans.getDeliveryChallanAttachment({ deliverychallan_id: '3', document_id: '5' })
    expect(JSON.parse(new TextDecoder().decode(jsonFile.bytes))).toEqual({ exported: [1, 2] })
  }).pipe(Effect.provide(zoho.layer))
})

it.effect('uploads a multipart body', () => {
  const zoho = books(json({ code: 0, message: 'Your file has been attached.' }))
  return Effect.gen(function* () {
    yield* DeliveryChallans.addAttachmentToDeliveryChallan({
      deliverychallan_id: '3',
      body: { attachment: { bytes: new Uint8Array([1, 2, 3]), fileName: 'packing-list.pdf', contentType: 'application/pdf' } },
    })
    const file = (zoho.requests[0]!.body as FormData).get('attachment') as File
    expect(file).toMatchObject({ name: 'packing-list.pdf', size: 3, type: 'application/pdf' })
  }).pipe(Effect.provide(zoho.layer))
})

it.effect('sends a file with its record as multipart, the record as JSON text', () => {
  const zoho = books(json({ code: 0, message: 'The expense has been recorded.', expense: {} }))
  return Effect.gen(function* () {
    yield* Expenses.createExpense({
      receipt: { bytes: new Uint8Array([1, 2]), fileName: 'fuel.pdf' },
      body: { account_id: '982000000561057', amount: 112.5, date: '2026-11-15', paid_through_account_id: '982000000567250' },
    })

    const form = zoho.requests[0]!.body as FormData
    expect((form.get('receipt') as File).name).toBe('fuel.pdf')
    expect(JSON.parse(form.get('JSONString') as string)).toMatchObject({ account_id: '982000000561057', amount: 112.5 })
    expect(zoho.requests[0]?.url.searchParams.has('receipt')).toBe(false)
  }).pipe(Effect.provide(zoho.layer))
})

it.effect('returns the file from a download Zoho documents with only a result code', () => {
  const zoho = books(new Response(new Uint8Array([7, 8]), { headers: { 'content-type': 'image/jpeg' } }))
  return Effect.gen(function* () {
    expect(yield* Bills.getBillAttachment({ bill_id: '9' })).toEqual({ bytes: new Uint8Array([7, 8]), contentType: 'image/jpeg' })
  }).pipe(Effect.provide(zoho.layer))
})

it.effect('keeps the payload of a response Zoho documents with only a result code', () => {
  const zoho = books(json({ code: 0, message: 'success', reconciliations: [{ reconciliation_id: '5' }] }))
  return Effect.gen(function* () {
    const response = yield* BankAccounts.listBankReconciliations({ account_id: '4' })
    expect(response).toEqual({ code: 0, message: 'success', reconciliations: [{ reconciliation_id: '5' }] })
  }).pipe(Effect.provide(zoho.layer))
})

it.effect('leaves the organisation out of the calls that list organisations', () => {
  const zoho = books(json({ code: 0, organizations: [{ organization_id: 10234695 }] }), json({ code: 0, organization: {} }))
  return Effect.gen(function* () {
    const { organizations } = yield* Organizations.listOrganizations()
    yield* Organizations.getOrganization({ organization_id: '10234695' })

    expect(organizations?.[0]?.organization_id).toBe('10234695')
    expect(zoho.requests.map((request) => request.url.searchParams.has('organization_id'))).toEqual([false, false])
    expect(zoho.requests[1]?.url.pathname).toBe('/books/v3/organizations/10234695')
  }).pipe(Effect.provide(zoho.layer))
})

it.effect('reads a duration Zoho documents as a number but sends as text', () => {
  const zoho = books(json({ code: 0, tasks: [{ task_id: '1', log_time: '13:06' }] }))
  return Effect.gen(function* () {
    const response = yield* Projects.listProjectTasks({ project_id: '2' })
    expect(response.tasks?.[0]?.log_time).toBe('13:06')
  }).pipe(Effect.provide(zoho.layer))
})

it.effect('streams every page of a list until Zoho reports no more', () => {
  const page = (number: number, more: boolean) =>
    json({ code: 0, invoices: [{ invoice_id: String(number) }], page_context: { page: number, has_more_page: more } })
  const zoho = books(page(1, true), page(2, true), page(3, false))
  return Effect.gen(function* () {
    const pages = yield* Stream.runCollect(paginate(Invoices.listInvoices, { status: 'unpaid' }))

    expect(pages.flatMap((response) => response.invoices ?? []).map((invoice) => invoice.invoice_id)).toEqual(['1', '2', '3'])
    expect(zoho.requests.map((request) => request.url.searchParams.get('page'))).toEqual(['1', '2', '3'])
    expect(zoho.requests.every((request) => request.url.searchParams.get('status') === 'unpaid')).toBe(true)
  }).pipe(Effect.provide(zoho.layer))
})

it.effect('lets a caller recover from one reason and leaves the rest as the same error', () => {
  const zoho = books(
    json({ code: 44, message: 'Too many requests' }, { status: 429 }),
    json({ code: 1002, message: 'Invoice does not exist.' }, { status: 404 }),
  )
  const invoice = Invoices.getInvoice({ invoice_id: '1' }).pipe(
    Effect.catchReason('ZohoError', 'ZohoRateLimitError', (reason) => Effect.succeed(`limited by code ${reason.code}`)),
  )
  return Effect.gen(function* () {
    expect(yield* invoice).toBe('limited by code 44')
    const missing = yield* Effect.flip(invoice)
    expect(missing).toBeInstanceOf(ZohoError)
    expect(missing.message).toBe('Zoho request get_invoice failed: HTTP 404 (code 1002): Invoice does not exist.')
  }).pipe(Effect.provide(zoho.layer))
})

it.effect('reads the organisation and data centre from Config, and refuses a data centre Zoho does not have', () => {
  const zoho = fakeZoho(json({ code: 0, invoices: [] }))
  const layer = (dataCenter: string) => ZohoBooksClient.layerConfig({
    organizationId: Config.String('ZOHO_ORGANIZATION_ID'),
    dataCenter: Config.schema(ZohoDataCenter, 'ZOHO_DATA_CENTER'),
  }).pipe(
    Layer.provide([zoho.layer, ZohoAccessToken.layerStatic(Redacted.make('token-1'))]),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ ZOHO_ORGANIZATION_ID: '20100000', ZOHO_DATA_CENTER: dataCenter }))),
  )
  return Effect.gen(function* () {
    yield* Invoices.listInvoices().pipe(Effect.provide(layer('au')))
    expect(zoho.requests[0]?.url.href).toBe('https://www.zohoapis.com.au/books/v3/invoices?organization_id=20100000')

    const refused = yield* Effect.flip(Invoices.listInvoices().pipe(Effect.provide(layer('mars'))))
    expect(refused._tag).toBe('ConfigError')
  })
})

it.effect('sends requests through transformClient, which can retry a 503 or a 429 and still reports the last answer by its reason', () => {
  const zoho = fakeZoho(
    new Response('upstream unavailable', { status: 503 }),
    json({ code: 0, invoices: [] }),
    json({ code: 44, message: 'Too many requests' }, { status: 429 }),
    json({ code: 44, message: 'Too many requests' }, { status: 429 }),
    json({ code: 44, message: 'Too many requests' }, { status: 429 }),
  )
  const layer = Layer.unwrap(Effect.gen(function* () {
    const limiter = yield* RateLimiter.RateLimiter
    return ZohoBooksClient.layer({
      organizationId: '20100000',
      dataCenter: 'eu',
      transformClient: flow(
        HttpClient.withRateLimiter({ limiter, key: 'zoho-books', limit: 100, window: '1 minute', times: 0 }),
        HttpClient.retryTransient({ times: 2 }),
      ),
    })
  })).pipe(
    Layer.provide([zoho.layer, ZohoAccessToken.layerStatic(Redacted.make('token-1'))]),
    Layer.provide(RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory))),
  )
  return Effect.gen(function* () {
    yield* Invoices.listInvoices()
    expect(zoho.requests).toHaveLength(2)

    const limited = yield* Effect.flip(Invoices.listInvoices())
    expect(limited.reason._tag).toBe('ZohoRateLimitError')
    expect(zoho.requests).toHaveLength(5)
  }).pipe(Effect.provide(layer))
})
