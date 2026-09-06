import {
  applyAccountNameToChannelSection,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  getChatChannelMeta,
  buildChannelConfigSchema,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/core";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { ResolvedLinqAccount } from "./linq/accounts.js";
import type { LinqProbe } from "./linq/types.js";
import { LinqConfigSchema } from "./linq/config.js";
import {
  listLinqAccountIds,
  resolveDefaultLinqAccountId,
  resolveLinqAccount,
  resolveLinqAccountForStatus,
} from "./linq/accounts.js";
import { probeLinq } from "./linq/probe.js";
import { sendMessageLinq } from "./linq/send.js";
import { parseLinqTarget } from "./linq/targets.js";
import { monitorLinqProvider } from "./linq/monitor.js";
import { linqOnboardingAdapter } from "./onboarding.js";
import { getLinqRuntime } from "./runtime.js";
import {
  collectLinqRuntimeConfigAssignments,
  linqSecretTargetRegistryEntries,
} from "./linq/secret-contract.js";

// beta.7 gateways may import the module before the chat-channel metadata
// registry knows plugin-manifest channels - fall back to the same values
// the manifest (package.json openclaw.channel) declares.
const meta = (() => {
  try {
    return getChatChannelMeta("linq");
  } catch {
    return {
      id: "linq",
      label: "Linq",
      selectionLabel: "Linq (Messaging API)",
      blurb: "iMessage, RCS, and SMS through the Linq API.",
    } as ReturnType<typeof getChatChannelMeta>;
  }
})();

export const linqPlugin: ChannelPlugin<ResolvedLinqAccount, LinqProbe> = {
  id: "linq",
  meta: {
    ...meta,
    aliases: ["linq-imessage"],
  },
  setupWizard: linqOnboardingAdapter as never,
  pairing: {
    idLabel: "phoneNumber",
    notifyApproval: async ({ id, accountId, cfg }) => {
      const account = resolveLinqAccount({ cfg, accountId });
      await sendMessageLinq(`linq:${id}`, "Pairing approved. You can now message this agent.", {
        account,
        accountId: account.accountId,
      });
    },
  },
  capabilities: {
    // Groups are first-class here (see monitorLinqProvider's group path): the
    // plugin holds a per-group context buffer, enforces the roster + mention
    // gates, and replies into the originating chat. Declaring "group" is what
    // lets the gateway route group events to this plugin at all.
    chatTypes: ["direct", "group"],
    reactions: false,
    media: true,
  },
  reload: { configPrefixes: ["channels.linq"] },
  configSchema: buildChannelConfigSchema(LinqConfigSchema),
  config: {
    listAccountIds: (cfg) => listLinqAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveLinqAccountForStatus({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultLinqAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "linq",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "linq",
        accountId,
        clearBaseFields: ["apiToken", "tokenFile", "fromPhone", "name", "service"],
      }),
    isConfigured: (account) => Boolean(account.token?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.token?.trim()),
      tokenSource: account.tokenSource,
      webhookSecretSource: account.webhookSecretSource,
      fromPhone: account.fromPhone,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveLinqAccountForStatus({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((entry) => String(entry).trim()).filter(Boolean),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const linqSection = (cfg.channels as Record<string, unknown> | undefined)?.linq as
        | Record<string, unknown>
        | undefined;
      const useAccountPath = Boolean(
        (linqSection?.accounts as Record<string, unknown> | undefined)?.[resolvedAccountId],
      );
      const basePath = useAccountPath
        ? `channels.linq.accounts.${resolvedAccountId}.`
        : "channels.linq.";
      return {
        policy: account.config.dmPolicy ?? "open",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("linq"),
      };
    },
  },
  messaging: {
    normalizeTarget: (raw: string) => {
      if (!raw) {
        return "";
      }
      try {
        return parseLinqTarget(raw).raw;
      } catch {
        return raw;
      }
    },
    targetResolver: {
      looksLikeId: (id) => {
        try {
          parseLinqTarget(id ?? "");
          return true;
        } catch {
          return false;
        }
      },
      hint: "linq:+15556667777 | linq:chat:<chat_id> | linq:<accountId>:+15556667777",
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "linq",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => {
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "LINQ_API_TOKEN can only be used for the default account.";
      }
      if (!input.useEnv && !input.token && !input.tokenFile) {
        return "Linq requires an API token or --token-file (or --use-env).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "linq",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({ cfg: namedConfig, channelKey: "linq" })
          : namedConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            linq: {
              ...((next.channels as Record<string, unknown> | undefined)?.linq as
                | Record<string, unknown>
                | undefined),
              enabled: true,
              ...(input.useEnv
                ? {}
                : input.tokenFile
                  ? { tokenFile: input.tokenFile }
                  : input.token
                    ? { apiToken: input.token }
                    : {}),
            },
          },
        };
      }
      const linqSection = (next.channels as Record<string, unknown> | undefined)?.linq as
        | Record<string, unknown>
        | undefined;
      return {
        ...next,
        channels: {
          ...next.channels,
          linq: {
            ...linqSection,
            enabled: true,
            accounts: {
              ...(linqSection?.accounts as Record<string, unknown> | undefined),
              [accountId]: {
                ...((linqSection?.accounts as Record<string, unknown> | undefined)?.[accountId] as
                  | Record<string, unknown>
                  | undefined),
                enabled: true,
                ...(input.tokenFile
                  ? { tokenFile: input.tokenFile }
                  : input.token
                    ? { apiToken: input.token }
                    : {}),
              },
            },
          },
        },
      };
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getLinqRuntime().channel.text.chunkText(text, limit),
    chunkerMode: "text",
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId }) => {
      const cfg = getLinqRuntime().config.current() as OpenClawConfig;
      const result = await sendMessageLinq(to, text, {
        accountId: accountId ?? undefined,
        config: cfg,
      });
      return { channel: "linq", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId }) => {
      const cfg = getLinqRuntime().config.current() as OpenClawConfig;
      const result = await sendMessageLinq(to, text, {
        mediaUrl,
        accountId: accountId ?? undefined,
        config: cfg,
      });
      return { channel: "linq", ...result };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts) =>
      accounts.flatMap((account) => {
        const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
        if (!lastError) {
          return [];
        }
        return [
          {
            channel: "linq",
            accountId: account.accountId,
            kind: "runtime",
            message: `Channel error: ${lastError}`,
          },
        ];
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      tokenSource: snapshot.tokenSource ?? "none",
      webhookSecretSource:
        ((snapshot as Record<string, unknown>).webhookSecretSource as string | undefined) ?? "none",
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) =>
      probeLinq(account.token, timeoutMs, account.config.apiBase),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.token?.trim()),
      tokenSource: account.tokenSource,
      webhookSecretSource: account.webhookSecretSource,
      fromPhone: account.fromPhone,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  secrets: {
    secretTargetRegistryEntries: linqSecretTargetRegistryEntries,
    collectRuntimeConfigAssignments: collectLinqRuntimeConfigAssignments,
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const token = account.token.trim();
      let phoneLabel = "";
      try {
        const probe = await probeLinq(token, 2500, account.config.apiBase);
        if (probe.ok && probe.phoneNumbers?.length) {
          phoneLabel = ` (${probe.phoneNumbers.join(", ")})`;
        }
      } catch {
        // Probe failure is non-fatal for startup.
      }
      ctx.log?.info(`[${account.accountId}] starting Linq provider${phoneLabel}`);
      return monitorLinqProvider({
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.log,
        abortSignal: ctx.abortSignal,
      });
    },
    logoutAccount: async ({ accountId, cfg }) => {
      const rt = getLinqRuntime();
      const nextCfg = { ...cfg };
      const linqSection = (cfg.channels as Record<string, unknown> | undefined)?.linq as
        | Record<string, unknown>
        | undefined;
      let cleared = false;
      let changed = false;
      if (linqSection) {
        const nextLinq = { ...linqSection };
        if (accountId === DEFAULT_ACCOUNT_ID && nextLinq.apiToken) {
          delete nextLinq.apiToken;
          cleared = true;
          changed = true;
        }
        const accounts =
          nextLinq.accounts && typeof nextLinq.accounts === "object"
            ? { ...(nextLinq.accounts as Record<string, unknown>) }
            : undefined;
        if (accounts && accountId in accounts) {
          const entry = accounts[accountId];
          if (entry && typeof entry === "object") {
            const nextEntry = { ...(entry as Record<string, unknown>) };
            if ("apiToken" in nextEntry) {
              cleared = true;
              delete nextEntry.apiToken;
              changed = true;
            }
            if (Object.keys(nextEntry).length === 0) {
              delete accounts[accountId];
              changed = true;
            } else {
              accounts[accountId] = nextEntry;
            }
          }
        }
        if (accounts) {
          if (Object.keys(accounts).length === 0) {
            delete nextLinq.accounts;
            changed = true;
          } else {
            nextLinq.accounts = accounts;
          }
        }
        if (changed) {
          if (Object.keys(nextLinq).length > 0) {
            nextCfg.channels = { ...nextCfg.channels, linq: nextLinq } as typeof nextCfg.channels;
          } else {
            const nextChannels = { ...nextCfg.channels } as Record<string, unknown>;
            delete nextChannels.linq;
            nextCfg.channels = nextChannels as typeof nextCfg.channels;
          }
        }
      }
      if (changed) {
        await rt.config.writeConfigFile(nextCfg);
      }
      const resolved = resolveLinqAccount({ cfg: changed ? nextCfg : cfg, accountId });
      return { cleared, loggedOut: resolved.tokenSource === "none" };
    },
  },
};
