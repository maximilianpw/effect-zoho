# Replace an access token after a 401 only when it is old enough

Zoho answers an expired token and a missing scope, role, organisation or data centre with the same HTTP 401 (result code 14 for a missing or malformed token, 57 for a token or permission it does not accept), and one refresh token can mint only about 10 access tokens in 10 minutes and hold 15 live ones. The client retries a 401 once with a replacement from `ZohoAccessToken.replace`, but the built-in service refuses to replace a token minted less than `minimumReplaceAgeMillis` (5 minutes) ago: a rejection that soon is almost certainly about permissions, and minting on each one would spend the quota and lock every caller out.

## Considered Options

- Retry every 401 with a fresh token: cures expiry, but turns a permissions error under load into a quota lockout.
- Never retry: every early revocation or clock skew surfaces as a failure.

## Consequences

- `replace` returns the current token when it already differs from the rejected one, so a burst of 401s mints once. A replacement equal to the rejected token is ignored.
- A refused grant (`ZohoOAuthError`) is remembered for 5 seconds so a burst of callers does not repeat it.
- The refresh runs uninterruptibly, so a caller interrupted mid-refresh does not waste a minted token.
- Each process holds its own token. Many short-lived processes should share tokens through their own `ZohoAccessToken` service.
- `ZohoOAuth.authorizationUrl` defaults `access_type` to `offline`, because Zoho issues a refresh token only on the first consent unless `prompt` is `consent`.
