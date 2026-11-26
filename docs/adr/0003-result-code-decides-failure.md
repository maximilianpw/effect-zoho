# Zoho's result code, not the HTTP status, decides failure

Zoho signals failure inconsistently: its accounts server answers a refused grant with HTTP 200 and an `error` field, and a malformed request with an HTML page; a download can fail as a JSON body with HTTP 200; and its limit codes (44 per minute, 45 per day, 1070 for concurrent calls) arrive with statuses other than 429. So the client checks Zoho's own signal on every response, whatever the status: a non-zero `code` in a JSON body is a failure, a limit code is a `ZohoRateLimitError` with any status, and a token response with `error` is a `ZohoOAuthError`.

## Consequences

- A download whose content type is `application/json` is checked for a non-zero `code`, so a JSON file is still a valid download unless it carries one.
- `retryAfterSeconds` is read from a `Retry-After` header, but Zoho does not document sending one, so expect it to be absent.
- Code 45, the daily limit, is not worth retrying until the next day.
