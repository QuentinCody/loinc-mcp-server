import type { McpServer } from "@bio-mcp/shared/mcp";
import { createSearchTool } from "@bio-mcp/shared/codemode/search-tool";
import { createExecuteTool } from "@bio-mcp/shared/codemode/execute-tool";
import { loincCatalogFor } from "../spec/catalog";
import { createLoincApiFetch } from "../lib/api-adapter";
import { loincSourceDescriptor, resolveLoincEndpoints } from "../lib/http";

interface CodeModeEnv {
    LOINC_DATA_DO: DurableObjectNamespace;
    CODE_MODE_LOADER: WorkerLoader;
    LOINC_USERNAME?: string;
    LOINC_PASSWORD?: string;
    LOINC_BASE_URL?: string;
}

export function registerCodeMode(
    server: McpServer,
    env: CodeModeEnv,
): void {
    const endpoints = resolveLoincEndpoints({
        username: env.LOINC_USERNAME,
        password: env.LOINC_PASSWORD,
        baseUrl: env.LOINC_BASE_URL,
    });
    const catalog = loincCatalogFor(endpoints[0]);
    const apiFetch = createLoincApiFetch({ endpoints });

    const searchTool = createSearchTool({
        prefix: "loinc",
        catalog,
    });
    searchTool.register(server as unknown as { tool: (...args: unknown[]) => void });

    const executeTool = createExecuteTool({
        prefix: "loinc",
        // Verifiable provenance: loinc_execute results carry a _meta.citation.
        // The descriptor never asserts a host that may not have answered — with
        // failover live it names the candidate set and carries no url. See
        // loincSourceDescriptor for why the answering host cannot reach the
        // citation, and _meta.loinc_tier on each result for the host that did.
        source: loincSourceDescriptor(endpoints),
        catalog,
        apiFetch,
        doNamespace: env.LOINC_DATA_DO,
        loader: env.CODE_MODE_LOADER,
    });
    executeTool.register(server as unknown as { tool: (...args: unknown[]) => void });
}
