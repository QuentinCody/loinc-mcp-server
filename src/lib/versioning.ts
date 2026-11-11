import { fail, object } from "./response";

type Data = Record<string, unknown>;
const system = "http://loinc.org";
const asObject = (value: unknown): Data | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Data : undefined;
function parameters(resource: Data, name: string): string[] {
  if (!Array.isArray(resource.parameter)) return [];
  return resource.parameter.flatMap(value => {
    const item = asObject(value);
    if (item?.name !== name) return [];
    const valueString = item.valueString ?? item.valueUri ?? item.valueCanonical ?? item.valueCode;
    return typeof valueString === "string" ? [valueString] : [];
  });
}
/** Resource versions are not automatically the LOINC CodeSystem release. */
export function reportedLoincVersions(resource: Data, path: string, params: Data): string[] {
  const versions = new Set<string>();
  const validated = path === "/CodeSystem/$validate-code" && Array.isArray(resource.parameter) && resource.parameter.some(value => {
    const item = asObject(value); return item?.name === "result" && item.valueBoolean === true;
  });
  if (resource.resourceType === "Parameters" && (path === "/CodeSystem/$lookup" && params.system === system || validated && params.url === system) && parameters(resource, "system").every(value => value === system)) {
    for (const version of parameters(resource, "version")) versions.add(version);
  }
  if (resource.resourceType === "CodeSystem" && resource.url === system && typeof resource.version === "string") versions.add(resource.version);
  if (resource.resourceType === "ValueSet") {
    const expansion = asObject(resource.expansion);
    for (const name of ["version", "used-codesystem"]) for (const value of parameters(expansion ?? {}, name)) {
      if (value.startsWith(`${system}|`)) versions.add(value.slice(system.length + 1));
    }
    const walk = (nodes: unknown) => {
      if (!Array.isArray(nodes)) return;
      for (const value of nodes) {
        const item = asObject(value);
        if (item?.system === system && typeof item.version === "string") versions.add(item.version);
        if (item) walk(item.contains);
      }
    };
    walk(expansion?.contains);
  }
  if (resource.resourceType === "Bundle" && Array.isArray(resource.entry)) for (const value of resource.entry) {
    const item = asObject(asObject(value)?.resource);
    if (item?.resourceType === "CodeSystem" && item.url === system && typeof item.version === "string") versions.add(item.version);
  }
  return [...versions];
}
export function validateVersionInputs(path: string, params: Data) {
  for (const key of ["version", "valueSetVersion", "conceptMapVersion"]) if (params[key] !== undefined && (typeof params[key] !== "string" || !params[key] || String(params[key]).length > 100)) fail(`${key} must be an explicit nonempty version string`);
  if (path === "/ValueSet/$expand" && params.version !== undefined) fail("Use valueSetVersion for the ValueSet definition; system-version for an underlying CodeSystem");
  if (params.version !== undefined && !["/CodeSystem/$lookup", "/CodeSystem/$validate-code"].includes(path) && !/^\/(?:CodeSystem|ConceptMap|Questionnaire)(?:\/[A-Za-z0-9.-]+)?$/.test(path)) fail("version is not supported on this route");
  if (params.valueSetVersion !== undefined && !/^\/ValueSet(?:\/(?:\$expand|[A-Za-z0-9.-]+))?$/.test(path)) fail("valueSetVersion is only supported on ValueSet reads");
  if (params.conceptMapVersion !== undefined) fail("Use ConceptMap search with version to verify a map release; translate does not establish that pin here");
  for (const key of ["system-version", "check-system-version"]) if (params[key] !== undefined) {
    if (path !== "/ValueSet/$expand" || typeof params[key] !== "string" || !/^http:\/\/loinc\.org\|[^\s|]{1,100}$/.test(params[key] as string)) fail(`${key} requires a ValueSet expansion and http://loinc.org|<release>`);
  }
  if (params["force-system-version"] !== undefined) fail("force-system-version is not supported; retain the ValueSet's definition");
}
export function verifyVersions(resource: Data, path: string, params: Data) {
  const reported = reportedLoincVersions(resource, path, params);
  if (["/CodeSystem/$lookup", "/CodeSystem/$validate-code"].includes(path)) for (const key of ["system", "code"]) {
    const expected = key === "system" && path.endsWith("$validate-code") ? params.url : params[key];
    if (expected !== undefined && parameters(resource, key).some(value => value !== expected)) fail(`CodeSystem operation returned a different ${key}`, 409);
  }
  for (const key of ["system-version", "check-system-version"]) if (params[key] !== undefined) {
    const expected = String(params[key]).slice(system.length + 1);
    if (resource.resourceType !== "ValueSet" || reported.length !== 1 || reported[0] !== expected) fail("Answering server did not establish the requested expansion CodeSystem version", 409, { requested_version: expected, reported_versions: reported });
  }
  if (["/CodeSystem/$lookup", "/CodeSystem/$validate-code"].includes(path) && params.version !== undefined) {
    if (resource.resourceType !== "Parameters" || reported.length !== 1 || reported[0] !== params.version) fail("Answering server did not establish the requested LOINC operation version", 409, { requested_version: params.version, reported_versions: reported });
  }
  const expected = /^\/ValueSet(?:\/.*)?$/.test(path) ? params.valueSetVersion
    : /^\/(?:CodeSystem|ConceptMap|Questionnaire)(?:\/[A-Za-z0-9.-]+)?\/?$/.test(path) ? params.version : undefined;
  if (expected !== undefined) {
    if (resource.resourceType === "Bundle" && resource.entry !== undefined && !Array.isArray(resource.entry)) fail("FHIR Bundle entry must be an array", 502);
    const resources = resource.resourceType === "Bundle"
      ? ((resource.entry ?? []) as unknown[]).map(value => object(object(value).resource)) : [resource];
    const expectedType = path.split("/")[1];
    for (const entry of resources) {
      if (entry.resourceType !== expectedType) fail("Versioned query returned the wrong FHIR resource type", 502);
      if (entry.version !== expected) fail("Answering server did not establish the requested resource version", 409, { requested_version: expected, resource_type: entry.resourceType, reported_version: entry.version ?? null });
      if (params.url !== undefined && entry.url !== params.url) fail("Versioned search returned a different canonical resource", 409);
    }
  }
  return reported;
}

export function verifyFhirShape(resource: Data, path: string): void {
  const type = resource.resourceType;
  const expected = path === "/metadata" ? ["CapabilityStatement", "TerminologyCapabilities"]
    : path.endsWith("/$expand") ? ["ValueSet"]
    : path.includes("/$") ? ["Parameters"] : [path.split("/")[1], ...(path.split("/").length === 2 ? ["Bundle"] : [])];
  if (!expected.includes(String(type))) fail("Unexpected FHIR resource type for the requested route", 502);
  for (const field of ["entry", "parameter", "item", "contained"]) if (resource[field] !== undefined && !Array.isArray(resource[field])) fail(`FHIR ${field} must be an array`, 502);
  if (type === "ValueSet" && resource.expansion !== undefined) {
    const expansion = object(resource.expansion);
    for (const key of ["parameter", "contains"]) if (expansion[key] !== undefined && !Array.isArray(expansion[key])) fail(`FHIR expansion.${key} must be an array`, 502);
  }
}
