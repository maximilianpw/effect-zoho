import { expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as Stream from 'effect/Stream'
import { ZohoAccessToken } from '../src/index.ts'
import { Contacts, DeliveryChallans, Invoices, paginate, ReportingTags, ZohoBooksClient } from '../src/books/index.ts'
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

    expect(missing).toMatchObject({ _tag: 'ZohoApiError', operation: 'get_invoice', status: 404, code: 1002, detail: 'Invoice does not exist.' })
    expect(invalid).toMatchObject({ _tag: 'ZohoApiError', status: 200, code: 4 })
    expect(limited).toMatchObject({ _tag: 'ZohoRateLimitError', code: 45, retryAfterSeconds: 30 })
  }).pipe(Effect.provide(zoho.layer))
})

it.effect('fails with the operation and the offending field when a response breaks its documented shape', () => {
  const zoho = books(json({ code: 0, invoice: { line_items: 'not a list' } }))
  return Effect.gen(function* () {
    const error = yield* Effect.flip(Invoices.getInvoice({ invoice_id: '1' }))
    expect(error).toMatchObject({ _tag: 'ZohoResponseError', operation: 'get_invoice' })
    expect(error.message).toContain('line_items')
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
      return Redacted.make('fresh')
    }),
  }))
  return Effect.gen(function* () {
    yield* Invoices.listInvoices()
    const error = yield* Effect.flip(Invoices.listInvoices())

    expect(zoho.requests.map((request) => request.authorization)).toEqual([
      'Zoho-oauthtoken stale', 'Zoho-oauthtoken fresh', 'Zoho-oauthtoken stale', 'Zoho-oauthtoken fresh',
    ])
    expect(replaced).toEqual(['stale', 'stale'])
    expect(error).toMatchObject({ _tag: 'ZohoUnauthorizedError', detail: 'Invalid value passed for authtoken.' })
  }).pipe(Effect.provide(ZohoBooksClient.layer({ organizationId: '1', dataCenter: 'us' }).pipe(Layer.provide([zoho.layer, tokens]))))
})

it.effect('returns a file as bytes, and a JSON answer to a download as a failure', () => {
  const pdf = new TextEncoder().encode('%PDF-1.7')
  const zoho = books(
    new Response(pdf, { headers: { 'content-type': 'application/pdf' } }),
    json({ code: 1002, message: 'Invoice does not exist.' }),
    new Response(pdf, { headers: { 'content-type': 'image/png' } }),
  )
  return Effect.gen(function* () {
    const file = yield* Invoices.getInvoice.binary({ invoice_id: '1', accept: 'pdf' })
    const refused = yield* Effect.flip(Invoices.getInvoice.binary({ invoice_id: '2', accept: 'pdf' }))
    const attachment = yield* DeliveryChallans.getDeliveryChallanAttachment({ deliverychallan_id: '3', document_id: '4' })

    expect(file).toEqual({ bytes: pdf, contentType: 'application/pdf' })
    expect(zoho.requests[0]?.url.searchParams.get('accept')).toBe('pdf')
    expect(refused).toMatchObject({ _tag: 'ZohoApiError', code: 1002 })
    expect(attachment.contentType).toBe('image/png')
  }).pipe(Effect.provide(zoho.layer))
})

it.effect('uploads a multipart body', () => {
  const zoho = books(json({ code: 0, message: 'Your file has been attached.' }))
  return Effect.gen(function* () {
    yield* DeliveryChallans.addAttachmentToDeliveryChallan({
      deliverychallan_id: '3',
      body: { attachment: new Uint8Array([1, 2, 3]) },
    })
    const form = zoho.requests[0]?.body as FormData
    expect(form.get('attachment')).toBeInstanceOf(Blob)
    expect((form.get('attachment') as Blob).size).toBe(3)
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
