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

export interface ZohoAccessTokenService {
  readonly get: Effect.Effect<Redacted.Redacted<string>, ZohoError>
  readonly replace: (
    rejected: Redacted.Redacted<string>,
  ) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, ZohoError>
}

export interface ZohoRefreshTokenOptions extends ZohoOAuthClient {
  readonly refreshToken: Redacted.Redacted<string>
  readonly expirySkewMillis?: number | undefined
  readonly minimumReplaceAgeMillis?: number | undefined
}

const refreshTimeout = '30 seconds'
const refusalMemoryMillis = 5_000

export class ZohoAccessToken extends Context.Service<ZohoAccessToken, ZohoAccessTokenService>()('effect-zoho/ZohoAccessToken') {
  static readonly layerStatic = (token: Redacted.Redacted<string>): Layer.Layer<ZohoAccessToken> =>
    Layer.succeed(ZohoAccessToken, ZohoAccessToken.of({ get: Effect.succeed(token), replace: () => Effect.succeed(Option.none()) }))

  static readonly makeRefreshToken = Effect.fnUntraced(function* (options: ZohoRefreshTokenOptions) {
    const http = yield* HttpClient.HttpClient
    const lock = yield* Semaphore.make(1)
    const skew = options.expirySkewMillis ?? 60_000
    const minimumReplaceAge = options.minimumReplaceAgeMillis ?? 300_000
    let cached: { readonly token: Redacted.Redacted<string>; readonly mintedAt: number; readonly usableUntil: number } | undefined
    let refused: { readonly error: ZohoError; readonly until: number } | undefined

    const mint = Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis
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
