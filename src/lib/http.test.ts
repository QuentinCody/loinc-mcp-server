import { afterEach, describe, expect, it, vi } from "vitest";
import { loincFetch, loincSourceDescriptor, resolveLoincEndpoints } from "./http";

interface Call {
    url: string;
    authorization: string | null;
}

/** Stub global fetch with a per-host reply table and record what was sent. */
function stubFetch(reply: (url: string) => Response | Promise<Response>): Call[] {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const headers = new Headers(init?.headers as HeadersInit);
        calls.push({ url, authorization: headers.get("Authorization") });
        return reply(url);
    });
    return calls;
}

function fhir(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/fhir+json" },
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("resolveLoincEndpoints (two-tier upstream selection)", () => {
    it("falls back to the keyless FHIR mirrors when no credential is set", () => {
        const endpoints = resolveLoincEndpoints();
        expect(endpoints.map((e) => e.tier)).toEqual([
            "keyless:tx.fhir.org",
            "keyless:ontoserver",
        ]);
        expect(endpoints[0].baseUrl).toBe("https://tx.fhir.org/r4");
        expect(endpoints.every((e) => e.username === undefined)).toBe(true);
    });

    // The bug this server shipped with: wrangler.jsonc declared the credentials
    // as vars with the value "", so "unset" and "set" looked the same.
    it("treats empty-string credentials as absent, not as a licensed tier", () => {
        const endpoints = resolveLoincEndpoints({ username: "", password: "  " });
        expect(endpoints[0].tier).toBe("keyless:tx.fhir.org");
    });

    it("uses the licensed Regenstrief server when both credentials are present", () => {
        const endpoints = resolveLoincEndpoints({ username: "u", password: "p" });
        expect(endpoints).toHaveLength(1);
        expect(endpoints[0].tier).toBe("licensed:fhir.loinc.org");
        expect(endpoints[0].baseUrl).toBe("https://fhir.loinc.org");
    });

    it("pins a single endpoint when LOINC_BASE_URL overrides the base", () => {
        const endpoints = resolveLoincEndpoints({ baseUrl: "https://tx.example.org/r4/" });
        expect(endpoints).toEqual([{ tier: "override", baseUrl: "https://tx.example.org/r4" }]);
    });
});

describe("loincFetch (tier selection and failover)", () => {
    it("sends no Authorization header on the keyless tier", async () => {
        const calls = stubFetch(() => fhir({ resourceType: "Parameters" }));
        const { endpoint } = await loincFetch(
            "/CodeSystem/$lookup",
            { system: "http://loinc.org", code: "2160-0" },
            { retries: 0 },
        );
        expect(endpoint.tier).toBe("keyless:tx.fhir.org");
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe(
            "https://tx.fhir.org/r4/CodeSystem/$lookup?system=http%3A%2F%2Floinc.org&code=2160-0",
        );
        expect(calls[0].authorization).toBeNull();
    });

    it("sends HTTP Basic to fhir.loinc.org when credentials are configured", async () => {
        const calls = stubFetch(() => fhir({ resourceType: "Parameters" }));
        const { endpoint } = await loincFetch("/metadata", undefined, {
            username: "user@example.org",
            password: "secret",
            retries: 0,
        });
        expect(endpoint.tier).toBe("licensed:fhir.loinc.org");
        expect(calls[0].url).toBe("https://fhir.loinc.org/metadata");
        expect(calls[0].authorization).toBe(`Basic ${btoa("user@example.org:secret")}`);
    });

    it("fails over to Ontoserver when the primary keyless server 5xxes", async () => {
        const calls = stubFetch((url) =>
            url.includes("tx.fhir.org")
                ? fhir({ resourceType: "OperationOutcome" }, 503)
                : fhir({ resourceType: "Parameters", parameter: [{ name: "display" }] }),
        );
        const { response, endpoint } = await loincFetch("/CodeSystem/$lookup", undefined, {
            retries: 0,
        });
        expect(response.status).toBe(200);
        expect(endpoint.tier).toBe("keyless:ontoserver");
        expect(calls.map((c) => new URL(c.url).host)).toEqual([
            "tx.fhir.org",
            "r4.ontoserver.csiro.au",
        ]);
    });

    it("fails over when the primary keyless server is unreachable", async () => {
        const calls = stubFetch((url) => {
            if (url.includes("tx.fhir.org")) throw new Error("connection refused");
            return fhir({ resourceType: "Parameters" });
        });
        const { endpoint } = await loincFetch("/metadata", undefined, { retries: 0 });
        expect(endpoint.tier).toBe("keyless:ontoserver");
        expect(calls).toHaveLength(2);
    });

    // The gate that keeps failover honest: a 404 OperationOutcome is FHIR's real
    // answer for "this code is not in the release", not a dead host. Retrying it
    // on the next mirror would hide the answer and burn the isolate's budget.
    it("returns a 404 OperationOutcome unchanged instead of failing over", async () => {
        const calls = stubFetch(() =>
            fhir(
                {
                    resourceType: "OperationOutcome",
                    issue: [{ severity: "error", code: "not-found" }],
                },
                404,
            ),
        );
        const { response, endpoint } = await loincFetch("/CodeSystem/$lookup", undefined, {
            retries: 0,
        });
        expect(response.status).toBe(404);
        expect(endpoint.tier).toBe("keyless:tx.fhir.org");
        expect(calls).toHaveLength(1);
    });

    it("returns the licensed tier's 401 rather than silently reaching a keyless mirror", async () => {
        const calls = stubFetch(() => new Response("401 Unauthorized", { status: 401 }));
        const { response, endpoint } = await loincFetch("/metadata", undefined, {
            username: "u",
            password: "p",
            retries: 0,
        });
        expect(response.status).toBe(401);
        expect(endpoint.tier).toBe("licensed:fhir.loinc.org");
        expect(calls).toHaveLength(1);
    });
});

// The citation a loinc_execute result carries must never assert a host that may
// not have answered. With failover live the descriptor names the candidate set
// and carries no url; the answering host is _meta.loinc_tier on each result.
describe("loincSourceDescriptor (citation must not name a host that may not have answered)", () => {
    it("omits url and names both candidates while keyless failover is live", () => {
        const source = loincSourceDescriptor(resolveLoincEndpoints());

        expect(source.url).toBeUndefined();
        expect(source.name).toContain("keyless:tx.fhir.org");
        expect(source.name).toContain("keyless:ontoserver");
        // The precise defect: naming the startup primary as THE source.
        expect(source.name).not.toBe("LOINC (keyless:tx.fhir.org)");
    });

    it("names the host when only one endpoint can answer", () => {
        const licensed = loincSourceDescriptor(
            resolveLoincEndpoints({ username: "u", password: "p" }),
        );
        expect(licensed.name).toBe("LOINC (licensed:fhir.loinc.org)");
        expect(licensed.url).toBe("https://fhir.loinc.org");

        const pinned = loincSourceDescriptor(
            resolveLoincEndpoints({ baseUrl: "https://tx.example.org/r4" }),
        );
        expect(pinned.url).toBe("https://tx.example.org/r4");
    });

    it("throws rather than emit a source with no upstream behind it", () => {
        expect(() => loincSourceDescriptor([])).toThrow(/no LOINC endpoint resolved/);
    });

    it("carries the LOINC licence on every tier", () => {
        for (const endpoints of [
            resolveLoincEndpoints(),
            resolveLoincEndpoints({ username: "u", password: "p" }),
        ]) {
            const source = loincSourceDescriptor(endpoints);
            expect(source.id).toBe("loinc");
            expect(source.license).toContain("Regenstrief Institute");
        }
    });
});
