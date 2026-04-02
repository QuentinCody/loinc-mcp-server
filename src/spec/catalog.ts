import type { ApiCatalog } from "@bio-mcp/shared/codemode/catalog";

export const loincCatalog: ApiCatalog = {
    name: "LOINC FHIR Terminology Server",
    baseUrl: "https://fhir.loinc.org",
    version: "R4",
    auth: "http_basic",
    endpointCount: 9,
    notes:
        "- LOINC = Logical Observation Identifiers Names and Codes (99K+ observation/lab codes)\n" +
        "- Auth: HTTP Basic with LOINC credentials (free registration at loinc.org)\n" +
        "- FHIR R4 format. Responses are application/fhir+json\n" +
        "- Code format: numeric with optional dash (e.g., 2160-0 for Creatinine, 718-7 for Hemoglobin)\n" +
        "- LOINC 6-part name axes: Component, Property, Time, System, Scale, Method\n" +
        "- Classes: CHEM (chemistry), HEM/BC (hematology), MICRO (microbiology), UA (urinalysis), etc.\n" +
        "- $lookup returns a Parameters resource with property name-value pairs\n" +
        "- $expand returns a ValueSet with expansion.contains[] array of codes\n" +
        "- Bundle resources contain entry[] arrays for search results\n" +
        "- system parameter is always http://loinc.org for LOINC codes",
    endpoints: [
        // ---- code_lookup ----
        {
            method: "GET",
            path: "/CodeSystem/$lookup",
            summary: "Look up a LOINC code. Returns display name and properties (COMPONENT, PROPERTY, TIME_ASPCT, SYSTEM, SCALE_TYP, METHOD_TYP, CLASS, STATUS, ORDER_OBS, etc.)",
            category: "code_lookup",
            queryParams: [
                { name: "system", type: "string", required: true, description: "Code system URL (use http://loinc.org)" },
                { name: "code", type: "string", required: true, description: "LOINC code (e.g. 2160-0 for Creatinine)" },
                { name: "property", type: "string", required: false, description: "Specific property to return (use * for all properties)" },
            ],
        },
        {
            method: "GET",
            path: "/CodeSystem/$validate-code",
            summary: "Validate whether a LOINC code exists and is active",
            category: "validation",
            queryParams: [
                { name: "system", type: "string", required: true, description: "Code system URL (use http://loinc.org)" },
                { name: "code", type: "string", required: true, description: "LOINC code to validate" },
                { name: "display", type: "string", required: false, description: "Display name to validate against the code" },
            ],
        },
        {
            method: "GET",
            path: "/CodeSystem/$subsumes",
            summary: "Check if one LOINC code subsumes another (hierarchical relationship)",
            category: "validation",
            queryParams: [
                { name: "system", type: "string", required: true, description: "Code system URL (use http://loinc.org)" },
                { name: "codeA", type: "string", required: true, description: "First LOINC code" },
                { name: "codeB", type: "string", required: true, description: "Second LOINC code" },
            ],
        },
        // ---- value_sets ----
        {
            method: "GET",
            path: "/ValueSet/$expand",
            summary: "Expand a LOINC value set or search for codes by keyword. Returns matching LOINC codes with display names.",
            category: "value_sets",
            queryParams: [
                { name: "url", type: "string", required: false, description: "Value set URL (e.g. http://loinc.org/vs/LL1000-0). Omit to search across all LOINC." },
                { name: "filter", type: "string", required: false, description: "Text filter to search for matching codes (e.g. 'creatinine', 'hemoglobin')" },
                { name: "count", type: "number", required: false, description: "Maximum number of codes to return" },
                { name: "offset", type: "number", required: false, description: "Starting offset for pagination" },
            ],
        },
        {
            method: "GET",
            path: "/ValueSet",
            summary: "Search for LOINC value sets (answer lists, panels, groups)",
            category: "value_sets",
            queryParams: [
                { name: "url", type: "string", required: false, description: "Filter by value set URL" },
                { name: "name", type: "string", required: false, description: "Filter by value set name" },
                { name: "_count", type: "number", required: false, description: "Maximum number of results" },
            ],
        },
        // ---- mappings ----
        {
            method: "GET",
            path: "/ConceptMap",
            summary: "Search for concept maps (mappings between LOINC and other code systems like SNOMED CT)",
            category: "mappings",
            queryParams: [
                { name: "source", type: "string", required: false, description: "Source code system URL (e.g. http://loinc.org to find maps FROM LOINC)" },
                { name: "target", type: "string", required: false, description: "Target code system URL (e.g. http://loinc.org to find maps TO LOINC)" },
                { name: "_count", type: "number", required: false, description: "Maximum number of results" },
            ],
        },
        {
            method: "GET",
            path: "/ConceptMap/$translate",
            summary: "Translate a code from one system to another using a concept map",
            category: "mappings",
            queryParams: [
                { name: "system", type: "string", required: true, description: "Source code system URL" },
                { name: "code", type: "string", required: true, description: "Code to translate" },
                { name: "targetsystem", type: "string", required: false, description: "Target code system URL" },
            ],
        },
        // ---- metadata ----
        {
            method: "GET",
            path: "/CodeSystem",
            summary: "Get LOINC CodeSystem metadata (version, content, count of concepts)",
            category: "metadata",
            queryParams: [
                { name: "url", type: "string", required: false, description: "CodeSystem URL (use http://loinc.org)" },
            ],
        },
        {
            method: "GET",
            path: "/metadata",
            summary: "Get FHIR server capability statement (supported resources, operations, search parameters)",
            category: "metadata",
        },
    ],
};
