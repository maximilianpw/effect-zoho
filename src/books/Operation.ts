import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SchemaIssue from 'effect/SchemaIssue'
import * as Stream from 'effect/Stream'
import { ZohoError, ZohoInvalidRequestError, ZohoResponseError } from '../ZohoError.ts'
import { ZohoBooksClient, type ZohoBinary, type ZohoBooksBody, type ZohoBooksMethod, type ZohoBooksRequest } from './ZohoBooksClient.ts'

export interface OperationDefinition<Response extends Schema.Top | undefined> {
  /** Zoho's `operationId`. */
  readonly id: string
  readonly method: ZohoBooksMethod
  /** Path template below `/books/v3`, such as `/invoices/{invoice_id}`. */
  readonly path: string
  /** Input keys sent as request headers; every other key except `body` and the path parameters is a query parameter. */
  readonly headers?: ReadonlyArray<string> | undefined
  /** Input keys that carry a file. When one is given the request is multipart, with a JSON `body` in its `JSONString` field. */
  readonly files?: ReadonlyArray<string> | undefined
  readonly body?: 'json' | 'multipart' | undefined
  /** `false` for the organisation endpoints, which take no `organization_id`. */
  readonly organization?: false | undefined
  /** The documented JSON response, or `undefined` when the operation only returns a file. */
  readonly response: Response
  /** OAuth scopes Zoho documents for the operation. */
  readonly scopes: ReadonlyArray<string>
}

type Arguments<Input> = {} extends Input ? [input?: Input] : [input: Input]

type Result<Response extends Schema.Top | undefined> = Response extends Schema.Top ? Response['Type'] : ZohoBinary

export interface Operation<Input, Response extends Schema.Top | undefined> {
  /** Calls the operation and decodes the response Zoho documents for it. */
  (...args: Arguments<Input>): Effect.Effect<Result<Response>, ZohoError, ZohoBooksClient>
  /** The response as Zoho sent it, including fields its documentation omits. Zoho's result code is still checked. */
  readonly raw: (...args: Arguments<Input>) => Effect.Effect<unknown, ZohoError, ZohoBooksClient>
  /** The response as bytes, for operations that can return a PDF or an attachment. */
  readonly binary: (...args: Arguments<Input>) => Effect.Effect<ZohoBinary, ZohoError, ZohoBooksClient>
  readonly definition: OperationDefinition<Response>
}

/**
 * A file to upload. Zoho checks the file name's extension, so give bytes a name;
 * a `File` carries its own, and a bare `Blob` is sent as `blob`.
 */
export type ZohoFile =
  | Blob
  | { readonly bytes: Uint8Array; readonly fileName: string; readonly contentType?: string | undefined }

const isScalar = (value: unknown): boolean => ['string', 'number', 'boolean'].includes(typeof value)

// Zoho documents list filters as comma-separated text; anything structured travels as JSON.
const queryValue = (value: unknown): string =>
  Array.isArray(value) && value.every(isScalar)
    ? value.join(',')
    : typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)

const isNamedBytes = (value: unknown): value is Extract<ZohoFile, { readonly bytes: Uint8Array }> =>
  typeof value === 'object' && value !== null && (value as { readonly bytes?: unknown }).bytes instanceof Uint8Array

const formData = (fields: Readonly<Record<string, unknown>>, form = new FormData()): FormData => {
  const append = (name: string, value: unknown): void => {
    if (value === undefined || value === null) return
    if (value instanceof Blob) form.append(name, value)
    else if (isNamedBytes(value)) {
      form.append(name, new Blob([new Uint8Array(value.bytes)], value.contentType === undefined ? {} : { type: value.contentType }), value.fileName)
    } else if (Array.isArray(value) && value.some((item) => item instanceof Blob || isNamedBytes(item))) {
      for (const item of value) append(name, item)
    } else form.append(name, queryValue(value))
  }
  for (const [name, value] of Object.entries(fields)) append(name, value)
  return form
}

