import * as Config from 'effect/Config'
import * as Context from 'effect/Context'
import type * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import type * as HttpClientResponse from 'effect/http/HttpClientResponse'
import { ZohoAccessToken } from '../ZohoAccessToken.ts'
import { zohoDataCenters, type ZohoDataCenter } from '../ZohoDataCenter.ts'
import {
  ZohoApiError,
  ZohoError,
  ZohoRateLimitError,
  ZohoResponseError,
  ZohoTransportError,
  ZohoUnauthorizedError,
} from '../ZohoError.ts'

export type ZohoBooksMethod = 'DELETE' | 'GET' | 'POST' | 'PUT'

export type ZohoBooksBody =
  | { readonly _tag: 'Json'; readonly value: unknown }
  | { readonly _tag: 'Multipart'; readonly value: FormData }

/** One request to the Books API, relative to `/books/v3`. The organisation is added by the client. */
export interface ZohoBooksRequest {
  /** Names the call in errors, such as `get_invoice`. */
  readonly operation: string
  readonly method: ZohoBooksMethod
  /** Path below `/books/v3`, already URL-encoded, such as `/invoices/982000000567114`. */
  readonly path: string
  readonly query?: Readonly<Record<string, string>> | undefined
  readonly headers?: Readonly<Record<string, string>> | undefined
  readonly body?: ZohoBooksBody | undefined
  /** `false` leaves out `organization_id`, for the endpoints that list or create organisations. */
  readonly organization?: false | undefined
}

export interface ZohoBinary {
  readonly bytes: Uint8Array
  readonly contentType: string | undefined
}

export interface ZohoBooksClientOptions {
  readonly organizationId: string
  readonly dataCenter: ZohoDataCenter
  /** Overrides the data centre's API host, for a proxy or a test server. */
  readonly apiUrl?: string | undefined
  /**
   * Wraps the HTTP client that sends API requests, for retries, rate limiting or
   * timeouts. Whatever it fails with reaches the caller as a `ZohoTransportError`.
   */
  readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient.With<unknown>) | undefined
  /**
   * The longest a call may take, from handing the request to the client built by
   * `transformClient` to reading the whole response body. It includes whatever that
   * client does, such as waiting for a rate limiter or retrying; to bound each retry,
   * add a timeout inside `transformClient`. A retry after a 401 gets its own deadline.
   * Past it the call fails with a `ZohoTransportError`, and the request may or may not
   * have reached Zoho.
   */
  readonly requestTimeout?: Duration.Input | undefined
}

type Attempt<A> =
  | { readonly _tag: 'Answered'; readonly value: A }
  | { readonly _tag: 'Rejected'; readonly rejected: ZohoError }

/** Result codes Zoho uses for its limits: 44 per minute, 45 per day, 1070 for concurrent calls. */
const rateLimitCodes: ReadonlySet<number> = new Set([44, 45, 1070])

const mediaType = (response: HttpClientResponse.HttpClientResponse): string | undefined =>
  response.headers['content-type']?.split(';')[0]?.trim().toLowerCase()

const parsed = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return undefined
  }
}

interface ZohoEnvelope {
  readonly code?: number
  readonly message?: string
}

const envelope = (body: unknown): ZohoEnvelope => {
  if (typeof body !== 'object' || body === null) return {}
  const { code, message } = body as { readonly code?: unknown; readonly message?: unknown }
  return {
    ...(typeof code === 'number' ? { code } : {}),
    ...(typeof message === 'string' ? { message } : {}),
  }
}

/**
 * Sends authenticated requests to one Zoho Books organisation. The generated
 * operations use it; call it directly for an endpoint they do not cover.
 */
export interface ZohoBooksClientService {
  /** The parsed JSON body of a successful response, with Zoho's `code` already checked. */
  readonly json: (request: ZohoBooksRequest) => Effect.Effect<unknown, ZohoError>
  /** The bytes of a successful response, for PDFs and attachments. */
  readonly binary: (request: ZohoBooksRequest) => Effect.Effect<ZohoBinary, ZohoError>
}

