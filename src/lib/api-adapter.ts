import type { ApiFetchFn } from "@bio-mcp/shared/codemode/catalog";
import { type LoincEndpoint, loincFetch, resolveLoincEndpoints } from "./http";

interface LoincAdapterOptions {
    /** Pre-resolved endpoints; defaults to the keyless tier */
    endpoints?: LoincEndpoint[];
}

/** The LOINC release the answering server reports, when it reports one. */
function extractLoincVersion(data: Record<string, unknown>): string | undefined {
    if (data.resourceType === "Parameters" && Array.isArray(data.parameter)) {
        for (const entry of data.parameter as Array<Record<string, unknown>>) {
            if (entry?.name === "version" && typeof entry.valueString === "string") {
                return entry.valueString;
            }
        }
    }
    // CodeSystem / ValueSet resources carry the release on the resource itself
    if (typeof data.version === "string") return data.version;
    return undefined;
}

/**
 * Stamp the answering upstream onto the FHIR resource, so a caller can never
 * mistake the keyless mirror for the licensed Regenstrief server or read a
 * LOINC release that is not the one it got. Purely additive — `parameter`,
 * `expansion` and `entry` reach the isolate untouched.
 */
function stampTier(data: unknown, endpoint: LoincEndpoint): unknown {
    if (!data || typeof data !== "object" || Array.isArray(data)) return data;
    const resource = data as Record<string, unknown>;
    const existing =
        resource._meta && typeof resource._meta === "object" && !Array.isArray(resource._meta)
            ? (resource._meta as Record<string, unknown>)
            : {};
    const version = extractLoincVersion(resource);
    return {
        ...resource,
        _meta: {
            ...existing,
            loinc_tier: endpoint.tier,
            loinc_base_url: endpoint.baseUrl,
            ...(version ? { loinc_version: version } : {}),
        },
    };
}

export function createLoincApiFetch(opts?: LoincAdapterOptions): ApiFetchFn {
    const endpoints = opts?.endpoints ?? resolveLoincEndpoints();

    return async (request) => {
        const path = request.path;

        const { response, endpoint } = await loincFetch(path, request.params, {
            endpoints,
        });

        if (!response.ok) {
            let errorBody: string;
            try {
                errorBody = await response.text();
            } catch {
                errorBody = response.statusText;
            }
            // Name the tier in the message: a 401 from fhir.loinc.org means a
            // missing/rejected credential, a 404 from a keyless mirror means the
            // code genuinely is not in the release it serves.
            const error = new Error(
                `HTTP ${response.status} from ${endpoint.tier}: ${errorBody.slice(0, 200)}`,
            ) as Error & {
                status: number;
                data: unknown;
            };
            error.status = response.status;
            error.data = errorBody;
            throw error;
        }

        const contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("json") && !contentType.includes("fhir")) {
            const text = await response.text();
            return { status: response.status, data: text };
        }

        const data = await response.json();
        return { status: response.status, data: stampTier(data, endpoint) };
    };
}
