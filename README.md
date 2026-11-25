# effect-zoho

A typed [Effect](https://effect.website) client for the Zoho Books API. Every one of
the 885 operations in Zoho's official OpenAPI documents is a function whose input,
result, failures and requirements are in its type.

It targets Effect 4 (`4.0.0` or later). It is not published to npm yet, and it
has not been run against a live Zoho account: see [Status](#status).

```ts
import { Effect, Layer, Redacted } from 'effect'
import { FetchHttpClient } from 'effect/http'
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

It fails with one error, `ZohoError`, which carries the `operation` and a `reason`.
The reason is one of seven tagged values:

| Reason | When |
| --- | --- |
| `ZohoApiError` | Zoho answered with an error status or a non-zero result code. Carries `status`, `code`, `detail`. |
| `ZohoRateLimitError` | HTTP 429. `code` is 44 for the per-minute limit, 45 for the daily limit, 1070 for the concurrency limit. |
| `ZohoUnauthorizedError` | HTTP 401. Zoho sends it for a bad token and also for a missing scope or role, or the wrong organisation or data centre. |
| `ZohoOAuthError` | The refresh token or client credentials were refused while getting an access token. |
| `ZohoResponseError` | A successful response was not JSON or did not match the documented shape. |
| `ZohoTransportError` | No response was read: DNS, TLS, timeout. The request may still have reached Zoho. |
| `ZohoInvalidRequestError` | The input cannot be sent, such as an empty path parameter. Nothing was sent. |

Handle one reason with `Effect.catchReason`, several with `Effect.catchReasons`, or move
them into the error channel with `Effect.unwrapReason('ZohoError')`:

```ts
const invoice = Invoices.getInvoice({ invoice_id }).pipe(
  Effect.catchReason('ZohoError', 'ZohoApiError', (reason) =>
    reason.status === 404 ? Effect.succeed(undefined) : Effect.fail(reason)),
)
```

Each call runs in a span named `zoho.books.<operationId>` with a `zoho.operation`
attribute. A failed call also records `zoho.error.reason`, the reason's tag, and
`zoho.error.code`, Zoho's result code when it sent one.

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
  provide your own `ZohoAccessToken` service. It has two members, and the client
  relies on them behaving like the built-in one:
  - `get` runs before every request, often concurrently. Hand out a cached token
    while it is valid, and let concurrent callers share one refresh.
  - `replace(rejected)` runs at most once per request, after a 401, and the request is
    retried once with what it returns. If the current token already differs from
    `rejected`, return it rather than minting, so a burst of 401s mints once.
  - Return `Option.none()` for a token minted moments ago, for the quota reason above.
    A replacement equal to the rejected token is ignored.

`ZohoBooksClient.layerConfig` and `ZohoAccessToken.layerRefreshTokenConfig` take the
same settings as `Config` values, to read them from the environment:

```ts
import { Config } from 'effect'
import { ZohoAccessToken, ZohoDataCenter } from 'effect-zoho'

const dataCenter = Config.schema(ZohoDataCenter, 'ZOHO_DATA_CENTER')

const ZohoLive = ZohoBooksClient.layerConfig({
  organizationId: Config.String('ZOHO_ORGANIZATION_ID'),
  dataCenter,
}).pipe(
  Layer.provide(ZohoAccessToken.layerRefreshTokenConfig({
    clientId: Config.String('ZOHO_CLIENT_ID'),
    clientSecret: Config.Redacted('ZOHO_CLIENT_SECRET'),
    refreshToken: Config.Redacted('ZOHO_REFRESH_TOKEN'),
    dataCenter,
  })),
  Layer.provide(FetchHttpClient.layer),
)
```

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

## Retries and rate limits

The client applies neither by default. `transformClient` wraps the HTTP client that
sends API requests, so Effect's own combinators apply. Zoho allows 100 requests a
minute per organisation, a daily total that depends on the plan, and five to ten
concurrent calls:

```ts
import { Effect, flow, Layer } from 'effect'
import { HttpClient } from 'effect/http'
import { RateLimiter } from 'effect/persistence'

const ZohoBooks = Layer.unwrap(Effect.gen(function* () {
  const limiter = yield* RateLimiter.RateLimiter
  return ZohoBooksClient.layer({
    organizationId: '20100000',
    dataCenter: 'eu',
    transformClient: flow(
      HttpClient.withRateLimiter({ limiter, key: 'zoho-books', limit: 100, window: '1 minute', times: 0 }),
      HttpClient.retryTransient({ times: 2 }),
    ),
  })
})).pipe(Layer.provide(RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory))))
```

- `withRateLimiter` holds requests back to stay inside the limit. Without `times` it
  retries a 429 for ever, which never ends once the daily limit (code 45) is reached.
- `retryTransient` repeats a request that got no response or a 408, 429, 500, 502, 503 or 504. It
  does so for every method: a `POST` that Zoho processed before the connection
  dropped is sent again and can create a second record. Leave it out, or give it a
  `while` predicate, where that matters.
- What is left after the retries reaches the caller as the usual `ZohoError`.
- The token endpoint uses the `HttpClient` you provide, not the transformed one.

## Not included

- Zoho CRM, Desk, Inventory and the other products. Only Books is generated.

## Status

Checked: the generator output typechecks, and the tests drive the client through a
fake HTTP server for requests, decoding, errors, token refresh, downloads, uploads and
pagination, on Effect 4.0.0 and 4.1.4. The hosts, OAuth endpoints, headers, result
codes and limits were checked against Zoho's published documentation.

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
