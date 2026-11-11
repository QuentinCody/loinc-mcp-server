import { RestStagingDO } from "@bio-mcp/shared/staging/rest-staging-do";
import { flattenObject, type SchemaHints } from "@bio-mcp/shared/staging/schema-inference";

type Row = Record<string, unknown>;
const record = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
const row = (value: unknown, sourcePath: string, index: number, parentPath?: string) => ({
  ...(record(value) ? { ...flattenObject(value, 2), ...Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, item !== null && typeof item === "object" ? JSON.stringify(item) : item])) } : { value }),
  native_json: JSON.stringify(value), source_path: sourcePath, source_index: index,
  ...(parentPath === undefined ? {} : { parent_path: parentPath }),
});

function children(nodes: unknown[], field: string, base: string, parent?: string): Row[] {
  const rows: Row[] = [];
  for (const [index, value] of nodes.entries()) {
    const path = `${base}/${index}`;
    rows.push(row(value, path, index, parent));
    if (record(value) && Array.isArray(value[field])) rows.push(...children(value[field], field, `${path}/${field}`, path));
  }
  return rows;
}

function questionnaireTables(resource: Row, path: string, tables: Record<string, Row[]>) {
  if (resource.resourceType !== "Questionnaire") return;
  if (Array.isArray(resource.item)) {
    const items = children(resource.item, "item", `${path}/item`).map(value => ({ ...value, resource_source_path: path }));
    tables.questionnaire_items = [...(tables.questionnaire_items ?? []), ...items];
  }
  if (Array.isArray(resource.contained)) tables.contained_resources = [
    ...(tables.contained_resources ?? []),
    ...resource.contained.map((value, index) => ({ ...row(value, `${path}/contained/${index}`, index), resource_source_path: path })),
  ];
}

/** Query projections retain every original FHIR field and hierarchy; payloads stays lossless. */
export class LoincDataDO extends RestStagingDO {
  protected getTabularData(value: unknown): unknown {
    const data = record(value) && Array.isArray(value.content) && record(value.structuredContent) && "data" in value.structuredContent
      ? value.structuredContent.data : value;
    if (Array.isArray(data)) {
      const first = data[0];
      const name = record(first) && "code" in first ? "codes" : record(first) && "source" in first && "target" in first ? "mappings" : "observations";
      return { [name]: data.map((value, index) => row(value, `/${index}`, index)) };
    }
    if (!record(data)) return data;
    if (typeof data.sql === "string" && Array.isArray(data.rows)) return { query_rows: data.rows.map((value, index) => row(value, `/rows/${index}`, index)) };
    return resourceTables(data);
  }

  protected getSchemaHints(value: unknown): SchemaHints {
    const tables = this.getTabularData(value);
    const columnTypes: Record<string, string> = { native_json: "TEXT", source_path: "TEXT", parent_path: "TEXT" };
    if (record(tables)) for (const values of Object.values(tables)) {
      if (!Array.isArray(values)) continue;
      for (const item of values) if (record(item)) for (const [key, value] of Object.entries(item)) {
        if (typeof value === "string") columnTypes[key] = "TEXT";
      }
    }
    return { columnTypes };
  }
}

function resourceTables(data: Row): Record<string, Row[]> {
  let context: Row = data;
  const tables: Record<string, Row[]> = {};
  if (data.resourceType === "Parameters" && Array.isArray(data.parameter)) {
    tables.code_properties = data.parameter.map((value, index) => row(value, `/parameter/${index}`, index));
    const { parameter: _parameter, ...rest } = data; context = rest;
  } else if (data.resourceType === "ValueSet" && record(data.expansion) && Array.isArray(data.expansion.contains)) {
    tables.codes = children(data.expansion.contains, "contains", "/expansion/contains");
    const { contains: _contains, ...expansion } = data.expansion; context = { ...data, expansion };
  } else if (data.resourceType === "Bundle" && Array.isArray(data.entry)) {
    tables.value_sets = data.entry.map((entry, index) => ({ ...row(entry, `/entry/${index}`, index),
      ...(record(entry) && record(entry.resource) ? { resource_type: entry.resource.resourceType, resource_version: entry.resource.version } : {}) }));
    const { entry: _entry, ...rest } = data; context = rest;
    for (const [index, entry] of data.entry.entries()) if (record(entry) && record(entry.resource)) questionnaireTables(entry.resource, `/entry/${index}/resource`, tables);
  } else {
    tables[data.resourceType === "Questionnaire" ? "questionnaires" : "native_observations"] = [row(data, "", 0)];
    questionnaireTables(data, "", tables);
  }
  tables.response_context = [{ native_json: JSON.stringify(context) }];
  return tables;
}
