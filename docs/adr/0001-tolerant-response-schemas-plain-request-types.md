# Responses are tolerant schemas; requests are plain types

Zoho's OpenAPI documents are not exact about types: a field documented as a string can arrive as a number, an unset number or boolean can arrive as `""`, and a documented list can arrive as one value or as nothing. Every response is therefore decoded through the codecs in `src/internal/wire.ts`, which accept what Zoho sends and always produce the documented type, with `null` for an unset scalar and every documented property optional and nullable. Requests are plain TypeScript types with no runtime check, because the data is the caller's own.

## Consequences

- An identifier sent as a JSON number beyond 2^53 has already lost digits, so `Str` fails on it rather than turning it into a string that names a different record.
- A response documented as nothing but Zoho's result code and message keeps every other field Zoho sends (`Schema.StructWithRest`), since its document says nothing about the payload.
- A value documented without a type, or as an object without properties, decodes as `unknown`.
