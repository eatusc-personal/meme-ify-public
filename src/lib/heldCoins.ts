import { type PaperState } from "./paper";
import { type LiveState } from "./live";

// ---------------------------------------------------------------------------
// Holdings chart mosaic
//
// One small candlestick chart per open position, drawn into a single canvas so
// the whole portfolio can be eyeballed (and saved as a PNG) in one shot instead
// of opening each coin on DexScreener. Candle data comes from src/lib/charts.ts
// (DexScreener for the pool address, GeckoTerminal for the OHLCV).
// ---------------------------------------------------------------------------

export type HeldCoin = {
  address: string;
  symbol: string;
  name: string;
  entryPriceUsd: number;
  side: "paper" | "live" | "paper+live";
};

// Collapse open paper + live positions to one row per coin. When a coin is
// held more than once the entry price is the token-amount-weighted average.
export function buildHeldCoins(paper: PaperState, live: LiveState): HeldCoin[] {
  type Acc = {
    symbol: string;
    name: string;
    wpSum: number;
    wSum: number;
    paper: boolean;
    live: boolean;
  };
  const map = new Map<string, Acc>();
  for (const p of paper.positions) {
    if (p.status !== "open") continue;
    const e =
      map.get(p.address) ??
      { symbol: p.symbol, name: p.name, wpSum: 0, wSum: 0, paper: false, live: false };
    e.wpSum += p.entryPriceUsd * p.tokenAmount;
    e.wSum += p.tokenAmount;
    e.paper = true;
    map.set(p.address, e);
  }
  for (const p of live.positions) {
    if (p.status !== "open") continue;
    const e =
      map.get(p.mint) ??
      { symbol: p.symbol, name: p.name, wpSum: 0, wSum: 0, paper: false, live: false };
    e.wpSum += p.entryPriceUsd * p.entryTokenAmount;
    e.wSum += p.entryTokenAmount;
    e.live = true;
    map.set(p.mint, e);
  }
  const out: HeldCoin[] = [];
  for (const [address, e] of map) {
    out.push({
      address,
      symbol: e.symbol,
      name: e.name,
      entryPriceUsd: e.wSum > 0 ? e.wpSum / e.wSum : 0,
      side: e.paper && e.live ? "paper+live" : e.live ? "live" : "paper"
    });
  }
  return out;
}
