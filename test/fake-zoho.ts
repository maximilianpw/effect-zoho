import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpClient from 'effect/http/HttpClient'
import type * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'

export interface RecordedRequest {
  readonly method: string
  readonly url: URL
  readonly authorization: string | undefined
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly body: unknown
}

export type Reply = Response | ((request: RecordedRequest) => Response)

export const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json;charset=UTF-8', ...init.headers } })

function recordedBody(request: HttpClientRequest.HttpClientRequest): unknown {
  const body = request.body
  switch (body._tag) {
    case 'Uint8Array': {
      const text = new TextDecoder().decode(body.body)
      return body.contentType.includes('json') ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text))
    }
    case 'FormData': return body.formData
    default: return undefined
  }
}

export function fakeZoho(...replies: ReadonlyArray<Reply>) {
  const queue = [...replies]
  const requests: RecordedRequest[] = []
  const layer = Layer.succeed(HttpClient.HttpClient, HttpClient.make((request, url) => Effect.sync(() => {
    const recorded: RecordedRequest = {
      method: request.method,
      url,
      authorization: request.headers['authorization'],
      headers: request.headers,
      body: recordedBody(request),
    }
    requests.push(recorded)
    const reply = queue.shift()
    if (reply === undefined) throw new Error(`Unexpected request: ${request.method} ${url}`)
    return HttpClientResponse.fromWeb(request, typeof reply === 'function' ? reply(recorded) : reply)
  })))
  return { layer, requests }
}
