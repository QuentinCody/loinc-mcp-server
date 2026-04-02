import { RestStagingDO } from "@bio-mcp/shared/staging/rest-staging-do";
import type { SchemaHints } from "@bio-mcp/shared/staging/schema-inference";

export class LoincDataDO extends RestStagingDO {
    protected getSchemaHints(data: unknown): SchemaHints | undefined {
        if (!data || typeof data !== "object") return undefined;

        // FHIR Parameters resource from $lookup
        const obj = data as Record<string, unknown>;
        if (obj.resourceType === "Parameters" && Array.isArray(obj.parameter)) {
            return {
                tableName: "code_properties",
                indexes: ["name"],
            };
        }

        // FHIR ValueSet resource from $expand
        if (obj.resourceType === "ValueSet") {
            const expansion = (obj as Record<string, unknown>).expansion as
                | Record<string, unknown>
                | undefined;
            if (expansion && Array.isArray(expansion.contains)) {
                return {
                    tableName: "codes",
                    indexes: ["code", "display", "system"],
                };
            }
        }

        // FHIR Bundle (search results)
        if (obj.resourceType === "Bundle" && Array.isArray(obj.entry)) {
            return {
                tableName: "value_sets",
                indexes: ["id", "name", "url"],
            };
        }

        if (Array.isArray(data)) {
            const sample = data[0];
            if (sample && typeof sample === "object") {
                // Array of codes (from expansion)
                if ("code" in sample && "display" in sample) {
                    return {
                        tableName: "codes",
                        indexes: ["code", "display", "system"],
                    };
                }
                // Array of concept mappings
                if ("source" in sample && "target" in sample) {
                    return {
                        tableName: "mappings",
                        indexes: ["source", "target"],
                    };
                }
            }
        }

        return undefined;
    }
}
