import * as Schema from 'effect/Schema'

/** The request never produced an HTTP response: DNS, TLS, timeout, or a body that could not be read. */
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

/** HTTP 429: the organisation's per-minute, daily, or concurrency limit was reached. */
export class ZohoRateLimitError extends Schema.TaggedError<ZohoRateLimitError>()('ZohoRateLimitError', {
  operation: Schema.String,
  code: Schema.optionalKey(Schema.Number),
  detail: Schema.String,
  /** Seconds from the `Retry-After` header, when Zoho sent one. */
  retryAfterSeconds: Schema.optionalKey(Schema.Number),
}) {
  override get message(): string {
    return `Zoho request ${this.operation} was rate limited: ${this.detail}`
  }
}

/** HTTP 401 that a fresh access token did not cure, or a token that could not be obtained. */
export class ZohoUnauthorizedError extends Schema.TaggedError<ZohoUnauthorizedError>()('ZohoUnauthorizedError', {
  operation: Schema.String,
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

/** A successful response did not match the shape Zoho documents for the operation. */
export class ZohoResponseError extends Schema.TaggedError<ZohoResponseError>()('ZohoResponseError', {
  operation: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return `Zoho response for ${this.operation} did not match its documented shape: ${this.detail}`
  }
}

export type ZohoRequestError =
  | ZohoApiError
  | ZohoRateLimitError
  | ZohoResponseError
  | ZohoTransportError
  | ZohoUnauthorizedError
