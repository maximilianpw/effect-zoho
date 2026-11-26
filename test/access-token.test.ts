import { expect, it } from '@effect/vitest'
import * as Config from 'effect/Config'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientError from 'effect/http/HttpClientError'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import { TestClock } from 'effect/testing'
import { ZohoAccessToken, ZohoDataCenter, ZohoOAuth } from '../src/index.ts'
import { fakeZoho, json, type Reply } from './fake-zoho.ts'

const client = { clientId: 'client-1', clientSecret: Redacted.make('secret-1'), dataCenter: 'eu' } as const
const grant = (token: string) => json({ access_token: token, api_domain: 'https://www.zohoapis.eu', token_type: 'Bearer', expires_in: 3600 })

function tokens(...replies: ReadonlyArray<Reply>) {
  const zoho = fakeZoho(...replies)
  const layer = ZohoAccessToken.layerRefreshToken({ ...client, refreshToken: Redacted.make('refresh-1') }).pipe(Layer.provide(zoho.layer))
  return { ...zoho, layer }
}

const current = Effect.flatMap(ZohoAccessToken, (service) => Effect.map(service.get, Redacted.value))

it.effect('mints one token from the refresh token, reuses it, and mints again shortly before it expires', () => {
  const zoho = tokens(grant('token-1'), grant('token-2'))
  return Effect.gen(function* () {
    expect(yield* Effect.all([current, current, current], { concurrency: 'unbounded' })).toEqual(['token-1', 'token-1', 'token-1'])
    yield* TestClock.adjust('58 minutes')
    expect(yield* current).toBe('token-1')
    yield* TestClock.adjust('90 seconds')
    expect(yield* current).toBe('token-2')

    expect(zoho.requests).toHaveLength(2)
    expect(`${zoho.requests[0]?.url}`).toBe('https://accounts.zoho.eu/oauth/v2/token')
    expect(zoho.requests[0]?.body).toEqual({
      client_id: 'client-1', client_secret: 'secret-1', grant_type: 'refresh_token', refresh_token: 'refresh-1',
    })
  }).pipe(Effect.provide(zoho.layer))
})

const replacement = (rejected: Redacted.Redacted<string>) =>
  Effect.flatMap(ZohoAccessToken, (service) => Effect.map(service.replace(rejected), Option.map(Redacted.value)))

it.effect('does not mint again for a token rejected minutes after it was minted', () => {
  const zoho = tokens(grant('token-1'))
  return Effect.gen(function* () {
    const rejected = yield* Effect.flatMap(ZohoAccessToken, (service) => service.get)
    yield* TestClock.adjust('4 minutes')

    expect(yield* Effect.all([replacement(rejected), replacement(rejected), replacement(rejected)])).toEqual([
      Option.none(), Option.none(), Option.none(),
    ])
    expect(zoho.requests).toHaveLength(1)
  }).pipe(Effect.provide(zoho.layer))
})

it.effect('replaces an older rejected token once, however many callers report it', () => {
  const zoho = tokens(grant('token-1'), grant('token-2'))
  return Effect.gen(function* () {
    const rejected = yield* Effect.flatMap(ZohoAccessToken, (service) => service.get)
    yield* TestClock.adjust('20 minutes')
    const replacements = yield* Effect.all([replacement(rejected), replacement(rejected)], { concurrency: 'unbounded' })

    expect(replacements).toEqual([Option.some('token-2'), Option.some('token-2')])
    expect(zoho.requests).toHaveLength(2)
  }).pipe(Effect.provide(zoho.layer))
})

it.effect('keeps the token a refresh minted even when the caller that started it is interrupted', () => {
  const zoho = tokens(grant('token-1'))
  return Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(current)
    yield* Fiber.interrupt(fiber)

    expect(yield* current).toBe('token-1')
    expect(zoho.requests).toHaveLength(1)
  }).pipe(Effect.provide(zoho.layer))
})

it.effect('reports a refused grant by Zoho’s error code, shares it between a burst of callers, and never echoes the response', () => {
  const zoho = tokens(json({ error: 'invalid_code' }), json({ access_token: 'token-1' }))
  return Effect.gen(function* () {
    const refusals = yield* Effect.all([Effect.flip(current), Effect.flip(current), Effect.flip(current)], { concurrency: 'unbounded' })
    expect(refusals.map((error) => error.reason._tag)).toEqual(['ZohoOAuthError', 'ZohoOAuthError', 'ZohoOAuthError'])
    expect(refusals[0]).toMatchObject({ operation: 'oauth.refreshAccessToken', reason: { error: 'invalid_code' } })
    expect(zoho.requests).toHaveLength(1)

    yield* TestClock.adjust('10 seconds')
    const malformed = yield* Effect.flip(current)
    expect(malformed.reason._tag).toBe('ZohoResponseError')
    expect(malformed.message).not.toContain('token-1')
  }).pipe(Effect.provide(zoho.layer))
})

it.effect('exchanges an authorization code and keeps the tokens redacted', () => {
  const zoho = fakeZoho(json({ access_token: 'token-1', refresh_token: 'refresh-1', expires_in: 3600 }))
  return Effect.gen(function* () {
    const result = yield* ZohoOAuth.exchangeCode({ ...client, code: 'code-1', redirectUri: 'https://app.example/callback' })

    expect(Redacted.value(result.access_token)).toBe('token-1')
    expect(result.refresh_token === undefined ? undefined : Redacted.value(result.refresh_token)).toBe('refresh-1')
    expect(String(result.access_token)).not.toContain('token-1')
    expect(zoho.requests[0]?.body).toMatchObject({ code: 'code-1', grant_type: 'authorization_code', redirect_uri: 'https://app.example/callback' })
  }).pipe(Effect.provide(zoho.layer))
})