function toRequest(
  definition: OperationDefinition<Schema.Top | undefined>,
  input: Readonly<Record<string, unknown>>,
): ZohoBooksRequest | ZohoError {
  const used = new Set<string>(['body'])
  const unusable: string[] = []
  const path = definition.path.replace(/\{(\w+)\}/g, (_, name: string) => {
    used.add(name)
    const value = input[name]
    // An empty segment or a dot segment would address a different endpoint with the caller's credentials.
    if (!isScalar(value) || ['', '.', '..'].includes(String(value))) unusable.push(name)
    return encodeURIComponent(String(value))
  })
  if (unusable.length > 0) {
    return new ZohoError({
      operation: definition.id,
      reason: new ZohoInvalidRequestError({ detail: `path parameter ${unusable.join(', ')} is missing or empty` }),
    })
  }
  const headers: Record<string, string> = {}
  for (const name of definition.headers ?? []) {
    used.add(name)
    if (input[name] !== undefined) headers[name] = String(input[name])
  }
  const files: Record<string, unknown> = {}
  for (const name of definition.files ?? []) {
    used.add(name)
    if (input[name] !== undefined && input[name] !== null) files[name] = input[name]
  }
  const query: Record<string, string> = {}
  for (const [name, value] of Object.entries(input)) {
    if (!used.has(name) && value !== undefined && value !== null) query[name] = queryValue(value)
  }
  const given = definition.body === undefined ? undefined : input['body']
  const body: ZohoBooksBody | undefined =
    Object.keys(files).length > 0
      // Zoho takes a file together with the record as multipart, the record as JSON text in `JSONString`.
      ? { _tag: 'Multipart', value: formData(given === undefined ? files : { ...files, JSONString: JSON.stringify(given) }) }
      : given === undefined
        ? undefined
        : definition.body === 'json'
          ? { _tag: 'Json', value: given }
          : { _tag: 'Multipart', value: formData(given as Readonly<Record<string, unknown>>) }
  return {
    operation: definition.id,
    method: definition.method,
    path,
    query,
    headers,
    ...(body === undefined ? {} : { body }),
    ...(definition.organization === false ? { organization: false as const } : {}),
  }
}

/**
 * Where a response broke its documented shape. Only the path is reported: an issue's
 * own message can quote the value, which may be a customer's data.
 */
function mismatch(error: Schema.SchemaError): string {
  const [issue] = SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues
  const path = (issue?.path ?? []).map((segment) => String(typeof segment === 'object' ? segment.key : segment))
  return path.length === 0 ? 'the response did not match' : `${path.join('.')} did not match`
}

const annotateFailure = ({ reason }: ZohoError) =>
  Effect.annotateCurrentSpan({
    'zoho.error.reason': reason._tag,
    ...('code' in reason && reason.code !== undefined ? { 'zoho.error.code': reason.code } : {}),
  })

/** Builds the callable for one documented Books operation. Used by the generated modules. */
export function operation<Input, const Response extends Schema.Top | undefined = Schema.Top | undefined>(
  definition: OperationDefinition<Response>,
): Operation<Input, Response> {
  const send = <A>(args: ReadonlyArray<unknown>, use: (client: ZohoBooksClient['Service'], request: ZohoBooksRequest) => Effect.Effect<A, ZohoError>) =>
    Effect.suspend(() => {
      const request = toRequest(definition, (args[0] ?? {}) as Readonly<Record<string, unknown>>)
      return request instanceof ZohoError ? Effect.fail(request) : Effect.flatMap(ZohoBooksClient, (client) => use(client, request))
    }).pipe(
      Effect.tapError(annotateFailure),
      Effect.withSpan(`zoho.books.${definition.id}`, { attributes: { 'zoho.operation': definition.id } }),
    )
  const raw = (...args: Arguments<Input>) => send(args, (client, request) => client.json(request))
  const binary = (...args: Arguments<Input>) => send(args, (client, request) => client.binary(request))
  const schema: Schema.Top | undefined = definition.response
  const decoded = schema === undefined
    ? binary
    : (...args: Arguments<Input>) => send(args, (client, request) => Effect.flatMap(client.json(request), (body) =>
        Schema.decodeUnknownEffect(schema as Schema.Codec<unknown>)(body).pipe(
          Effect.mapError((error) => new ZohoError({ operation: definition.id, reason: new ZohoResponseError({ detail: mismatch(error) }) })),
        )))
  return Object.assign(decoded, { raw, binary, definition }) as Operation<Input, Response>
}

interface Paged {
  readonly page_context?: { readonly has_more_page?: boolean | null } | null | undefined
}

/**
 * Every page of a list operation, starting from `input.page` or the first page,
 * requested one at a time as the stream is consumed.
 */
export function paginate<Input extends { readonly page?: number | undefined }, Response extends Schema.Top>(
  list: Operation<Input, Response>,
  ...args: Arguments<Input>
): Stream.Stream<Response['Type'], ZohoError, ZohoBooksClient> {
  const input = args[0] ?? ({} as Input)
  const call = list as unknown as (input: Input) => Effect.Effect<Response['Type'], ZohoError, ZohoBooksClient>
  return Stream.paginate(input.page ?? 1, (page) =>
    Effect.map(call({ ...input, page }), (response) => [
      [response],
      (response as Paged).page_context?.has_more_page === true ? Option.some(page + 1) : Option.none<number>(),
    ] as const))
}
