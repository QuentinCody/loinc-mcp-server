import { afterEach, expect, it, vi } from "vitest";
import { createLoincApiFetch } from "./api-adapter";
import { resolveLoincEndpoints } from "./http";
import { readText } from "./response";
import { reportedLoincVersions } from "./versioning";

const api = createLoincApiFetch();
const lookup = (version = "2.83") => ({ resourceType: "Parameters", parameter: [
  { name: "version", valueString: version }, { name: "code", valueCode: "2160-0" }, { name: "system", valueUri: "http://loinc.org" },
] });
const setup = (data: unknown, status = 200) => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(data, { status })); vi.stubGlobal("fetch", fetcher); return fetcher;
};
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("verifies URL-embedded version pins after trailing-slash normalization", async () => {
  setup(lookup("2.82"));
  await expect(api({ method: "GET", path: "/CodeSystem/$lookup/?system=http%3A%2F%2Floinc.org&code=2160-0&version=2.83" })).rejects.toMatchObject({ status: 409, data: { resource: lookup("2.82"), loinc_tier: "keyless:tx.fhir.org" } });
});

it.each([
  ["/CodeSystem/$lookup?version=2.82&version=2.83", {}],
  ["/CodeSystem/$lookup?version=2.82", { version: "2.83" }],
  ["/CodeSystem/$lookup#version=2.83", {}],
  ["//example.org/CodeSystem", {}],
  ["/CodeSystem/..", {}],
  ["/CodeSystem", { _count: 1.5 }],
  ["/metadata", { version: "2.83" }],
  ["/ConceptMap/$translate", { conceptMapVersion: "2.83" }],
  ["/ValueSet/$expand", { "force-system-version": "http://loinc.org|2.83" }],
])("rejects ambiguous or unsupported request controls before networking %#", async (path, params) => {
  const fetcher = setup(lookup());
  await expect(api({ method: "GET", path, params })).rejects.toMatchObject({ status: expect.any(Number) });
  expect(fetcher).not.toHaveBeenCalled();
});

it("explicitly selects only the configured Ontoserver endpoint and strips the local selector", async () => {
  const fetcher = setup(lookup());
  const result = await api({ method: "GET", path: "/CodeSystem/$lookup?upstream=ontoserver", params: { system: "http://loinc.org", code: "2160-0", version: "2.83" } });
  const url = new URL(String(fetcher.mock.calls[0][0]));
  expect(url.host).toBe("r4.ontoserver.csiro.au"); expect(url.searchParams.has("upstream")).toBe(false);
  expect(result.data).toMatchObject({ _meta: { loinc_tier: "keyless:ontoserver", loinc_version: "2.83" } });
});

it("does not let a mirror selector escape licensed endpoint configuration", async () => {
  const fetcher = setup(lookup());
  const licensed = createLoincApiFetch({ endpoints: resolveLoincEndpoints({ username: "fixture", password: "fixture" }) });
  await expect(licensed({ method: "GET", path: "/CodeSystem/$lookup", params: { upstream: "ontoserver" } })).rejects.toMatchObject({ status: 400 });
  expect(fetcher).not.toHaveBeenCalled();
});

it("keeps the primary's unsupported version response without hidden failover", async () => {
  const body = { resourceType: "OperationOutcome", issue: [{ code: "not-found", diagnostics: "version missing" }] };
  const fetcher = setup(body, 422);
  await expect(api({ method: "GET", path: "/CodeSystem/$lookup", params: { system: "http://loinc.org", version: "2.83" } })).rejects.toMatchObject({ status: 422, data: { response: JSON.stringify(body), loinc_tier: "keyless:tx.fhir.org" } });
  expect(fetcher).toHaveBeenCalledOnce();
});

it("retains complete long native errors and successful-but-invalid FHIR for diagnosis", async () => {
  const body = { resourceType: "OperationOutcome", issue: [{ code: "not-found", diagnostics: "α".repeat(7000) }] };
  setup(body, 404);
  await expect(api({ method: "GET", path: "/Questionnaire/55757-9" })).rejects.toMatchObject({ status: 404, data: { response: JSON.stringify(body) } });
  const malformed = { resourceType: "Bundle", entry: "not an array" }; setup(malformed);
  await expect(api({ method: "GET", path: "/CodeSystem" })).rejects.toMatchObject({ status: 502, data: { resource: malformed } });
});

