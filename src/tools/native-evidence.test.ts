import { verifyCitationEnvelope } from "@bio-mcp/shared";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ RpcTarget: class {}, DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} } }));

import { fixture, recover } from "./staging-fixture";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function invoke(f: ReturnType<typeof fixture>, name: string, args: unknown, failed = false) {
  const result = await f.tools[name].handler(args, {});
  expect(result.isError === true, JSON.stringify(result).slice(0, 500)).toBe(failed);
  const sc = result.structuredContent;
  const id = sc.staged ? sc.data_access_id : sc.data?.__staged ? sc.data.data_access_id : undefined;
  const staged = id ? await recover(f, id, "") : undefined;
  const proof = await verifyCitationEnvelope({ citation: sc._meta?.citation, structuredContent: sc, toolArguments: args,
    ...(staged ? { materialized: { value: staged } } : {}) });
  expect(proof.verification).toMatchObject({ query: "verified", result: "verified" });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(30720);
  return { sc, id, data: sc.staged ? staged.structuredContent.data : sc.data?.__staged ? staged : sc.data };
}

it.each(["", "mcp_"])("verifies every %s alias and preserves complete errors", async prefix => {
  const f = fixture();
  try {
    await invoke(f, `${prefix}loinc_search`, { query: "version" });
    await invoke(f, `${prefix}loinc_execute`, { code: "return {value:'001'};" });
    await invoke(f, `${prefix}loinc_execute`, { code: "" }, true);
    await invoke(f, `${prefix}loinc_query_data`, { data_access_id: "missing", sql: "SELECT * FROM missing" }, true);
    await invoke(f, `${prefix}loinc_get_schema`, { data_access_id: "missing" });
  } finally { f.close(); }
});

it("recovers Questionnaire hierarchy, contained answer lists and source resource versions", async () => {
  const f = fixture();
  const resource = { resourceType: "Questionnaire", id: "fixture", url: "http://loinc.org/q/fixture", version: "2.83", item: [
    { linkId: "001", type: "group", text: "α😀".repeat(7000), item: [{ linkId: "002", type: "choice", answerValueSet: "#answers", enableWhen: [{ question: "001", operator: "=", answerBoolean: true }] }] },
  ], contained: [{ resourceType: "ValueSet", id: "answers", version: "2.82", compose: { include: [{ system: "http://loinc.org", concept: [{ code: "LA1-1", display: "No", extension: [{ url: "score", valueDecimal: 0 }] }] }] } }] };
  const raw = { resourceType: "Bundle", total: 2, link: [{ relation: "next", url: "https://tx.fhir.org/r4/Questionnaire?_getpages=fixture" }], entry: [{ fullUrl: "http://loinc.org/q/fixture", resource }] };
  vi.stubGlobal("fetch", async () => Response.json(raw));
  try {
    const result = await invoke(f, "loinc_execute", { code: 'return await api.get("/Questionnaire", {url:"http://loinc.org/q/fixture",version:"2.83"});' });
    expect(result.id).toBeTruthy(); expect(result.data).toMatchObject(raw);
    expect(result.sc._meta.completeness.complete).toBe(false);
    const projected = await invoke(f, "mcp_loinc_query_data", { data_access_id: result.id, sql: "SELECT source_path,parent_path,resource_source_path,linkId,typeof(linkId) AS kind,native_json FROM questionnaire_items WHERE linkId='002'" });
    expect(projected.data.rows[0]).toMatchObject({ source_path: "/entry/0/resource/item/0/item/0", parent_path: "/entry/0/resource/item/0", resource_source_path: "/entry/0/resource", linkId: "002", kind: "text" });
    expect(JSON.parse(projected.data.rows[0].native_json)).toEqual(resource.item[0].item[0]);
    const contained = await invoke(f, "loinc_query_data", { data_access_id: result.id, sql: "SELECT native_json,resource_source_path FROM contained_resources" });
    expect(JSON.parse(contained.data.rows[0].native_json)).toEqual(resource.contained[0]);
    const context = await invoke(f, "loinc_query_data", { data_access_id: result.id, sql: "SELECT native_json FROM response_context" });
    expect(JSON.parse(context.data.rows[0].native_json)).toMatchObject({ total: 2, link: raw.link, _meta: { requested_versions: { version: "2.83" } } });
    const bundle = await invoke(f, "loinc_query_data", { data_access_id: result.id, sql: "SELECT native_json,resource_version FROM value_sets" });
    expect(JSON.parse(bundle.data.rows[0].native_json)).toEqual(raw.entry[0]); expect(bundle.data.rows[0].resource_version).toBe("2.83");
  } finally { f.close(); }
});

it("retains nested expansion codes, designations and unknown total without flattening away parents", async () => {
  const f = fixture();
  const node = { system: "http://loinc.org", code: "001", display: "Parent", contains: [{ system: "http://loinc.org", code: "002", designation: [{ language: "fr", value: "Enfant" }] }] };
  const data = { resourceType: "ValueSet", url: "http://loinc.org/vs/fixture", expansion: { offset: 5, parameter: [{ name: "used-codesystem", valueUri: "http://loinc.org|2.83" }], contains: [node] }, note: "α".repeat(17000) };
  try {
    const result = await invoke(f, "loinc_execute", { code: `return ${JSON.stringify(data)};` });
    expect(result.sc.staged).toBe(true); expect(result.data).toEqual(data);
    const rows = await invoke(f, "loinc_query_data", { data_access_id: result.id, sql: "SELECT code,parent_path,native_json FROM codes ORDER BY source_path" });
    expect(rows.data.rows.map((r: { code: string }) => r.code)).toEqual(["001", "002"]);
    expect(rows.data.rows[1].parent_path).toBe("/expansion/contains/0");
    expect(JSON.parse(rows.data.rows[1].native_json)).toEqual(node.contains[0]);
  } finally { f.close(); }
});

it("retains complete native error bytes through error and SQL staging", async () => {
  const f = fixture();
  const native = { resourceType: "OperationOutcome", issue: [{ severity: "error", code: "not-found", diagnostics: "unavailable α".repeat(7000) }] };
  vi.stubGlobal("fetch", async () => Response.json(native, { status: 404 }));
  try {
    const result = await invoke(f, "mcp_loinc_execute", { code: 'return await api.get("/Questionnaire/55757-9");' }, true);
    expect(result.data).toMatchObject({ __api_error: true, status: 404 });
    const evidence = result.data.data.__staged ? await recover(f, result.data.data.data_access_id, "") : result.data.data;
    expect(evidence.response).toBe(JSON.stringify(native)); expect(evidence.loinc_tier).toBe("keyless:tx.fhir.org");
  } finally { f.close(); }
});
