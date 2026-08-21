import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import { Tool } from "effect/unstable/ai";

import { SchedulesToolkit } from "./tools.ts";

const schemaHasDescription = (schema: unknown): boolean => {
  if (!schema || typeof schema !== "object") return false;
  const record = schema as Record<string, unknown>;
  if (typeof record.description === "string" && record.description.length > 0) return true;
  return [record.anyOf, record.oneOf, record.allOf]
    .filter(Array.isArray)
    .some((members) => members.some(schemaHasDescription));
};

it("exports provider-compatible object schemas", () => {
  for (const tool of Object.values(SchedulesToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly anyOf?: unknown;
      readonly oneOf?: unknown;
    };
    expect(
      tool.description?.length ?? 0,
      `${tool.name} should have a useful description`,
    ).toBeGreaterThan(40);
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined();
    expect(schema.oneOf, `${tool.name} must not export a root oneOf`).toBeUndefined();
  }
});

it("gives every tool at least one parameter", () => {
  // An empty Schema.Struct({}) encodes to a typeless `anyOf`, and Claude Code
  // drops an MCP server's ENTIRE toolset when any one tool's schema fails
  // validation — while still reporting the server as connected. A read-only
  // lister is the tool most likely to be written with no parameters at all.
  for (const tool of Object.values(SchedulesToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly properties?: Readonly<Record<string, unknown>>;
    };
    expect(
      Object.keys(schema.properties ?? {}).length,
      `${tool.name} must declare at least one (optional) parameter`,
    ).toBeGreaterThan(0);
  }
});

it("documents every parameter, in the schema or in the tool description", () => {
  // Effect's JSON-schema emitter renders the ENCODED side of a schema, so a
  // description annotated onto a branded or transformed field (every id here)
  // is dropped — only optional wrappers and plain schemas keep theirs. Rather
  // than un-brand the ids to win a description, those parameters are documented
  // in the tool description, and this test holds that line: every parameter is
  // explained somewhere the agent actually reads.
  for (const tool of Object.values(SchedulesToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly properties?: Readonly<Record<string, unknown>>;
    };
    for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
      const documented =
        schemaHasDescription(fieldSchema) || (tool.description?.includes(field) ?? false);
      expect(
        documented,
        `${tool.name}.${field} is undocumented: annotate it, or name it in the tool description`,
      ).toBe(true);
    }
  }
});

it("marks the read-only tools read-only and never marks a tool destructive", () => {
  const readonly = (name: keyof typeof SchedulesToolkit.tools) =>
    Context.get(SchedulesToolkit.tools[name].annotations, Tool.Readonly);

  expect(readonly("list_schedules")).toBe(true);
  expect(readonly("get_schedule")).toBe(true);
  expect(readonly("create_schedule")).toBe(false);
  expect(readonly("update_schedule")).toBe(false);
  expect(readonly("set_schedule_state")).toBe(false);
  expect(readonly("run_schedule_now")).toBe(false);

  // Nothing here deletes: pausing is reversible, and this toolkit deliberately
  // has no delete tool at all.
  for (const tool of Object.values(SchedulesToolkit.tools)) {
    expect(
      Context.get(tool.annotations, Tool.Destructive),
      `${tool.name} must not be destructive`,
    ).toBe(false);
  }
});

it("exposes no tool that can delete a Schedule", () => {
  const names = Object.keys(SchedulesToolkit.tools);
  expect(names).not.toContain("delete_schedule");
  expect(names.some((name) => name.includes("delete"))).toBe(false);
});