it.each(["system", "code"])("rejects a lookup that establishes the wrong %s", async name => {
  const raw = lookup(); raw.parameter.push(name === "system" ? { name, valueUri: "http://example.org" } : { name, valueCode: "718-7" }); setup(raw);
  await expect(api({ method: "GET", path: "/CodeSystem/$lookup", params: { system: "http://loinc.org", code: "2160-0", version: "2.83" } })).rejects.toMatchObject({ status: 409 });
});

it("recognizes used-codesystem evidence but not an echoed system-version request", async () => {
  const resource = (name: string) => ({ resourceType: "ValueSet", expansion: { parameter: [{ name, valueUri: "http://loinc.org|2.83" }], contains: [] } });
  setup(resource("used-codesystem"));
  expect(await api({ method: "GET", path: "/ValueSet/$expand", params: { "check-system-version": "http://loinc.org|2.83" } })).toMatchObject({ data: { _meta: { loinc_version: "2.83" } } });
  setup(resource("system-version"));
  await expect(api({ method: "GET", path: "/ValueSet/$expand", params: { "check-system-version": "http://loinc.org|2.83" } })).rejects.toMatchObject({ status: 409 });
  expect(reportedLoincVersions({ resourceType: "CodeSystem", version: "2.83" }, "/CodeSystem", {})).toEqual([]);
});

it("terminates stalled bodies even if cancellation never settles", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const response = new Response(new ReadableStream({ pull: () => new Promise<void>(() => {}), cancel }));
  const check = expect(readText(response)).rejects.toMatchObject({ status: 504 });
  await vi.advanceTimersByTimeAsync(15_001); await check;
  expect(cancel).toHaveBeenCalledOnce(); expect(response.body?.locked).toBe(false);
});

it("normalizes legacy validation system to the standard url accepted by both mirrors", async () => {
  const raw = { ...lookup(), parameter: [...lookup().parameter, { name: "result", valueBoolean: true }] };
  const fetcher = setup(raw);
  const result = await api({ method: "GET", path: "/CodeSystem/$validate-code", params: { system: "http://loinc.org", code: "2160-0", version: "2.83", upstream: "ontoserver" } });
  const url = new URL(String(fetcher.mock.calls[0][0]));
  expect(url.searchParams.get("url")).toBe("http://loinc.org"); expect(url.searchParams.has("system")).toBe(false);
  expect(result.data).toMatchObject({ _meta: { loinc_version: "2.83" } });
});

it("rejects conflicting validation canonicals before networking", async () => {
  const fetcher = setup(lookup());
  await expect(api({ method: "GET", path: "/CodeSystem/$validate-code", params: { system: "http://loinc.org", url: "http://example.org" } })).rejects.toMatchObject({ status: 400 });
  expect(fetcher).not.toHaveBeenCalled();
});

it("never treats an echoed unavailable version in negative validation as observed release evidence", async () => {
  const raw = { ...lookup(), parameter: [...lookup().parameter, { name: "result", valueBoolean: false }, { name: "x-caused-by-unknown-system", valueCanonical: "http://loinc.org|2.83" }] };
  setup(raw);
  const result = await api({ method: "GET", path: "/CodeSystem/$validate-code", params: { url: "http://loinc.org", code: "2160-0" } });
  expect((result.data as { _meta: Record<string, unknown> })._meta.loinc_version).toBeUndefined();
  await expect(api({ method: "GET", path: "/CodeSystem/$validate-code", params: { url: "http://loinc.org", code: "2160-0", version: "2.83" } })).rejects.toMatchObject({ status: 409, data: { resource: raw } });
});

it("rejects partial HTTP 200 FHIR instead of calling it complete", async () => {
  await expect(readText(new Response('{"resourceType":"Bundle"}', { headers: { "content-range": "bytes 0-24/100" } })))
    .rejects.toMatchObject({ status: 502, data: { response: '{"resourceType":"Bundle"}' } });
});
