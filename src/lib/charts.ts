// OHLCV candle client for the holdings chart mosaic.
//
// The mosaic renders a small candlestick chart per held coin so the whole
// portfolio can be scanned in one image instead of opening each coin on
// DexScreener. Two upstream calls, both through the existing Vite proxies,
// both keyless and read-only:
//   1. DexScreener  -> the deepest-liquidity pool (pair) address per token.
//   2. GeckoTerminal -> OHLCV candles for that pool.
// A DexScreener pairAddress is the on-chain pool account, which is also how
// GeckoTerminal keys its pools, so the address carries straight across.
//
// Honest output (docs/ARCHITECTURE.md rule 5): a token with no pool or no candles is
// returned with an `error` string and an empty series, not faked.

export type Candle = { t: number; o: number; h: number; l: number; c: number };

export type ChartSeries = {
  candles: Candle[];
  poolAddress?: string;
  error?: string;
};

export type ChartTimeframe = "6h" | "24h" | "7d";

export const CHART_TIMEFRAMES: { id: ChartTimeframe; label: string }[] = [
  { id: "6h", label: "6h" },
  { id: "24h", label: "24h" },
  { id: "7d", label: "7d" }
];

// GeckoTerminal OHLCV granularity. minute aggregates allow 1/5/15, hour 1/4/12.
const TF_PARAMS: Record<ChartTimeframe, { tf: string; aggregate: number; limit: number }> = {
  "6h": { tf: "minute", aggregate: 15, limit: 24 }, // 24 x 15m = 6h
  "24h": { tf: "hour", aggregate: 1, limit: 24 }, //   24 x 1h  = 24h
  "7d": { tf: "hour", aggregate: 4, limit: 42 } //     42 x 4h  = 7d
};

function num(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : 0;
  return Number.isFinite(n) ? n : 0;
}

// 15s per-request timeout so one hung upstream call cannot freeze the whole
// mosaic load. An abort surfaces as a normal error and is retried.
async function getJson(url: string, timeoutMs = 15000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

// Deepest-liquidity DexScreener Solana pair address per token address.
type DexPairLite = {
  chainId?: string;
  pairAddress?: string;
  baseToken?: { address?: string };
  liquidity?: { usd?: number };
};

async function resolvePools(addresses: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const bestLiq: Record<string, number> = {};
  for (let i = 0; i < addresses.length; i += 30) {
    const batch = addresses.slice(i, i + 30);
    try {
      const data = (await getJson(
        `/api/dexscreener/latest/dex/tokens/${batch.join(",")}`
      )) as { pairs?: DexPairLite[] };
      const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
      for (const p of pairs) {
        const addr = p?.baseToken?.address;
        if (!addr || !p.pairAddress || p.chainId !== "solana") continue;
        const liq = num(p.liquidity?.usd);
        if (out[addr] === undefined || liq > (bestLiq[addr] ?? -1)) {
          out[addr] = p.pairAddress;
          bestLiq[addr] = liq;
        }
      }
    } catch {
      /* batch missing: those tokens get no pool and render "no chart data" */
    }
  }
  return out;
}

async function fetchPoolCandles(
  poolAddress: string,
  coinAddress: string,
  timeframe: ChartTimeframe
): Promise<Candle[]> {
  const { tf, aggregate, limit } = TF_PARAMS[timeframe];
  // token=<mint> forces the candles onto the memecoin's price regardless of
  // which side of the pool GeckoTerminal treats as base.
  const data = (await getJson(
    `/api/geckoterminal/networks/solana/pools/${poolAddress}/ohlcv/${tf}` +
      `?aggregate=${aggregate}&limit=${limit}&currency=usd&token=${coinAddress}`
  )) as { data?: { attributes?: { ohlcv_list?: number[][] } } };
  const list = data?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return [];
  return list
    .filter((row) => Array.isArray(row) && row.length >= 5)
    .map((row) => ({ t: row[0], o: row[1], h: row[2], l: row[3], c: row[4] }))
    .sort((a, b) => a.t - b.t); // GeckoTerminal returns newest-first
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A coin worth retrying: not a permanent failure. "no DexScreener pool" never
// resolves, and "no candles returned" is a real (empty) answer from the API.
// Everything else (429, 5xx, aborted, network) is transient.
function isTransientChartError(error?: string): boolean {
  if (!error) return false;
  if (error === "no DexScreener pool") return false;
  if (error === "no candles returned") return false;
  return true;
}

// Fetch candles for every held coin. The pool lookup is one or two batched
// DexScreener calls; the candle calls go to GeckoTerminal one at a time.
//
// GeckoTerminal's free OHLCV endpoint runs near ~30 requests/minute. Rather
// than sprint into that limit and then crawl, the loader paces evenly: a
// steady ~2.5s gap from the very first call. The gap only WIDENS, on a 429,
// and only eases back toward the base, never below it, so there is no fast
// burst and no fast resume. After the main pass, up to two cleanup rounds
// retry any coin a transient error or a stray 429 still beat; permanent
// failures (no pool, an empty candle list) are left as-is. `onProgress` fires
// after every coin so the caller renders the mosaic progressively. For a
// large portfolio the main pass is roughly `coins x 2.5s`.
export async function fetchHoldingsCharts(
  addresses: string[],
  timeframe: ChartTimeframe,
  onProgress?: (done: number, total: number, partial: Record<string, ChartSeries>) => void
): Promise<Record<string, ChartSeries>> {
  const out: Record<string, ChartSeries> = {};
  const total = addresses.length;
  if (total === 0) return out;

  const pools = await resolvePools(addresses);

  // Even pacing. ~2.5s between calls stays under GeckoTerminal's free limit.
  // The gap widens on a 429 and eases back toward BASE_DELAY, never below it.
  const BASE_DELAY = 2500;
  const MAX_DELAY = 9000;
  let delay = BASE_DELAY;
  let paced = false; // no sleep before the very first call

  // One paced GeckoTerminal call. Carries the shared adaptive gap.
  async function pacedFetch(addr: string, pool: string): Promise<ChartSeries> {
    if (paced) await sleep(delay);
    paced = true;
    try {
      const candles = await fetchPoolCandles(pool, addr, timeframe);
      delay = Math.max(BASE_DELAY, delay - 500); // ease back toward the base
      return candles.length
        ? { candles, poolAddress: pool }
        : { candles: [], poolAddress: pool, error: "no candles returned" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("429")) delay = Math.min(MAX_DELAY, Math.round(delay * 1.6));
      return { candles: [], poolAddress: pool, error: msg };
    }
  }

  // Main pass: one evenly paced call per coin.
  let done = 0;
  for (const addr of addresses) {
    const pool = pools[addr];
    out[addr] = pool
      ? await pacedFetch(addr, pool)
      : { candles: [], error: "no DexScreener pool" };
    onProgress?.(++done, total, out);
  }

  // Cleanup: retry the coins a transient error or a stray 429 still beat, up
  // to two rounds. A retry only replaces the tile if it did better, so a good
  // chart is never overwritten by a fresh failure.
  for (let round = 0; round < 2; round++) {
    const stragglers = addresses.filter((a) => isTransientChartError(out[a]?.error));
    if (stragglers.length === 0) break;
    for (const addr of stragglers) {
      const pool = pools[addr];
      if (!pool) continue;
      const retry = await pacedFetch(addr, pool);
      if (retry.candles.length > 0 || !isTransientChartError(retry.error)) {
        out[addr] = retry;
        onProgress?.(done, total, out);
      }
    }
  }

  return out;
}
