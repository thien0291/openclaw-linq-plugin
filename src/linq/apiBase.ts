/**
 * Where the Linq partner API lives for this gateway.
 *
 * Originally a module constant read from `process.env.LINQ_API_BASE`. That is
 * only settable when the container is created, and a cell is created BEFORE its
 * iMessage channel is connected — so a pooled-line deployment (MLabRelay, which
 * serves this same API from its own host) could never get the value in: the
 * plugin kept posting the relay's send token to Linq's cloud, which rejects it,
 * and every reply vanished with the agent none the wiser.
 *
 * Account config is passed explicitly so iMessage and WhatsApp accounts can
 * target different API hosts without racing through shared module state.
 */
const DEFAULT_LINQ_API_BASE = "https://api.linqapp.com/api/partner/v3";

const trim = (value: string | undefined): string =>
  (value ?? "").trim().replace(/\/+$/, "");

export function linqApiBase(accountBase?: string): string {
  return trim(accountBase) || trim(process.env.LINQ_API_BASE) || DEFAULT_LINQ_API_BASE;
}
