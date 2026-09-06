// @ts-nocheck - Legacy setup wizard compatibility surface; the concrete setup
// adapter lives on the channel plugin's `setup` property.
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type {
  ChannelSetupAdapter as ChannelOnboardingAdapter,
  ChannelSetupDmPolicy as ChannelOnboardingDmPolicy,
  DmPolicy,
  WizardPrompter,
} from "openclaw/plugin-sdk/setup";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  addWildcardAllowFrom,
  promptAccountId,
} from "openclaw/plugin-sdk/setup";
import {
  listLinqAccountIds,
  resolveDefaultLinqAccountId,
  resolveLinqAccount,
  resolveLinqAccountForStatus,
} from "./linq/accounts.js";
import { probeLinq } from "./linq/probe.js";
import {
  createLinqWebhookSubscription,
  deleteLinqWebhookSubscription,
  findLinqWebhookSubscription,
  findReplaceableLinqWebhookSubscriptions,
  listLinqWebhookSubscriptions,
} from "./linq/subscriptions.js";

const channel = "linq" as const;
const webhookPathPattern = /^\/[A-Za-z0-9/_-]*$/u;

function validateWebhookPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "Required";
  }
  return webhookPathPattern.test(trimmed)
    ? undefined
    : "Use a path like /linq-webhook with letters, numbers, _, -, or /.";
}

function parseWebhookUrl(value: string | undefined): URL | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }
  try {
    return new URL(trimmed);
  } catch {
    return null;
  }
}

function validateWebhookUrl(value: string | undefined): string | undefined {
  const url = parseWebhookUrl(value);
  if (!url) {
    return "Enter a valid URL.";
  }
  if (url.pathname === "/") {
    return "Include a webhook path, for example /linq-webhook.";
  }
  return validateWebhookPath(url.pathname);
}

function setLinqAccountPatch(
  cfg: OpenClawConfig,
  accountId: string,
  patch: Record<string, unknown>,
): OpenClawConfig {
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        linq: {
          ...cfg.channels?.linq,
          ...patch,
        },
      },
    };
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      linq: {
        ...cfg.channels?.linq,
        enabled: true,
        accounts: {
          ...cfg.channels?.linq?.accounts,
          [accountId]: {
            ...cfg.channels?.linq?.accounts?.[accountId],
            ...patch,
          },
        },
      },
    },
  };
}

function setLinqDmPolicy(cfg: OpenClawConfig, dmPolicy: DmPolicy) {
  const allowFrom =
    dmPolicy === "open" ? addWildcardAllowFrom(cfg.channels?.linq?.allowFrom) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      linq: {
        ...cfg.channels?.linq,
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  };
}

async function noteLinqTokenHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) Sign up at linqapp.com",
      "2) Copy your API token from the dashboard",
      "3) Tip: you can also set LINQ_API_TOKEN in your env.",
    ].join("\n"),
    "Linq API token",
  );
}

async function noteLinqPhoneHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "Your Linq phone number is shown in your linqapp.com dashboard.",
      "This is the number people will text to reach your agent.",
    ].join("\n"),
    "Linq phone number",
  );
}

async function selectLinqPhone(params: {
  prompter: WizardPrompter;
  token: string;
  existingPhone?: string;
  apiBase?: string;
}): Promise<string> {
  const { prompter, token, existingPhone, apiBase } = params;
  let phoneNumbers: string[] = [];
  try {
    const probe = await probeLinq(token, 5000, apiBase);
    phoneNumbers = probe.ok ? (probe.phoneNumbers ?? []) : [];
    if (!probe.ok && probe.error) {
      await prompter.note(`Could not list Linq phone numbers: ${probe.error}`, "Linq phone lookup");
    }
  } catch (err) {
    await prompter.note(`Could not list Linq phone numbers: ${String(err)}`, "Linq phone lookup");
  }

  if (phoneNumbers.length > 0) {
    return String(
      await prompter.select({
        message: "Linq sender phone number",
        initialValue: existingPhone && phoneNumbers.includes(existingPhone) ? existingPhone : phoneNumbers[0],
        options: phoneNumbers.map((phone) => ({ value: phone, label: phone })),
      }),
    );
  }

  await noteLinqPhoneHelp(prompter);
  return String(
    await prompter.text({
      message: "Linq phone number (E.164 format, e.g. +15551234567)",
      initialValue: existingPhone,
      validate: (value) => (value?.trim() ? undefined : "Required"),
    }),
  ).trim();
}

