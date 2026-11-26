import * as Schema from 'effect/Schema'

export class ZohoTransportError extends Schema.TaggedError<ZohoTransportError>()('ZohoTransportError', {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return 'no response was read'
  }
}

export class ZohoApiError extends Schema.TaggedError<ZohoApiError>()('ZohoApiError', {
  status: Schema.Number,
  code: Schema.optionalKey(Schema.Number),
  detail: Schema.String,
}) {
  override get message(): string {
    return `HTTP ${this.status}${this.code === undefined ? '' : ` (code ${this.code})`}: ${this.detail}`
  }
}

export class ZohoRateLimitError extends Schema.TaggedError<ZohoRateLimitError>()('ZohoRateLimitError', {
  code: Schema.optionalKey(Schema.Number),
  detail: Schema.String,
  retryAfterSeconds: Schema.optionalKey(Schema.Number),
}) {
  override get message(): string {
    return `rate limited: ${this.detail}`
  }
}

export class ZohoUnauthorizedError extends Schema.TaggedError<ZohoUnauthorizedError>()('ZohoUnauthorizedError', {
  code: Schema.optionalKey(Schema.Number),
  detail: Schema.String,
}) {
  override get message(): string {
    return `not authorised: ${this.detail}`
  }
}

export class ZohoOAuthError extends Schema.TaggedError<ZohoOAuthError>()('ZohoOAuthError', {
  error: Schema.String,
}) {
  override get message(): string {
    return `the OAuth grant was refused: ${this.error}`
  }
}

export class ZohoResponseError extends Schema.TaggedError<ZohoResponseError>()('ZohoResponseError', {
  detail: Schema.String,
}) {
  override get message(): string {
    return `the response did not match its documented shape: ${this.detail}`
  }
}

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

export class ZohoError extends Schema.TaggedError<ZohoError>()('ZohoError', {
  operation: Schema.String,
  reason: ZohoErrorReason,
}) {
  override get message(): string {
    return `Zoho request ${this.operation} failed: ${this.reason.message}`
  }
}
