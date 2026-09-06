import type { LinqSendResult } from "./types.js";
import { resolveLinqAccount, type ResolvedLinqAccount } from "./accounts.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { parseLinqTarget, type LinqTarget } from "./targets.js";
import { linqApiBase } from "./apiBase.js";
import { toPlainText } from "./format.js";

const UA = "OpenClaw-Linq/1.0";
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 500;

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = MAX_RETRIES,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, init);
    if (response.status === 429 && attempt < retries) {
      const retryAfter = Number(response.headers.get("retry-after")) || 0;
      const delay = retryAfter > 0 ? retryAfter * 1000 : RETRY_DELAY_MS * 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.min(delay, 10_000)));
      continue;
    }
    return response;
  }
}

export type LinqSendOpts = {
  accountId?: string;
  mediaUrl?: string;
  replyToMessageId?: string;
  verbose?: boolean;
  token?: string;
  config?: OpenClawConfig;
  account?: ResolvedLinqAccount;
  idempotencyKey?: string;
  apiBase?: string;
};

function buildSendUrl(target: LinqTarget, fromPhone?: string, apiBase?: string): string {
  if (target.kind === "phone") {
    if (!fromPhone?.trim()) {
      throw new Error("Linq phone targets require fromPhone on the selected account");
    }
    return `${linqApiBase(apiBase)}/chats`;
  }
  return `${linqApiBase(apiBase)}/chats/${encodeURIComponent(target.chatId)}/messages`;
}

function buildSendBody(
  target: LinqTarget,
  message: Record<string, unknown>,
  fromPhone?: string,
): Record<string, unknown> {
  if (target.kind === "phone") {
    if (!fromPhone?.trim()) {
      throw new Error("Linq phone targets require fromPhone on the selected account");
    }
    return { from: fromPhone.trim(), to: [target.phone], message };
  }
  return { message };
}

export async function sendMessageLinq(
  to: string,
  text: string,
  opts: LinqSendOpts = {},
): Promise<LinqSendResult> {
  const target = parseLinqTarget(to, opts.accountId ?? opts.account?.accountId);
  const account =
    opts.account && (!target.accountId || target.accountId === opts.account.accountId)
      ? opts.account
      : opts.config
        ? resolveLinqAccount({ cfg: opts.config, accountId: target.accountId ?? opts.accountId })
        : opts.account;

  const parts: Array<Record<string, unknown>> = [];
  if (text) {
    // Rendered here rather than at the call sites: this is the one place every
    // outbound message passes through, so a new caller cannot forget it and
    // ship raw asterisks to a handset.
    parts.push({ type: "text", value: toPlainText(text, opts.config) });
  }
  if (opts.mediaUrl?.trim()) {
    parts.push({ type: "media", url: opts.mediaUrl.trim() });
  }
  if (parts.length === 0) {
    throw new Error("Linq send requires text or media");
  }

  const message: Record<string, unknown> = { parts };
  if (opts.replyToMessageId?.trim()) {
    message.reply_to = { message_id: opts.replyToMessageId.trim() };
  }

  if (target.kind === "group") {
    throw new Error("Linq group sends are not enabled in this plugin version");
  }
  const resolvedAccount = account;
  const resolvedToken = opts.token?.trim() || resolvedAccount?.token;
  if (!resolvedToken) {
    throw new Error("Linq API token not configured");
  }
  const url = buildSendUrl(
    target,
    resolvedAccount?.fromPhone,
    opts.apiBase ?? resolvedAccount?.config.apiBase,
  );
  const headers: Record<string, string> = {
    Authorization: `Bearer ${resolvedToken}`,
    "Content-Type": "application/json",
    "User-Agent": UA,
  };
  if (opts.idempotencyKey?.trim()) {
    headers["Idempotency-Key"] = opts.idempotencyKey.trim();
  }
  const response = await fetchWithRetry(url, {
    method: "POST",
    headers,
    body: JSON.stringify(buildSendBody(target, message, resolvedAccount?.fromPhone)),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Linq API error: ${response.status} ${errorText.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    id?: string;
    chat_id?: string;
    message_id?: string;
    message?: { id?: string };
    chat?: { id?: string };
    trace_id?: string;
  };
  const messageId =
    data.message?.id ?? data.message_id ?? (data.chat_id && data.id ? data.id : "unknown");
  const chatId =
    data.chat_id ??
    data.chat?.id ??
    (target.kind === "phone" ? data.id : undefined) ??
    (target.kind === "chat" ? target.chatId : "unknown");
  return {
    messageId,
    chatId,
    target: target.raw,
    accountId: target.accountId ?? resolvedAccount?.accountId,
    fromPhone: resolvedAccount?.fromPhone,
    traceId: data.trace_id,
  };
}

/**
 * Fire-and-forget helper for side-effect API calls (typing, read receipts, reactions).
 * Swallows errors so callers don't need `.catch(() => {})` everywhere.
 */
async function fireAndForget(url: string, init: RequestInit): Promise<boolean> {
  try {
    const res = await fetch(url, init);
    return res.ok;
  } catch {
    return false;
  }
}

export async function startTypingLinq(
  chatId: string,
  token: string,
  apiBase?: string,
): Promise<boolean> {
  return fireAndForget(`${linqApiBase(apiBase)}/chats/${encodeURIComponent(chatId)}/typing`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "User-Agent": UA },
  });
}

export async function stopTypingLinq(
  chatId: string,
  token: string,
  apiBase?: string,
): Promise<boolean> {
  return fireAndForget(`${linqApiBase(apiBase)}/chats/${encodeURIComponent(chatId)}/typing`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}`, "User-Agent": UA },
  });
}

export async function markAsReadLinq(
  chatId: string,
  token: string,
  apiBase?: string,
): Promise<boolean> {
  return fireAndForget(`${linqApiBase(apiBase)}/chats/${encodeURIComponent(chatId)}/read`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "User-Agent": UA },
  });
}

export async function sendReactionLinq(
  messageId: string,
  type: "love" | "like" | "dislike" | "laugh" | "emphasize" | "question",
  token: string,
  operation: "add" | "remove" = "add",
  apiBase?: string,
): Promise<boolean> {
  return fireAndForget(`${linqApiBase(apiBase)}/messages/${encodeURIComponent(messageId)}/reactions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": UA,
    },
    body: JSON.stringify({ operation, type }),
  });
}
