import { expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import { TestClock } from 'effect/testing'
import { ZohoAccessToken, ZohoOAuth } from '../src/index.ts'
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

it.effect('replaces a rejected token once, however many callers report it', () => {
  const zoho = tokens(grant('token-1'), grant('token-2'))
  return Effect.gen(function* () {
    const service = yield* ZohoAccessToken
    const rejected = yield* service.get
    const replacements = yield* Effect.all([service.replace(rejected), service.replace(rejected)], { concurrency: 'unbounded' })

    expect(replacements.map(Redacted.value)).toEqual(['token-2', 'token-2'])
    expect(zoho.requests).toHaveLength(2)
  }).pipe(Effect.provide(zoho.layer))
})

it.effect('reports a refused grant by Zoho’s error code, without echoing the response', () => {
  const zoho = tokens(json({ error: 'invalid_code' }), json({ access_token: 'token-1' }))
  return Effect.gen(function* () {
    expect(yield* Effect.flip(current)).toMatchObject({ _tag: 'ZohoOAuthError', error: 'invalid_code' })
    const malformed = yield* Effect.flip(current)
    expect(malformed._tag).toBe('ZohoResponseError')
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
