# effect-zoho

A typed [Effect](https://effect.website) client for the Zoho Books API. Every one of
the 885 operations in Zoho's official OpenAPI documents is a function whose input,
result, failures and requirements are in its type.

It targets Effect 4 (`4.0.0-rc.112` or later). It is not published to npm yet, and it
has not been run against a live Zoho account: see [Status](#status).

```ts
import { Effect, Layer, Redacted } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import { ZohoAccessToken } from 'effect-zoho'
import { ZohoBooksClient } from 'effect-zoho/books'
import * as Invoices from 'effect-zoho/books/Invoices'

const program = Effect.gen(function* () {
  const { invoices } = yield* Invoices.listInvoices({ status: 'unpaid', per_page: 50 })
  for (const invoice of invoices ?? []) {
    yield* Effect.log(`${invoice.invoice_number}: ${invoice.balance} ${invoice.currency_code}`)
  }
})

const ZohoLive = ZohoBooksClient.layer({ organizationId: '20100000', dataCenter: 'eu' }).pipe(
  Layer.provide(ZohoAccessToken.layerRefreshToken({
    clientId: 'your client id',
    clientSecret: Redacted.make('your client secret'),
    refreshToken: Redacted.make('your refresh token'),
    dataCenter: 'eu',
  })),
  Layer.provide(FetchHttpClient.layer),
)

Effect.runPromise(program.pipe(Effect.provide(ZohoLive)))
```

## Operations

Each Zoho Books module is a namespace: `Invoices`, `Contacts`, `SalesOrders`,
`CustomerPayments`, `Items`, `Bills`, and 39 more. Import one with
`import * as Invoices from 'effect-zoho/books/Invoices'`, which lets a bundler keep
only the operations you call, or several with
`import { Invoices, Contacts } from 'effect-zoho/books'`.

An operation takes one object: its path, query and header parameters by Zoho's own
names, and `body` for the request body. The organisation ID comes from the client.

```ts
yield* Invoices.updateInvoice({
  invoice_id: '982000000567114',
  body: { customer_id: '982000000567001', line_items: [{ item_id: '982000000030049', quantity: 2 }] },
})
```

It fails with one of seven tagged errors, so `Effect.catchTag` can tell them apart:

| Error | When |
| --- | --- |
| `ZohoApiError` | Zoho answered with an error status or a non-zero result code. Carries `status`, `code`, `detail`. |
| `ZohoRateLimitError` | HTTP 429. `code` is 44 for the per-minute limit, 45 for the daily limit, 1070 for the concurrency limit. |
| `ZohoUnauthorizedError` | HTTP 401. Zoho sends it for a bad token and also for a missing scope or role, or the wrong organisation or data centre. |
| `ZohoOAuthError` | The refresh token or client credentials were refused while getting an access token. |
| `ZohoResponseError` | A successful response was not JSON or did not match the documented shape. |
| `ZohoTransportError` | No response was read: DNS, TLS, timeout. Usually worth retrying. |
| `ZohoInvalidRequestError` | The input cannot be sent, such as an empty path parameter. Nothing was sent. |

Each call runs in a span named `zoho.books.<operationId>`.

Every operation also has two other forms:

- `Invoices.getInvoice.raw(input)` returns the JSON as Zoho sent it, including fields
  its documents omit. Zoho's result code is still checked.
- `Invoices.getInvoice.binary({ invoice_id, accept: 'pdf' })` returns
  `{ bytes, contentType }`, for PDFs and attachments. Operations that only serve a
  file, such as `Bills.getBillAttachment`, return that directly.

### Files

A file is a `File`, a `Blob`, or bytes with a name. Zoho checks the extension, so name it:

```ts
yield* Expenses.createExpense({
  receipt: { bytes, fileName: 'fuel.pdf', contentType: 'application/pdf' },
  body: { account_id, paid_through_account_id, date: '2026-11-15', amount: 112.5 },
})
```

`definition` holds the method, path template and the OAuth scopes Zoho documents for
the operation, which is useful for building a consent URL:

```ts
const scopes = [Invoices.listInvoices, Contacts.getContact].flatMap((operation) => operation.definition.scopes)
```

### Pagination

`paginate` turns a list operation into a stream of pages, requested as the stream is
consumed:

```ts
import { Stream } from 'effect'
import { Invoices, paginate } from 'effect-zoho/books'

const unpaid = paginate(Invoices.listInvoices, { status: 'unpaid' }).pipe(
  Stream.flatMap((page) => Stream.fromIterable(page.invoices ?? [])),
)
```

### Anything else

`ZohoBooksClient` sends an arbitrary authenticated request, for an endpoint or a
filter the documents do not describe:

```ts
const client = yield* ZohoBooksClient
const body = yield* client.json({
  operation: 'list_invoices',
  method: 'GET',
  path: '/invoices',
  query: { invoice_number_startswith: 'INV-2026' },
})
```

## Authentication

Zoho uses OAuth 2.0, and each account lives in one data centre (`us`, `eu`, `in`,
`au`, `jp`, `ca`, `cn`, `sa`, `ae`). Use the same data centre for the token layer and
the client.

- `ZohoAccessToken.layerRefreshToken` mints access tokens from a refresh token, keeps
  one in memory until a minute before it expires, and shares one refresh between
  concurrent callers.
- When Zoho rejects a token with a 401, the client asks for a replacement and retries
  once, but only if the token is more than five minutes old. Zoho lets a refresh
  token mint about ten access tokens in ten minutes and answers a missing permission
  with the same 401, so replacing a fresh token would spend that allowance and lock
  the application out.
- `ZohoAccessToken.layerStatic` uses a fixed token, for scripts and tests.
- For anything else, such as tokens shared between processes through a database,
  provide your own `ZohoAccessToken` service. It has two members, `get` and `replace`.

An application that serves several organisations can build a client for each with
`ZohoBooksClient.make` and pass it with `Effect.provideService(ZohoBooksClient, client)`.
`Organizations.listOrganizations` needs no organisation, so it can find the ID.

`ZohoOAuth` covers the consent flow that produces the refresh token:

```ts
import { ZohoOAuth } from 'effect-zoho'

const url = ZohoOAuth.authorizationUrl({
  clientId, dataCenter: 'eu', redirectUri, state,
  scopes: ['ZohoBooks.invoices.READ', 'ZohoBooks.contacts.READ'],
})
// After Zoho redirects back with ?code=…
const grant = yield* ZohoOAuth.exchangeCode({ clientId, clientSecret, dataCenter: 'eu', code, redirectUri })
```

Tokens are `Redacted`, so they do not appear in logs or error messages.

## How the types relate to Zoho's API

Request types are plain TypeScript, taken from the documents as written.

Response types are Effect schemas, and every response is decoded. Zoho's documents are
not exact, so decoding is deliberately tolerant, and the type you get always matches
the value you get:

- Every documented response field is optional and may be `null`.
- Scalars are coerced to the documented type. A field documented as a string arrives
  as a string even when Zoho sends a number, which is common for amounts: `total` is
  documented as a string and sent as a number. A number or boolean sent as `""`
  becomes `null`.
- A field documented as a list accepts a single value and returns a one-element list.
- Fields Zoho sends but does not document are dropped. Use `.raw` to read them.
- About half the responses are documented with nothing but a result code and a
  message. Those keep every field Zoho sends, typed `unknown`.
- An identifier sent as a JSON number too large to be exact fails rather than
  silently naming a different record.

A response that still does not fit, such as text where an object is documented, fails
with `ZohoResponseError` naming the operation and the field. `.raw` is the way round it.

The generator corrects the documents where they contradict the API or themselves:

- `page_context` is one object, though eight list responses document a list of them.
- Three reporting-tag paths write a path segment as the regular expression `(\d+)`.
  It becomes a named parameter (`option_id` or `tag_id`).
- A parameter declared for both the path and the query is sent in the path only.
- 29 file parameters are documented as query strings, and three as JSON fields. They
  are sent as multipart, with the record in Zoho's `JSONString` field. Two upload
  operations that document no file at all get an `attachment` parameter.
- 21 downloads are documented with a JSON result code only. They return the file.
- A number or boolean whose own example is not one, such as `log_time: '13:06'`, is text.
- `POST` and `PUT` operations documented without a body accept an untyped one.
- A request body made from another with `allOf` does not inherit its required fields.
- The organisation endpoints are sent without `organization_id`.
- Seven modules are renamed to match the rest: `SalesOrders`, `PurchaseOrders`,
  `SalesReceipts`, `Currencies`, `BaseCurrencyAdjustments`, `PriceLists`, `CrmIntegration`.

Generation fails on anything in the documents it does not handle, rather than guessing.

## Not included

- Rate limiting. Zoho allows 100 requests a minute per organisation, a daily total
  that depends on the plan, and five to ten concurrent calls. A 429 surfaces as
  `ZohoRateLimitError`; retry policy and request budgets are left to the application.
- Request timeouts and retries. Wrap a call in `Effect.timeout` or `Effect.retry`, or
  provide an `HttpClient` that applies them; the token endpoint uses the same client.
- Zoho CRM, Desk, Inventory and the other products. Only Books is generated.

## Status

Checked: the generator output typechecks, and the tests drive the client through a
fake HTTP server for requests, decoding, errors, token refresh, downloads, uploads and
pagination. The hosts, OAuth endpoints, headers, result codes and limits were checked
against Zoho's published documentation.

Not checked: any authenticated call against a live Zoho organisation. The operations
are only as accurate as Zoho's documents, and the corrections above came from reading
them, not from observing the API. In particular, sending a file with its record in
`JSONString` follows Zoho's long-standing convention but is not in the v3 documents.
Expect to find more inaccuracies; please open an issue with the operation and the field.

## Development

```sh
bun install
bun run generate   # regenerate src/books/generated from spec/books
bun run check      # generate:check, typecheck, lint, test, build
```

`spec/books` holds Zoho's documents unmodified; see [`spec/README.md`](spec/README.md).
The generator is `scripts/generate.ts`. Generated files are committed and must not be
edited by hand.

## Licence

MIT. Zoho and Zoho Books are trademarks of Zoho Corporation; this project is not
affiliated with or endorsed by Zoho.
