import type { LoincEndpoint } from "./http";
import { fail } from "./response";

/** Normalize version selectors before dispatch; duplicate controls are ambiguous. */
export function loincRequest(inputPath: string, inputParams: Record<string, unknown> | undefined, configured: LoincEndpoint[]) {
  if (!inputPath.startsWith("/") || inputPath.startsWith("//") || /[#\\]/.test(inputPath)) fail("Use a relative catalog path without fragments");
  const split = inputPath.indexOf("?");
  const path = (split < 0 ? inputPath : inputPath.slice(0, split)).replace(/\/$/, "");
  if (!/^\/(?:metadata|(?:CodeSystem|ValueSet|ConceptMap|Questionnaire)(?:\/(?:\$[a-z-]+|[A-Za-z0-9.-]+))?)$/.test(path) || path.endsWith("/..") || path.endsWith("/.")) fail("Unsupported LOINC catalog path", 404);
  const params = { ...inputParams };
  for (const [key, value] of new URLSearchParams(split < 0 ? "" : inputPath.slice(split + 1))) {
    if (Object.keys(params).includes(key)) fail(`Duplicate query parameter ${key}`);
    params[key] = value;
  }
  if (path === "/CodeSystem/$validate-code" && params.system !== undefined) {
    if (params.url !== undefined && params.url !== params.system) fail("Validation url and legacy system alias must agree");
    params.url = params.system;
    delete params.system;
  }
  const upstream = params.upstream;
  delete params.upstream;
  let endpoints = configured;
  if (upstream !== undefined) {
    if (upstream === "primary") endpoints = configured.slice(0, 1);
    else {
      const base = upstream === "tx.fhir.org" ? "https://tx.fhir.org/r4" : upstream === "ontoserver" ? "https://r4.ontoserver.csiro.au/fhir" : undefined;
      if (!base) fail("upstream must be primary, tx.fhir.org or ontoserver");
      endpoints = configured.filter(endpoint => endpoint.baseUrl === base);
      if (!endpoints.length) fail("Requested upstream is outside the configured endpoint set");
    }
  }
  for (const name of ["count", "offset", "_count"]) if (params[name] !== undefined) {
    const value = params[name];
    if (!["string", "number"].includes(typeof value) || String(value).trim() === "" || !Number.isSafeInteger(Number(value)) || Number(value) < 0) fail(`${name} must be a non-negative safe integer`);
  }
  return { path, params, endpoints };
}
