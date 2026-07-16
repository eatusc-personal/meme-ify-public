// Browser-side client for the Meme Coin sub-project's Postgres storage.
//
// The data lives in a user-provided Postgres database, reached through the
// local Vite middleware at /api/memecoin/state. localStorage is kept only as
// a fast offline cache; Postgres is the source of truth when configured.
// See docs/ARCHITECTURE.md, "Storage".

import type { PaperState, PriceMap, PanelAlert, TradeIntent, DismissedBuyIntent } from "./paper";
import type { ScanResult } from "./markets";
import type { LiveState } from "./live";
import type { PumpEvent } from "./pumpwatch";

// One row from the `watchlist` table. User-set price alert; the
// position-watch tick reads every active row, fetches current prices,
// and fires a toast when target is hit. See `evaluateWatchlist` in
// App.tsx and the watchlist table comment in db/schema.sql.
export type WatchlistEntry = {
  id: string;
  mint: string;
  symbol: string | null;
  name: string | null;
  targetPriceUsd: number;
  direction: "below" | "above";
  note: string | null;
  createdAt: string;
  triggeredAt: string | null;
  triggeredPrice: number | null;
};

// Per-user view preferences. Server-stored so they follow the account
// across browsers / machines / a future Supabase migration. Previously
// each lived in its own per-browser localStorage key; that pattern was
// retired in the 2026-05-24 "no-localStorage-for-settings" pass. See
// docs/ARCHITECTURE.md "Persistence audit" for the architecture rationale.
export type UserPrefs = {
  sortBy: string; // SortKey union in App.tsx; persisted as a plain string
  sortDir: "asc" | "desc";
  hideView: "visible" | "hidden";
  hiddenMints: string[]; // mint addresses the user has hidden from the scan
  closedExpanded: boolean; // closed-trades panel collapse state
  collapsedSections: string[]; // section ids the user has collapsed
};

export type MemecoinState = {
  paper: PaperState | null;
  live: LiveState | null;
  alerts: PanelAlert[];
  prices: PriceMap;
  scan: ScanResult | null;
  autoRun: boolean;
  watchOn: boolean;
  queueMode: boolean;
  tradeQueue: TradeIntent[];
  feePct: number;
  pumpEvents: PumpEvent[];
  tradingMode: "paper" | "real";
  dismissedBuyIntents: DismissedBuyIntent[];
  userPrefs: UserPrefs;
  watchlist: WatchlistEntry[];
  // Server-side scheduler ownership flags. When a cycle is set to true here,
  // the React app skips installing its own setInterval for that cycle so the
  // server is the sole owner and there's no 2× burn. See
  // positionWatchSchedulerPlugin in vite.config.ts.
  serverScheduler?: { watch?: boolean; scan?: boolean };
};

export async function loadMemecoinState(): Promise<
  { ok: true; state: MemecoinState } | { ok: false; error: string }
> {
  try {
    const res = await fetch("/api/memecoin/state");
    const data = await res.json();
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.error || `HTTP ${res.status}` };
    }
    return { ok: true, state: data.state as MemecoinState };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function saveMemecoinState(state: {
  paper: PaperState;
  live: LiveState;
  alerts: PanelAlert[];
  prices: PriceMap;
  scan: ScanResult | null;
  autoRun: boolean;
  watchOn: boolean;
  queueMode: boolean;
  tradeQueue: TradeIntent[];
  feePct: number;
  pumpEvents: PumpEvent[];
  tradingMode: "paper" | "real";
  dismissedBuyIntents: DismissedBuyIntent[];
  userPrefs: UserPrefs;
  watchlist: WatchlistEntry[];
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    // pumpEvents is stripped from the round-trip body — each new pump event
    // gets POSTed via savePumpEvent to the dedicated endpoint instead. Keeps
    // the full-state body under the sendBeacon 64 KB ceiling so the
    // beforeunload save can survive a fast refresh. pumpEvents undefined on
    // the server side is treated as "don't touch m_pump_events" (see
    // saveMemecoinDbState).
    //
    // scan is also dropped here. It's ~47 KB on this app (top tokens list +
    // metadata) and only changes on scan-cycle ticks; if the user happens to
    // refresh during the brief window between a scan-cycle finishing and
    // the next persist round-trip, they get the previous scan from DB and
    // the next cycle re-fills it. Acceptable for hourly-frequency data.
    const { pumpEvents: _pe, scan: _sc, ...slim } = state;
    const res = await fetch("/api/memecoin/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(slim)
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.error || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Dedicated pump-events writer. Appends one event at a time (server
// upserts on id and trims to the 200-row cap), keeping the per-call
// body around the size of a single chatter blob (~5 KB) — well under
// sendBeacon's ceiling.
export async function savePumpEvent(
  event: PumpEvent
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/memecoin/pump-events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.error || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Dedicated scan-cache writer. Scan is ~47 KB and is stripped from the
// beforeunload beacon body to keep it under sendBeacon's 64 KB ceiling.
// Without this dedicated path a refresh between scan-cycle completion
// and the next debounced full-state save could leave m_scan_cache stale
// while the tradeQueue still held intents referencing freshly-scanned
// coins — applyQueuedIntents then fails the buy with "no fresh price,
// buy skipped" because the queue references a mint not in the scan.
// Call this from every setScan site so the canonical write lands
// regardless of refresh timing.
export async function saveScan(
  scan: ScanResult
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/memecoin/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scan })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.error || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
