import { restFetch } from "@bio-mcp/shared/http/rest-fetch";
import type { RestFetchOptions } from "@bio-mcp/shared/http/rest-fetch";

const LOINC_BASE = "https://fhir.loinc.org";

export interface LoincFetchOptions extends Omit<RestFetchOptions, "retryOn"> {
    baseUrl?: string;
    username?: string;
    password?: string;
}

/**
 * Fetch from the LOINC FHIR Terminology Server.
 * Requires HTTP Basic auth with LOINC credentials.
 */
export async function loincFetch(
    path: string,
    params?: Record<string, unknown>,
    opts?: LoincFetchOptions,
): Promise<Response> {
    const baseUrl = opts?.baseUrl ?? LOINC_BASE;
    const headers: Record<string, string> = {
        Accept: "application/fhir+json",
        ...(opts?.headers ?? {}),
    };

    // Add HTTP Basic auth if credentials are provided
    if (opts?.username && opts?.password) {
        const credentials = btoa(`${opts.username}:${opts.password}`);
        headers.Authorization = `Basic ${credentials}`;
    }

    return restFetch(baseUrl, path, params, {
        ...opts,
        headers,
        retryOn: [429, 500, 502, 503],
        retries: opts?.retries ?? 3,
        timeout: opts?.timeout ?? 30_000,
        userAgent: "loinc-mcp-server/1.0 (bio-mcp)",
    });
}
