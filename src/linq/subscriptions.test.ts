import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLinqWebhookSubscription,
  deleteLinqWebhookSubscription,
  findLinqWebhookSubscription,
  findReplaceableLinqWebhookSubscriptions,
  listLinqWebhookSubscriptions,
} from "./subscriptions.js";
import { linqPlugin } from "../channel.js";

describe("Linq webhook subscriptions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists existing webhook subscriptions", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          subscriptions: [
            {
              id: "sub_1",
              is_active: true,
              subscribed_events: ["message.received"],
              target_url: "https://agent.example.com/linq-webhook",
            },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(listLinqWebhookSubscriptions("token")).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.linqapp.com/api/partner/v3/webhook-subscriptions",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer token" }),
      }),
    );
  });

  it("uses the selected account API base for subscription calls", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ subscriptions: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await listLinqWebhookSubscriptions("token", "https://relay.test/api/partner/v3/");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://relay.test/api/partner/v3/webhook-subscriptions",
      expect.any(Object),
    );
  });

  it("matches subscriptions by URL and selected phone number", () => {
    const subscription = {
      id: "sub_1",
      is_active: true,
      subscribed_events: ["message.received"],
      target_url: "https://agent.example.com/linq-webhook",
      phone_numbers: ["+15551112222"],
    };

    expect(
      findLinqWebhookSubscription(
        [subscription],
        "https://agent.example.com/linq-webhook",
        "+15551112222",
      ),
    ).toBe(subscription);
    expect(
      findLinqWebhookSubscription(
        [subscription],
        "https://agent.example.com/linq-webhook",
        "+15553334444",
      ),
    ).toBeUndefined();
  });

  it("treats unfiltered subscriptions as covering the selected phone number", () => {
    const subscription = {
      id: "sub_1",
      is_active: true,
      subscribed_events: ["message.received"],
      target_url: "https://agent.example.com/linq-webhook",
      phone_numbers: null,
    };

    expect(
      findLinqWebhookSubscription(
        [subscription],
        "https://agent.example.com/linq-webhook",
        "+15551112222",
      ),
    ).toBe(subscription);
  });

  it("ignores inactive subscriptions and subscriptions missing inbound events", () => {
    const base = {
      id: "sub_1",
      target_url: "https://agent.example.com/linq-webhook",
      phone_numbers: ["+15551112222"],
    };

    expect(
      findLinqWebhookSubscription(
        [
          {
            ...base,
            is_active: false,
            subscribed_events: ["message.received"],
          },
          {
            ...base,
            id: "sub_2",
            is_active: true,
            subscribed_events: ["reaction.received"],
          },
        ],
        "https://agent.example.com/linq-webhook",
        "+15551112222",
      ),
    ).toBeUndefined();
  });

  it("selects stale active inbound subscriptions for replacement", () => {
    const current = {
      id: "current",
      is_active: true,
      subscribed_events: ["message.received"],
      target_url: "https://agent.example.com/current",
      phone_numbers: ["+15550000000"],
    };
    const staleSameUrl = {
      id: "stale-same-url",
      is_active: true,
      subscribed_events: ["message.received"],
      target_url: "https://agent.example.com/current",
      phone_numbers: ["+15551112222"],
    };
    const staleOldUrl = {
      id: "stale-old-url",
      is_active: true,
      subscribed_events: ["message.received"],
      target_url: "https://agent.example.com/old",
      phone_numbers: ["+15551112222"],
    };
    const unrelated = {
      id: "unrelated",
      is_active: true,
      subscribed_events: ["message.received"],
      target_url: "https://agent.example.com/other",
      phone_numbers: ["+15551112222"],
    };

    expect(
      findReplaceableLinqWebhookSubscriptions(
        [current, staleSameUrl, staleOldUrl, unrelated],
        {
          targetUrl: "https://agent.example.com/current",
          phoneNumber: "+15550000000",
          previousTargetUrl: "https://agent.example.com/old",
          previousPhoneNumber: "+15551112222",
        },
      ).map((subscription) => subscription.id),
    ).toEqual(["stale-same-url", "stale-old-url"]);
  });

  it("creates inbound webhook subscriptions and returns the signing secret", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: "sub_2",
          is_active: true,
          subscribed_events: ["message.received"],
          target_url: "https://agent.example.com/linq-webhook",
          phone_numbers: ["+15551112222"],
          signing_secret: "secret_1",
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const created = await createLinqWebhookSubscription({
      token: "token",
      targetUrl: "https://agent.example.com/linq-webhook",
      phoneNumber: "+15551112222",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.linqapp.com/api/partner/v3/webhook-subscriptions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          subscribed_events: ["message.received"],
          target_url: "https://agent.example.com/linq-webhook",
          phone_numbers: ["+15551112222"],
        }),
      }),
    );
    expect(created.signing_secret).toBe("secret_1");
  });

  it("retries subscription creation without phone filter when Linq rejects phone scope", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: 2006,
              message: "You do not have permission to send from this phone number",
              status: 403,
            },
            success: false,
          }),
          { status: 403 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "sub_2",
            is_active: true,
            subscribed_events: ["message.received"],
            target_url: "https://agent.example.com/linq-webhook",
            phone_numbers: null,
            signing_secret: "secret_1",
          }),
          { status: 201 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createLinqWebhookSubscription({
        token: "token",
        targetUrl: "https://agent.example.com/linq-webhook",
        phoneNumber: "+15551112222",
      }),
    ).resolves.toMatchObject({ id: "sub_2", phone_numbers: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.linqapp.com/api/partner/v3/webhook-subscriptions",
      expect.objectContaining({
        body: JSON.stringify({
          subscribed_events: ["message.received"],
          target_url: "https://agent.example.com/linq-webhook",
          phone_numbers: ["+15551112222"],
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.linqapp.com/api/partner/v3/webhook-subscriptions",
      expect.objectContaining({
        body: JSON.stringify({
          subscribed_events: ["message.received"],
          target_url: "https://agent.example.com/linq-webhook",
        }),
      }),
    );
  });

  it("deletes webhook subscriptions by id", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      deleteLinqWebhookSubscription({ token: "token", subscriptionId: "sub_1" }),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.linqapp.com/api/partner/v3/webhook-subscriptions/sub_1",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({ Authorization: "Bearer token" }),
      }),
    );
  });
});

describe("Linq secret contract", () => {
  it("declares API token and webhook signing secret as configurable secret targets", () => {
    const ids = linqPlugin.secrets?.secretTargetRegistryEntries?.map((entry) => entry.id) ?? [];

    expect(ids).toContain("channels.linq.apiToken");
    expect(ids).toContain("channels.linq.webhookSecret");
    expect(ids).toContain("channels.linq.accounts.*.apiToken");
    expect(ids).toContain("channels.linq.accounts.*.webhookSecret");
  });
});
