import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSearchTool } from "@bio-mcp/shared/codemode/search-tool";
import { createExecuteTool } from "@bio-mcp/shared/codemode/execute-tool";
import { loincCatalog } from "../spec/catalog";
import { createLoincApiFetch } from "../lib/api-adapter";

interface CodeModeEnv {
    LOINC_DATA_DO: DurableObjectNamespace;
    CODE_MODE_LOADER: WorkerLoader;
    LOINC_USERNAME: string;
    LOINC_PASSWORD: string;
}

export function registerCodeMode(
    server: McpServer,
    env: CodeModeEnv,
): void {
    const apiFetch = createLoincApiFetch({
        username: env.LOINC_USERNAME,
        password: env.LOINC_PASSWORD,
    });

    const searchTool = createSearchTool({
        prefix: "loinc",
        catalog: loincCatalog,
    });
    searchTool.register(server as unknown as { tool: (...args: unknown[]) => void });

    const executeTool = createExecuteTool({
        prefix: "loinc",
        // Verifiable provenance: loinc_execute results carry a _meta.citation.
        source: { id: "loinc", name: "LOINC", url: "https://loinc.org" },
        catalog: loincCatalog,
        apiFetch,
        doNamespace: env.LOINC_DATA_DO,
        loader: env.CODE_MODE_LOADER,
    });
    executeTool.register(server as unknown as { tool: (...args: unknown[]) => void });
}
