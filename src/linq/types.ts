/** Linq Blue V3 webhook event envelope. */
export type LinqWebhookEvent = {
  api_version: "v3";
  event_id: string;
  created_at: string;
  trace_id: string;
  partner_id: string;
  event_type: string;
  data: unknown;
};

export type LinqMessageReceivedData = {
  chat_id: string;
  from: string;
  recipient_phone: string;
  received_at: string;
  is_from_me: boolean;
  service: "iMessage" | "SMS" | "RCS";
  message: LinqIncomingMessage;
  /** A group chat: `from` is one participant, `chat_id` is the whole chat. */
  is_group?: boolean;
  /** Participant handles as the provider last reported them. */
  participants?: string[];
  chat_display_name?: string;
};

/** Per-group settings, keyed by the chat id the provider delivers. */
export type LinqGroupConfig = {
  /** Answer only when named (mention patterns) or replied to. Default true. */
  requireMention?: boolean;
  /** false ⇒ the assistant hears nothing from this chat (muted at the cell). */
  enabled?: boolean;
  /** Handle → display name, so the agent sees "Ben", not a phone number. */
  participants?: Record<string, string>;
};

export type LinqIncomingMessage = {
  id: string;
  parts: LinqMessagePart[];
  effect?: { type: "screen" | "bubble"; name: string };
  reply_to?: { message_id: string; part_index?: number };
};

export type LinqTextPart = { type: "text"; value: string };
export type LinqMediaPart = {
  type: "media";
  url?: string;
  attachment_id?: string;
  filename?: string;
  mime_type?: string;
  size?: number;
};
export type LinqMessagePart = LinqTextPart | LinqMediaPart;

export type LinqReactionReceivedData = {
  chat_id: string;
  from: string;
  message_id: string;
  reaction: {
    type: "love" | "like" | "dislike" | "laugh" | "emphasize" | "question";
    operation: "add" | "remove";
  };
  received_at: string;
  is_from_me: boolean;
};

export type LinqDeliveryStatusData = {
  chat_id: string;
  message_id: string;
  status: "delivered" | "read" | "failed";
  updated_at: string;
};

export type LinqSendResult = {
  messageId: string;
  chatId: string;
  target: string;
  accountId?: string;
  fromPhone?: string;
  traceId?: string;
};

export type LinqProbe = {
  ok: boolean;
  error?: string | null;
  phoneNumbers?: string[];
};

export type LinqSecretRef = {
  source: "env" | "file" | "exec";
  provider?: string;
  id: string;
};

/** Per-account config for the Linq channel (mirrors the Zod schema shape). */
export type LinqAccountConfig = {
  name?: string;
  enabled?: boolean;
  /** Linq API bearer token or SecretRef-backed token. */
  apiToken?: string | LinqSecretRef;
  /** Read token from file instead of config (mutual exclusive with apiToken). */
  tokenFile?: string;
  /** Phone number this account sends from (E.164). */
  fromPhone?: string;
  /** DM security policy. */
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  /** Allowed sender IDs (phone numbers or "*"). */
  allowFrom?: Array<string | number>;
  /**
   * Who may make the assistant answer in a group chat. `allowlist` (default)
   * means `groupAllowFrom`, falling back to `allowFrom` — the roster; `open`
   * lets anyone in the chat trigger it; `disabled` mutes every group.
   */
  groupPolicy?: "open" | "allowlist" | "disabled";
  /** Allowed group sender IDs; falls back to allowFrom when unset. */
  groupAllowFrom?: Array<string | number>;
  /** Max media size in MB (default: 10). */
  mediaMaxMb?: number;
  /** Max text chunk length (default: 4000). */
  textChunkLimit?: number;
  /** Deliver-planner chunking; "newline" = one paragraph per message. */
  streaming?: { chunkMode?: "length" | "newline" };
  /** Webhook URL for inbound messages from Linq. */
  webhookUrl?: string;
  /** Webhook HMAC signing secret or SecretRef-backed secret. */
  webhookSecret?: string | LinqSecretRef;
  /** Local HTTP path prefix for the webhook listener (default: /linq-webhook). */
  webhookPath?: string;
  /** Deprecated: OpenClaw owns plugin route binding. */
  webhookHost?: string;
  /** How many unanswered group lines are kept as context for the next turn (default 50). */
  historyLimit?: number;
  /** Block streaming responses. */
  blockStreaming?: boolean;
  /** Group configs keyed by chat_id. */
  groups?: Record<string, LinqGroupConfig>;
  /** Per-account sub-accounts. */
  accounts?: Record<string, LinqAccountConfig>;
  /** Preferred default account id. */
  defaultAccount?: string;
  /**
   * Partner API origin, including the version path. Defaults to Linq's own
   * cloud. Set it to point the channel at an API-compatible host instead —
   * MLabRelay serves this surface for pooled lines. Config rather than env
   * because a cell is created before its channel is connected, so an env var
   * can never carry a value that is only known at connect time.
   */
  apiBase?: string;
};
