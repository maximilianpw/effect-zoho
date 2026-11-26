# The generator corrects Zoho's documents in code

`spec/books` holds Zoho's OpenAPI documents unmodified, so an update is a fresh download. Where the documents contradict the API or themselves, `scripts/generate.ts` corrects them in code. The corrections kept as tables (`undeclaredPathParameters`, `undeclaredFileParameters`, `moduleNames`, `responseKeyAliases`) must each still match the documents, or generation fails, so a fixed document does not leave a stale correction behind. Generation also fails on anything it does not handle, rather than guessing. The corrections are listed for users in the README under "How the types relate to Zoho's API".

## Consequences

- Corrections the README lists for users also cover choices that are invisible there: an update body built from a create body with `allOf` does not inherit its required fields, because what creating requires, updating does not; filter variants are taken from parameter prose only when they extend the parameter's own name, because the prose has typos; and a response schema Zoho named after a documentation heading also gets a type alias named after the operation.
- Some corrections are inferred rather than keyed to a name, and so escape the staleness check (see issues #1 and #2).
