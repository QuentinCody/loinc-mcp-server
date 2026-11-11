import type { ApiEndpoint, WorkflowRecipe } from "@bio-mcp/shared/codemode/catalog";
export const releaseEndpoints: ApiEndpoint[] = [
  { method: "GET", path: "/Questionnaire", category: "questionnaires", summary: "Search LOINC panels/assessments as versioned FHIR Questionnaires.", description: "Provider added historical Questionnaire selection in August 2026. Licensed LOINC server documents this operation; keyless mirrors may not carry these resources. Preserve contained answer lists, bindings, scores and skip logic.", queryParams: [
    { name: "url", type: "string", required: true, description: "Canonical http://loinc.org/q/{LOINC code}, e.g. http://loinc.org/q/89689-4" },
    { name: "version", type: "string", required: false, description: "Explicit Questionnaire release, e.g. 2.83 or 2.82; verified against each returned resource" },
    { name: "_count", type: "number", required: false, description: "FHIR search page size; retain Bundle links/total" },
  ] },
  { method: "GET", path: "/Questionnaire/{id}", category: "questionnaires", summary: "Retrieve a full LOINC Questionnaire by provider ID.", description: "Preserves nested items/contained resources and source versions. Historical selection uses the search route with canonical URL and version. Keyless availability is unverified.", pathParams: [{ name: "id", type: "string", required: true, description: "Provider Questionnaire identifier, e.g. 55757-9" }] },
];
export const releaseWorkflows: WorkflowRecipe[] = [
  { title: "Verify LOINC 2.83 on the answering host", description: "Explicit lookup pin; a missing or different returned version fails. A release announcement does not establish mirror availability. Preserve answering tier and full Parameters properties.", keywords: ["release", "2.83", "version", "lookup"], code: 'return await api.get("/CodeSystem/$lookup", { system: "http://loinc.org", code: "2160-0", version: "2.83", property: "*" });' },
  { title: "Discover advertised CodeSystem versions", description: "Retain the full FHIR Bundle, including pagination and distinct versions. Empty results are not proof a lookup version is unavailable; test the explicit lookup separately.", keywords: ["release", "metadata", "version"], code: 'return await api.get("/CodeSystem", { url: "http://loinc.org", _count: 20 });' },
  { title: "Expand a release-selected LOINC Group", description: "Uses the August 2026 valueSetVersion contract. ValueSet definition version and underlying CodeSystem version are separate. Preserve expansion timestamp, parameters, total, offset and nested terms; this is one bounded page.", keywords: ["2.83", "ValueSet", "Group", "SARS-CoV-2"], code: 'return await api.get("/ValueSet/$expand", { url: "http://loinc.org/vs/LG51018-6", valueSetVersion: "2.83", count: 50, offset: 0 });' },
  { title: "Retrieve a versioned LOINC–ChEBI ConceptMap", description: "Uses canonical URL plus version instead of an old version suffix. Preserve source/target/group versions and equivalence; keyless maps may be unavailable. A map version is not proof of the current ChEBI release.", keywords: ["ConceptMap", "ChEBI", "2.83", "version"], code: 'return await api.get("/ConceptMap", { url: "http://loinc.org/cm/loinc-parts-to-chebi", version: "2.83", _count: 10 });' },
  { title: "Retrieve a versioned LOINC Questionnaire", description: "Licensed provider supports release selection added in August 2026. Preserve all items, contained answer lists, code/score bindings and skip logic; keyless availability requires checking.", keywords: ["Questionnaire", "2.83", "assessment", "version"], code: 'return await api.get("/Questionnaire", { url: "http://loinc.org/q/89689-4", version: "2.83", _count: 10 });' },
];

/** Keep mirror selection explicit; a primary 4xx never triggers hidden failover. */
export function releaseWorkflowsFor(keyless: boolean): WorkflowRecipe[] {
  if (!keyless) return releaseWorkflows;
  return releaseWorkflows.map((workflow, index) => index === 0 ? { ...workflow,
    description: `${workflow.description} October 4, 2026: Ontoserver serves 2.83 while tx.fhir.org rejects that release. Explicitly select the configured Ontoserver endpoint.`,
    code: 'return await api.get("/CodeSystem/$lookup", { upstream: "ontoserver", system: "http://loinc.org", code: "2160-0", version: "2.83", property: "*" });',
  } : workflow);
}
