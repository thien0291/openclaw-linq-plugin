import { afterEach, describe, expect, it, vi } from "vitest";
import { sendMessageLinq } from "./send.js";

describe("sendMessageLinq", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends to existing chats through the chat endpoint", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ chat_id: "chat_1", message: { id: "msg_1" } }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const receipt = await sendMessageLinq("linq:chat:chat_1", "hello", {
      token: "token",
      accountId: "default",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.linqapp.com/api/partner/v3/chats/chat_1/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ message: { parts: [{ type: "text", value: "hello" }] } }),
      }),
    );
    expect(receipt).toMatchObject({ messageId: "msg_1", chatId: "chat_1", accountId: "default" });
  });

  it("sends first-contact phone targets from the account phone line", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ id: "chat_2" }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const receipt = await sendMessageLinq("linq:sales:+15556667777", "hello", {
      account: {
        accountId: "sales",
        enabled: true,
        token: "token",
        tokenSource: "config",
        webhookSecret: "",
        webhookSecretSource: "none",
        fromPhone: "+15551112222",
        config: {},
      },
      idempotencyKey: "idem_1",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.linqapp.com/api/partner/v3/chats",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Idempotency-Key": "idem_1" }),
        body: JSON.stringify({
          from: "+15551112222",
          to: ["+15556667777"],
          message: { parts: [{ type: "text", value: "hello" }] },
        }),
      }),
    );
    expect(receipt).toMatchObject({ messageId: "unknown", chatId: "chat_2" });
  });

  it("keeps explicit chat targets on the existing-chat endpoint even with colon chat ids", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ chat_id: "chat:with:colon", message: { id: "msg_3" } }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await sendMessageLinq("linq:chat:chat:with:colon", "hello", {
      token: "token",
      accountId: "default",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.linqapp.com/api/partner/v3/chats/chat%3Awith%3Acolon/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ message: { parts: [{ type: "text", value: "hello" }] } }),
      }),
    );
  });

  it("routes each account through its own API base", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ chat_id: "chat_1", message: { id: "msg_1" } }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await sendMessageLinq("linq:chat:chat_1", "whatsapp", {
      account: {
        accountId: "whatsapp",
        enabled: true,
        token: "whatsapp-token",
        tokenSource: "config",
        webhookSecret: "",
        webhookSecretSource: "none",
        config: { apiBase: "https://relay.test/api/partner/v3" },
      },
    });
    await sendMessageLinq("linq:chat:chat_1", "imessage", {
      token: "imessage-token",
      accountId: "default",
    });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://relay.test/api/partner/v3/chats/chat_1/messages",
      "https://api.linqapp.com/api/partner/v3/chats/chat_1/messages",
    ]);
  });

  it("rejects phone targets without a configured fromPhone", async () => {
    await expect(sendMessageLinq("linq:+15556667777", "hello", { token: "token" })).rejects.toThrow(
      /fromPhone/u,
    );
  });
});
