import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import { ZohoResponseError, type ZohoRequestError } from '../ZohoError.ts'
import { ZohoBooksClient, type ZohoBinary, type ZohoBooksBody, type ZohoBooksMethod, type ZohoBooksRequest } from './ZohoBooksClient.ts'

export interface OperationDefinition<Response extends Schema.Top | undefined> {
  /** Zoho's `operationId`. */
  readonly id: string
  readonly method: ZohoBooksMethod
  /** Path template below `/books/v3`, such as `/invoices/{invoice_id}`. */
  readonly path: string
  /** Input keys sent as request headers; every other key except `body` and the path parameters is a query parameter. */
  readonly headers?: ReadonlyArray<string>
  readonly body?: 'json' | 'multipart'
  /** The documented JSON response, or `undefined` when the operation only returns a file. */
  readonly response: Response
  /** OAuth scopes Zoho documents for the operation. */
  readonly scopes: ReadonlyArray<string>
}

type Arguments<Input> = {} extends Input ? [input?: Input] : [input: Input]

type Result<Response extends Schema.Top | undefined> = Response extends Schema.Top ? Response['Type'] : ZohoBinary

export interface Operation<Input, Response extends Schema.Top | undefined> {
  /** Calls the operation and decodes the response Zoho documents for it. */
  (...args: Arguments<Input>): Effect.Effect<Result<Response>, ZohoRequestError, ZohoBooksClient>
  /** The response as Zoho sent it, including fields its documentation omits. Zoho's result code is still checked. */
  readonly raw: (...args: Arguments<Input>) => Effect.Effect<unknown, ZohoRequestError, ZohoBooksClient>
  /** The response as bytes, for operations that can return a PDF or an attachment. */
  readonly binary: (...args: Arguments<Input>) => Effect.Effect<ZohoBinary, ZohoRequestError, ZohoBooksClient>
  readonly definition: OperationDefinition<Response>
}

const queryValue = (value: unknown): string =>
  typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)

const formData = (fields: Readonly<Record<string, unknown>>): FormData => {
  const form = new FormData()
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue
    if (value instanceof Blob) form.append(name, value)
    else if (value instanceof Uint8Array) form.append(name, new Blob([new Uint8Array(value)]))
    else form.append(name, queryValue(value))
  }
  return form
}

function toRequest(definition: OperationDefinition<Schema.Top | undefined>, input: Readonly<Record<string, unknown>>): ZohoBooksRequest {
  const used = new Set<string>(['body'])
  const path = definition.path.replace(/\{(\w+)\}/g, (_, name: string) => {
    used.add(name)
    return encodeURIComponent(String(input[name]))
  })
  const headers: Record<string, string> = {}
  for (const name of definition.headers ?? []) {
    used.add(name)
    if (input[name] !== undefined) headers[name] = String(input[name])
  }
  const query: Record<string, string> = {}
  for (const [name, value] of Object.entries(input)) {
    if (!used.has(name) && value !== undefined) query[name] = queryValue(value)
  }
  const body: ZohoBooksBody | undefined =
    definition.body === undefined || input['body'] === undefined
      ? undefined
      : definition.body === 'json'
        ? { _tag: 'Json', value: input['body'] }
        : { _tag: 'Multipart', value: formData(input['body'] as Readonly<Record<string, unknown>>) }
  return {
    operation: definition.id,
    method: definition.method,
    path,
    query,
    headers,
    ...(body === undefined ? {} : { body }),
  }
}

/** Builds the callable for one documented Books operation. Used by the generated modules. */
export function operation<Input, const Response extends Schema.Top | undefined = Schema.Top | undefined>(
  definition: OperationDefinition<Response>,
): Operation<Input, Response> {
  const request = (args: ReadonlyArray<unknown>) => toRequest(definition, (args[0] ?? {}) as Readonly<Record<string, unknown>>)
  const raw = (...args: Arguments<Input>) => Effect.flatMap(ZohoBooksClient, (client) => client.json(request(args)))
  const binary = (...args: Arguments<Input>) => Effect.flatMap(ZohoBooksClient, (client) => client.binary(request(args)))
  const schema: Schema.Top | undefined = definition.response
  const decoded = schema === undefined
    ? binary
    : (...args: Arguments<Input>) => Effect.flatMap(raw(...args), (body) =>
        Schema.decodeUnknownEffect(schema as Schema.Codec<unknown>)(body).pipe(
          Effect.mapError((issue) => new ZohoResponseError({ operation: definition.id, detail: String(issue) })),
        ))
  return Object.assign(decoded, { raw, binary, definition }) as Operation<Input, Response>
}

interface Paged {
  readonly page_context?: { readonly has_more_page?: boolean | null } | null | undefined
}

/**
 * Every page of a list operation, starting from `input.page` or the first page,
 * requested one at a time as the stream is consumed.
 */
export function paginate<Input extends { readonly page?: number }, Response extends Schema.Top>(
  list: Operation<Input, Response>,
  ...args: Arguments<Input>
): Stream.Stream<Response['Type'], ZohoRequestError, ZohoBooksClient> {
  const input = args[0] ?? ({} as Input)
  const call = list as unknown as (input: Input) => Effect.Effect<Response['Type'], ZohoRequestError, ZohoBooksClient>
  return Stream.paginate(input.page ?? 1, (page) =>
    Effect.map(call({ ...input, page }), (response) => [
      [response],
      (response as Paged).page_context?.has_more_page === true ? Option.some(page + 1) : Option.none<number>(),
    ] as const))
}
