// Pump-trigger log for the Meme Coin tab.
//
// When a coin runs up 50% or more, run one social-media scan to capture what
// may have triggered it (a post, a listing, organic chatter) and store the
// result. Over time this builds a research log of "what moved this coin".
//
// Two triggers (see docs/ARCHITECTURE.md): a held paper position crossing +50% from
// entry, and any scanned coin up 50%+ over 24h (top few per scan). The social
// scan is the rate-limited part, so each coin is logged at most once per
// DEDUP window.
//
// Postgres-backed via the memecoin state store (the pump_events table). The
// readPumpEvents / writePumpEvents helpers below are only the pre-hydration
// localStorage cache, the same pattern as the trade queue.

import { checkSocialChatter, type ChatterResult, type MemeToken } from "./markets";

export type PumpEvent = {
  id: string;
  address: string;
  symbol: string;
  name: string;
  detectedAt: string;
  // Human-readable, e.g. "Held position, +63% from entry" or "Scan, +120% 24h".
  trigger: string;
  runUpPct: number;
  // The social-media scan result, or null if the scan failed.
  chatter: ChatterResult | null;
  chatterError?: string;
};

const KEY = "memeify-memecoin-pumps-v1";
const MAX_EVENTS = 200;
// Do not re-log the same coin within this window: one entry per pump episode.
const DEDUP_MS = 24 * 60 * 60 * 1000;

export function readPumpEvents(): PumpEvent[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as PumpEvent[]) : [];
  } catch {
    return [];
  }
}

export function writePumpEvents(events: PumpEvent[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(events.slice(0, MAX_EVENTS)));
  } catch {
    /* storage full or unavailable; the in-memory list still works */
  }
}

// True if this coin already has a pump event logged within the dedup window.
export function recentlyLogged(events: PumpEvent[], address: string): boolean {
  const cutoff = Date.now() - DEDUP_MS;
  return events.some(
    (e) => e.address === address && new Date(e.detectedAt).getTime() > cutoff
  );
}

function pid(): string {
  return `pe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// Run one social-media scan for a pumping coin and build a PumpEvent. The
// caller handles the dedup check (before calling, to not waste a search) and
// the storage write.
export async function buildPumpEvent(
  coin: { address: string; symbol: string; name: string },
  trigger: string,
  runUpPct: number
): Promise<PumpEvent> {
  // Serper-primary for auto-logged pump events. Bulk fire-and-forget path
  // that filled the Pump triggers panel; Tavily's better snippet quality
  // doesn't pay off on rows the user almost never reads. Tavily stays
  // available as the fallback. Manual chatter requests in App.tsx
  // (runChatter) keep the default Tavily-primary path.
  const res = await checkSocialChatter(coin.symbol, coin.name, { preferProvider: "serper" });
  return {
    id: pid(),
    address: coin.address,
    symbol: coin.symbol,
    name: coin.name,
    detectedAt: new Date().toISOString(),
    trigger,
    runUpPct,
    chatter: res.ok ? res.data : null,
    chatterError: res.ok ? undefined : res.error
  };
}

// Pick scanned coins that just ran up 50%+ over 24h and are not already
// logged. Top `limit` by run-up. The caller runs buildPumpEvent for each.
export function pickScanPumps(
  tokens: MemeToken[],
  existing: PumpEvent[],
  limit = 3
): MemeToken[] {
  return tokens
    .filter((t) => t.priceChange24h >= 50 && !recentlyLogged(existing, t.address))
    .sort((a, b) => b.priceChange24h - a.priceChange24h)
    .slice(0, limit);
}
