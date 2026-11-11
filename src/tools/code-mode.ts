import { createExecuteTool } from "@bio-mcp/shared/codemode/execute-tool";
import { createSearchTool } from "@bio-mcp/shared/codemode/search-tool";
import type { McpServer } from "@bio-mcp/shared/mcp";
import { createLoincApiFetch } from "../lib/api-adapter";
import { loincSourceDescriptor, resolveLoincEndpoints } from "../lib/http";
import { loincResponse } from "../lib/tool-result";
import { loincCatalogFor } from "../spec/catalog";

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
    const registrar = { tool: (...args: unknown[]) => {
        const [name, ...rest] = args;
        const handler = rest.pop() as (input: unknown, extra: unknown) => ReturnType<typeof loincResponse>;
        const respond = (input: unknown, extra: unknown) => loincResponse(() => handler(input, extra), env, String(name), extra, input);
        const register = server.tool.bind(server) as (...values: unknown[]) => void;
        register(name, ...rest, respond);
        register(`mcp_${String(name)}`, ...rest, respond);
    } };

    const searchTool = createSearchTool({
        prefix: "loinc",
        catalog,
    });
    searchTool.register(registrar);

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
        preserveApiErrors: true,
        maxInlineBytes: 30 * 1024,
        timeout: 90_000,
        doNamespace: env.LOINC_DATA_DO,
        loader: env.CODE_MODE_LOADER,
    });
    executeTool.register(registrar);
}
