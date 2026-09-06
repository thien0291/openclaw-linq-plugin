import type { LinqProbe } from "./types.js";
import { linqApiBase } from "./apiBase.js";


export async function probeLinq(
  token?: string,
  timeoutMs?: number,
  apiBase?: string,
): Promise<LinqProbe> {
  const resolvedToken = token?.trim() ?? "";
  if (!resolvedToken) {
    return { ok: false, error: "Linq API token not configured" };
  }

  const url = `${linqApiBase(apiBase)}/phone_numbers`;
  const controller = new AbortController();
  const timer = timeoutMs && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${resolvedToken}`, "User-Agent": "OpenClaw-Linq/1.0" },
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return { ok: false, error: `Linq API ${response.status}: ${text.slice(0, 200)}` };
    }
    const data = (await response.json()) as {
      phone_numbers?: Array<{ phone_number?: string }>;
    };
    const phoneNumbers = (data.phone_numbers ?? [])
      .map((p) => p.phone_number)
      .filter(Boolean) as string[];
    return { ok: true, phoneNumbers };
  } catch (err) {
    if (controller.signal.aborted) {
      return { ok: false, error: `Linq probe timed out (${timeoutMs}ms)` };
    }
    return { ok: false, error: String(err) };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