export class ZohoBooksClient extends Context.Service<ZohoBooksClient, ZohoBooksClientService>()('effect-zoho/books/ZohoBooksClient') {
  /**
   * A client for one organisation. An application that serves several can make one
   * per organisation and pass it with `Effect.provideService(ZohoBooksClient, client)`.
   */
  static readonly make = (
    options: ZohoBooksClientOptions,
  ): Effect.Effect<ZohoBooksClientService, never, HttpClient.HttpClient | ZohoAccessToken> =>
      Effect.gen(function* () {
        const ambient = yield* HttpClient.HttpClient
        const http = options.transformClient === undefined ? ambient : options.transformClient(ambient)
        const tokens = yield* ZohoAccessToken
        const base = `${options.apiUrl ?? zohoDataCenters[options.dataCenter].api}/books/v3`

        const build = (request: ZohoBooksRequest, token: Redacted.Redacted<string>) => {
          const built = HttpClientRequest.make(request.method)(`${base}${request.path}`).pipe(
            HttpClientRequest.setUrlParams(request.organization === false
              ? { ...request.query }
              : { ...request.query, organization_id: options.organizationId }),
            HttpClientRequest.setHeaders({ ...request.headers, Authorization: `Zoho-oauthtoken ${Redacted.value(token)}` }),
          )
          if (request.body === undefined) return built
          return request.body._tag === 'Json'
            ? HttpClientRequest.bodyJsonUnsafe(built, request.body.value)
            : HttpClientRequest.bodyFormData(built, request.body.value)
        }

        const failure = (request: ZohoBooksRequest, response: HttpClientResponse.HttpClientResponse, body: unknown) => {
          const { code, message } = envelope(body)
          const problem = {
            detail: message ?? `HTTP ${response.status}`,
            ...(code === undefined ? {} : { code }),
          }
          const reason = (): ZohoError['reason'] => {
            // A limit's result code identifies it whatever HTTP status accompanies it, 401 included.
            if (response.status === 429 || (code !== undefined && rateLimitCodes.has(code))) {
              const retryAfter = Number(response.headers['retry-after'])
              return new ZohoRateLimitError({
                ...problem,
                ...(Number.isFinite(retryAfter) && retryAfter >= 0 ? { retryAfterSeconds: retryAfter } : {}),
              })
            }
            if (response.status === 401) return new ZohoUnauthorizedError(problem)
            return new ZohoApiError({ ...problem, status: response.status })
          }
          return new ZohoError({ operation: request.operation, reason: reason() })
        }

        const send = <A>(
          request: ZohoBooksRequest,
          read: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, ZohoError>,
        ): Effect.Effect<A, ZohoError> => {
          const transport = (cause: unknown) => new ZohoError({ operation: request.operation, reason: new ZohoTransportError({ cause }) })
          const refusal = (response: HttpClientResponse.HttpClientResponse) =>
            Effect.map(
              mediaType(response) === 'application/json'
                ? response.json.pipe(Effect.orElseSucceed((): unknown => undefined))
                : Effect.as(Effect.ignore(response.text), undefined),
              (body) => failure(request, response, body),
            )
          const answer = (response: HttpClientResponse.HttpClientResponse) =>
            response.status < 400 ? read(response) : Effect.flatMap(refusal(response), Effect.fail)
          const deadline = <B>(effect: Effect.Effect<B, ZohoError>): Effect.Effect<B, ZohoError> =>
            options.requestTimeout === undefined
              ? effect
              : Effect.timeoutOrElse(effect, {
                  duration: options.requestTimeout,
                  orElse: () => Effect.fail(transport('the request deadline passed')),
                })
          // One HTTP attempt: a 401 is returned with its error, unread by `read`, so the caller can retry it.
          const attempt = (credential: Redacted.Redacted<string>): Effect.Effect<Attempt<A>, ZohoError> =>
            deadline(Effect.flatMap(
              http.execute(build(request, credential)).pipe(Effect.mapError(transport)),
              (response): Effect.Effect<Attempt<A>, ZohoError> => response.status === 401
                ? Effect.flatMap(refusal(response), (rejected): Effect.Effect<Attempt<A>, ZohoError> =>
                    rejected.reason._tag === 'ZohoRateLimitError' ? Effect.fail(rejected) : Effect.succeed({ _tag: 'Rejected', rejected }))
                : Effect.map(answer(response), (value) => ({ _tag: 'Answered', value })),
            ))

          return Effect.gen(function* () {
            const credential = yield* tokens.get
            const first = yield* attempt(credential)
            if (first._tag === 'Answered') return first.value
            // An access token can expire or be revoked early; one retry with a replacement settles it.
            const replacement = yield* tokens.replace(credential)
            if (Option.isNone(replacement) || Redacted.value(replacement.value) === Redacted.value(credential)) {
              return yield* first.rejected
            }
            const second = yield* attempt(replacement.value)
            return second._tag === 'Answered' ? second.value : yield* second.rejected
          })
        }

        const json = (request: ZohoBooksRequest) =>
          send(request, (response) =>
            Effect.flatMap(
              mediaType(response) === 'application/json'
                ? response.json.pipe(Effect.mapError((cause) => new ZohoError({ operation: request.operation, reason: new ZohoTransportError({ cause }) })))
                : Effect.fail(new ZohoError({
                    operation: request.operation,
                    reason: new ZohoResponseError({ detail: `expected JSON but received ${mediaType(response) ?? 'no content type'}` }),
                  })),
              (body): Effect.Effect<unknown, ZohoError> => {
                const { code } = envelope(body)
                return code === undefined || code === 0 ? Effect.succeed(body) : Effect.fail(failure(request, response, body))
              },
            ))

        const binary = (request: ZohoBooksRequest) =>
          send(request, (response) =>
            Effect.flatMap(
              response.arrayBuffer.pipe(Effect.mapError((cause) => new ZohoError({ operation: request.operation, reason: new ZohoTransportError({ cause }) }))),
              (buffer): Effect.Effect<ZohoBinary, ZohoError> => {
                const bytes = new Uint8Array(buffer)
                // Zoho can report a failed download as a JSON body with HTTP 200. A JSON file is a valid download too.
                const code = mediaType(response) === 'application/json' ? envelope(parsed(bytes)).code : undefined
                return code === undefined || code === 0
                  ? Effect.succeed({ bytes, contentType: mediaType(response) })
                  : Effect.fail(failure(request, response, parsed(bytes)))
              },
            ))

        return ZohoBooksClient.of({ json, binary })
      })

  static readonly layer = (
    options: ZohoBooksClientOptions,
  ): Layer.Layer<ZohoBooksClient, never, HttpClient.HttpClient | ZohoAccessToken> =>
    Layer.effect(ZohoBooksClient, ZohoBooksClient.make(options))

  static readonly layerConfig = (options: {
    readonly organizationId: Config.Config<string>
    readonly dataCenter: Config.Config<ZohoDataCenter>
    readonly apiUrl?: Config.Config<string> | undefined
    readonly transformClient?: ZohoBooksClientOptions['transformClient']
    readonly requestTimeout?: ZohoBooksClientOptions['requestTimeout']
  }): Layer.Layer<ZohoBooksClient, Config.ConfigError, HttpClient.HttpClient | ZohoAccessToken> =>
    Layer.effect(ZohoBooksClient, Effect.gen(function* () {
      return yield* ZohoBooksClient.make({
        organizationId: yield* options.organizationId,
        dataCenter: yield* options.dataCenter,
        apiUrl: options.apiUrl === undefined ? undefined : yield* options.apiUrl,
        transformClient: options.transformClient,
        requestTimeout: options.requestTimeout,
      })
    }))
}
