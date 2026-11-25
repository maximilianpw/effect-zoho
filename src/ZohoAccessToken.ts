import * as Clock from 'effect/Clock'
import * as Config from 'effect/Config'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Semaphore from 'effect/Semaphore'
import * as HttpClient from 'effect/http/HttpClient'
import type { ZohoDataCenter } from './ZohoDataCenter.ts'
import { ZohoError, ZohoTransportError } from './ZohoError.ts'
import { refreshAccessToken, type ZohoOAuthClient } from './ZohoOAuth.ts'

/**
 * What `ZohoBooksClient` expects of a token service, including one you write yourself:
 *
 * - `get` runs before every request, often concurrently. Hand out a cached token while
 *   it is valid, and let concurrent callers share one refresh.
 * - `replace` runs at most once per request, after Zoho answered `rejected` with HTTP
 *   401, and the request is retried once with the token it returns. When the current
 *   token already differs from `rejected`, return it, so a burst of rejections mints once.
 * - Return none for a token minted moments ago. Zoho answers a missing scope or role
 *   with the same 401, and a refresh token can mint only about 10 access tokens in 10
 *   minutes, so minting on every such 401 spends that allowance and locks every caller out.
 */
export interface ZohoAccessTokenService {
  readonly get: Effect.Effect<Redacted.Redacted<string>, ZohoError>
  readonly replace: (
    rejected: Redacted.Redacted<string>,
  ) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, ZohoError>
}

export interface ZohoRefreshTokenOptions extends ZohoOAuthClient {
  readonly refreshToken: Redacted.Redacted<string>
  /** How long before expiry a token stops being handed out. Defaults to 60 seconds. */
  readonly expirySkewMillis?: number | undefined
  /**
   * A token rejected sooner than this after it was minted is not replaced.
   * Defaults to 5 minutes. See `makeRefreshToken`.
   */
  readonly minimumReplaceAgeMillis?: number | undefined
}

const refreshTimeout = '30 seconds'
const refusalMemoryMillis = 5_000

/** Supplies the access token sent with every API request. */
export class ZohoAccessToken extends Context.Service<ZohoAccessToken, ZohoAccessTokenService>()('effect-zoho/ZohoAccessToken') {
  /** A fixed token, for scripts and tests. It is never refreshed, so a 401 is not retried. */
  static readonly layerStatic = (token: Redacted.Redacted<string>): Layer.Layer<ZohoAccessToken> =>
    Layer.succeed(ZohoAccessToken, ZohoAccessToken.of({ get: Effect.succeed(token), replace: () => Effect.succeed(Option.none()) }))

  /**
   * Mints access tokens from a refresh token and keeps one in memory until shortly
   * before it expires. Concurrent callers share one refresh, which completes even if
   * the caller that started it is interrupted.
   *
   * Zoho lets one refresh token mint about 10 access tokens in 10 minutes and hold 15
   * live ones, and it answers a missing scope or role with the same HTTP 401 as an
   * expired token. So a token rejected within `minimumReplaceAgeMillis` of being
   * minted is not replaced: the rejection is almost certainly about permissions, and
   * minting on each one would spend the quota and lock every caller out. Each process
   * holds its own token; many short-lived processes should share tokens through
   * their own `ZohoAccessToken` service instead.
   */
  static readonly makeRefreshToken = Effect.fnUntraced(function* (options: ZohoRefreshTokenOptions) {
    const http = yield* HttpClient.HttpClient
    const lock = yield* Semaphore.make(1)
    const skew = options.expirySkewMillis ?? 60_000
    const minimumReplaceAge = options.minimumReplaceAgeMillis ?? 300_000
    let cached: { readonly token: Redacted.Redacted<string>; readonly mintedAt: number; readonly usableUntil: number } | undefined
    let refused: { readonly error: ZohoError; readonly until: number } | undefined

    const mint = Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis
      // A refused grant stays refused; remembering it briefly keeps a burst of callers from repeating it.
      if (refused !== undefined && started < refused.until) return yield* refused.error
      const grant = yield* refreshAccessToken(options).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.timeoutOrElse({
          duration: refreshTimeout,
          orElse: () => Effect.fail(new ZohoError({ operation: 'oauth.refreshAccessToken', reason: new ZohoTransportError({ cause: 'timed out' }) })),
        }),
        Effect.tapError((error) => Effect.sync(() => {
          if (error.reason._tag === 'ZohoOAuthError') refused = { error, until: started + refusalMemoryMillis }
        })),
      )
      const now = yield* Clock.currentTimeMillis
      cached = { token: grant.access_token, mintedAt: now, usableUntil: now + grant.expires_in * 1000 - skew }
      return grant.access_token
    }).pipe(Effect.uninterruptible)

    const usable = (now: number) => (cached !== undefined && now < cached.usableUntil ? cached : undefined)

    const get = lock.withPermits(1)(Effect.gen(function* () {
      return usable(yield* Clock.currentTimeMillis)?.token ?? (yield* mint)
    }))

    const replace = (rejected: Redacted.Redacted<string>) => lock.withPermits(1)(Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const current = usable(now)
      if (current === undefined) return Option.some(yield* mint)
      if (Redacted.value(current.token) !== Redacted.value(rejected)) return Option.some(current.token)
      if (now - current.mintedAt < minimumReplaceAge) return Option.none()
      return Option.some(yield* mint)
    }))

    return ZohoAccessToken.of({ get, replace })
  })

  static readonly layerRefreshToken = (options: ZohoRefreshTokenOptions): Layer.Layer<ZohoAccessToken, never, HttpClient.HttpClient> =>
    Layer.effect(ZohoAccessToken, ZohoAccessToken.makeRefreshToken(options))

  static readonly layerRefreshTokenConfig = (options: {
    readonly clientId: Config.Config<string>
    readonly clientSecret: Config.Config<Redacted.Redacted<string>>
    readonly refreshToken: Config.Config<Redacted.Redacted<string>>
    readonly dataCenter: Config.Config<ZohoDataCenter>
    readonly expirySkewMillis?: number | undefined
    readonly minimumReplaceAgeMillis?: number | undefined
  }): Layer.Layer<ZohoAccessToken, Config.ConfigError, HttpClient.HttpClient> =>
    Layer.effect(ZohoAccessToken, Effect.gen(function* () {
      return yield* ZohoAccessToken.makeRefreshToken({
        clientId: yield* options.clientId,
        clientSecret: yield* options.clientSecret,
        refreshToken: yield* options.refreshToken,
        dataCenter: yield* options.dataCenter,
        expirySkewMillis: options.expirySkewMillis,
        minimumReplaceAgeMillis: options.minimumReplaceAgeMillis,
      })
    }))
}
