import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { LinqConfigJsonSchema, LinqConfigSchema } from "./config.js";
import {
  listLinqAccountIds,
  resolveLinqAccount,
  resolveLinqAccountForStatus,
} from "./accounts.js";

describe("LinqConfigSchema", () => {
  it("accepts supported SecretRef-backed credentials and applies open dmPolicy by default", () => {
    const parsed = LinqConfigSchema.safeParse({
      apiToken: { source: "env", id: "LINQ_API_TOKEN" },
      webhookSecret: { source: "exec", provider: "vault", id: "linq/webhook-secret" },
      fromPhone: "+15556667777",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.dmPolicy).toBe("open");
  });

  it("rejects unsupported SecretRef sources and extra config knobs", () => {
    expect(
      LinqConfigSchema.safeParse({
        apiToken: { source: "literal", id: "op read token" },
      }).success,
    ).toBe(false);
    const invalid = LinqConfigSchema.safeParse({
      apiToken: "token",
      webhookMaxBytes: 2048,
    });
    expect(invalid.success).toBe(false);
  });
});

describe("resolveLinqAccount", () => {
  afterEach(() => {
    delete process.env.LINQ_TOKEN_TEST;
    delete process.env.LINQ_WEBHOOK_SECRET_TEST;
  });

  it("resolves env SecretRefs for account and webhook credentials", () => {
    process.env.LINQ_TOKEN_TEST = "resolved-token";
    process.env.LINQ_WEBHOOK_SECRET_TEST = "resolved-secret";

    const account = resolveLinqAccount({
      cfg: {
        channels: {
          linq: {
            accounts: {
              sales: {
                apiToken: { source: "env", id: "LINQ_TOKEN_TEST" },
                webhookSecret: { source: "env", id: "LINQ_WEBHOOK_SECRET_TEST" },
                fromPhone: "+15556667777",
              },
            },
          },
        },
      } as never,
      accountId: "sales",
    });

    expect(account).toMatchObject({
      accountId: "sales",
      token: "resolved-token",
      tokenSource: "env",
      webhookSecret: "resolved-secret",
      webhookSecretSource: "env",
      fromPhone: "+15556667777",
    });
  });

  it("throws on unresolved exec SecretRefs instead of treating them as missing", () => {
    expect(() =>
      resolveLinqAccount({
        cfg: {
          channels: {
            linq: {
              apiToken: { source: "exec", provider: "vault", id: "linq/token" },
            },
          },
        } as never,
      }),
    ).toThrow('channels.linq.apiToken: unresolved SecretRef "exec:vault:linq/token"');
  });

  it("keeps status resolution readable when SecretRefs are unresolved", () => {
    const account = resolveLinqAccountForStatus({
      cfg: {
        channels: {
          linq: {
            apiToken: { source: "env", id: "LINQ_TOKEN_TEST" },
            webhookSecret: { source: "env", id: "LINQ_WEBHOOK_SECRET_TEST" },
            fromPhone: "+15556667777",
          },
        },
      } as never,
    });

    expect(account).toMatchObject({
      token: "",
      tokenSource: "none",
      webhookSecret: "",
      webhookSecretSource: "none",
      fromPhone: "+15556667777",
    });
  });
});

describe("listLinqAccountIds", () => {
  it("keeps the legacy top-level account when WhatsApp is added beside it", () => {
    const cfg = {
      channels: {
        linq: {
          apiToken: "imessage-token",
          accounts: {
            whatsapp: {
              apiToken: "whatsapp-token",
              service: "WhatsApp",
            },
          },
        },
      },
    };

    expect(listLinqAccountIds(cfg as never)).toEqual(["default", "whatsapp"]);
  });
});

describe("LinqConfigSchema: outbound chunking keys", () => {
  it("accepts textChunkLimit and streaming.chunkMode", () => {
    const parsed = LinqConfigSchema.parse({
      apiToken: "tok",
      textChunkLimit: 220,
      streaming: { chunkMode: "newline" },
    });
    expect(parsed.textChunkLimit).toBe(220);
    expect(parsed.streaming?.chunkMode).toBe("newline");
  });

  it("declares both keys in the JSON schema the gateway validates against", () => {
    const props = LinqConfigJsonSchema.properties as Record<string, unknown>;
    expect(props.textChunkLimit).toBeDefined();
    expect(props.streaming).toBeDefined();
  });

  it("stays strict: unknown keys are still rejected", () => {
    expect(LinqConfigSchema.safeParse({ apiToken: "tok", bogus: 1 }).success).toBe(false);
    expect(
      LinqConfigSchema.safeParse({ apiToken: "tok", streaming: { mode: "block" } }).success,
    ).toBe(false);
  });
});

describe("openclaw.plugin.json", () => {
  // The gateway validates channels.linq against the MANIFEST (configSchema and
  // channelConfigs.linq.schema, both additionalProperties:false), not against the
  // code schema — a key declared only in code makes every cell refuse to start.
  it("declares every key the code schema declares, in both manifest schemas", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../openclaw.plugin.json", import.meta.url), "utf8"),
    );
    const code = Object.keys(LinqConfigJsonSchema.properties);
    for (const site of [
      manifest.configSchema.properties,
      manifest.channelConfigs.linq.schema.properties,
    ]) {
      for (const key of code) {
        expect(Object.keys(site), `manifest is missing ${key}`).toContain(key);
      }
    }
  });
});
