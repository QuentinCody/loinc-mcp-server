import { restFetch } from "@bio-mcp/shared/http/rest-fetch";
import type { RestFetchOptions } from "@bio-mcp/shared/http/rest-fetch";

/**
 * Licensed tier — Regenstrief's own FHIR server. It sits behind an Authelia
 * forward-auth proxy: with no credential it answers 401 (Accept:
 * application/fhir+json) or 302s to auth.loinc.org, so the body never parses as
 * FHIR. HTTP Basic is still the scheme the proxy offers, which is what
 * LOINC_USERNAME / LOINC_PASSWORD feed.
 */
const LICENSED_BASE = "https://fhir.loinc.org";

/**
 * Keyless tier, in failover order. Both serve the same LOINC CodeSystem over
 * FHIR R4 with no credential (verified live 2026-08-27: $lookup of 2160-0
 * returns HTTP 200 and LOINC version 2.82 from each).
 */
const KEYLESS_ENDPOINTS: readonly LoincEndpoint[] = [
    { tier: "keyless:tx.fhir.org", baseUrl: "https://tx.fhir.org/r4" },
    { tier: "keyless:ontoserver", baseUrl: "https://r4.ontoserver.csiro.au/fhir" },
];

/** Which upstream a result came from. Stamped onto every response as _meta.loinc_tier. */
export type LoincTier =
    | "licensed:fhir.loinc.org"
    | "keyless:tx.fhir.org"
    | "keyless:ontoserver"
    | "override";

export interface LoincEndpoint {
    tier: LoincTier;
    baseUrl: string;
    username?: string;
    password?: string;
}

export interface LoincCredentials {
    /** LOINC_USERNAME — set as a Worker secret, not a var */
    username?: string;
    /** LOINC_PASSWORD — set as a Worker secret, not a var */
    password?: string;
    /** LOINC_BASE_URL — pins one FHIR base and disables failover */
    baseUrl?: string;
}

export interface LoincFetchOptions
    extends Omit<RestFetchOptions, "retryOn">,
        LoincCredentials {
    /** Pre-resolved endpoints; defaults to resolveLoincEndpoints(opts) */
    endpoints?: LoincEndpoint[];
}

export interface LoincFetchResult {
    response: Response;
    /** The endpoint that actually answered — not necessarily the first one tried */
    endpoint: LoincEndpoint;
}

/** An unset Worker secret reads as undefined; an unset var used to read as "". Treat both as absent. */
function present(value?: string): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

/**
 * Decide which upstream(s) this Worker talks to.
 *
 * With both credentials it is the licensed Regenstrief server, unchanged.
 * Without them it is the keyless FHIR terminology mirrors — which serve the
 * full LOINC CodeSystem, so an absent credential degrades the surface (see
 * `loincCatalogFor`) instead of failing every call.
 */
export function resolveLoincEndpoints(
    creds?: LoincCredentials,
): LoincEndpoint[] {
    const username = present(creds?.username);
    const password = present(creds?.password);
    const override = present(creds?.baseUrl);
    const licensed = username !== undefined && password !== undefined;

    if (override !== undefined) {
        return [
            {
                tier: "override",
                baseUrl: override.replace(/\/$/, ""),
                ...(licensed ? { username, password } : {}),
            },
        ];
    }

    if (licensed) {
        return [
            {
                tier: "licensed:fhir.loinc.org",
                baseUrl: LICENSED_BASE,
                username,
                password,
            },
        ];
    }

    return KEYLESS_ENDPOINTS.map((endpoint) => ({ ...endpoint }));
}

/**
 * LOINC's redistribution terms. The same text whichever tier answered — the
 * keyless mirrors redistribute Regenstrief's content unchanged.
 */
const LOINC_LICENSE =
    "LOINC is copyright Regenstrief Institute, Inc. and the LOINC Committee, " +
    "available under the LOINC Terms of Use (https://loinc.org/license/). " +
    "The keyless HL7 and CSIRO terminology servers redistribute that content unchanged.";

/** The subset of SourceDescriptor this server declares (structural, so the
 *  shared provenance type stays out of the server's import graph). */
export interface LoincSourceDescriptor {
    id: "loinc";
    name: string;
    url?: string;
    license: string;
}

