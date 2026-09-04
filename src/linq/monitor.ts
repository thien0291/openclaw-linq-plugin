import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  LinqGroupConfig,
  LinqMediaPart,
  LinqMessageReceivedData,
  LinqReactionReceivedData,
  LinqTextPart,
  LinqWebhookEvent,
} from "./types.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { createReplyPrefixOptions, waitUntilAbort } from "openclaw/plugin-sdk/channel-outbound";
import { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
import { resolveLinqAccount } from "./accounts.js";
import { markAsReadLinq, sendMessageLinq, startTypingLinq } from "./send.js";
import { getLinqRuntime } from "../runtime.js";
import { createLinqWebhookHandler, createMemoryLinqWebhookDedupeStore } from "./webhook.js";

const LINQ_WEBHOOK_MAX_BYTES = 1024 * 1024;
const LINQ_WEBHOOK_REPLAY_WINDOW_SECONDS = 300;
const LINQ_WEBHOOK_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
const activeWebhookPaths = new Map<string, string>();

export type MonitorLinqOpts = {
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: { info: (msg: string) => void; error?: (msg: string) => void };
  abortSignal?: AbortSignal;
};

function normalizeAllowList(raw?: Array<string | number>): string[] {
  if (!raw || !Array.isArray(raw)) {
    return [];
  }
  return raw.map((v) => String(v).trim()).filter(Boolean);
}

function extractTextContent(parts: Array<{ type: string; value?: string }>): string {
  return parts
    .filter((p): p is LinqTextPart => p.type === "text")
    .map((p) => p.value)
    .join("\n");
}

function extractMediaUrls(
  parts: Array<{ type: string; url?: string; mime_type?: string }>,
): Array<{ url: string; mimeType: string }> {
  return parts
    .filter(
      (p): p is LinqMediaPart & { url: string; mime_type: string } =>
        p.type === "media" && Boolean(p.url) && Boolean(p.mime_type),
    )
    .map((p) => ({ url: p.url, mimeType: p.mime_type }));
}

export function normalizeLinqMessageReceivedData(raw: unknown): LinqMessageReceivedData | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const data = raw as Record<string, unknown>;
  const legacyMessage = data.message as { id?: unknown; parts?: unknown; reply_to?: unknown } | undefined;
  if (
    typeof data.chat_id === "string" &&
    typeof data.from === "string" &&
    legacyMessage &&
    typeof legacyMessage.id === "string" &&
    Array.isArray(legacyMessage.parts)
  ) {
    return data as LinqMessageReceivedData;
  }

  const chat = data.chat as
    | {
        id?: unknown;
        owner_handle?: { handle?: unknown };
      }
    | undefined;
  const senderHandle = data.sender_handle as { handle?: unknown; is_me?: unknown } | undefined;
  if (
    typeof chat?.id !== "string" ||
    typeof senderHandle?.handle !== "string" ||
    !Array.isArray(data.parts) ||
    typeof data.id !== "string"
  ) {
    return null;
  }

  return {
    chat_id: chat.id,
    from: senderHandle.handle,
    recipient_phone:
      typeof chat.owner_handle?.handle === "string" ? chat.owner_handle.handle : "",
    received_at:
      typeof data.sent_at === "string"
        ? data.sent_at
        : typeof data.created_at === "string"
          ? data.created_at
          : "",
    is_from_me:
      data.direction === "outbound" ||
      senderHandle.is_me === true,
    service:
      data.service === "SMS" || data.service === "RCS" || data.service === "iMessage"
        ? data.service
        : "iMessage",
    message: {
      id: data.id,
      parts: data.parts as LinqMessageReceivedData["message"]["parts"],
      reply_to: data.reply_to as LinqMessageReceivedData["message"]["reply_to"],
    },
    ...groupFieldsOf(data),
  };
}

/** The group facts a provider may attach: a flag, the participants, a name. */
function groupFieldsOf(data: Record<string, unknown>): Pick<
  LinqMessageReceivedData,
  "is_group" | "participants" | "chat_display_name"
> {
  const out: Pick<LinqMessageReceivedData, "is_group" | "participants" | "chat_display_name"> = {};
  if (data.is_group === true) {
    out.is_group = true;
  }
  const raw = data.participants ?? (data.chat as { handles?: unknown } | undefined)?.handles;
  if (Array.isArray(raw)) {
    const handles = raw
      .map((entry) =>
        typeof entry === "string"
          ? entry
          : entry && typeof entry === "object" && typeof (entry as { handle?: unknown }).handle === "string"
            ? ((entry as { handle: string }).handle)
            : "",
      )
      .map((h) => h.trim())
      .filter(Boolean);
    if (handles.length > 0) {
      out.participants = handles;
    }
  }
  const name = data.chat_display_name ?? (data.chat as { display_name?: unknown } | undefined)?.display_name;
  if (typeof name === "string" && name.trim()) {
    out.chat_display_name = name.trim();
  }
  return out;
}

