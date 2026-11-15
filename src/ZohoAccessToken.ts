import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as Semaphore from 'effect/Semaphore'
import type * as HttpClient from 'effect/unstable/http/HttpClient'
import type { ZohoOAuthError, ZohoResponseError, ZohoTransportError } from './ZohoError.ts'
import { refreshAccessToken, type ZohoOAuthClient } from './ZohoOAuth.ts'

export type ZohoAccessTokenError = ZohoOAuthError | ZohoResponseError | ZohoTransportError

/** Supplies the access token sent with every API request. */
export class ZohoAccessToken extends Context.Service<
  ZohoAccessToken,
  {
    readonly get: Effect.Effect<Redacted.Redacted<string>, ZohoAccessTokenError>
    /**
     * Called when Zoho rejected `rejected` with HTTP 401. Returns a token to retry
     * with, which is a new one unless another caller already replaced it.
     */
    readonly replace: (rejected: Redacted.Redacted<string>) => Effect.Effect<Redacted.Redacted<string>, ZohoAccessTokenError>
  }
>()('effect-zoho/ZohoAccessToken') {
  /** A fixed token, for scripts and tests. It is never refreshed. */
  static readonly layerStatic = (token: Redacted.Redacted<string>): Layer.Layer<ZohoAccessToken> =>
    Layer.succeed(ZohoAccessToken, ZohoAccessToken.of({ get: Effect.succeed(token), replace: () => Effect.succeed(token) }))

  /**
   * Mints access tokens from a refresh token and keeps one in memory until shortly
   * before it expires. Concurrent callers share one refresh. Each process holds its
   * own token; Zoho allows a limited number of live access tokens per refresh token,
   * so many short-lived processes should share tokens through their own store instead.
   */
  static readonly layerRefreshToken = (
    options: ZohoOAuthClient & {
      readonly refreshToken: Redacted.Redacted<string>
      /** How long before expiry a token stops being handed out. Defaults to 60 seconds. */
      readonly expirySkewMillis?: number
    },
  ): Layer.Layer<ZohoAccessToken, never, HttpClient.HttpClient> =>
    Layer.effect(
      ZohoAccessToken,
      Effect.gen(function* () {
        const context = yield* Effect.context<HttpClient.HttpClient>()
        const lock = yield* Semaphore.make(1)
        const skew = options.expirySkewMillis ?? 60_000
        let cached: { readonly token: Redacted.Redacted<string>; readonly usableUntil: number } | undefined

        const mint = Effect.gen(function* () {
          const grant = yield* refreshAccessToken(options).pipe(Effect.provide(context))
          const now = yield* Clock.currentTimeMillis
          cached = { token: grant.access_token, usableUntil: now + grant.expires_in * 1000 - skew }
          return grant.access_token
        })

        const get = lock.withPermits(1)(Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          return cached !== undefined && now < cached.usableUntil ? cached.token : yield* mint
        }))

        const replace = (rejected: Redacted.Redacted<string>) => lock.withPermits(1)(Effect.suspend(() =>
          cached !== undefined && Redacted.value(cached.token) !== Redacted.value(rejected)
            ? Effect.succeed(cached.token)
            : mint))

        return ZohoAccessToken.of({ get, replace })
      }),
    )
}
