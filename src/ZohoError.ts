import * as Predicate from 'effect/Predicate'
import * as Schema from 'effect/Schema'
import * as HttpClientError from 'effect/http/HttpClientError'

/**
 * No usable HTTP response was read: DNS, TLS, the request deadline, a connection that
 * dropped mid-body, or a failure from `transformClient`. The original failure is not
 * kept, because an HTTP client error carries the request, and its URL, headers and body
 * can hold tokens and client secrets.
 */
export class ZohoTransportError extends Schema.TaggedError<ZohoTransportError>()('ZohoTransportError', {
  /**
   * `timeout`: the request deadline passed. `request`: no response arrived.
   * `body`: a response arrived but its body could not be read.
   */
  kind: Schema.Literals(['timeout', 'request', 'body']),
  /** The failure's name, such as `TransportError` or `TypeError`, when it has a plain one. */
  causeName: Schema.optionalKey(Schema.String),
}) {
  /** Keeps only the name of `cause`, never its message or the request it carries. */
  static fromCause(kind: 'request' | 'body', cause: unknown): ZohoTransportError {
    const name = HttpClientError.isHttpClientError(cause) ? cause.reason._tag
      : Predicate.isObject(cause) && 'name' in cause && typeof cause.name === 'string' ? cause.name
      : undefined
    return new ZohoTransportError(name !== undefined && /^[A-Za-z]{1,60}$/.test(name) ? { kind, causeName: name } : { kind })
  }

  override get message(): string {
    return this.kind === 'timeout' ? 'the request deadline passed' : 'no response was read'
  }
}

/** Zoho answered with an error status or a non-zero result code. */
export class ZohoApiError extends Schema.TaggedError<ZohoApiError>()('ZohoApiError', {
  status: Schema.Number,
  /** Zoho's own result code from the response body, when it sent one. */
  code: Schema.optionalKey(Schema.Number),
  detail: Schema.String,
}) {
  override get message(): string {
    return `HTTP ${this.status}${this.code === undefined ? '' : ` (code ${this.code})`}: ${this.detail}`
  }
}

/**
 * HTTP 429. `code` tells Zoho's limits apart: 44 is the per-minute limit, 45 the
 * daily limit (not worth retrying until the next day) and 1070 the concurrency limit.
 */
export class ZohoRateLimitError extends Schema.TaggedError<ZohoRateLimitError>()('ZohoRateLimitError', {
  code: Schema.optionalKey(Schema.Number),
  detail: Schema.String,
  /** Seconds from a `Retry-After` header. Zoho does not document sending one, so expect it to be absent. */
  retryAfterSeconds: Schema.optionalKey(Schema.Number),
}) {
  override get message(): string {
    return `rate limited: ${this.detail}`
  }
}

/**
 * HTTP 401. Zoho uses it both for a bad access token and for a missing scope,
 * role, or the wrong organisation or data centre, so reconnecting does not always cure it.
 */
export class ZohoUnauthorizedError extends Schema.TaggedError<ZohoUnauthorizedError>()('ZohoUnauthorizedError', {
  /** Zoho's result code: 14 for a missing or malformed token, 57 for a token or permission it does not accept. */
  code: Schema.optionalKey(Schema.Number),
  detail: Schema.String,
}) {
  override get message(): string {
    return `not authorised: ${this.detail}`
  }
}

/** Zoho's OAuth endpoint refused a grant; `error` is Zoho's code, such as `invalid_code`. */
export class ZohoOAuthError extends Schema.TaggedError<ZohoOAuthError>()('ZohoOAuthError', {
  error: Schema.String,
}) {
  override get message(): string {
    return `the OAuth grant was refused: ${this.error}`
  }
}

/** A successful response was not JSON, or did not match the shape Zoho documents for the operation. */
export class ZohoResponseError extends Schema.TaggedError<ZohoResponseError>()('ZohoResponseError', {
  detail: Schema.String,
}) {
  override get message(): string {
    return `the response did not match its documented shape: ${this.detail}`
  }
}

/** The input cannot be sent, such as an empty value for a path parameter. Nothing was sent to Zoho. */
export class ZohoInvalidRequestError extends Schema.TaggedError<ZohoInvalidRequestError>()('ZohoInvalidRequestError', {
  detail: Schema.String,
}) {
  override get message(): string {
    return `nothing was sent: ${this.detail}`
  }
}

export const ZohoErrorReason = Schema.Union([
  ZohoApiError,
  ZohoInvalidRequestError,
  ZohoOAuthError,
  ZohoRateLimitError,
  ZohoResponseError,
  ZohoTransportError,
  ZohoUnauthorizedError,
])
export type ZohoErrorReason = typeof ZohoErrorReason.Type

/**
 * The one failure of every call. `reason` says what went wrong; handle one with
 * `Effect.catchReason('ZohoError', 'ZohoRateLimitError', …)`. A `ZohoOAuthError`
 * reason on an API call means no access token could be obtained for it.
 */
export class ZohoError extends Schema.TaggedError<ZohoError>()('ZohoError', {
  /** Zoho's `operationId`, such as `get_invoice`, or `oauth.<name>` for a token call. */
  operation: Schema.String,
  reason: ZohoErrorReason,
}) {
  override get message(): string {
    return `Zoho request ${this.operation} failed: ${this.reason.message}`
  }
}