/**
 * The provenance identity that `loinc_execute` results cite.
 *
 * A citation cannot name the answering host whenever failover is live, and the
 * reason is structural, not an oversight:
 *
 *  - `createExecuteTool` takes ONE SourceDescriptor at registration and issues
 *    ONE citation per `_execute` call. It never sees the adapter's per-request
 *    result, so there is no seam to thread an answering endpoint back through.
 *  - One `_execute` program issues arbitrarily many upstream calls, and any of
 *    the resolved endpoints may answer any one of them. "The" answering host is
 *    not even single-valued for one citation.
 *
 * So: a single resolved endpoint (licensed, override, or a pinned base) is the
 * only host that can answer and is named with its `url`. With failover
 * candidates the descriptor names the candidate SET and omits `url` rather than
 * asserting a host that may not have answered. The host that answered each
 * individual call is stamped on that call's own result as `_meta.loinc_tier`
 * and `_meta.loinc_base_url` (see `api-adapter.ts`), inside the bytes the
 * citation's result_hash covers.
 */
export function loincSourceDescriptor(
    endpoints: LoincEndpoint[],
): LoincSourceDescriptor {
    if (endpoints.length === 0) {
        throw new Error("loincSourceDescriptor: no LOINC endpoint resolved");
    }
    if (endpoints.length === 1) {
        const only = endpoints[0];
        return {
            id: "loinc",
            name: `LOINC (${only.tier})`,
            url: only.baseUrl,
            license: LOINC_LICENSE,
        };
    }
    return {
        id: "loinc",
        name: `LOINC (failover set: ${endpoints.map((e) => e.tier).join(", ")}; ` +
            "the answering host is _meta.loinc_tier on each result)",
        license: LOINC_LICENSE,
    };
}

/**
 * Fetch from a LOINC FHIR terminology server, trying the resolved endpoints in
 * order and reporting which one answered.
 *
 * Failover is deliberately narrow: a transport error or a 5xx means that host
 * is down, so the next one gets the request. Every 4xx is a real FHIR answer —
 * notably the 404 OperationOutcome for an unknown code, and the 401 the
 * licensed tier returns without a credential — and is returned unchanged from
 * the endpoint that produced it.
 */
export async function loincFetch(
    path: string,
    params?: Record<string, unknown>,
    opts?: LoincFetchOptions,
): Promise<LoincFetchResult> {
    const endpoints = opts?.endpoints ?? resolveLoincEndpoints(opts);
    if (endpoints.length === 0) {
        throw new Error("loincFetch: no LOINC endpoint resolved");
    }

    // With a failover candidate behind it, each endpoint gets a fraction of the
    // isolate's 30s execution budget so the second one still gets a turn. A
    // single pinned endpoint keeps the original 30s.
    const hasFailover = endpoints.length > 1;
    const attemptTimeout = opts?.timeout ?? (hasFailover ? 10_000 : 30_000);
    const endpointBudget = opts?.deadlineMs ?? (hasFailover ? 12_000 : 30_000);

    let lastError: unknown;

    for (let i = 0; i < endpoints.length; i++) {
        const endpoint = endpoints[i];
        const isLast = i === endpoints.length - 1;

        const headers: Record<string, string> = {
            Accept: "application/fhir+json",
            ...(opts?.headers ?? {}),
        };
        if (endpoint.username && endpoint.password) {
            const credentials = btoa(`${endpoint.username}:${endpoint.password}`);
            headers.Authorization = `Basic ${credentials}`;
        }

        try {
            const response = await restFetch(endpoint.baseUrl, path, params, {
                headers,
                retryOn: [429, 500, 502, 503],
                retries: opts?.retries ?? 3,
                timeout: attemptTimeout,
                deadlineMs: endpointBudget,
                userAgent: "loinc-mcp-server/1.0 (bio-mcp)",
                ...(opts?.method ? { method: opts.method } : {}),
                ...(opts?.body !== undefined ? { body: opts.body } : {}),
                ...(opts?.cache ? { cache: opts.cache } : {}),
            });

            if (response.status >= 500 && !isLast) {
                lastError = new Error(
                    `${endpoint.baseUrl} returned HTTP ${response.status}`,
                );
                console.warn(
                    `[loinc] ${endpoint.tier} returned HTTP ${response.status} — failing over`,
                );
                continue;
            }

            return { response, endpoint };
        } catch (error) {
            lastError = error;
            if (isLast) throw error;
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`[loinc] ${endpoint.tier} transport error — failing over: ${message}`);
        }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
