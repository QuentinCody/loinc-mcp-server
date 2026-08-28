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

- `loinc_search` — discover available API operations (Code Mode catalog search, 9 endpoints)
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

Failover happens only on a transport error or a 5xx. A 4xx is a real answer — a
404 `OperationOutcome` means the code is not in the release the server carries —
and reaches the caller unchanged from the endpoint that produced it.

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
a bounded slice of the isolate's 30 s budget so the failover candidate still
gets a turn. `deadlineMs` is a `@bio-mcp/shared` option. Servers resolve
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
