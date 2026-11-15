import * as Schema from 'effect/Schema'

/** No HTTP response was read: DNS, TLS, a timeout, or a connection that dropped mid-body. Usually worth retrying. */
export class ZohoTransportError extends Schema.TaggedError<ZohoTransportError>()('ZohoTransportError', {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Zoho request ${this.operation} failed before a response was read.`
  }
}

/** Zoho answered with an error status or a non-zero result code. */
export class ZohoApiError extends Schema.TaggedError<ZohoApiError>()('ZohoApiError', {
  operation: Schema.String,
  status: Schema.Number,
  /** Zoho's own result code from the response body, when it sent one. */
  code: Schema.optionalKey(Schema.Number),
  detail: Schema.String,
}) {
  override get message(): string {
    return `Zoho request ${this.operation} failed with HTTP ${this.status}${this.code === undefined ? '' : ` (code ${this.code})`}: ${this.detail}`
  }
}

/**
 * HTTP 429. `code` tells Zoho's limits apart: 44 is the per-minute limit, 45 the
 * daily limit (not worth retrying until the next day) and 1070 the concurrency limit.
 */
export class ZohoRateLimitError extends Schema.TaggedError<ZohoRateLimitError>()('ZohoRateLimitError', {
  operation: Schema.String,
  code: Schema.optionalKey(Schema.Number),
  detail: Schema.String,
  /** Seconds from a `Retry-After` header. Zoho does not document sending one, so expect it to be absent. */
  retryAfterSeconds: Schema.optionalKey(Schema.Number),
}) {
  override get message(): string {
    return `Zoho request ${this.operation} was rate limited: ${this.detail}`
  }
}

/**
 * HTTP 401. Zoho uses it both for a bad access token and for a missing scope,
 * role, or the wrong organisation or data centre, so reconnecting does not always cure it.
 */
export class ZohoUnauthorizedError extends Schema.TaggedError<ZohoUnauthorizedError>()('ZohoUnauthorizedError', {
  operation: Schema.String,
  /** Zoho's result code: 14 for a missing or malformed token, 57 for a token or permission it does not accept. */
  code: Schema.optionalKey(Schema.Number),
  detail: Schema.String,
}) {
  override get message(): string {
    return `Zoho request ${this.operation} was not authorised: ${this.detail}`
  }
}

/** Zoho's OAuth endpoint refused a grant; `error` is Zoho's code, such as `invalid_code`. */
export class ZohoOAuthError extends Schema.TaggedError<ZohoOAuthError>()('ZohoOAuthError', {
  operation: Schema.String,
  error: Schema.String,
}) {
  override get message(): string {
    return `Zoho OAuth ${this.operation} was refused: ${this.error}`
  }
}

/** A successful response was not JSON, or did not match the shape Zoho documents for the operation. */
export class ZohoResponseError extends Schema.TaggedError<ZohoResponseError>()('ZohoResponseError', {
  operation: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return `Zoho response for ${this.operation} did not match its documented shape: ${this.detail}`
  }
}

/** The input cannot be sent, such as an empty value for a path parameter. Nothing was sent to Zoho. */
export class ZohoInvalidRequestError extends Schema.TaggedError<ZohoInvalidRequestError>()('ZohoInvalidRequestError', {
  operation: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return `Zoho request ${this.operation} was not sent: ${this.detail}`
  }
}

export type ZohoRequestError =
  | ZohoApiError
  | ZohoInvalidRequestError
  /** The refresh token or client credentials were refused while obtaining an access token. */
  | ZohoOAuthError
  | ZohoRateLimitError
  | ZohoResponseError
  | ZohoTransportError
  | ZohoUnauthorizedError