function isAllowedLinqSender(allowFrom: string[], sender: string): boolean {
  if (allowFrom.includes("*")) {
    return true;
  }
  const normalized = sender.replace(/[\s()-]/g, "").toLowerCase();
  return allowFrom.some((entry) => {
    const norm = entry.replace(/[\s()-]/g, "").toLowerCase();
    return norm === normalized;
  });
}

// ---- group chats ----------------------------------------------------------
//
// A group message goes through two gates before it becomes a turn, and it is
// always kept as context whether or not it does:
//   1. the sender gate — is this handle on the assistant's roster
//      (groupAllowFrom, else allowFrom plus pairing approvals)? A guest never
//      triggers a turn, and never gets a pairing code in a group.
//   2. the mention gate — was the assistant named (mentionPatterns, since
//      iMessage has no @-mention object) or replied to?

export type GroupLine = { at: string; from: string; name: string; text: string };

export type GroupTurnDecision = {
  authorized: boolean;
  mentioned: boolean;
  triggers: boolean;
  reason: string;
};

/** `messages.groupChat.mentionPatterns` as regexes; a bad pattern is skipped, not fatal. */
export function compileMentionPatterns(raw: unknown): RegExp[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: RegExp[] = [];
  for (const pattern of raw) {
    if (typeof pattern !== "string" || !pattern.trim()) {
      continue;
    }
    try {
      out.push(new RegExp(pattern, "i"));
    } catch {
      // an unparseable pattern must not take the whole channel down
    }
  }
  return out;
}

export function decideGroupTurn(params: {
  sender: string;
  text: string;
  replyToId?: string;
  groupPolicy?: "open" | "allowlist" | "disabled";
  roster: string[];
  requireMention: boolean;
  mentionPatterns: RegExp[];
  ownMessageIds: Set<string>;
}): GroupTurnDecision {
  if (params.groupPolicy === "disabled") {
    return { authorized: false, mentioned: false, triggers: false, reason: "groups are disabled" };
  }
  const authorized =
    params.groupPolicy === "open" ? true : isAllowedLinqSender(params.roster, params.sender);
  const named = params.mentionPatterns.some((re) => re.test(params.text));
  const replied = Boolean(params.replyToId && params.ownMessageIds.has(params.replyToId));
  const mentioned = !params.requireMention || named || replied;
  const triggers = authorized && mentioned;
  const reason = !authorized
    ? "sender is not on the roster: context only"
    : !mentioned
      ? "not addressed: context only"
      : "addressed by a roster member";
  return { authorized, mentioned, triggers, reason };
}

/** What the agent reads: the unanswered lines since its last turn, then the one that addressed it. */
export function buildGroupBodyForAgent(context: GroupLine[], current: GroupLine): string {
  const fmt = (line: GroupLine) => `${line.at} ${line.name}: ${line.text}`;
  const parts: string[] = [];
  if (context.length > 0) {
    parts.push("[Chat messages since your last reply - for context]", ...context.map(fmt), "");
  }
  parts.push("[Current message]", `${current.name}: ${current.text}`);
  return parts.join("\n");
}

export function clockOf(iso: string | undefined): string {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) {
    return "--:--";
  }
  return date.toISOString().slice(11, 16);
}