it.effect('exchanges a Self Client code without a redirect URI', () => {
  const zoho = fakeZoho(json({ access_token: 'token-1', refresh_token: 'refresh-1', expires_in: 3600 }))
  return Effect.gen(function* () {
    yield* ZohoOAuth.exchangeCode({ ...client, code: 'code-1' })
    expect(zoho.requests[0]?.body).toEqual({ client_id: 'client-1', client_secret: 'secret-1', code: 'code-1', grant_type: 'authorization_code' })
  }).pipe(Effect.provide(zoho.layer))
})

it.effect('reads the refusal Zoho sends with an error status', () => {
  const zoho = fakeZoho(json({ error: 'invalid_client' }, { status: 400 }))
  return Effect.gen(function* () {
    const error = yield* Effect.flip(ZohoOAuth.refreshAccessToken({ ...client, refreshToken: Redacted.make('refresh-1') }))
    expect(error.reason).toMatchObject({ _tag: 'ZohoOAuthError', error: 'invalid_client' })
  }).pipe(Effect.provide(zoho.layer))
})

it.effect('keeps neither the request nor its client secret when the accounts server cannot be reached', () => {
  const dropped = HttpClient.make((request) => Effect.fail(new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request }),
  })))
  return Effect.gen(function* () {
    const error = yield* Effect.flip(ZohoOAuth.refreshAccessToken({ ...client, refreshToken: Redacted.make('refresh-1') }))
    expect(error.reason).toMatchObject({ _tag: 'ZohoTransportError', kind: 'request', causeName: 'TransportError' })
    expect(JSON.stringify(error)).not.toMatch(/secret-1|refresh-1/)
  }).pipe(Effect.provideService(HttpClient.HttpClient, dropped))
})

it.effect('reports an HTML error page from the accounts server as a refusal, and an unconfirmed revocation as a failure', () => {
  const zoho = fakeZoho(
    new Response('<html>Bad Request</html>', { status: 400, headers: { 'content-type': 'text/html' } }),
    json({ status: 'failure' }),
    json({ status: 'success' }),
  )
  return Effect.gen(function* () {
    const refreshToken = Redacted.make('refresh-1')
    expect(yield* Effect.flip(ZohoOAuth.refreshAccessToken({ ...client, refreshToken }))).toMatchObject({ reason: { _tag: 'ZohoOAuthError', error: 'HTTP 400' } })
    expect((yield* Effect.flip(ZohoOAuth.revokeRefreshToken({ dataCenter: 'eu', refreshToken }))).reason._tag).toBe('ZohoOAuthError')
    yield* ZohoOAuth.revokeRefreshToken({ dataCenter: 'eu', refreshToken })
    expect(zoho.requests[2]?.body).toEqual({ token: 'refresh-1' })
  }).pipe(Effect.provide(zoho.layer))
})

it('builds the consent URL for the account’s data centre', () => {
  const url = new URL(ZohoOAuth.authorizationUrl({
    clientId: 'client-1',
    dataCenter: 'in',
    redirectUri: 'https://app.example/callback',
    scopes: ['ZohoBooks.invoices.READ', 'ZohoBooks.contacts.READ'],
    state: 'state-1',
    prompt: 'consent',
  }))

  expect(`${url.origin}${url.pathname}`).toBe('https://accounts.zoho.in/oauth/v2/auth')
  expect(Object.fromEntries(url.searchParams)).toEqual({
    access_type: 'offline',
    client_id: 'client-1',
    prompt: 'consent',
    redirect_uri: 'https://app.example/callback',
    response_type: 'code',
    scope: 'ZohoBooks.invoices.READ,ZohoBooks.contacts.READ',
    state: 'state-1',
  })
})

it.effect('reads the client credentials and refresh token from Config and keeps them redacted', () => {
  const zoho = fakeZoho(grant('token-1'))
  const layer = ZohoAccessToken.layerRefreshTokenConfig({
    clientId: Config.String('ZOHO_CLIENT_ID'),
    clientSecret: Config.Redacted('ZOHO_CLIENT_SECRET'),
    refreshToken: Config.Redacted('ZOHO_REFRESH_TOKEN'),
    dataCenter: Config.schema(ZohoDataCenter, 'ZOHO_DATA_CENTER'),
  }).pipe(
    Layer.provide(zoho.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({
      ZOHO_CLIENT_ID: 'client-1', ZOHO_CLIENT_SECRET: 'secret-1', ZOHO_REFRESH_TOKEN: 'refresh-1', ZOHO_DATA_CENTER: 'in',
    }))),
  )
  return Effect.gen(function* () {
    expect(yield* current).toBe('token-1')
    expect(zoho.requests[0]?.url.href).toBe('https://accounts.zoho.in/oauth/v2/token')
    expect(zoho.requests[0]?.body).toMatchObject({ client_id: 'client-1', client_secret: 'secret-1', refresh_token: 'refresh-1' })
  }).pipe(Effect.provide(layer))
})
