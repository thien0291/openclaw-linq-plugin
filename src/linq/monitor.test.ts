import { describe, expect, it } from "vitest";
import { normalizeLinqMessageReceivedData } from "./monitor.js";

describe("normalizeLinqMessageReceivedData", () => {
  it("keeps the legacy 2025 message.received shape", () => {
    const data = {
      chat_id: "chat_1",
      from: "+12025550100",
      recipient_phone: "+12025550101",
      received_at: "2026-02-05T19:31:13.736Z",
      is_from_me: false,
      service: "SMS",
      message: {
        id: "msg_1",
        parts: [{ type: "text", value: "hello" }],
      },
    };

    expect(normalizeLinqMessageReceivedData(data)).toEqual(data);
  });

  it("normalizes the current 2026 message.received shape", () => {
    expect(
      normalizeLinqMessageReceivedData({
        chat: {
          id: "chat_2",
          owner_handle: { handle: "+12025550101" },
        },
        id: "msg_2",
        direction: "inbound",
        sender_handle: { handle: "+12025550100", is_me: false },
        parts: [{ type: "text", value: "hello" }],
        sent_at: "2026-02-05T19:31:13.074Z",
        service: "SMS",
      }),
    ).toEqual({
      chat_id: "chat_2",
      from: "+12025550100",
      recipient_phone: "+12025550101",
      received_at: "2026-02-05T19:31:13.074Z",
      is_from_me: false,
      service: "SMS",
      message: {
        id: "msg_2",
        parts: [{ type: "text", value: "hello" }],
      },
    });
  });
});

import {
  buildGroupBodyForAgent,
  clockOf,
  compileMentionPatterns,
  decideGroupTurn,
} from "./monitor.js";

describe("group turns: the roster gate and the mention gate", () => {
  const patterns = compileMentionPatterns(["@?\\bPA\\b", "partnership\\s*agent"]);
  const roster = ["+84912357477", "+84903331122"];
  const base = { roster, requireMention: true, mentionPatterns: patterns, ownMessageIds: new Set<string>() };

  it("a roster member who names the assistant triggers a turn", () => {
    const d = decideGroupTurn({ ...base, sender: "+84912357477", text: "@PA how does that compare to the deck?" });
    expect(d).toMatchObject({ authorized: true, mentioned: true, triggers: true });
  });

  it("a roster member who does not name it is context only", () => {
    const d = decideGroupTurn({ ...base, sender: "+84903331122", text: "nice" });
    expect(d).toMatchObject({ authorized: true, mentioned: false, triggers: false });
  });

  it("a guest never triggers a turn, even when naming it", () => {
    const d = decideGroupTurn({ ...base, sender: "+14155550142", text: "@PA what is your valuation view?" });
    expect(d).toMatchObject({ authorized: false, triggers: false });
  });

  it("a reply to the assistant's own message counts as addressing it", () => {
    const d = decideGroupTurn({
      ...base,
      sender: "+84912357477",
      text: "and the cohort table?",
      replyToId: "m1",
      ownMessageIds: new Set(["m1"]),
    });
    expect(d.triggers).toBe(true);
  });

  it("the roster match ignores formatting, like the DM allow list does", () => {
    const d = decideGroupTurn({ ...base, sender: "+84 91 235 7477", text: "PA, summarise" });
    expect(d.triggers).toBe(true);
  });

  it("groupPolicy open lets a guest ask", () => {
    const d = decideGroupTurn({ ...base, groupPolicy: "open", sender: "+14155550142", text: "@PA status?" });
    expect(d.triggers).toBe(true);
  });

  it("groupPolicy disabled silences the group", () => {
    const d = decideGroupTurn({ ...base, groupPolicy: "disabled", sender: "+84912357477", text: "@PA?" });
    expect(d.triggers).toBe(false);
  });

  it("requireMention false answers every roster message and still no guest", () => {
    expect(decideGroupTurn({ ...base, requireMention: false, sender: "+84912357477", text: "hi" }).triggers).toBe(true);
    expect(decideGroupTurn({ ...base, requireMention: false, sender: "+14155550142", text: "hi" }).triggers).toBe(false);
  });

  it("an unparseable pattern is skipped rather than fatal", () => {
    expect(compileMentionPatterns(["(", "@?\\bPA\\b"])).toHaveLength(1);
    expect(compileMentionPatterns(undefined)).toEqual([]);
  });
});

describe("group context handed to the agent", () => {
  const alex = { at: "03:11", from: "+14155550142", name: "Alex (Avango)", text: "churn was 4.2% last quarter" };
  const ben = { at: "03:12", from: "+84903331122", name: "Ben", text: "nice" };
  const me = { at: "03:12", from: "+84912357477", name: "Thien", text: "@PA how does that compare to the deck?" };

  it("puts the unanswered lines before the one that addressed it", () => {
    expect(buildGroupBodyForAgent([alex, ben], me)).toBe(
      [
        "[Chat messages since your last reply - for context]",
        "03:11 Alex (Avango): churn was 4.2% last quarter",
        "03:12 Ben: nice",
        "",
        "[Current message]",
        "Thien: @PA how does that compare to the deck?",
      ].join("\n"),
    );
  });

  it("with nothing buffered, only the current line", () => {
    expect(buildGroupBodyForAgent([], me)).toBe("[Current message]\nThien: @PA how does that compare to the deck?");
  });

  it("clock labels come from the provider timestamp", () => {
    expect(clockOf("2026-09-04T03:12:41Z")).toBe("03:12");
    expect(clockOf("not a date")).toBe("--:--");
  });
});

describe("normalizeLinqMessageReceivedData: group fields", () => {
  it("keeps the relay's group fields on the legacy shape", () => {
    const data = {
      chat_id: "grp-42",
      from: "+84912357477",
      recipient_phone: "webmaster3t@gmail.com",
      received_at: "2026-09-04T03:12:41Z",
      is_from_me: false,
      service: "iMessage",
      is_group: true,
      participants: ["+84912357477", "+84903331122", "+14155550142"],
      message: { id: "m-1", parts: [{ type: "text", value: "@PA hi" }] },
    };
    expect(normalizeLinqMessageReceivedData(data)).toEqual(data);
  });

  it("reads is_group and participant handles off the current shape", () => {
    const normalized = normalizeLinqMessageReceivedData({
      chat: { id: "chat_9", owner_handle: { handle: "+12025550101" }, display_name: "Avango deal", handles: [{ handle: "+12025550100" }, { handle: "+12025550102" }] },
      id: "msg_9",
      direction: "inbound",
      is_group: true,
      sender_handle: { handle: "+12025550100", is_me: false },
      parts: [{ type: "text", value: "hello" }],
      sent_at: "2026-02-05T19:31:13.074Z",
      service: "iMessage",
    });
    expect(normalized).toMatchObject({
      chat_id: "chat_9",
      from: "+12025550100",
      is_group: true,
      participants: ["+12025550100", "+12025550102"],
      chat_display_name: "Avango deal",
    });
  });
});
