# LOINC MCP Server

This is a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server. It lets MCP clients (Claude Desktop, Claude Code, Continue, etc.) query the upstream LOINC API in natural language. It is one of 100+ servers in the [Bio MCP](../../README.md) monorepo.

## Connect

The server is deployed and ready at:

```
https://loinc-mcp-server.quentincody.workers.dev/mcp
```

Add it to your MCP client (Claude Desktop → Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "loinc": {
      "command": "npx",
      "args": ["mcp-remote", "https://loinc-mcp-server.quentincody.workers.dev/mcp"]
    }
  }
}
```

For local development the server runs at `http://localhost:8874/mcp` (start it with `./scripts/dev-servers.sh loinc`):

```json
{
  "mcpServers": {
    "loinc-local": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:8874/mcp"]
    }
  }
}
```

## Tools

- `loinc_search` — discover available API operations and release-selection recipes (Code Mode catalog search)
- `loinc_execute` — **Code Mode**: write JavaScript in a V8 isolate (`api.get()` / `api.post()` / `searchSpec()`) instead of issuing tool calls one by one
- `loinc_query_data` — run SQL over large responses auto-staged into a per-session SQLite database
- `loinc_get_schema` — inspect the inferred schema of a staged dataset

Large responses (>30KB) are auto-staged into a queryable SQLite database; the tools return a `data_access_id` you can query with SQL.

Every tool returns both a human-readable `content` summary and a structured `structuredContent` payload.

## Upstream tiers

LOINC content reaches this server over FHIR R4 from one of two tiers. The tier is
resolved at startup from the environment, and every result carries
`_meta.loinc_tier`, `_meta.loinc_base_url` and (when the server reports one)
`_meta.loinc_version`, so a caller always knows which upstream answered.

| Tier | Base URL | When it is used |
| --- | --- | --- |
| `keyless:tx.fhir.org` | `https://tx.fhir.org/r4` | Default. No credential configured. |
| `keyless:ontoserver` | `https://r4.ontoserver.csiro.au/fhir` | Failover, when the primary is unreachable or 5xxes. |
| `licensed:fhir.loinc.org` | `https://fhir.loinc.org` | `LOINC_USERNAME` **and** `LOINC_PASSWORD` are both set. |
| `override` | `LOINC_BASE_URL` | An explicit base is pinned. Failover is disabled. |

Failover happens only on a transport error or a 5xx. A 4xx keeps its answering
host and HTTP status. Read its diagnostics: a 404 can indicate an unsupported
version or resource, so it does not by itself establish code absence.

Each catalog request also accepts `upstream: "primary"`, `"tx.fhir.org"` or
`"ontoserver"`. This local selector chooses one endpoint from the configured set
and disables failover for that request. It cannot escape a licensed or override
configuration, and it is never sent to the upstream API. For example:

```js
return await api.get("/CodeSystem/$lookup", {
  upstream: "ontoserver", system: "http://loinc.org", code: "2160-0",
  version: "2.83", property: "*"
});
```

Use the catalog path and a separate parameter object. The shared Code Mode
dispatcher rejects query-bearing paths before they reach the adapter.

### Release selection and Questionnaires

