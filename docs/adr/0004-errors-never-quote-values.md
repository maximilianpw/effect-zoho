# Errors never quote values, and credentials go only to exact endpoints

Errors end up in logs and traces. A decode failure therefore reports only the path of the field that broke its documented shape, never the schema issue's message, which can quote a customer's data; a token response that fails to decode reports nothing about the body, which could contain a token. And the client never sends credentials somewhere the caller did not name: a path parameter that is empty, `.` or `..` would address a different endpoint, so it fails with `ZohoInvalidRequestError` before anything is sent, and `zohoDataCenterFromAccountsServer` and `zohoDataCenterFromApiDomain` accept only an exact official origin, so a forged redirect parameter cannot route credentials elsewhere.

## Consequences

- `ZohoBooksRequest.path` is sent as given. Callers of `ZohoBooksClient` directly must URL-encode it themselves.
