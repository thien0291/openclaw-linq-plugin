import { z } from "zod";

const e164PhoneSchema = z.string().regex(/^\+[1-9]\d{6,14}$/u, "expected E.164 phone number");
const allowFromEntrySchema = z.union([z.string().min(1), z.number()]);
const secretRefSchema = z.object({
  source: z.enum(["env", "file", "exec"]),
  provider: z.string().min(1).default("default"),
  id: z.string().min(1),
});

export const LinqAccountConfigSchema: z.ZodType<Record<string, unknown>> = z.lazy(() =>
  z
    .object({
      name: z.string().min(1).optional(),
      enabled: z.boolean().optional(),
      apiToken: z.union([z.string().min(1), secretRefSchema]).optional(),
      tokenFile: z.string().min(1).optional(),
      fromPhone: e164PhoneSchema.optional(),
      // TODO: default to "pairing" once durable Linq pairing setup is supported.
      dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).default("open").optional(),
      allowFrom: z.array(allowFromEntrySchema).optional(),
      // Group chats. Who may trigger the assistant (groupPolicy /
      // groupAllowFrom, falling back to allowFrom), per-chat settings, and how
      // many unanswered lines ride along as context on the next turn.
      groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),
      groupAllowFrom: z.array(allowFromEntrySchema).optional(),
      groups: z
        .record(
          z.string(),
          z
            .object({
              requireMention: z.boolean().optional(),
              enabled: z.boolean().optional(),
              participants: z.record(z.string(), z.string()).optional(),
            })
            .strict(),
        )
        .optional(),
      historyLimit: z.number().int().min(0).max(500).optional(),
      webhookUrl: z.string().url().optional(),
      webhookSecret: z.union([z.string().min(1), secretRefSchema]).optional(),
      webhookPath: z.string().regex(/^\/[A-Za-z0-9/_-]*$/u).default("/linq-webhook").optional(),
      webhookHost: z.string().min(1).optional(),
      accounts: z.record(z.string(), LinqAccountConfigSchema).optional(),
      defaultAccount: z.string().min(1).optional(),
      apiBase: z.string().url().optional(),
      // Outbound bubble size. The core deliver planner reads this via
      // resolveTextChunkLimit(cfg, "linq", …); without it the adapter's
      // static 4000 applies and a long reply lands as one iMessage.
      textChunkLimit: z.number().int().positive().max(4000).optional(),
      // Same planner knob as the built-in channels: "newline" flushes one
      // paragraph per message instead of packing paragraphs up to the limit.
      streaming: z
        .object({ chunkMode: z.enum(["length", "newline"]).optional() })
        .strict()
        .optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      const tokenSources = [value.apiToken, value.tokenFile].filter(Boolean);
      if (tokenSources.length > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "configure only one of apiToken or tokenFile",
          path: ["apiToken"],
        });
      }
    }),
);

export const LinqConfigSchema = LinqAccountConfigSchema;

export const LinqConfigJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    name: { type: "string", minLength: 1 },
    apiToken: { anyOf: [{ type: "string", minLength: 1 }, { $ref: "#/$defs/secretRef" }] },
    tokenFile: { type: "string", minLength: 1 },
    fromPhone: { type: "string", pattern: "^\\+[1-9]\\d{6,14}$" },
    dmPolicy: { enum: ["pairing", "allowlist", "open", "disabled"], default: "open" },
    allowFrom: { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } },
    groupPolicy: { enum: ["open", "allowlist", "disabled"] },
    groupAllowFrom: { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } },
    groups: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        properties: {
          requireMention: { type: "boolean" },
          enabled: { type: "boolean" },
          participants: { type: "object", additionalProperties: { type: "string" } },
        },
      },
    },
    historyLimit: { type: "integer", minimum: 0, maximum: 500 },
    webhookUrl: { type: "string", format: "uri" },
    webhookSecret: { anyOf: [{ type: "string", minLength: 1 }, { $ref: "#/$defs/secretRef" }] },
    webhookPath: { type: "string", pattern: "^/[A-Za-z0-9/_-]*$", default: "/linq-webhook" },
    webhookHost: { type: "string", minLength: 1 },
    accounts: { type: "object", additionalProperties: true },
    defaultAccount: { type: "string", minLength: 1 },
    apiBase: { type: "string", format: "uri" },
    textChunkLimit: { type: "integer", minimum: 1, maximum: 4000 },
    streaming: {
      type: "object",
      additionalProperties: false,
      properties: { chunkMode: { enum: ["length", "newline"] } },
    },
  },
  $defs: {
    secretRef: {
      type: "object",
      additionalProperties: false,
      required: ["source", "id"],
      properties: {
        source: { enum: ["env", "file", "exec"] },
        provider: { type: "string", default: "default" },
        id: { type: "string", minLength: 1 },
      },
    },
  },
};