export async function monitorLinqProvider(opts: MonitorLinqOpts = {}): Promise<void> {
  const rt = getLinqRuntime();
  const logVerbose = (msg: string) => {
    if (rt.logging.shouldLogVerbose()) {
      opts.runtime?.info(msg);
    }
  };
  const cfg = opts.config ?? rt.config.loadConfig();
  const accountInfo = resolveLinqAccount({ cfg, accountId: opts.accountId });
  const linqCfg = accountInfo.config;
  const token = accountInfo.token;

  if (!token) {
    throw new Error("Linq API token not configured");
  }

  const allowFrom = normalizeAllowList(linqCfg.allowFrom);
  const dmPolicy = linqCfg.dmPolicy ?? "open";
  const webhookSecret = accountInfo.webhookSecret;
  const webhookPath = linqCfg.webhookPath?.trim() || "/linq-webhook";
  const fromPhone = accountInfo.fromPhone;

  // Group chats: the unanswered lines per chat (context for the next turn),
  // the ids of our own posts per chat (a reply to one counts as addressing
  // us), and the name patterns that stand in for @-mentions on iMessage.
  const groupBuffers = new Map<string, GroupLine[]>();
  const ownMessageIds = new Map<string, Set<string>>();
  const mentionPatterns = compileMentionPatterns(
    (cfg as unknown as { messages?: { groupChat?: { mentionPatterns?: unknown } } }).messages
      ?.groupChat?.mentionPatterns,
  );
  const historyLimit = typeof linqCfg.historyLimit === "number" ? linqCfg.historyLimit : 50;

  const inboundDebounceMs = rt.channel.debounce.resolveInboundDebounceMs({ cfg, channel: "linq" });
  const inboundDebouncer = rt.channel.debounce.createInboundDebouncer<{ event: LinqMessageReceivedData }>({
    debounceMs: inboundDebounceMs,
    buildKey: (entry) => {
      const sender = entry.event.from?.trim();
      if (!sender) {
        return null;
      }
      return `linq:${accountInfo.accountId}:${entry.event.chat_id}:${sender}`;
    },
    shouldDebounce: (entry) => {
      const text = extractTextContent(
        entry.event.message.parts as Array<{ type: string; value?: string }>,
      );
      if (!text.trim()) {
        return false;
      }
      return !rt.channel.text.hasControlCommand(text, cfg);
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        await handleMessage(last.event);
        return;
      }
      const combinedText = entries
        .map((e) =>
          extractTextContent(e.event.message.parts as Array<{ type: string; value?: string }>),
        )
        .filter(Boolean)
        .join("\n");
      const syntheticEvent: LinqMessageReceivedData = {
        ...last.event,
        message: {
          ...last.event.message,
          parts: [{ type: "text" as const, value: combinedText }],
        },
      };
      await handleMessage(syntheticEvent);
    },
    onError: (err) => {
      opts.runtime?.error?.(`linq debounce flush failed: ${String(err)}`);
    },
  });

  async function handleGroupMessage(data: LinqMessageReceivedData, sender: string) {
    const chatId = data.chat_id;
    const text = extractTextContent(data.message.parts as Array<{ type: string; value?: string }>);
    const media = extractMediaUrls(
      data.message.parts as Array<{ type: string; url?: string; mime_type?: string }>,
    );
    const bodyText = text.trim() || (media.length > 0 ? "<media:image>" : "");
    if (!bodyText) {
      return;
    }

    if (linqCfg.dmPolicy === "disabled") {
      return;
    }
    const groupCfg: LinqGroupConfig | undefined = linqCfg.groups?.[chatId];
    if (groupCfg?.enabled === false) {
      logVerbose(`linq group ${chatId}: muted in config`);
      return;
    }

    const names = groupCfg?.participants ?? {};
    const nameOf = (handle: string) => names[handle] ?? handle;
    const line: GroupLine = { at: clockOf(data.received_at), from: sender, name: nameOf(sender), text: bodyText };

    // The one await before the buffer is touched. Everything between the
    // push below and the splice further down is synchronous, so two messages
    // arriving together cannot interleave inside the buffer.
    let storeAllowFrom: Array<string | number> = [];
    try {
      storeAllowFrom =
        (await rt.channel.pairing.readAllowFromStore?.({
          channel: "linq",
          accountId: accountInfo.accountId,
        })) ?? [];
    } catch {
      storeAllowFrom = [];
    }

    // 1. Into the chat's context, whoever said it.
    const key = `${accountInfo.accountId}:${chatId}`;
    const buffer = groupBuffers.get(key) ?? [];
    buffer.push(line);
    while (buffer.length > Math.max(historyLimit, 1)) {
      buffer.shift();
    }
    groupBuffers.set(key, buffer);
    const myIndex = buffer.length - 1;

    // 2 + 3. The roster gate and the mention gate.
    const explicitRoster = normalizeAllowList(linqCfg.groupAllowFrom);
    const roster =
      explicitRoster.length > 0
        ? explicitRoster
        : Array.from(new Set([...allowFrom, ...storeAllowFrom]))
            .map((v) => String(v).trim())
            .filter(Boolean);
    const own = ownMessageIds.get(key) ?? new Set<string>();
    const decision = decideGroupTurn({
      sender,
      text: bodyText,
      replyToId: data.message.reply_to?.message_id,
      groupPolicy: linqCfg.groupPolicy,
      roster,
      requireMention: groupCfg?.requireMention ?? true,
      mentionPatterns,
      ownMessageIds: own,
    });
    logVerbose(`linq group ${chatId}: ${sender} — ${decision.reason}`);
    if (!decision.triggers) {
      // Context kept; nothing said. A group never gets a pairing code.
      return;
    }

    // The unanswered lines before this one are this turn's context; they and
    // this line leave the buffer, anything that landed after stays for the
    // next turn. Still synchronous with the push above.
    const context = buffer.slice(0, myIndex);
    buffer.splice(0, myIndex + 1);

    markAsReadLinq(chatId, token);
    startTypingLinq(chatId, token);

    // 4. A turn, in the chat's own session — never in anyone's private thread.
    const route = rt.channel.routing.resolveAgentRoute({
      cfg,
      channel: "linq",
      accountId: accountInfo.accountId,
      peer: { kind: "group", id: chatId },
    });
    const bodyForAgent = buildGroupBodyForAgent(context, line);

    const createdAt = data.received_at ? Date.parse(data.received_at) : undefined;
    const storePath = rt.channel.session.resolveStorePath(cfg.session?.store, { agentId: route.agentId });
    const envelopeOptions = rt.channel.reply.resolveEnvelopeFormatOptions(cfg);
    const previousTimestamp = rt.channel.session.readSessionUpdatedAt({
      storePath,
      sessionKey: route.sessionKey,
    });
    const participantsLabel = (data.participants ?? []).map(nameOf).join(", ");
    const conversationLabel = data.chat_display_name || participantsLabel || chatId;

    const body = rt.channel.reply.formatAgentEnvelope({
      channel: "Linq iMessage",
      from: conversationLabel,
      timestamp: createdAt,
      body: bodyForAgent,
      chatType: "group",
      sender: { name: line.name, id: sender },
      previousTimestamp,
      envelope: envelopeOptions,
    } as unknown as Parameters<typeof rt.channel.reply.formatAgentEnvelope>[0]);

    const ctxPayload = rt.channel.reply.finalizeInboundContext({
      Body: body,
      BodyForAgent: bodyForAgent,
      RawBody: bodyText,
      CommandBody: bodyText,
      From: `linq:${sender}`,
      To: chatId,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: "group",
      ConversationLabel: conversationLabel,
      SenderName: line.name,
      SenderId: sender,
      Provider: "linq",
      Surface: "linq",
      MessageSid: data.message.id,
      ReplyToId: data.message.reply_to?.message_id,
      Timestamp: createdAt,
      MediaUrl: media[0]?.url,
      MediaType: media[0]?.mimeType,
      MediaUrls: media.length > 0 ? media.map((m) => m.url) : undefined,
      MediaTypes: media.length > 0 ? media.map((m) => m.mimeType) : undefined,
      WasMentioned: true,
      CommandAuthorized: decision.authorized,
      OriginatingChannel: "linq" as const,
      OriginatingTo: chatId,
    });

    // Deliberately no `updateLastRoute`: the main session's last route is the
    // owner's private thread, and a group turn must never point an
    // agent-initiated send (a digest, a message-tool call) at the group.
    await rt.channel.session.recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
      onRecordError: (err) => {
        logVerbose(`linq: failed updating session meta: ${String(err)}`);
      },
    });

    logVerbose(`linq group inbound: chatId=${chatId} from=${sender} context=${context.length}`);

    const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
      cfg,
      agentId: route.agentId,
      channel: "linq",
      accountId: route.accountId,
    });

    await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        ...prefixOptions,
        deliver: async (payload) => {
          const replyText = typeof payload === "string" ? payload : (payload.text ?? "");
          if (replyText) {
            const receipt = await sendMessageLinq(`linq:chat:${chatId}`, replyText, {
              token,
              accountId: accountInfo.accountId,
            });
            if (receipt?.messageId) {
              own.add(receipt.messageId);
              ownMessageIds.set(key, own);
            }
          }
        },
      },
    });
  }

  async function handleMessage(data: LinqMessageReceivedData) {
    const sender = data.from?.trim();
    if (!sender) {
      return;
    }
    if (data.is_from_me) {
      return;
    }
    if (fromPhone && data.recipient_phone !== fromPhone) {
      logVerbose(`linq: skipping message to ${data.recipient_phone} (not ${fromPhone})`);
      return;
    }
    if (data.is_group) {
      // A group is its own path: no pairing, its own session. The channel
      // switch (dmPolicy: disabled) still applies to it.
      await handleGroupMessage(data, sender);
      return;
    }

    const chatId = data.chat_id;
    const text = extractTextContent(data.message.parts as Array<{ type: string; value?: string }>);
    const media = extractMediaUrls(
      data.message.parts as Array<{ type: string; url?: string; mime_type?: string }>,
    );

    if (!text.trim() && media.length === 0) {
      return;
    }

    markAsReadLinq(chatId, token);
    startTypingLinq(chatId, token);

    // beta.7 SDKs may not implement readAllowFromStore (returns undefined,
    // so a chained .catch throws). Tolerate missing/void/throwing here.
    let storeAllowFrom: Array<string | number> = [];
    try {
      storeAllowFrom =
        (await rt.channel.pairing.readAllowFromStore?.({
          channel: "linq",
          accountId: accountInfo.accountId,
        })) ?? [];
    } catch {
      storeAllowFrom = [];
    }
    const effectiveDmAllowFrom = Array.from(new Set([...allowFrom, ...storeAllowFrom]))
      .map((v) => String(v).trim())
      .filter(Boolean);

    const dmHasWildcard = effectiveDmAllowFrom.includes("*");
    const dmAuthorized =
      dmPolicy === "open"
        ? true
        : dmHasWildcard ||
          (effectiveDmAllowFrom.length > 0 && isAllowedLinqSender(effectiveDmAllowFrom, sender));

    if (dmPolicy === "disabled") {
      return;
    }
    if (!dmAuthorized) {
      if (dmPolicy === "pairing") {
        const { code, created } = await rt.channel.pairing.upsertPairingRequest({
          channel: "linq",
          id: sender,
          accountId: accountInfo.accountId,
          meta: { sender, chatId },
        });
        if (created) {
          logVerbose(`linq pairing request sender=${sender}`);
          try {
            await sendMessageLinq(
              `linq:chat:${chatId}`,
              rt.channel.pairing.buildPairingReply({
                channel: "linq",
                idLine: `Your phone number: ${sender}`,
                code,
              }),
              { token, accountId: accountInfo.accountId },
            );
          } catch (err) {
            logVerbose(`linq pairing reply failed for ${sender}: ${String(err)}`);
          }
        }
      } else {
        logVerbose(`Blocked linq sender ${sender} (dmPolicy=${dmPolicy})`);
      }
      return;
    }

    const route = rt.channel.routing.resolveAgentRoute({
      cfg,
      channel: "linq",
      accountId: accountInfo.accountId,
      peer: { kind: "direct", id: sender },
    });
    const bodyText = text.trim() || (media.length > 0 ? "<media:image>" : "");
    if (!bodyText) {
      return;
    }

    const replyContext = data.message.reply_to ? { id: data.message.reply_to.message_id } : null;
    const createdAt = data.received_at ? Date.parse(data.received_at) : undefined;

    const fromLabel = sender;
    const storePath = rt.channel.session.resolveStorePath(cfg.session?.store, { agentId: route.agentId });
    const envelopeOptions = rt.channel.reply.resolveEnvelopeFormatOptions(cfg);
    const previousTimestamp = rt.channel.session.readSessionUpdatedAt({
      storePath,
      sessionKey: route.sessionKey,
    });

    const replySuffix = replyContext?.id ? `\n\n[Replying to message ${replyContext.id}]` : "";
    const body = rt.channel.reply.formatAgentEnvelope({
      channel: "Linq iMessage",
      from: fromLabel,
      timestamp: createdAt,
      body: `${bodyText}${replySuffix}`,
      chatType: "direct",
      sender: { name: sender, id: sender },
      previousTimestamp,
      envelope: envelopeOptions,
    });

    const linqTo = chatId;
    const ctxPayload = rt.channel.reply.finalizeInboundContext({
      Body: body,
      BodyForAgent: bodyText,
      RawBody: bodyText,
      CommandBody: bodyText,
      From: `linq:${sender}`,
      To: linqTo,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: "direct",
      ConversationLabel: fromLabel,
      SenderName: sender,
      SenderId: sender,
      Provider: "linq",
      Surface: "linq",
      MessageSid: data.message.id,
      ReplyToId: replyContext?.id,
      Timestamp: createdAt,
      MediaUrl: media[0]?.url,
      MediaType: media[0]?.mimeType,
      MediaUrls: media.length > 0 ? media.map((m) => m.url) : undefined,
      MediaTypes: media.length > 0 ? media.map((m) => m.mimeType) : undefined,
      WasMentioned: true,
      CommandAuthorized: dmAuthorized,
      OriginatingChannel: "linq" as const,
      OriginatingTo: linqTo,
    });

    await rt.channel.session.recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
      updateLastRoute: {
        sessionKey: route.mainSessionKey,
        channel: "linq",
        to: linqTo,
        accountId: route.accountId,
      },
      onRecordError: (err) => {
        logVerbose(`linq: failed updating session meta: ${String(err)}`);
      },
    });

    logVerbose(
      `linq inbound: chatId=${chatId} from=${sender} len=${body.length}`,
    );

    const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
      cfg,
      agentId: route.agentId,
      channel: "linq",
      accountId: route.accountId,
    });

    await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        ...prefixOptions,
        deliver: async (payload) => {
          const replyText = typeof payload === "string" ? payload : (payload.text ?? "");
          if (replyText) {
            await sendMessageLinq(`linq:chat:${chatId}`, replyText, {
              token,
              accountId: accountInfo.accountId,
            });
          }
        },
      },
    });
  }

  const webhookHandler = createLinqWebhookHandler({
    path: webhookPath,
    secret: webhookSecret,
    maxBytes: LINQ_WEBHOOK_MAX_BYTES,
    replayWindowSeconds: LINQ_WEBHOOK_REPLAY_WINDOW_SECONDS,
    dedupeTtlMs: LINQ_WEBHOOK_DEDUPE_TTL_MS,
    dedupeStore: createMemoryLinqWebhookDedupeStore(),
  });

  const currentPathOwner = activeWebhookPaths.get(webhookPath);
  if (currentPathOwner && currentPathOwner !== accountInfo.accountId) {
    throw new Error(
      `Linq webhook path ${webhookPath} is already registered by account ${currentPathOwner}; configure a distinct webhookPath for account ${accountInfo.accountId}.`,
    );
  }

  const unregister = registerPluginHttpRoute({
    path: webhookPath,
    auth: "plugin",
    pluginId: "linq",
    accountId: accountInfo.accountId,
    replaceExisting: true,
    log: (msg) => opts.runtime?.info(msg),
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);
      const chunks: Buffer[] = [];
      let size = 0;
      const maxPayloadBytes = LINQ_WEBHOOK_MAX_BYTES;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > maxPayloadBytes) {
          res.writeHead(413);
          res.end();
          return;
        }
        chunks.push(chunk as Buffer);
      }
      const result = await webhookHandler({
        method: req.method ?? "GET",
        path: url.pathname,
        headers: req.headers,
        body: Buffer.concat(chunks),
      });

      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(result.body);

      if (!result.event || result.duplicate) {
        return;
      }

      try {
        const event = result.event as LinqWebhookEvent;
        if (event.event_type === "message.received") {
          const data = normalizeLinqMessageReceivedData(event.data);
          if (!data) {
            logVerbose(`linq webhook ignored malformed message.received event ${event.event_id}`);
            return;
          }
          // The 2026.7.x SDK's inbound debouncer expects onFlush to return an
          // {admission, completion} pair built from a flush factory; this
          // plugin pin predates that contract, so enqueue() throws inside the
          // SDK. Debouncing only coalesces rapid consecutive texts, so dispatch
          // each message directly rather than depend on the version-specific
          // debouncer shape.
          await handleMessage(data);
        } else if (event.event_type === "reaction.received") {
          const data = event.data as LinqReactionReceivedData;
          if (!data.is_from_me && data.reaction) {
            logVerbose(
              `linq reaction: ${data.reaction.operation} ${data.reaction.type} from=${data.from} msg=${data.message_id}`,
            );
          }
        } else if (event.event_type === "message.delivery_status") {
          logVerbose(`linq delivery: ${(event.data as { status?: string })?.status} msg=${(event.data as { message_id?: string })?.message_id}`);
        }
      } catch (err) {
        opts.runtime?.error?.(
          `linq webhook parse error: ${String(err)} :: STACK ${(err as Error)?.stack ?? "no-stack"}`,
        );
      }
    },
  });
  activeWebhookPaths.set(webhookPath, accountInfo.accountId);
  opts.runtime?.info(`linq: registered webhook route ${webhookPath} for account ${accountInfo.accountId}`);
  await waitUntilAbort(opts.abortSignal, () => {
    unregister();
    if (activeWebhookPaths.get(webhookPath) === accountInfo.accountId) {
      activeWebhookPaths.delete(webhookPath);
    }
  });
}
