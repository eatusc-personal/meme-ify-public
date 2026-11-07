import { type MemeToken } from "./markets";
import { type TradeIntent } from "./paper";
import { type ChartSeries, type ChartTimeframe } from "./charts";

// Loaded candles per timeframe. Held in the MemeCoinPanel (not the modal) and
// mirrored to localStorage so the slow one-by-one load is done once and then
// kept: closing the mosaic, reopening it, or reloading the page all show the
// same cached snapshot until the user explicitly hits Reload.
export type MosaicCacheEntry = { series: Record<string, ChartSeries>; loadedAt: string };
export type MosaicCache = Partial<Record<ChartTimeframe, MosaicCacheEntry>>;

const MOSAIC_CACHE_KEY = "memeify-memecoin-mosaic-v1";

export function readMosaicCache(): MosaicCache {
  try {
    const raw = localStorage.getItem(MOSAIC_CACHE_KEY);
    return raw ? (JSON.parse(raw) as MosaicCache) : {};
  } catch {
    return {};
  }
}

export function writeMosaicCache(cache: MosaicCache): void {
  try {
    localStorage.setItem(MOSAIC_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* storage full or unavailable; the in-memory cache still works */
  }
}

// Estimated fee-per-fill assumption for the trade-stats block. A pure display
// preference (it does not affect the simulation), so it lives in localStorage
// rather than the paper account in Postgres.
const DEFAULT_FEE_PCT = 1;

// fee_pct is Postgres-only as of the 2026-05-24 "no-localStorage-for-settings"
// migration. The DEFAULT_FEE_PCT below is used as the initial-render fallback
// before hydration completes (~50-100ms on Supabase Postgres). The previous
// readFeePct / writeFeePct localStorage helpers were retired; their call
// sites now read DEFAULT_FEE_PCT on first paint and let hydration overwrite.
export function readFeePct(): number {
  return DEFAULT_FEE_PCT;
}

// writeFeePct is a no-op kept for call-site compatibility. The persist effect
// covers fee_pct via the standard payload now.
export function writeFeePct(_pct: number): void {
  /* no-op; see migration comment above */
}

// Trade queue localStorage cache. The queue and its on/off mode persist to
// Postgres (the paper_account row, via the hydration + persist effects);
// these helpers are only the pre-hydration cache, read on first render
// before the database load lands. No real money either way.
const TRADE_QUEUE_KEY = "memeify-memecoin-queue-v1";
const QUEUE_MODE_KEY = "memeify-memecoin-queuemode-v1";

export function readTradeQueue(): TradeIntent[] {
  try {
    const raw = localStorage.getItem(TRADE_QUEUE_KEY);
    return raw ? (JSON.parse(raw) as TradeIntent[]) : [];
  } catch {
    return [];
  }
}

export function writeTradeQueue(q: TradeIntent[]): void {
  try {
    localStorage.setItem(TRADE_QUEUE_KEY, JSON.stringify(q.slice(0, 100)));
  } catch {
    /* ignore */
  }
}

export function readQueueMode(): boolean {
  try {
    return localStorage.getItem(QUEUE_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeQueueMode(on: boolean): void {
  try {
    localStorage.setItem(QUEUE_MODE_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

// New-coin pop-up bar. When a scan surfaces a coin that is new since the last
// scan AND clears this quality bar, fire one notification (in-app toast + OS
// pop-up, via pushAlert). Purely a notification gate — it never trades. The
// bar is browser-local (localStorage), like the other display settings here;
// there's no shared-account meaning to it. See notifyNewCoins in <App/>.
export type NewCoinBar = {
  enabled: boolean;
  bands: MemeToken["ratingBand"][];
  minLiquidityUsd: number;
  minVolume24h: number;
};

const NEWCOIN_BAR_KEY = "memeify-memecoin-newcoin-bar-v1";
const NEWCOIN_SEEN_KEY = "memeify-memecoin-newcoin-seen-v1";
// Don't re-alert the same coin within this window. A coin that drops off a
// scan and resurfaces later (genuinely re-discovered) can alert again.
export const NEWCOIN_REALERT_MS = 6 * 60 * 60 * 1000;

const DEFAULT_NEWCOIN_BAR: NewCoinBar = {
  enabled: true,
  bands: ["A"],
  minLiquidityUsd: 50000,
  minVolume24h: 75000
};

export function readNewCoinBar(): NewCoinBar {
  try {
    const raw = localStorage.getItem(NEWCOIN_BAR_KEY);
    if (!raw) return DEFAULT_NEWCOIN_BAR;
    const p = JSON.parse(raw);
    if (!p || typeof p !== "object") return DEFAULT_NEWCOIN_BAR;
    return {
      enabled: p.enabled !== false,
      bands: Array.isArray(p.bands) && p.bands.length > 0 ? p.bands : DEFAULT_NEWCOIN_BAR.bands,
      minLiquidityUsd:
        typeof p.minLiquidityUsd === "number" ? p.minLiquidityUsd : DEFAULT_NEWCOIN_BAR.minLiquidityUsd,
      minVolume24h:
        typeof p.minVolume24h === "number" ? p.minVolume24h : DEFAULT_NEWCOIN_BAR.minVolume24h
    };
  } catch {
    return DEFAULT_NEWCOIN_BAR;
  }
}

export function writeNewCoinBar(bar: NewCoinBar): void {
  try {
    localStorage.setItem(NEWCOIN_BAR_KEY, JSON.stringify(bar));
  } catch {
    /* ignore */
  }
}

// Dedup ledger: address -> epoch ms of last alert. Persisted so a reload (or a
// fresh tab on this origin) doesn't re-alert coins already announced. Pruned to
// the re-alert window on every read so it can't grow without bound.
export function readNewCoinSeen(): Record<string, number> {
  try {
    const raw = localStorage.getItem(NEWCOIN_SEEN_KEY);
    const p = raw ? JSON.parse(raw) : null;
    if (!p || typeof p !== "object") return {};
    const now = Date.now();
    const out: Record<string, number> = {};
    for (const [addr, ts] of Object.entries(p)) {
      if (typeof ts === "number" && now - ts < NEWCOIN_REALERT_MS) out[addr] = ts;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeNewCoinSeen(seen: Record<string, number>): void {
  try {
    localStorage.setItem(NEWCOIN_SEEN_KEY, JSON.stringify(seen));
  } catch {
    /* ignore */
  }
}

// Trading mode (paper / real). Postgres-backed via paper_account.trading_mode;
// this localStorage key is the pre-hydration cache so the top switch does not
// flicker on load.
const TRADING_MODE_KEY = "memeify-memecoin-mode-v1";

export function readTradingMode(): "paper" | "real" {
  try {
    return localStorage.getItem(TRADING_MODE_KEY) === "real" ? "real" : "paper";
  } catch {
    return "paper";
  }
}

export function writeTradingMode(mode: "paper" | "real"): void {
  try {
    localStorage.setItem(TRADING_MODE_KEY, mode);
  } catch {
    /* ignore */
  }
}
