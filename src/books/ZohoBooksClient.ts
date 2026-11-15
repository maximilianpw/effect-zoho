import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import type * as HttpClientResponse from 'effect/unstable/http/HttpClientResponse'
import { ZohoAccessToken } from '../ZohoAccessToken.ts'
import { zohoDataCenters, type ZohoDataCenter } from '../ZohoDataCenter.ts'
import {
  ZohoApiError,
  ZohoRateLimitError,
  ZohoTransportError,
  ZohoUnauthorizedError,
  type ZohoRequestError,
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
  readonly query?: Readonly<Record<string, string>>
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: ZohoBooksBody
}

export interface ZohoBinary {
  readonly bytes: Uint8Array
  readonly contentType: string | undefined
}

export interface ZohoBooksClientOptions {
  readonly organizationId: string
  readonly dataCenter: ZohoDataCenter
  /** Overrides the data centre's API host, for a proxy or a test server. */
  readonly apiUrl?: string
}

const mediaType = (response: HttpClientResponse.HttpClientResponse): string | undefined =>
  response.headers['content-type']?.split(';')[0]?.trim().toLowerCase()

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
export class ZohoBooksClient extends Context.Service<
  ZohoBooksClient,
  {
    /** The parsed JSON body of a successful response, with Zoho's `code` already checked. */
    readonly json: (request: ZohoBooksRequest) => Effect.Effect<unknown, ZohoRequestError>
    /** The bytes of a successful response, for PDFs and attachments. */
    readonly binary: (request: ZohoBooksRequest) => Effect.Effect<ZohoBinary, ZohoRequestError>
  }
>()('effect-zoho/books/ZohoBooksClient') {
  static readonly layer = (
    options: ZohoBooksClientOptions,
  ): Layer.Layer<ZohoBooksClient, never, HttpClient.HttpClient | ZohoAccessToken> =>
    Layer.effect(
      ZohoBooksClient,
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient
        const tokens = yield* ZohoAccessToken
        const base = `${options.apiUrl ?? zohoDataCenters[options.dataCenter].api}/books/v3`

        const build = (request: ZohoBooksRequest, token: Redacted.Redacted<string>) => {
          const built = HttpClientRequest.make(request.method)(`${base}${request.path}`).pipe(
            HttpClientRequest.setUrlParams({ ...request.query, organization_id: options.organizationId }),
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
            operation: request.operation,
            detail: message ?? `HTTP ${response.status}`,
            ...(code === undefined ? {} : { code }),
          }
          if (response.status === 401) return new ZohoUnauthorizedError(problem)
          if (response.status === 429) {
            const retryAfter = Number(response.headers['retry-after'])
            return new ZohoRateLimitError({
              ...problem,
              ...(Number.isFinite(retryAfter) && retryAfter >= 0 ? { retryAfterSeconds: retryAfter } : {}),
            })
          }
          return new ZohoApiError({ ...problem, status: response.status })
        }

        const send = <A>(
          request: ZohoBooksRequest,
          read: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, ZohoRequestError>,
        ): Effect.Effect<A, ZohoRequestError> => {
          const transport = (cause: unknown) => new ZohoTransportError({ operation: request.operation, cause })
          const token = <E>(effect: Effect.Effect<Redacted.Redacted<string>, E>) =>
            effect.pipe(Effect.mapError((cause) =>
              new ZohoUnauthorizedError({ operation: request.operation, detail: `no access token: ${String(cause)}` })))
          const attempt = (credential: Redacted.Redacted<string>) =>
            http.execute(build(request, credential)).pipe(Effect.mapError(transport))
          const answer = (response: HttpClientResponse.HttpClientResponse) =>
            response.status < 400
              ? read(response)
              : Effect.flatMap(
                  mediaType(response) === 'application/json'
                    ? response.json.pipe(Effect.orElseSucceed((): unknown => undefined))
                    : Effect.succeed(undefined),
                  (body) => Effect.fail(failure(request, response, body)),
                )

          return Effect.gen(function* () {
            const credential = yield* token(tokens.get)
            const first = yield* attempt(credential)
            if (first.status !== 401) return yield* answer(first)
            // An access token can expire or be revoked early; one retry with a replacement settles it.
            const replacement = yield* token(tokens.replace(credential))
            return yield* Effect.flatMap(attempt(replacement), answer)
          })
        }

        const json = (request: ZohoBooksRequest) =>
          send(request, (response) =>
            Effect.flatMap(
              response.json.pipe(Effect.mapError((cause) => new ZohoTransportError({ operation: request.operation, cause }))),
              (body): Effect.Effect<unknown, ZohoRequestError> => {
                const { code } = envelope(body)
                return code === undefined || code === 0 ? Effect.succeed(body) : Effect.fail(failure(request, response, body))
              },
            ))

        const binary = (request: ZohoBooksRequest) =>
          send(request, (response) =>
            mediaType(response) === 'application/json'
              // Zoho reports a failed download as a JSON body, sometimes with HTTP 200.
              ? Effect.flatMap(
                  response.json.pipe(Effect.orElseSucceed((): unknown => undefined)),
                  (body) => Effect.fail(failure(request, response, body)),
                )
              : Effect.map(
                  response.arrayBuffer.pipe(Effect.mapError((cause) => new ZohoTransportError({ operation: request.operation, cause }))),
                  (buffer): ZohoBinary => ({ bytes: new Uint8Array(buffer), contentType: mediaType(response) }),
                ))

        return ZohoBooksClient.of({ json, binary })
      }),
    )
}