async function maybeCreateLinqWebhookSubscription(params: {
  prompter: WizardPrompter;
  token: string;
  webhookUrl: string;
  previousWebhookUrl?: string;
  fromPhone: string;
  previousFromPhone?: string;
  hasWebhookSecret: boolean;
  apiBase?: string;
}): Promise<string | null> {
  const {
    prompter,
    token,
    webhookUrl,
    previousWebhookUrl,
    fromPhone,
    previousFromPhone,
    hasWebhookSecret,
    apiBase,
  } = params;
  if (!token?.trim()) {
    return null;
  }
  try {
    const subscriptions = await listLinqWebhookSubscriptions(token, apiBase);
    const parsedWebhookUrl = parseWebhookUrl(webhookUrl);
    const isPublicHttps = parsedWebhookUrl?.protocol === "https:";
    const existing = findLinqWebhookSubscription(subscriptions, webhookUrl, fromPhone);
    if (existing) {
      await prompter.note(
        `Found Linq webhook subscription ${existing.id} for ${webhookUrl}.`,
        "Linq webhook",
      );
      if (hasWebhookSecret) {
        return null;
      }
      if (!isPublicHttps) {
        await prompter.note(
          "Skipping Linq webhook subscription recreation because the webhook URL is not HTTPS.",
          "Linq webhook",
        );
        return null;
      }
      const recreateForSecret = await prompter.confirm({
        message: "Recreate the existing Linq webhook subscription to store its signing secret?",
        initialValue: true,
      });
      if (!recreateForSecret) {
        await prompter.note(
          "Linq only returns the signing secret when creating a subscription. Delete/recreate the subscription or enter the secret manually if inbound signatures fail.",
          "Linq webhook secret",
        );
        return null;
      }
      await deleteLinqWebhookSubscription({ token, subscriptionId: existing.id, apiBase });
    }

    if (!isPublicHttps) {
      await prompter.note(
        "Skipping Linq webhook subscription creation because the webhook URL is not HTTPS.",
        "Linq webhook",
      );
      return null;
    }

    const replaceable = findReplaceableLinqWebhookSubscriptions(subscriptions, {
      targetUrl: webhookUrl,
      phoneNumber: fromPhone,
      previousTargetUrl: previousWebhookUrl,
      previousPhoneNumber: previousFromPhone,
    });
    if (replaceable.length > 0) {
      const replace = await prompter.confirm({
        message: `Replace ${replaceable.length} stale Linq webhook subscription${replaceable.length === 1 ? "" : "s"} before creating the current one?`,
        initialValue: true,
      });
      if (!replace) {
        return null;
      }
      for (const subscription of replaceable) {
        await deleteLinqWebhookSubscription({ token, subscriptionId: subscription.id, apiBase });
      }
    }

    const create = await prompter.confirm({
      message: "Create Linq webhook subscription for inbound messages?",
      initialValue: true,
    });
    if (!create) {
      return null;
    }
    const subscription = await createLinqWebhookSubscription({
      token,
      targetUrl: webhookUrl,
      phoneNumber: fromPhone,
      apiBase,
    });
    await prompter.note(
      `Created Linq webhook subscription ${subscription.id}.`,
      "Linq webhook",
    );
    return subscription.signing_secret?.trim() || null;
  } catch (err) {
    await prompter.note(`Could not configure Linq webhook subscription: ${String(err)}`, "Linq webhook");
    return null;
  }
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Linq",
  channel,
  policyKey: "channels.linq.dmPolicy",
  allowFromKey: "channels.linq.allowFrom",
  getCurrent: (cfg) => cfg.channels?.linq?.dmPolicy ?? "open",
  setPolicy: (cfg, policy) => setLinqDmPolicy(cfg, policy),
};

