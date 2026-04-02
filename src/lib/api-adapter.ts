import type { ApiFetchFn } from "@bio-mcp/shared/codemode/catalog";
import { loincFetch } from "./http";

interface LoincAdapterOptions {
    username?: string;
    password?: string;
}

export function createLoincApiFetch(opts?: LoincAdapterOptions): ApiFetchFn {
    return async (request) => {
        const path = request.path;

        const response = await loincFetch(path, request.params, {
            username: opts?.username,
            password: opts?.password,
        });

        if (!response.ok) {
            let errorBody: string;
            try {
                errorBody = await response.text();
            } catch {
                errorBody = response.statusText;
            }
            const error = new Error(`HTTP ${response.status}: ${errorBody.slice(0, 200)}`) as Error & {
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
        return { status: response.status, data };
    };
}