LOINC announced [2.83 on August 19, 2026](https://loinc.org/news/loinc-version-2-83-release-highlights).
The [provider service update of August 27](https://loinc.org/kb/api/fhir)
changed ConceptMap/ValueSet version selection and added historical Questionnaires.
The catalog exposes the native selectors and recipes:

| Read | Selector | Verification |
| --- | --- | --- |
| `CodeSystem/$lookup` | `version: "2.83"` | Returned Parameters must establish exactly the requested LOINC version. |
| `CodeSystem/$validate-code` | `url: "http://loinc.org"`, `code`, optional `version` | A pin requires positive validation and the same returned release. Legacy `system` is normalized to `url`; conflicting values fail locally. |
| `CodeSystem`, `ConceptMap`, `Questionnaire` search | canonical `url` plus `version` | Each returned resource must match both selectors. |
| `ValueSet/$expand` | `url` plus `valueSetVersion` | Returned ValueSet definition version must match. |
| `ValueSet/$expand` | `check-system-version: "http://loinc.org\|2.83"` | Native expansion evidence must establish the underlying CodeSystem release. `system-version` receives the same strict verification here; a request echo is insufficient. |
| `Questionnaire/{id}` | Provider resource ID | Retains the provider's resource version; use search for historical selection. |

An empty search is not proof of version availability. A host that ignores a pin
or omits the required version produces an error rather than an unverified result.
Version selection survives keyless failover. Native checks on October 4, 2026
established 2.83 and pinned 2.82 lookup/validation on Ontoserver. tx.fhir.org
defaults to 2.82 and rejects a 2.83 lookup with 422; that response does not trigger
failover. Its negative 2.83 validation echoes the requested version even though
the release is unavailable. The adapter retains that native result in a 409
verification error instead of reporting the echoed release as observed.
Some named ValueSets lack historical versions; see the
[provider's collection and version restrictions](https://loinc.org/kb/api/fhir/valueset).

`_meta.loinc_version` (or `loinc_versions` for multiple reported releases) is
derived from the returned CodeSystem/lookup or expansion evidence.
ValueSet, ConceptMap and Questionnaire versions are separate: their full resources
retain `version`, and direct resources also expose `_meta.resource_version`.
`_meta.requested_versions` records inputs, not observed releases. ConceptMap group
source/target versions and equivalence are preserved; a map release does not
establish the target terminology release. The provider documents its SNOMED maps
as historical; see [ConceptMap coverage](https://loinc.org/kb/api/fhir/conceptmap).

Full FHIR envelopes retain pagination, expansion parameters, designations, nested
Questionnaire items, contained answer lists and skip logic. Responses over 30 KiB
stage through the shared data tools, including large composed results and errors.
SQL projections retain `native_json`, source paths and parent paths; `response_context`
keeps root metadata, pagination and expansion totals. Questionnaire item and contained
resource tables are covered by fixtures; positive licensed native data remains pending.
Responses over 2 MiB, partial HTTP bodies, invalid UTF-8 and bodies stalled beyond
15 seconds fail explicitly. Bounded native error bodies remain recoverable rather
than being sliced to a short diagnostic. Recipes return staging/error handles intact. Both
the usual tool names and their `mcp_` aliases are registered.

### Native acceptance — October 4, 2026

- Ontoserver lists 12 LOINC CodeSystem versions; tx.fhir.org lists 2. Native lookup
  properties and designations survive both inline and staged MCP responses.
- A creatinine expansion on Ontoserver reports 4,011 matches. The bounded 500-term
  page and offset continuation preserve total, version evidence and partial-coverage
  metadata. tx.fhir.org's tested expansion omits a total; the server does not invent one.
- Both mirrors expand answer list `LL1162-8`. Tested group `LG51018-6` expansion is
  unavailable, and the tested 2.83 ChEBI ConceptMap search returns an empty Bundle.
  Neither result establishes complete LOINC collection or mapping coverage.
- Both 2.82/2.83 Questionnaire searches and the tested detail fail on public mirrors
  (tx.fhir.org 404; Ontoserver 400). The licensed endpoint returns 401 without credentials.
  Positive historical Questionnaire and licensed group/map acceptance remain pending.
- Code validation uses the [FHIR R4 type-level `url` parameter](https://hl7.org/fhir/R4/codesystem-operation-validate-code.html).
  A valid code does not by itself establish active status; retain native `result` and issues.

Native receipts, full MCP proof/recovery checks and validation logs are recorded in
`scratch/2026-10-04-loinc/`. These are bounded local acceptance checks, not a deployment
or exhaustive release/terminology coverage claim.

### Historical keyless observations

**What the keyless tier serves:** the full LOINC CodeSystem (2.82 as of
2026-08-27 on both mirrors) — `$lookup`, `$validate-code`, `$subsumes`,
`ValueSet/$expand` (keyword search across LOINC and expansion of a known
answer-list URL), `CodeSystem` search and `/metadata`.

**The two keyless mirrors are not equivalent.** Measured 2026-08-27,
`$lookup?system=http://loinc.org&code=2160-0&property=*`:

| Mirror | `property` parts | Distinct property codes |
| --- | --- | --- |
| `tx.fhir.org` | 25 | 15 — COMPONENT, PROPERTY, TIME_ASPCT, SYSTEM, SCALE_TYP, CLASS, CLASSTYPE, STATUS, ORDER_OBS, `parent`, `inactive`, EXAMPLE_UNITS, EXAMPLE_UCUM_UNITS, UNITSREQUIRED, RELATEDNAMES2 (×11) |
| `r4.ontoserver.csiro.au` | 12 | 12 — the same set **minus** EXAMPLE_UNITS, UNITSREQUIRED and RELATEDNAMES2 |

The 25-property figure belongs to `tx.fhir.org` alone. On a failover the three
missing properties are absent because Ontoserver does not serve them, not
because the code lacks them — `_meta.loinc_tier` on the result says which mirror
answered, and the Code Mode catalog carries the same warning so the model sees
it.

**What degrades without a credential** (verified live against both keyless
servers, and marked in the Code Mode catalog so the model sees it):

- `ConceptMap/$translate` — both mirrors answer HTTP 200 with `result=false`
  (`tx.fhir.org`: "No ConceptMap is available to translate from
  http://loinc.org"; Ontoserver: "No mappings could be found"). The LOINC/SNOMED
  cooperative maps are not loaded on either.
- `ConceptMap` search — neither keyless server indexes LOINC ConceptMaps.
- `ValueSet` search by a `loinc.org/vs` canonical — neither mirror reaches the
  LOINC answer-list catalogue: `tx.fhir.org` returns a Bundle with `total 0`,
  Ontoserver returns `total 1` (only `http://loinc.org/2.82/vs`, the all-codes
  value set). Expanding a known answer-list URL with `ValueSet/$expand` works.

### What the citation can and cannot say

`loinc_execute` results carry a verifiable `_meta.citation`. Its
`source` names the tier, and **it names a host only when exactly one host can
answer** (licensed, or a pinned `LOINC_BASE_URL`). With the keyless failover set
the descriptor lists both candidate tiers and carries **no `url`**, because it
would otherwise assert a host that may not have answered.

That limit is structural, not an oversight. `createExecuteTool` in
`@bio-mcp/shared` takes one `SourceDescriptor` at registration and issues one
citation per `_execute` call, and it never sees the adapter's per-request
result — so there is no seam to thread the answering endpoint back through. One
`_execute` program can also issue many upstream calls that different mirrors
answer, so "the answering host" is not single-valued for one citation anyway.

Per-call attribution therefore lives on each result instead:
`_meta.loinc_tier` and `_meta.loinc_base_url` are stamped by the adapter onto
the resource the isolate receives, inside the bytes the citation's
`result_hash` covers. Read those, not `source.url`, to learn which mirror
answered a given call.

### Shared-package dependency

`src/lib/http.ts` passes `deadlineMs` to `restFetch`, which gives each endpoint
a bounded per-endpoint budget (12 s with failover; 30 s for a pinned endpoint)
so the failover candidate still gets a turn. Code Mode allows 90 s for execution
and staging. `deadlineMs` is a `@bio-mcp/shared` option. Servers resolve
`@bio-mcp/shared` to `dist/`, so **run `pnpm --filter @bio-mcp/shared run build`
before deploying this server**; a stale `dist` ignores the option silently and
each endpoint can burn its full retry budget instead of failing over in time.

### Upgrading to the licensed tier

`fhir.loinc.org` sits behind an Authelia forward-auth proxy that offers HTTP
Basic. Sign up for a free LOINC account, then set the credentials as Worker
**secrets** (never as `vars` — an empty-string var is indistinguishable from a
real credential at a glance):

```bash
cd servers/loinc-mcp-server
npx wrangler secret put LOINC_USERNAME   # your loinc.org account e-mail
npx wrangler secret put LOINC_PASSWORD
npx wrangler secret list                 # confirm both are present
```

With both set, the server talks only to `https://fhir.loinc.org` with a
`Authorization: Basic` header and does not fall back to the keyless mirrors — a
401 there is reported as a 401, not papered over. To point at a different FHIR
terminology server instead, set the `LOINC_BASE_URL` var.

## Development

```bash
./scripts/dev-servers.sh loinc            # run locally (port 8874)
pnpm --filter loinc-mcp-server run deploy   # deploy to Cloudflare Workers
```

See [`docs/adding-mcp-servers.md`](../../docs/adding-mcp-servers.md) and the root [README](../../README.md) for the full architecture (Code Mode, staging, portals).

---

*Auto-generated baseline README — refine with server-specific detail as needed.*

<!-- license-and-data-terms:start -->
## License and data terms

The code in this repository is licensed under the Apache License 2.0 (see `LICENSE`).
If you use it in your work, please cite it (see `CITATION.cff`). Citation is requested, not required.

The license covers the code only. Data that this server returns comes from LOINC (FHIR terminology) and stays under the terms of that source: Free incl. commercial; attribution, no modification, no competing standard.
You are responsible for your use of the data under those terms.
<!-- license-and-data-terms:end -->
