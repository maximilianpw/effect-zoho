# effect-zoho

A typed [Effect](https://effect.website) client for the Zoho Books API. Every one of
the 885 operations in Zoho's official OpenAPI documents is a function whose input,
result, failures and requirements are in its type.

It targets Effect 4 (`4.0.0` or later) and runs on Node, Bun and other runtimes with
`fetch`. It is at version 0.1: it works against a live Zoho organisation, but the API
may still change, and Zoho's documents are wrong in places this client has not yet
found. Read [Known limitations](#known-limitations) before relying on it.

```sh
npm install effect-zoho effect
```

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

Contents: [Operations](#operations) · [Authentication](#authentication) ·
[How the types relate to Zoho's API](#how-the-types-relate-to-zohos-api) ·
[Deadlines, retries and rate limits](#deadlines-retries-and-rate-limits) ·
[Known limitations](#known-limitations) · [Status](#status) · [Contributing](#contributing)

## Operations

Each Zoho Books module is a namespace: `Invoices`, `Contacts`, `SalesOrders`,
`CustomerPayments`, `Items`, `Bills`, and 39 more. Import one with
`import * as Invoices from 'effect-zoho/books/Invoices'`, which lets a bundler keep
only the operations you call, or several with
`import { Invoices, Contacts } from 'effect-zoho/books'`. Prefer the first in large
projects: the second makes TypeScript load the types of all 45 modules.

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
| `ZohoRateLimitError` | HTTP 429, or result code 44, 45 or 1070 with any status. `code` is 44 for the per-minute limit, 45 for the daily limit, 1070 for the concurrency limit. |
| `ZohoUnauthorizedError` | HTTP 401. Zoho sends it for a bad token and also for a missing scope or role, or the wrong organisation or data centre. |
| `ZohoOAuthError` | The refresh token or client credentials were refused while getting an access token. |
| `ZohoResponseError` | A successful response was not JSON or did not match the documented shape. `detail` names the field, never its value. |
| `ZohoTransportError` | No usable response was read: DNS, TLS, the request deadline, a body that broke off, or a failure from `transformClient`. `kind` is `timeout`, `request` or `body`; `causeName` names the failure, such as `TransportError`. The failure itself is not kept, because it carries the request and its secrets. The request may still have reached Zoho. |
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

Zoho's redirect names the data centre twice, as `location` and `accounts-server`, and a
token grant names its API host as `api_domain`. `zohoDataCenterFromLocation`,
`zohoDataCenterFromAccountsServer` and `zohoDataCenterFromApiDomain` turn each into a
`ZohoDataCenter`, and return none for anything but an official value.

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

A code generated by a Self Client in Zoho's API console has no redirect URI; leave
`redirectUri` out when exchanging one.

Tokens are `Redacted`, so they do not appear in logs or error messages.

## How the types relate to Zoho's API

Request types are plain TypeScript, taken from the documents as written.

Response types are Effect schemas, and every response is decoded. Zoho's documents are
not exact, so decoding is deliberately tolerant, and the type you get always matches
the value you get:

- Every documented response field is optional, and a field that is present holds a
  value of its documented type: `invoice.reference_number` is `string | undefined`.
  Zoho marks an unset value with `""` or `null`, or leaves the field out, and all three
  arrive as an absent field. An unset item in a list is left out of it. No response
  type includes `null`.
- Fields are optional because Zoho leaves many out: the tax fields of other countries,
  and those of features the organisation does not use, such as locations or projects.
- Scalars are coerced to the documented type. A field documented as a string arrives
  as a string even when Zoho sends a number or boolean.
- Amounts, quantities and page numbers that Zoho documents as text, such as `total`,
  `balance` and `shipping_charge`, are numbers, as Zoho sends them. Identifiers are
  documented the same way and stay text.
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
- The customer payment list is documented as `customer_payments` and sent as
  `customerpayments`. Both keys are decoded.
- Filter variants named only in a parameter's description, such as
  `contact_name_contains` beside `contact_name`, are parameters too. Names in that prose
  that do not extend the parameter's own name are typos and are left out.
- A list that takes `sort_column` also takes `sort_order` (`A` or `D`), which Zoho
  documents for only some of them.
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
- Five operations document no parameters but are refused without one: the contact card
  count and bank account list take `contact_ids`, the e-invoice lists take
  `invoice_ids` or `creditnote_ids`, and the bank rule match filters take `account_id`.
- Three response fields are documented with a type Zoho does not send:
  `fiscal_year_start_month` is a month name, not a number; the credit note list is a
  list, not one object; and a user's `custom_fields` is a list, not text.
- Seven modules are renamed to match the rest: `SalesOrders`, `PurchaseOrders`,
  `SalesReceipts`, `Currencies`, `BaseCurrencyAdjustments`, `PriceLists`, `CrmIntegration`.

Generation fails on anything in the documents it does not handle, rather than guessing.

## Deadlines, retries and rate limits

`requestTimeout` bounds a call as the caller waits for it, from handing the request to
the client that `transformClient` builds to reading the whole response body. Time spent
waiting for a rate limiter or retrying inside `transformClient` counts against it; the
retry after a 401 gets its own deadline. Past it the call fails with
`ZohoTransportError`, and the request may or may not have reached Zoho. There is no
deadline by default.

```ts
ZohoBooksClient.layer({ organizationId: '20100000', dataCenter: 'eu', requestTimeout: '10 seconds' })
```

The client applies no retries or rate limiting by default. `transformClient` wraps the HTTP client that
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
- To bound each attempt rather than the whole call, add `HttpClient.timeout` (Effect
  4.1 or later) inside `transformClient`, before the retry.

## Known limitations

- **Only part of the API has been checked live.** One organisation in the EU data
  centre, the operations listed under [Status](#status), and every list that needs no
  input. Everything else is as accurate as Zoho's documents, which are wrong in places:
  the first live run found three response fields with the wrong type and five operations
  missing a required parameter. A call that hits another such mistake fails with
  `ZohoResponseError`; use `.raw` until it is corrected.
- **Every response field is optional, identifiers included.** Zoho leaves many fields
  out, depending on the country and the features in use, so the types cannot promise
  any. Expect `invoice.invoice_id ?? …` or a check where you need a value.
- **Undocumented fields are dropped.** An invoice carries about 95 fields with values
  that Zoho's documents do not list. `.raw` returns them, untyped.
- **Amounts as numbers are partly verified.** `total`, `balance` and `shipping_charge`
  were seen arriving as numbers. The other fields treated the same way follow the
  same pattern in the documents and also accept numeric text, but have not been seen.
- **No rate limiting or retries by default.** Zoho's limits are low (100 requests a
  minute per organisation); add them with `transformClient` as shown above.
- **Responses are read whole.** Downloads are buffered in memory, and `paginate`
  streams pages, not records.
- **Access tokens are cached per process.** Many short-lived processes sharing one
  refresh token can exhaust Zoho's token allowance; give them a shared
  `ZohoAccessToken` service.
- **Type-checking cost.** Importing from `effect-zoho/books` adds about 5 seconds and
  1 GB of memory to a `tsc` run; importing one module, such as
  `effect-zoho/books/Invoices`, about half that time and 400 MB.
- **Zoho Books only.** CRM, Desk, Inventory and Zoho's other products are not included.

## Status

Checked: the generator output typechecks, and the tests drive the client through a
fake HTTP server for requests, decoding, errors, token refresh, downloads, uploads and
pagination, on Effect 4.0.0 and 4.1.4. The hosts, OAuth endpoints, headers, result
codes and limits were checked against Zoho's published documentation.

Checked against a live organisation in the EU data centre, with `bun run smoke` (see
`scripts/smoke.ts`): a Self Client code exchange, token refresh, listing organisations
without an organisation ID, creating, updating and deleting contacts, items, invoices
and expenses, pagination, an unknown record failing as `ZohoApiError` with HTTP 404,
PDF and attachment downloads, a file-only upload, and an upload with its record in
`JSONString`. Every list operation that needs no input decoded its response.

Not checked: the other data centres, and most operations that take input.

## Contributing

Reports of a response or parameter that does not match what Zoho sends are the most
useful contribution. Open an issue with the operation, the field, what Zoho sent, and
your data centre. Remove customer data from anything you paste.

Most fixes are a correction in the generator, not a change to generated code. Each kind
of correction is a table near the top of `scripts/generate.ts`, such as
`undeclaredQueryParameters` or `responseTypeCorrections`, with the reason beside it.
Generation fails when a correction stops matching the documents, so one that Zoho has
fixed upstream is noticed and removed.

### Development

```sh
bun install
bun run generate   # regenerate src/books/generated from spec/books
bun run check      # generate:check, typecheck, lint, test, build
```

Run `bun run check` before opening a pull request; CI runs the same.

`bun run smoke` runs the client against a real organisation. Put `ZOHO_CLIENT_ID`,
`ZOHO_CLIENT_SECRET` and `ZOHO_DATA_CENTER` from a Self Client in `.env.smoke`, generate a
code with the scope `ZohoBooks.fullaccess.all`, and run `bun run smoke exchange <code>`
to save a refresh token there. Then `bun run smoke` reads, `--write` also creates and
deletes records, and `--sweep` decodes every list operation that needs no input. Use a
test organisation.

`spec/books` holds Zoho's documents unmodified; see [`spec/README.md`](spec/README.md).
The generator is `scripts/generate.ts`. Generated files are committed and must not be
edited by hand.

## Licence

MIT. Zoho and Zoho Books are trademarks of Zoho Corporation; this project is not
affiliated with or endorsed by Zoho.
