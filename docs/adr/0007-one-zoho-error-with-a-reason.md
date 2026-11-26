# Every call fails with one ZohoError that carries a reason

Every operation, OAuth call and raw client call fails with `ZohoError`, which carries the `operation` (Zoho's `operationId`, or `oauth.<name>` for a token call) and a tagged `reason`, rather than a union of error classes per call. One error type keeps 885 generated signatures readable and lets callers use Effect 4's `catchReason`, `catchReasons` and `unwrapReason` to handle one reason, several, or all of them in the error channel.

## Consequences

- A `ZohoOAuthError` reason on an API call means no access token could be obtained for it.
- Adding a reason is a breaking change for callers that match the reasons exhaustively.
