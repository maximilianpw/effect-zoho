# Changelog

## 0.2.0

- **Breaking:** `ZohoTransportError` no longer carries the original failure as `cause`.
  An HTTP client error holds the request, whose URL, headers and body can contain
  tokens and the client secret. It now has `kind` (`timeout`, `request` or `body`) and,
  when the failure has a plain name, `causeName`.
- A token request refused with an HTTP error status reports Zoho's `error`, such as
  `invalid_client`, instead of only `HTTP 400`.
- A result code sent as text, such as `"0"` or `"45"`, is read as a number.

## 0.1.0

First release.

- A typed Effect function for each of the 885 operations in Zoho's Books API v3
  documents, with `.raw` and `.binary` forms, in 45 modules.
- `ZohoAccessToken` for refresh-token, static or custom token sources. After a 401 the
  client retries once with a new token, but not when the token was minted less than five
  minutes ago (`minimumReplaceAgeMillis`): such a 401 is almost always a permission
  error, and minting for it would spend Zoho's allowance of about ten tokens in ten
  minutes. A permission error on an older token still mints one replacement.
- `ZohoOAuth` for the consent flow, including Self Client codes.
- One `ZohoError` with seven tagged reasons, and a tracing span per call.
- Multipart uploads, file downloads and `paginate`.
- Response decoding that treats `""`, `null` and a missing field alike, returns amounts
  as numbers, and corrects the documents where a live organisation showed them wrong.
- `bun run smoke`, which checks the client against a real organisation.
