import { afterEach, describe, expect, it } from "vitest";
import { linqApiBase } from "./apiBase.js";

describe("linq api base", () => {
  afterEach(() => {
    delete process.env.LINQ_API_BASE;
  });

  it("defaults to Linq's own cloud", () => {
    expect(linqApiBase()).toBe("https://api.linqapp.com/api/partner/v3");
  });

  it("takes account config over env, and env over the default", () => {
    process.env.LINQ_API_BASE = "https://from-env.test/api/partner/v3";
    expect(linqApiBase()).toBe("https://from-env.test/api/partner/v3");

    expect(linqApiBase("https://relay.test/api/partner/v3")).toBe(
      "https://relay.test/api/partner/v3",
    );
  });

  it("ignores a blank value instead of pointing at nothing", () => {
    process.env.LINQ_API_BASE = "   ";
    expect(linqApiBase("   ")).toBe("https://api.linqapp.com/api/partner/v3");
  });

  it("strips trailing slashes so paths do not double up", () => {
    expect(linqApiBase("https://relay.test/api/partner/v3///")).toBe(
      "https://relay.test/api/partner/v3",
    );
  });
});

describe("apiBase is accepted by the config schema", () => {
  it("validates, because the schema is strict", async () => {
    // The schema is `.strict()` / additionalProperties:false, so an undeclared
    // key is a hard validation failure, not an ignored extra. Writing apiBase
    // into a cell running a plugin build without it would break the channel
    // outright — hence declaring it in BOTH schemas, and pinning that here.
    const { LinqConfigSchema, LinqConfigJsonSchema } = await import("./config.js");
    const parsed = LinqConfigSchema.safeParse({
      apiToken: "tok",
      apiBase: "https://relay.test/api/partner/v3",
    });
    expect(parsed.success).toBe(true);
    expect(LinqConfigJsonSchema.properties).toHaveProperty("apiBase");
  });

  it("still rejects a genuinely unknown key", async () => {
    // Guards against someone "fixing" a future rejection by loosening strict,
    // which would silently accept typo'd config instead of reporting it.
    const { LinqConfigSchema } = await import("./config.js");
    expect(LinqConfigSchema.safeParse({ apiToken: "tok", apiBse: "x" }).success)
      .toBe(false);
  });
});

describe("every published schema declares apiBase", () => {
  it("checks the whole manifest, not one hand-picked key", async () => {
    // Shipped broken once: apiBase was added to `configSchema` but NOT to
    // `channelConfigs.linq.schema`, which is the one the gateway validates
    // `channels.linq` against. Every gateway then refused to start with
    // 'must not have additional properties: "apiBase"' — a crash loop, not a
    // degraded channel. So walk the manifest instead of naming a path.
    const { readFileSync } = await import("node:fs");
    const manifest = JSON.parse(
      readFileSync(new URL("../../openclaw.plugin.json", import.meta.url), "utf8"),
    );

    const objectSchemas: Array<{ path: string; schema: Record<string, never> }> = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((v, i) => walk(v, `${path}[${i}]`));
        return;
      }
      if (!node || typeof node !== "object") return;
      const obj = node as Record<string, unknown>;
      if (obj.type === "object" && obj.properties && typeof obj.properties === "object") {
        objectSchemas.push({ path, schema: obj.properties as Record<string, never> });
      }
      for (const [k, v] of Object.entries(obj)) walk(v, path ? `${path}.${k}` : k);
    };
    walk(manifest, "");

    // Anything that knows about defaultAccount is a channel config schema and
    // must therefore accept apiBase too.
    const gaps = objectSchemas
      .filter(({ schema }) => "defaultAccount" in schema && !("apiBase" in schema))
      .map(({ path }) => path);
    expect(gaps).toEqual([]);
    expect(objectSchemas.some(({ schema }) => "apiBase" in schema)).toBe(true);
  });
});
