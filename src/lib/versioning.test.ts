import { afterEach, expect, it, vi } from "vitest";
import { createLoincApiFetch } from "./api-adapter";
import { reportedLoincVersions } from "./versioning";

const api = createLoincApiFetch();
const params = { system: "http://loinc.org", code: "2160-0", version: "2.83" };
const lookup = (version = "2.83") => ({ resourceType: "Parameters", parameter: [{ name: "version", valueString: version }, { name: "property", part: [{ name: "code", valueCode: "STATUS" }, { name: "value", valueCode: "ACTIVE" }] }] });
const fhir = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/fhir+json" } });
function setup(data: unknown, status = 200) { const fn = vi.fn().mockResolvedValueOnce(fhir(data, status)); vi.stubGlobal("fetch", fn); return fn; }
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it("forwards and verifies selectable 2.83 without replacing full lookup properties", async () => {
  const raw = lookup(); const fetcher = setup(raw);
  expect(await api({ method: "GET", path: "/CodeSystem/$lookup", params })).toMatchObject({ data: { ...raw, _meta: { loinc_version: "2.83", loinc_tier: "keyless:tx.fhir.org", requested_versions: { version: "2.83" } } } });
  expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get("version")).toBe("2.83");
});
it("retains selectable historical lookup versions", async () => {
  setup(lookup("2.82"));
  expect(await api({ method: "GET", path: "/CodeSystem/$lookup", params: { ...params, version: "2.82" } })).toMatchObject({ data: { _meta: { loinc_version: "2.82" } } });
});
it.each([
  lookup("2.82"), { resourceType: "Parameters", parameter: [] },
  { resourceType: "Parameters", parameter: [...lookup().parameter, { name: "version", valueString: "2.82" }] },
  { resourceType: "CodeSystem", version: "2.83" },
])("rejects ignored, missing, conflicting or malformed lookup pins %#", async raw => {
  const fetcher = setup(raw);
  await expect(api({ method: "GET", path: "/CodeSystem/$lookup", params })).rejects.toMatchObject({ status: 409 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("does not fall through a genuine 404 or assume it establishes code absence in every release", async () => {
  const fetcher = setup({ resourceType: "OperationOutcome", issue: [{ severity: "error", code: "not-supported" }] }, 404);
  await expect(api({ method: "GET", path: "/CodeSystem/$lookup", params })).rejects.toMatchObject({ status: 404 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("preserves version selection when transport failover changes the host", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockImplementation(async (url: string) => {
    if (url.includes("tx.fhir.org")) throw new Error("unreachable");
    expect(new URL(url).searchParams.get("version")).toBe("2.83"); return fhir(lookup());
  }); vi.stubGlobal("fetch", fetcher);
  const result = api({ method: "GET", path: "/CodeSystem/$lookup", params });
  await vi.runAllTimersAsync();
  expect(await result).toMatchObject({ data: { _meta: { loinc_tier: "keyless:ontoserver", loinc_version: "2.83" } } });
});
it("retains Bundle versions and links without promoting multiple releases to one", async () => {
  const raw = { resourceType: "Bundle", total: 3, link: [{ relation: "next", url: "https://tx.fhir.org/r4/CodeSystem?_getpages=fixture" }], entry: ["2.82", "2.83"].map(version => ({ resource: { resourceType: "CodeSystem", url: "http://loinc.org", version } })) };
  setup(raw);
  expect(await api({ method: "GET", path: "/CodeSystem", params: { url: "http://loinc.org" } })).toMatchObject({ data: { ...raw, _meta: { loinc_versions: ["2.82", "2.83"] } } });
});
it("rejects version-filter mismatch or ignored canonical URL in searches", async () => {
  setup({ resourceType: "Bundle", entry: [{ resource: { resourceType: "CodeSystem", url: "http://loinc.org", version: "2.82" } }] });
  await expect(api({ method: "GET", path: "/CodeSystem", params: { url: "http://loinc.org", version: "2.83" } })).rejects.toMatchObject({ status: 409 });
});
it.each([{}, { entry: [] }])("preserves an empty version search without claiming availability %#", async entries => {
  setup({ resourceType: "Bundle", total: 0, ...entries });
  expect(await api({ method: "GET", path: "/CodeSystem", params: { url: "http://loinc.org", version: "2.83" } })).toMatchObject({ data: { total: 0, _meta: { version_note: expect.stringContaining("do not establish availability") } } });
});
it("separates ValueSet version from code-system versions and preserves the expansion envelope", async () => {
  const raw = { resourceType: "ValueSet", url: "http://loinc.org/vs/LG51018-6", version: "2.83", expansion: { identifier: "urn:uuid:fixture", timestamp: "2026-09-28", total: 20, offset: 0, parameter: [{ name: "version", valueUri: "http://loinc.org|2.82" }], contains: [{ system: "http://loinc.org", code: "2160-0", version: "2.82", designation: [{ language: "en", value: "Creatinine" }] }] } };
  const fetcher = setup(raw);
  expect(await api({ method: "GET", path: "/ValueSet/$expand", params: { url: raw.url, valueSetVersion: "2.83", count: 1 } })).toMatchObject({ data: { ...raw, _meta: { resource_version: "2.83", loinc_version: "2.82" } } });
  expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get("valueSetVersion")).toBe("2.83");
});
it("does not mislabel ConceptMap/Questionnaire/ValueSet versions as CodeSystem releases", () => {
  for (const resourceType of ["ValueSet", "ConceptMap", "Questionnaire", "CapabilityStatement"]) expect(reportedLoincVersions({ resourceType, version: "2.83" }, `/${resourceType}`, {})).toEqual([]);
});
it.each(["ConceptMap", "Questionnaire"])("retains versioned %s nested content", async resourceType => {
  const resource = { resourceType, url: "http://loinc.org/example", version: "2.83", group: [{ sourceVersion: "2.83", targetVersion: "other-release", element: [{ code: "LP1-1", target: [{ code: "x", equivalence: "narrower" }] }] }], item: [{ linkId: "1", item: [{ linkId: "2", enableWhen: [{ question: "1", operator: "=", answerBoolean: true }] }] }], contained: [{ resourceType: "ValueSet", id: "answers", version: "2.82" }] };
  setup({ resourceType: "Bundle", entry: [{ resource }] });
  expect(await api({ method: "GET", path: `/${resourceType}`, params: { url: resource.url, version: "2.83" } })).toMatchObject({ data: { entry: [{ resource }] } });
});
it("rejects ValueSet version fallback", async () => {
  setup({ resourceType: "ValueSet", version: "2.82" });
  await expect(api({ method: "GET", path: "/ValueSet/$expand", params: { valueSetVersion: "2.83" } })).rejects.toMatchObject({ status: 409 });
});
it("never turns HTTP 200 OperationOutcome or HTML auth pages into success", async () => {
  setup({ resourceType: "OperationOutcome", issue: [{ severity: "error", code: "not-supported" }] });
  await expect(api({ method: "GET", path: "/CodeSystem/$lookup", params })).rejects.toMatchObject({ status: 502 });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("<html>Sign in</html>")));
  await expect(api({ method: "GET", path: "/CodeSystem/$lookup", params })).rejects.toMatchObject({ status: 502 });
});
it.each([{ version: ["2.82", "2.83"] }, { version: 2.83 }, { version: "" }])("rejects ambiguous version inputs before networking %#", async bad => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(api({ method: "GET", path: "/CodeSystem/$lookup", params: { ...params, ...bad } })).rejects.toMatchObject({ status: 400 }); expect(fetcher).not.toHaveBeenCalled();
});
it("does not pretend POST was a GET", async () => {
  await expect(api({ method: "POST", path: "/CodeSystem/$lookup", body: { resourceType: "Parameters" } })).rejects.toMatchObject({ status: 405 });
});
it("rejects oversized FHIR without partial success", async () => {
  setup({ ...lookup(), extra: "α".repeat(1_100_000) });
  await expect(api({ method: "GET", path: "/CodeSystem/$lookup", params })).rejects.toThrow(/2MiB/);
});
