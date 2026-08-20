import { describe, expect, it } from "vitest";

import { createWorkflowManifestSchema } from "./manifest.ts";

const schema = createWorkflowManifestSchema("Europe/London");

const validManifest = {
  key: "prospect-research",
  title: "Prospect research",
  skill: "SKILL.md",
  schedules: [{ cron: "0 6 * * 1-5", timezone: "Europe/London", enabled: true }],
};

describe("workflow manifest schema", () => {
  it("accepts a fully specified valid manifest", () => {
    const result = schema.safeParse(validManifest);
    expect(result.success).toBe(true);
  });

  it("accepts the minimal shape and fills in defaults", () => {
    const result = schema.safeParse({ key: "ping", title: "Ping", skill: "SKILL.md" });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.schedules).toEqual([]);
  });

  it("defaults a schedule's timezone to the schema's default timezone", () => {
    const result = schema.safeParse({
      key: "ping",
      title: "Ping",
      skill: "SKILL.md",
      schedules: [{ cron: "* * * * *" }],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.schedules[0]?.timezone).toBe("Europe/London");
    expect(result.data.schedules[0]?.enabled).toBe(true);
  });

  it.each(["Prospect-Research", "1_bad", "-leading-dash", "has space", ""])(
    "rejects an invalid key %j",
    (key) => {
      const result = schema.safeParse({ ...validManifest, key });
      expect(result.success).toBe(false);
    },
  );

  it.each(["prospect-research", "a", "a1-b2"])("accepts a valid key %j", (key) => {
    const result = schema.safeParse({ ...validManifest, key });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid cron expression", () => {
    const result = schema.safeParse({
      ...validManifest,
      schedules: [{ cron: "not a cron", timezone: "Europe/London" }],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((issue) => issue.path.join(".") === "schedules.0.cron")).toBe(
      true,
    );
  });

  it("rejects a cron expression with too few fields", () => {
    const result = schema.safeParse({ ...validManifest, schedules: [{ cron: "* * *" }] });
    expect(result.success).toBe(false);
  });

  it("accepts optional description, input_schema, timeout_ms, and phoenix overrides", () => {
    const result = schema.safeParse({
      ...validManifest,
      description: "does research",
      input_schema: { type: "object", properties: { company: { type: "string" } } },
      timeout_ms: 3_600_000,
      phoenix: {
        provider_instance_id: "claudeAgent",
        model: "claude-fable-5",
        runtime_mode: "auto",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown phoenix runtime_mode", () => {
    const result = schema.safeParse({ ...validManifest, phoenix: { runtime_mode: "yolo" } });
    expect(result.success).toBe(false);
  });

  it("rejects a non-positive timeout_ms", () => {
    const result = schema.safeParse({ ...validManifest, timeout_ms: 0 });
    expect(result.success).toBe(false);
  });
});
