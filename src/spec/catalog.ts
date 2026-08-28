import type { ApiCatalog, ApiEndpoint } from "@bio-mcp/shared/codemode/catalog";
import type { LoincEndpoint } from "../lib/http";

const SHARED_NOTES =
    "- LOINC = Logical Observation Identifiers Names and Codes (99K+ observation/lab codes)\n" +
    "- FHIR R4 format. Responses are application/fhir+json\n" +
    "- Code format: numeric with optional dash (e.g., 2160-0 for Creatinine, 718-7 for Hemoglobin)\n" +
    "- LOINC 6-part name axes: Component, Property, Time, System, Scale, Method\n" +
    "- Classes: CHEM (chemistry), HEM/BC (hematology), MICRO (microbiology), UA (urinalysis), etc.\n" +
    "- $lookup returns a Parameters resource with property name-value pairs\n" +
    "- $expand returns a ValueSet with expansion.contains[] array of codes\n" +
    "- Bundle resources contain entry[] arrays for search results\n" +
    "- system parameter is always http://loinc.org for LOINC codes\n" +
    "- Every result carries _meta.loinc_tier (which upstream answered), _meta.loinc_base_url\n" +
    "  and, when the server reports one, _meta.loinc_version (the LOINC release)";

const KEYLESS_NOTES =
    "- ACTIVE TIER: keyless. No LOINC credential is configured, so this server reads the LOINC\n" +
    "  CodeSystem from the public HL7 (tx.fhir.org/r4) primary and the CSIRO\n" +
    "  (r4.ontoserver.csiro.au/fhir) failover. Both serve LOINC 2.82\n" +
    "- THE TWO MIRRORS DIFFER. Measured 2026-08-27, $lookup of 2160-0 with property=*:\n" +
    "  tx.fhir.org returned 25 property parts over 15 distinct codes (COMPONENT, PROPERTY,\n" +
    "  TIME_ASPCT, SYSTEM, SCALE_TYP, CLASS, CLASSTYPE, STATUS, ORDER_OBS, parent, inactive,\n" +
    "  EXAMPLE_UNITS, EXAMPLE_UCUM_UNITS, UNITSREQUIRED, and RELATEDNAMES2 repeated 11 times);\n" +
    "  Ontoserver returned 12 parts and omits EXAMPLE_UNITS, UNITSREQUIRED and RELATEDNAMES2.\n" +
    "  If a result carries _meta.loinc_tier keyless:ontoserver, those three are absent because\n" +
    "  that mirror does not serve them, NOT because the code lacks them. Re-read on\n" +
    "  tx.fhir.org before concluding a property is empty\n" +
    "- DEGRADED here: ConceptMap search and ConceptMap/$translate (no LOINC->SNOMED maps are\n" +
    "  loaded) and ValueSet search by a loinc.org/vs canonical. Expanding a known answer-list\n" +
    "  URL with ValueSet/$expand does work\n" +
    "- To get the licensed tier, set the LOINC_USERNAME and LOINC_PASSWORD Worker secrets";

const LICENSED_NOTES =
    "- ACTIVE TIER: licensed. LOINC_USERNAME / LOINC_PASSWORD are configured, so requests go to\n" +
    "  fhir.loinc.org with HTTP Basic auth\n" +
    "- fhir.loinc.org sits behind an Authelia forward-auth proxy: a rejected credential answers\n" +
    "  401 with an HTML body (or 302s to auth.loinc.org), never a FHIR OperationOutcome";

const OVERRIDE_NOTES =
    "- ACTIVE TIER: LOINC_BASE_URL override. Failover is disabled; every call goes to that base";

function tierNotes(endpoint: LoincEndpoint): string {
    if (endpoint.tier === "override") return OVERRIDE_NOTES;
    if (endpoint.tier === "licensed:fhir.loinc.org") return LICENSED_NOTES;
    return KEYLESS_NOTES;
}

/**
 * The endpoints the keyless terminology servers cannot answer, keyed by path.
 * Verified live 2026-08-27 against tx.fhir.org and r4.ontoserver.csiro.au, and
 * re-measured 2026-08-27 (the two mirrors fail these differently - see the
 * per-path text, which names each mirror's own behaviour).
 */
const KEYLESS_GAPS: Record<string, string> = {
    "/ConceptMap":
        "DEGRADED without LOINC credentials: neither keyless server indexes LOINC ConceptMaps (tx.fhir.org errors, Ontoserver rejects the search).",
    "/ConceptMap/$translate":
        "DEGRADED without LOINC credentials: both mirrors answer HTTP 200 with result=false - tx.fhir.org says 'No ConceptMap is available to translate from http://loinc.org', Ontoserver says 'No mappings could be found'. The LOINC/SNOMED cooperative maps are not loaded on either keyless server.",
    "/ValueSet":
        "DEGRADED without LOINC credentials: searching by the loinc.org/vs canonical does not reach the LOINC answer-list catalogue on either mirror - tx.fhir.org returns a Bundle with total 0, Ontoserver returns total 1 (only http://loinc.org/2.82/vs, the all-codes value set). Expand a known answer-list URL via ValueSet/$expand instead.",
};

function withTierWarnings(
    endpoints: ApiEndpoint[],
    keyless: boolean,
): ApiEndpoint[] {
    if (!keyless) return endpoints;
    return endpoints.map((endpoint) => {
        const gap = KEYLESS_GAPS[endpoint.path];
        return gap ? { ...endpoint, summary: `${endpoint.summary}. ${gap}` } : endpoint;
    });
}

const ENDPOINTS: ApiEndpoint[] = [
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
            { name: "url", type: "string", required: false, description: "Value set URL (e.g. http://loinc.org/vs/LL1000-0 for an answer list, or http://loinc.org/vs for all of LOINC)" },
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
];

/**
 * Build the catalog for the tier this Worker resolved at startup, so the
 * description the model reads names the upstream it will actually reach and
 * marks the endpoints that tier cannot answer.
 */
export function loincCatalogFor(endpoint: LoincEndpoint): ApiCatalog {
    const keyless = endpoint.tier.startsWith("keyless:");
    return {
        name: "LOINC FHIR Terminology Server",
        baseUrl: endpoint.baseUrl,
        version: "R4",
        auth: keyless
            ? "none (keyless FHIR terminology server; set LOINC_USERNAME/LOINC_PASSWORD for the licensed tier)"
            : "http_basic",
        endpointCount: ENDPOINTS.length,
        notes: `${SHARED_NOTES}\n${tierNotes(endpoint)}`,
        endpoints: withTierWarnings(ENDPOINTS, keyless),
    };
}
