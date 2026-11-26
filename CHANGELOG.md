# Changelog

## 0.1.0

First release.

- A typed Effect function for each of the 885 operations in Zoho's Books API v3
  documents, with `.raw` and `.binary` forms, in 45 modules.
- `ZohoAccessToken` for refresh-token, static or custom token sources, with one retry
  after a 401 that does not spend Zoho's token allowance on a permission error.
- `ZohoOAuth` for the consent flow, including Self Client codes.
- One `ZohoError` with seven tagged reasons, and a tracing span per call.
- Multipart uploads, file downloads and `paginate`.
- Response decoding that treats `""`, `null` and a missing field alike, returns amounts
  as numbers, and corrects the documents where a live organisation showed them wrong.
- `bun run smoke`, which checks the client against a real organisation.
