import { McpServer } from "@bio-mcp/shared/mcp";
import { createApiProxyTool } from "@bio-mcp/shared/tools/api-proxy";
import { afterEach, expect, it, vi } from "vitest";
import { createLoincApiFetch } from "../lib/api-adapter";
import { resolveLoincEndpoints } from "../lib/http";
import { loincCatalogFor } from "../spec/catalog";
import { registerCodeMode } from "./code-mode";
import { registerGetSchema } from "./get-schema";
import { registerQueryData } from "./query-data";

afterEach(() => vi.unstubAllGlobals());
const catalog = loincCatalogFor(resolveLoincEndpoints()[0]);
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "content-type": "application/fhir+json" } });
it("registers both aliases and discovers versioned questionnaires with both-fields contracts", async () => {
  const server = new McpServer({ name: "fixture", version: "1" });
  registerCodeMode(server, { CODE_MODE_LOADER: { get: () => ({}) } } as unknown as Parameters<typeof registerCodeMode>[1]);
  registerQueryData(server, {}); registerGetSchema(server, {});
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }> })._registeredTools;
  for (const name of ["loinc_search", "loinc_execute", "loinc_query_data", "loinc_get_schema"]) {
    expect(tools[name]).toBeDefined(); expect(tools[`mcp_${name}`]).toBeDefined();
  }
  const result = await tools.mcp_loinc_search.handler({ query: "versioned LOINC Questionnaire", category: "workflows", max_results: 5 }, {});
  expect(result).toMatchObject({ content: expect.any(Array), structuredContent: { success: true } });
  expect(JSON.stringify(result)).toContain("89689-4");
  expect(await tools.mcp_loinc_query_data.handler({ data_access_id: "loinc_fixture", sql: "SELECT 1" }, {})).toMatchObject({ isError: true, content: expect.any(Array), structuredContent: expect.any(Object) });
  expect(catalog.endpointCount).toBe(catalog.endpoints.length);
});
it("stages a full Questionnaire with nested items, answer lists and observed versions intact", async () => {
  const resource = { resourceType: "Questionnaire", url: "http://loinc.org/q/89689-4", version: "2.83", item: [{ linkId: "1", text: "α".repeat(17_000), item: [{ linkId: "2", enableWhen: [{ question: "1", operator: "=", answerBoolean: true }], answerValueSet: "#answers" }] }], contained: [{ resourceType: "ValueSet", id: "answers", version: "2.82" }] };
  const raw = { resourceType: "Bundle", total: 1, entry: [{ resource }] };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json(raw)));
  const stored: unknown[] = [];
  const namespace = { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => {
    if (new URL(request.url).pathname === "/process") {
      stored.push((await request.json() as { data: unknown }).data);
      return json({ success: true, tables_created: ["entry"], total_rows: 1, input_rows: 1, table_row_counts: { entry: 1 } });
    }
    return json({ success: true, schema: { tables: { entry: { columns: [{ name: "resource" }] } } } });
  } }) } as unknown as DurableObjectNamespace;
  const proxy = createApiProxyTool({ apiFetch: createLoincApiFetch(), catalog, doNamespace: namespace, stagingPrefix: "loinc", maxInlineBytes: 30 * 1024 });
  const result = await proxy.handler({ method: "GET", path: "/Questionnaire", params: { url: resource.url, version: "2.83" } }, { sql: () => [] });
  expect(result).toMatchObject({ __staged: true, data_access_id: expect.any(String) });
  expect(JSON.parse(stored[0] as string)).toMatchObject({ ...raw, _meta: { loinc_tier: "keyless:tx.fhir.org", requested_versions: { version: "2.83" } } });
  expect(stored[1]).toMatchObject(raw);
  expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(30_000);
});
it.each([{ __api_error: true, status: 409 }, { __staged: true, data_access_id: "loinc_fixture" }, { __stage_error: true, message: "staging unavailable" }])("recipes preserve error and staging handles %#", async handle => {
  for (const workflow of catalog.workflows!) {
    const run = new Function("api", `return (async () => { ${workflow.code} })()`);
    expect(await run({ get: vi.fn().mockResolvedValue(handle) })).toEqual(handle);
  }
});
it("version mismatch survives canonical proxy handling", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ resourceType: "Parameters", parameter: [{ name: "version", valueString: "2.82" }] })));
  const proxy = createApiProxyTool({ apiFetch: createLoincApiFetch(), catalog, stagingPrefix: "loinc", maxInlineBytes: 30 * 1024 });
  expect(await proxy.handler({ method: "GET", path: "/CodeSystem/$lookup", params: { system: "http://loinc.org", code: "2160-0", version: "2.83" } }, { sql: () => [] })).toMatchObject({ __api_error: true, status: 409, incomplete: true });
});