export const linqOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const configured = listLinqAccountIds(cfg).some((accountId) =>
      Boolean(resolveLinqAccountForStatus({ cfg, accountId }).token),
    );
    return {
      channel,
      configured,
      statusLines: [`Linq: ${configured ? "configured" : "needs token"}`],
      selectionHint: configured
        ? "recommended · configured"
        : "recommended · iMessage blue bubbles",
      quickstartScore: configured ? 1 : 10,
    };
  },
  configure: async ({
    cfg,
    prompter,
    accountOverrides,
    shouldPromptAccountIds,
    forceAllowFrom,
  }) => {
    const linqOverride = accountOverrides.linq?.trim();
    const defaultLinqAccountId = resolveDefaultLinqAccountId(cfg);
    let linqAccountId = linqOverride ? normalizeAccountId(linqOverride) : defaultLinqAccountId;
    if (shouldPromptAccountIds && !linqOverride) {
      linqAccountId = await promptAccountId({
        cfg,
        prompter,
        label: "Linq",
        currentId: linqAccountId,
        listAccountIds: listLinqAccountIds,
        defaultAccountId: defaultLinqAccountId,
      });
    }

    let next = cfg;
    const resolvedAccount = resolveLinqAccount({
      cfg: next,
      accountId: linqAccountId,
    });
    const accountConfigured = Boolean(resolvedAccount.token);
    const allowEnv = linqAccountId === DEFAULT_ACCOUNT_ID;
    const canUseEnv = allowEnv && Boolean(process.env.LINQ_API_TOKEN?.trim());
    const hasConfigToken = Boolean(
      resolvedAccount.config.apiToken || resolvedAccount.config.tokenFile,
    );

    let token: string | null = null;
    if (!accountConfigured) {
      await noteLinqTokenHelp(prompter);
    }
    if (canUseEnv && !resolvedAccount.config.apiToken) {
      const keepEnv = await prompter.confirm({
        message: "LINQ_API_TOKEN detected. Use env var?",
        initialValue: true,
      });
      if (keepEnv) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            linq: {
              ...next.channels?.linq,
              enabled: true,
            },
          },
        };
      } else {
        token = String(
          await prompter.text({
            message: "Enter Linq API token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else if (hasConfigToken) {
      const keep = await prompter.confirm({
        message: "Linq token already configured. Keep it?",
        initialValue: true,
      });
      if (!keep) {
        token = String(
          await prompter.text({
            message: "Enter Linq API token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else {
      token = String(
        await prompter.text({
          message: "Enter Linq API token",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
    }

    if (token) {
      next = setLinqAccountPatch(next, linqAccountId, { enabled: true, apiToken: token });
    }

    // --- fromPhone ---
    const accountAfterToken = resolveLinqAccount({ cfg: next, accountId: linqAccountId });
    const previousFromPhone = accountAfterToken.fromPhone;
    const fromPhone = await selectLinqPhone({
      prompter,
      token: accountAfterToken.token,
      existingPhone: accountAfterToken.fromPhone,
      apiBase: accountAfterToken.config.apiBase,
    });

    next = setLinqAccountPatch(next, linqAccountId, { fromPhone });

    // --- Webhook config ---
    const linqSection = (next.channels as Record<string, unknown> | undefined)?.linq as
      | Record<string, unknown>
      | undefined;
    const existingWebhookPath = (linqSection?.webhookPath as string) ?? "/linq-webhook";
    const existingWebhookUrl =
      (linqSection?.webhookUrl as string) ?? `http://localhost:3100${existingWebhookPath}`;
    const previousWebhookUrl =
      typeof linqSection?.webhookUrl === "string" ? linqSection.webhookUrl : undefined;
    const webhookUrl = String(
      await prompter.text({
        message: "Webhook URL",
        initialValue: existingWebhookUrl,
        validate: validateWebhookUrl,
      }),
    ).trim();

    const webhookPath = parseWebhookUrl(webhookUrl)?.pathname ?? existingWebhookPath;

    next = {
      ...next,
      channels: {
        ...next.channels,
        linq: {
          ...next.channels?.linq,
          webhookUrl,
          webhookPath,
        },
      },
    };

    const accountAfterWebhook = resolveLinqAccount({ cfg: next, accountId: linqAccountId });
    const webhookSecret = await maybeCreateLinqWebhookSubscription({
      prompter,
      token: accountAfterWebhook.token,
      webhookUrl,
      previousWebhookUrl,
      fromPhone,
      previousFromPhone,
      hasWebhookSecret: Boolean(accountAfterWebhook.webhookSecret),
      apiBase: accountAfterWebhook.config.apiBase,
    });
    if (webhookSecret) {
      next = setLinqAccountPatch(next, linqAccountId, { webhookSecret });
    }

    if (!next.channels?.linq?.dmPolicy) {
      next = setLinqDmPolicy(next, "open");
    }

    return { cfg: next, accountId: linqAccountId };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      linq: { ...cfg.channels?.linq, enabled: false },
    },
  }),
};
