import { afterEach, describe, expect, it, vi } from "vitest";
import { createLoincApiFetch } from "./api-adapter";
import { resolveLoincEndpoints } from "./http";

const LOOKUP_2160_0 = {
    resourceType: "Parameters",
    parameter: [
        { name: "name", valueString: "LOINC" },
        { name: "version", valueString: "2.82" },
        { name: "display", valueString: "Creatinine [Mass/volume] in Serum or Plasma" },
        {
            name: "property",
            part: [
                { name: "code", valueCode: "COMPONENT" },
                { name: "value", valueString: "Creatinine" },
            ],
        },
    ],
};

function stubFetch(status: number, body: unknown): void {
    vi.stubGlobal("fetch", async () =>
        typeof body === "string"
            ? new Response(body, { status })
            : new Response(JSON.stringify(body), {
                  status,
                  headers: { "content-type": "application/fhir+json" },
              }),
    );
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("createLoincApiFetch (tier provenance on every result)", () => {
    it("stamps the answering tier and LOINC release without touching the resource", async () => {
        stubFetch(200, LOOKUP_2160_0);
        const apiFetch = createLoincApiFetch({ endpoints: resolveLoincEndpoints() });

        const { status, data } = await apiFetch({
            method: "GET",
            path: "/CodeSystem/$lookup",
            params: { system: "http://loinc.org", code: "2160-0" },
        });
        const resource = data as Record<string, unknown>;

        expect(status).toBe(200);
        // The seeded canary reads r.parameter — the stamp must stay additive.
        expect(resource.parameter).toEqual(LOOKUP_2160_0.parameter);
        expect(resource._meta).toEqual({
            loinc_tier: "keyless:tx.fhir.org",
            loinc_base_url: "https://tx.fhir.org/r4",
            loinc_version: "2.82",
        });
    });

    it("reports the licensed tier when credentials are configured", async () => {
        stubFetch(200, { resourceType: "CodeSystem", version: "2.83" });
        const apiFetch = createLoincApiFetch({
            endpoints: resolveLoincEndpoints({ username: "u", password: "p" }),
        });

        const { data } = await apiFetch({ method: "GET", path: "/CodeSystem" });

        expect((data as { _meta: unknown })._meta).toEqual({
            loinc_tier: "licensed:fhir.loinc.org",
            loinc_base_url: "https://fhir.loinc.org",
            loinc_version: "2.83",
        });
    });

    // An upstream failure must stay a failure: the isolate turns a thrown error
    // into an __api_error, and naming the tier says which upstream refused.
    it("throws on an upstream error instead of returning it as a result", async () => {
        stubFetch(404, {
            resourceType: "OperationOutcome",
            issue: [{ severity: "error", code: "not-found" }],
        });
        const apiFetch = createLoincApiFetch({ endpoints: resolveLoincEndpoints() });

        await expect(
            apiFetch({ method: "GET", path: "/CodeSystem/$lookup", params: { code: "NOT-A-CODE" } }),
        ).rejects.toThrow(/HTTP 404 from keyless:tx\.fhir\.org/);
    });
});
