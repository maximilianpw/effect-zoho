# Requests are encoded the way Zoho reads them

Zoho documents list filters as comma-separated text and takes structured query values as JSON text, so a list of scalars is joined with commas and anything else structured is sent as JSON. Zoho takes a file together with its record as multipart, with the record as JSON text in a `JSONString` field; a few uploads that Zoho documents as JSON bodies are sent as multipart too, because a file can only travel that way. `JSONString` follows Zoho's long-standing convention but is not in the v3 documents, and has not been checked against the live API.

## Consequences

- Zoho checks an upload's file-name extension, so `ZohoFile` bytes carry a `fileName`. A `File` carries its own, and a bare `Blob` is sent as `blob`.
