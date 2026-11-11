import type { ApiFetchFn } from "@bio-mcp/shared/codemode/catalog";
import { type LoincEndpoint, loincFetch, LoincTier, resolveLoincEndpoints } from "./http";
import { loincRequest } from "./request";
import { fail, object, readText } from "./response";
import { validateVersionInputs, verifyFhirShape, verifyVersions } from "./versioning";

interface LoincAdapterOptions { endpoints?: LoincEndpoint[] }

export function createLoincApiFetch(opts?: LoincAdapterOptions): ApiFetchFn {
  const endpoints = opts?.endpoints ?? resolveLoincEndpoints();
  return async request => {
    const method = request.method.toUpperCase();
    if (method !== "GET" || request.body !== undefined) fail("This LOINC catalog supports GET reads without a body", 405);
    const normalized = loincRequest(request.path, request.params, endpoints);
    const { path, params } = normalized;
    validateVersionInputs(path, params);
    const { response, endpoint } = await loincFetch(path, params, { endpoints: normalized.endpoints });
    let text: string;
    try { text = await readText(response); }
    catch (error) {
      const failure = error as Error & { status?: number; data?: unknown };
      fail(failure.message, failure.status ?? 502, { loinc_tier: endpoint.tier, loinc_base_url: endpoint.baseUrl, path, params, body_error: failure.data });
    }
    const evidence = { response: text, http_status: response.status, content_type: response.headers.get("content-type"), loinc_tier: endpoint.tier, loinc_base_url: endpoint.baseUrl, path, params };
    if (!response.ok) fail(`HTTP ${response.status} from ${endpoint.tier}`, response.status, evidence);
    let resource: Record<string, unknown>;
    try { resource = object(JSON.parse(text)); }
    catch { fail(`Non-JSON FHIR response from ${endpoint.tier}`, 502, evidence); }
    if (typeof resource.resourceType !== "string") fail(`Missing FHIR resource type from ${endpoint.tier}`, 502, evidence);
    if (resource.resourceType === "OperationOutcome") fail(`FHIR OperationOutcome from ${endpoint.tier}`, 502, { ...evidence, resource });
    return buildVersionedResource(resource, path, params, evidence, response, endpoint);
  };
}

function buildVersionedResource(resource: Record<string, unknown>, path: string, params: { [x: string]: unknown; }, evidence: { response: string; http_status: number; content_type: string | null; loinc_tier: LoincTier; loinc_base_url: string; path: string; params: { [x: string]: unknown; }; }, response: Response, endpoint: LoincEndpoint) : Awaited<ReturnType<ApiFetchFn>> {
  let versions: string[];
  try { versions = verifyVersions(resource, path, params); verifyFhirShape(resource, path); }
  catch (error) {
    const failure = error as Error & { status?: number; data?: unknown; };
    fail(failure.message, failure.status ?? 502, { ...evidence, resource, verification: failure.data });
  }
  const existing = resource._meta && typeof resource._meta === "object" && !Array.isArray(resource._meta) ? resource._meta as Record<string, unknown> : {};
  return {
    status: response.status, data: {
      ...resource, _meta: {
        ...Object.fromEntries(Object.entries(existing).filter(([key]) => !["loinc_version", "loinc_versions", "resource_version"].includes(key))), loinc_tier: endpoint.tier, loinc_base_url: endpoint.baseUrl,
        ...(versions.length === 1 ? { loinc_version: versions[0] } : versions.length > 1 ? { loinc_versions: versions } : {}),
        ...(["ValueSet", "ConceptMap", "Questionnaire"].includes(String(resource.resourceType)) && typeof resource.version === "string" ? { resource_version: resource.version } : {}),
        ...(Object.keys(params).some(key => ["version", "valueSetVersion", "system-version", "check-system-version"].includes(key)) ? {
          requested_versions: { version: params.version, valueSetVersion: params.valueSetVersion, "system-version": params["system-version"], "check-system-version": params["check-system-version"] },
          version_note: "Requested versions are not observed releases. Lookup/resource pins are checked against returned versions. Empty search results do not establish availability. ValueSet/ConceptMap/Questionnaire versions are distinct from code-system versions.",
        } : {}),
      }
    }
  };
}
