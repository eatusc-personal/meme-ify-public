// Live trading state for the Meme Coin tab.
//
// Real positions on Solana mainnet, opened by the user clicking Sign in
// Phantom. This module owns the position record, the math, and the P&L,
// nothing else. It does NOT call signAndSendBase64Tx, it does NOT decide
// when to trade. Every live mutation in this codebase passes through a
// fresh user click in Phantom; see docs/ARCHITECTURE.md "Trading and execution
// boundary".

import { SOL_MINT, USDC_MINT } from "./swap";
import {
  deriveAlgoVersion,
  sellIntentFor,
  intentId,
  snapshotMemeToken,
  buyDismissalBlocks,
  plausibleSellPrice
} from "./paper";
import type {
  PriceMap,
  TradeIntent,
  PaperSettings,
  EntrySnapshot,
  DismissedBuyIntent,
  WatchAlert
} from "./paper";
import type { MemeToken } from "./markets";

export type LiveBaseMint = typeof SOL_MINT | typeof USDC_MINT;

export type LivePosition = {
  id: string;
  mint: string;
  symbol: string;
  name: string;
  status: "open" | "closed";
  baseMint: LiveBaseMint;
  entryAt: string;
  entrySignature: string;
  // Algorithm version (see ALGO_VERSION in paper.ts). Optional for backwards
  // compatibility with positions opened before this field was added; the DB
  // default is the current ALGO_VERSION ('algo2' as of this writing), not
  // 'algo1'. Historical rows were tagged 'algo1' via a one-shot backfill on
  // 2026-05-23, not via the column default.
  algoVersion?: string;
  // Human units (SOL or USDC, not lamports / 1e-6).
  entryBaseAmount: number;
  // Human units of the memecoin received.
  entryTokenAmount: number;
  // USD price per token at the moment the buy was confirmed.
  entryPriceUsd: number;
  slippageBps: number;
  buyPriceImpactPct?: number;
  routeSummary?: string;
  // Watch / scale-out tracking (mirrors PaperPosition).
  alertedSpike?: boolean;
  tookHalfProfit?: boolean;
  partialProceedsBase?: number;
  partialRealizedBase?: number;
  dangerAlerted?: boolean;
  lastPriceUsd?: number;
  lastLiquidityUsd?: number;
  // Highest USD price ever observed on this open position. Drives the
  // trailing-stop rule in sellIntentFor. Seeded at entry, lifted on each
  // live re-pricing pass (runLiveCycle).
  peakPriceUsd?: number;
  // Entry-time feature snapshot from the MemeToken at the moment the swap
  // was booked. Mirrors PaperPosition.entry*; plus entryExitScore which paper
  // tracks separately. Copied to live_trade_log on close.
  entryExitScore?: number;
  entryLiquidityUsd?: number;
  entryVolume24h?: number;
  entryMarketCap?: number;
  entryAgeHours?: number;
  entryPriceChange24h?: number;
  entryBuys24h?: number;
  entrySells24h?: number;
  entryBuyRatio?: number;
  entryTop10HoldersPct?: number;
  entryBotRatio?: number;
  entryHolderCount?: number;
  entryOrganicLabel?: string;
  entryRating?: number;
  entryRatingBand?: string;
  entryVerdict?: string;
  entrySources?: string[];
  entryRiskFlags?: string[];
  entrySocialsCount?: number;
  entryJupiterEnrichedAt?: string;
  // Snapshot of PaperSettings at the moment the live buy was opened. Same
  // shape and rationale as PaperPosition.entrySettingsSnapshot. JSONB on disk.
  entrySettingsSnapshot?: PaperSettings;
  exitAt?: string;
  exitSignature?: string;
  exitPriceUsd?: number;
  exitBaseAmount?: number;
  exitReason?: string;
  pnlBase?: number;
  pnlUsd?: number;
};

export type LiveState = {
  positions: LivePosition[];
  updatedAt: string;
};

export function defaultLiveState(): LiveState {
  return { positions: [], updatedAt: new Date().toISOString() };
}

export function liveId(): string {
  return `lp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function baseSymbol(mint: LiveBaseMint): "SOL" | "USDC" {
  return mint === SOL_MINT ? "SOL" : "USDC";
}

// Open a new live position record from a confirmed buy. Caller must have
// already signed and received confirmation, and must pass the on-chain
// outAmount (the tokens actually received from the swap) rather than the
// quoted outAmount, so a wide slippage fill is recorded honestly.
export function openLivePosition(
  state: LiveState,
  args: {
    mint: string;
    symbol: string;
    name: string;
    baseMint: LiveBaseMint;
    signature: string;
    baseAmountSpent: number;
    tokenAmountReceived: number;
    priceUsdAtEntry: number;
    slippageBps: number;
    buyPriceImpactPct?: number;
    routeSummary?: string;
    // The MemeToken in hand at the moment the buy was approved. REQUIRED:
    // a live (real-money) position without an entry-time feature snapshot
    // is data we can never recover, and the snapshot drives every later
    // win-rate analysis. If a caller genuinely has no MemeToken (manual
    // override flow), pass a stub built from on-chain data rather than
    // omit it; the strictness here prevents silent data loss.
    token: MemeToken;
    // Active PaperSettings at the time of the live buy. REQUIRED for the
    // same reason: without it we can't tell which filter regime produced
    // the trade, so settings-snapshot retrospectives become impossible.
    settings: PaperSettings;
  }
): LiveState {
  const snapshot: EntrySnapshot = snapshotMemeToken(args.token);
  const pos: LivePosition = {
    id: liveId(),
    mint: args.mint,
    symbol: args.symbol,
    name: args.name,
    status: "open",
    baseMint: args.baseMint,
    entryAt: new Date().toISOString(),
    entrySignature: args.signature,
    entryBaseAmount: args.baseAmountSpent,
    entryTokenAmount: args.tokenAmountReceived,
    entryPriceUsd: args.priceUsdAtEntry,
    slippageBps: args.slippageBps,
    buyPriceImpactPct: args.buyPriceImpactPct,
    routeSummary: args.routeSummary,
    // Seed the peak at entry so the trailing stop has a baseline. The live
    // cycle lifts it on every re-pricing pass when price prints a new high.
    peakPriceUsd: args.priceUsdAtEntry,
    // Live tracks the entry exit-score the same way paper does, for parity
    // in retrospective analysis across the two trading modes.
    entryExitScore: args.token.exitScore,
    // Full settings snapshot + DERIVED algo tag. Same pattern as
    // paper.openPosition: algo_version is computed from the snapshot, not
    // stamped, so the label can't drift from the gates that actually applied.
    entrySettingsSnapshot: { ...args.settings },
    algoVersion: deriveAlgoVersion(args.settings),
    ...snapshot
  };
  return { ...state, positions: [pos, ...state.positions], updatedAt: new Date().toISOString() };
}

// Record a confirmed live sell. Caller passes the tokens actually sold and the
// base actually received (the on-chain fills, not the quote).
//
// A full sell closes the position in place. A partial sell splits off a closed
// "slice" sized to the tokens sold, carrying the P&L of just that slice, and
// shrinks the still-open position to the remaining cost basis. The slice is an
// ordinary closed LivePosition, so it flows through liveStats, the closed
// table, and the append-only live_trade_log with no special handling. Selling
// the last remainder later closes the position normally.
export function sellLivePosition(
  state: LiveState,
  positionId: string,
  args: {
    signature: string;
    tokensSold: number;
    baseAmountReceived: number;
    exitPriceUsd: number;
    reason: string;
  }
): LiveState {
  const target = state.positions.find((p) => p.id === positionId && p.status === "open");
  if (!target) return state;

  const held = target.entryTokenAmount;
  // Clamp: never record selling more tokens than the position holds.
  const sold = Math.min(args.tokensSold > 0 ? args.tokensSold : held, held);
  const isFull = sold >= held * 0.9999;

  // Cost basis and P&L of the tokens sold in THIS transaction. entryPriceUsd
  // is per-token, so the USD P&L stays honest even if SOL itself moved.
  const soldBase = isFull ? target.entryBaseAmount : target.entryBaseAmount * (sold / held);
  const pnlBase = args.baseAmountReceived - soldBase;
  const pnlUsd =
    args.exitPriceUsd > 0
      ? (args.exitPriceUsd - target.entryPriceUsd) * sold
      : -target.entryPriceUsd * sold;

  const now = new Date().toISOString();

  if (isFull) {
    const positions = state.positions.map((p) =>
      p.id === positionId && p.status === "open"
        ? {
            ...p,
            status: "closed" as const,
            exitAt: now,
            exitSignature: args.signature,
            exitPriceUsd: args.exitPriceUsd,
            exitBaseAmount: args.baseAmountReceived,
            exitReason: args.reason,
            pnlBase,
            pnlUsd
          }
        : p
    );
    return { ...state, positions, updatedAt: now };
  }

  // Partial: a closed slice for the sold portion + the shrunk open remainder.
  const slice: LivePosition = {
    ...target,
    id: liveId(),
    status: "closed",
    entryTokenAmount: sold,
    entryBaseAmount: soldBase,
    // Watch / scale-out flags do not carry onto a realized slice.
    alertedSpike: false,
    tookHalfProfit: false,
    partialProceedsBase: undefined,
    partialRealizedBase: undefined,
    dangerAlerted: false,
    lastPriceUsd: undefined,
    lastLiquidityUsd: undefined,
    exitAt: now,
    exitSignature: args.signature,
    exitPriceUsd: args.exitPriceUsd,
    exitBaseAmount: args.baseAmountReceived,
    exitReason: `${args.reason} (partial)`,
    pnlBase,
    pnlUsd
  };
  const positions = state.positions.map((p) =>
    p.id === positionId && p.status === "open"
      ? {
          ...p,
          entryTokenAmount: held - sold,
          entryBaseAmount: target.entryBaseAmount - soldBase
        }
      : p
  );
  return { ...state, positions: [slice, ...positions], updatedAt: now };
}

export function liveStats(state: LiveState, prices: PriceMap) {
  const open = state.positions.filter((p) => p.status === "open");
  const closed = state.positions.filter((p) => p.status === "closed");
  let openValueUsd = 0;
  let unrealizedUsd = 0;
  for (const p of open) {
    const info = prices[p.mint];
    const px = info && info.priceUsd > 0 ? info.priceUsd : p.entryPriceUsd;
    const value = p.entryTokenAmount * px;
    openValueUsd += value;
    unrealizedUsd += value - p.entryTokenAmount * p.entryPriceUsd;
  }
  const realizedUsd = closed.reduce((s, p) => s + (p.pnlUsd ?? 0), 0);
  const realizedBase = closed.reduce((s, p) => s + (p.pnlBase ?? 0), 0);
  const wins = closed.filter((p) => (p.pnlUsd ?? 0) > 0).length;
  return {
    openValueUsd,
    unrealizedUsd,
    realizedUsd,
    realizedBase,
    openCount: open.length,
    closedCount: closed.length,
    wins,
    winRate: closed.length ? (wins / closed.length) * 100 : 0
  };
}

// Display-safe current price for a live position. A DexScreener tick more than
// 1000x above entry is almost certainly a bad-data glitch from a thin/scam pool
// (same failure plausibleSellPrice guards on the sell path), so it is dropped
// here too: returns 0 ("no price") rather than painting a fake +285766% P&L.
// See docs/ARCHITECTURE.md "Bad-price guard". Returns 0 when there is no usable price.
export function livePriceUsd(pos: LivePosition, prices: PriceMap): number {
  const px = prices[pos.mint]?.priceUsd ?? 0;
  if (px <= 0) return 0;
  return plausibleSellPrice(px, pos.entryPriceUsd) ? px : 0;
}

export function liveValueUsd(pos: LivePosition, prices: PriceMap): number {
  const px = livePriceUsd(pos, prices);
  return pos.entryTokenAmount * (px > 0 ? px : pos.entryPriceUsd);
}

// Exit reasons on a closed live position that read as a rug. Substring,
// case-insensitive. A coin that rugged on real money is never re-proposed.
const LIVE_RUG_EXIT_REASONS = ["liquidity", "rug"];

// Mints of live coins that rugged on us: any closed live position whose exit
// reason looks like a liquidity collapse.
export function liveRuggedMints(positions: LivePosition[]): Set<string> {
  const out = new Set<string>();
  for (const p of positions) {
    if (p.status === "closed" && p.exitReason) {
      const r = p.exitReason.toLowerCase();
      if (LIVE_RUG_EXIT_REASONS.some((x) => r.includes(x))) out.add(p.mint);
    }
  }
  return out;
}

function sameLocalDay(iso: string, now: Date): boolean {
  const d = new Date(iso);
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

// Realized live P&L booked on the current calendar day, in USD. Sum of pnlUsd
// across live positions closed today (full closes and partial-sell slices,
// both stored as separate closed rows by sellLivePosition).
export function liveDailyRealizedUsd(positions: LivePosition[]): number {
  const now = new Date();
  let sum = 0;
  for (const p of positions) {
    if (p.status === "closed" && p.exitAt && p.pnlUsd !== undefined && sameLocalDay(p.exitAt, now)) {
      sum += p.pnlUsd;
    }
  }
  return sum;
}

// True if today's realized live loss has passed the live circuit-breaker
// limit. Paper uses % of starting cash; live uses a fixed dollar amount
// because a live wallet has no starting-cash baseline. 0 disables. When
// tripped, decideLiveBuyIntents opens nothing; selling is never blocked.
export function liveCircuitBreakerTripped(
  positions: LivePosition[],
  limitUsd: number
): boolean {
  if (!limitUsd || limitUsd <= 0) return false;
  return liveDailyRealizedUsd(positions) <= -limitUsd;
}

// True if `mint` was sold (a live position closed) within the re-entry
// cooldown window.
export function liveInReentryCooldown(
  positions: LivePosition[],
  mint: string,
  hours: number
): boolean {
  if (!hours || hours <= 0) return false;
  let lastExit = 0;
  for (const p of positions) {
    if (p.status === "closed" && p.mint === mint && p.exitAt) {
      const t = new Date(p.exitAt).getTime();
      if (t > lastExit) lastExit = t;
    }
  }
  if (lastExit === 0) return false;
  return (Date.now() - lastExit) / 3.6e6 < hours;
}

// Queue-mode buy decisions for live trading. Same coin gates as the paper
// decideBuyIntents (exit score, liquidity, age), plus: not already held live,
// open slots vs live position count, the rug blacklist, and the re-entry
// cooldown, all derived from live history. The daily-loss circuit breaker is
// NOT applied here yet (it is a % of paper starting cash; live needs its own
// baseline). The pre-buy safety gate still runs per buy intent in the queue.
export function decideLiveBuyIntents(
  candidates: MemeToken[],
  positions: LivePosition[],
  settings: PaperSettings,
  dismissals: DismissedBuyIntent[] = []
): {
  intents: TradeIntent[];
  skipped: { rugged: number; cooldown: number; dismissed: number };
} {
  const { maxOpenPositions, minExitScore, minLiquidityUsd, minAgeHours, minHolderCount } =
    settings;
  // Live daily-loss circuit breaker: when today's realized live P&L is at or
  // below -liveDailyLossLimitUsd, propose nothing. The paper account has a
  // matching gate in decideBuyIntents; this is the live mirror.
  if (liveCircuitBreakerTripped(positions, settings.liveDailyLossLimitUsd)) {
    return { intents: [], skipped: { rugged: 0, cooldown: 0, dismissed: 0 } };
  }
  const openCount = positions.filter((p) => p.status === "open").length;
  const slots = Math.max(0, maxOpenPositions - openCount);
  const rugged = liveRuggedMints(positions);
  const intents: TradeIntent[] = [];
  let ruggedSkips = 0;
  let cooldownSkips = 0;
  let dismissedSkips = 0;
  for (const t of candidates) {
    if (intents.length >= slots) break;
    if (t.exitScore < minExitScore) continue;
    if (t.liquidityUsd < minLiquidityUsd) continue;
    if (minAgeHours > 0 && t.ageHours > 0 && t.ageHours < minAgeHours) continue;
    if (
      minHolderCount > 0 &&
      t.jupiterHolderCount !== undefined &&
      t.jupiterHolderCount < minHolderCount
    )
      continue;
    if (t.priceUsd <= 0) continue;
    if (positions.some((p) => p.status === "open" && p.mint === t.address)) continue;
    if (rugged.has(t.address)) {
      ruggedSkips++;
      continue;
    }
    if (liveInReentryCooldown(positions, t.address, settings.reentryCooldownHours)) {
      cooldownSkips++;
      continue;
    }
    if (buyDismissalBlocks(t, dismissals, settings.buyDismissalImprovementPoints)) {
      dismissedSkips++;
      continue;
    }
    intents.push({
      id: intentId(),
      kind: "buy",
      account: "live",
      address: t.address,
      symbol: t.symbol,
      name: t.name,
      sizeUsd: settings.tradeSizeUsd,
      reason: `Clears your buy rules. Rating ${t.rating}, exit score ${t.exitScore}, liquidity $${Math.round(
        t.liquidityUsd / 1000
      )}k.`,
      decidedAt: new Date().toISOString(),
      ratingAtProposal: t.rating,
      exitScoreAtProposal: t.exitScore,
      liquidityAtProposal: t.liquidityUsd
    });
  }
  return {
    intents,
    skipped: { rugged: ruggedSkips, cooldown: cooldownSkips, dismissed: dismissedSkips }
  };
}

// Queue-mode sell decisions for live positions. Uses the exact same rule
// implementation as the paper account (sellIntentFor), evaluated against live
// positions, with the editable trading rules (`settings`) applied identically.
// Live re-arm is not wired yet, so rearmPrice / rearmDir are left unset.
export function decideLiveSellIntents(
  positions: LivePosition[],
  prices: PriceMap,
  settings: PaperSettings
): TradeIntent[] {
  const intents: TradeIntent[] = [];
  for (const p of positions) {
    if (p.status !== "open") continue;
    const info = prices[p.mint];
    if (!info || info.priceUsd <= 0) continue;
    const it = sellIntentFor(
      {
        id: p.id,
        address: p.mint,
        symbol: p.symbol,
        name: p.name,
        entryPriceUsd: p.entryPriceUsd,
        entryAt: p.entryAt,
        tookHalfProfit: p.tookHalfProfit,
        peakPriceUsd: p.peakPriceUsd
      },
      info,
      settings,
      "live"
    );
    if (it) intents.push(it);
  }
  return intents;
}

function usdShort(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}

// Throttle flags + last-seen values to persist after a live watch tick, so
// each alert fires once per condition instead of every tick.
export type LiveWatchFlagUpdate = {
  id: string;
  alertedSpike: boolean;
  tookHalfProfit: boolean;
  dangerAlerted: boolean;
  lastPriceUsd: number;
  lastLiquidityUsd: number;
  peakPriceUsd: number | undefined;
};

// Notification-only position watch for LIVE (real-money) positions.
//
// CRITICAL: unlike evaluatePositionWatch (paper), this NEVER sells, never
// banks profit, never force-exits. Real money is only ever sold by a user
// click in Phantom (docs/ARCHITECTURE.md "Trading and execution boundary"). This
// function's whole job is to surface the same big-move / danger signals the
// paper watch raises — up-runs and downside risk — so the user can decide.
//
// Signals (each fires once, throttled by a persisted flag):
//   - +50% from entry  -> "spike" heads-up.
//   - +100% from entry -> "profit" heads-up ("consider taking some off").
//   - Danger: thin/collapsing liquidity, dead volume, or a sudden price dump.
// The danger flag re-arms on a clean tick, so a position that recovers and
// then deteriorates again will alert a second time. tookHalfProfit is reused
// purely as the +100% throttle here (live never actually sells half).
export function liveWatchAlerts(
  positions: LivePosition[],
  prices: PriceMap
): { alerts: WatchAlert[]; flagUpdates: LiveWatchFlagUpdate[] } {
  const alerts: WatchAlert[] = [];
  const flagUpdates: LiveWatchFlagUpdate[] = [];

  for (const p of positions) {
    if (p.status !== "open") continue;
    const info = prices[p.mint];
    // No price this tick: leave the position untouched (no alert, no flag
    // change) so an upstream blip cannot fire a fake danger alert.
    if (!info || info.priceUsd <= 0) continue;

    let alertedSpike = !!p.alertedSpike;
    let alerted100 = !!p.tookHalfProfit;
    let dangerAlerted = !!p.dangerAlerted;

    const priceOk = plausibleSellPrice(info.priceUsd, p.entryPriceUsd);
    const pnlPct = ((info.priceUsd - p.entryPriceUsd) / p.entryPriceUsd) * 100;

    // Run-up. +100% and +50%, each once. Notification only.
    if (pnlPct >= 100 && !alerted100 && priceOk) {
      alerted100 = true;
      alertedSpike = true; // clearing +100% implies the +50% milestone passed
      alerts.push({
        kind: "profit",
        symbol: p.symbol,
        address: p.mint,
        text: `🔴 LIVE ${p.symbol} is up +${pnlPct.toFixed(0)}% since entry. Real money — consider taking some profit in Phantom.`
      });
    } else if (pnlPct >= 50 && !alertedSpike && priceOk) {
      alertedSpike = true;
      alerts.push({
        kind: "spike",
        symbol: p.symbol,
        address: p.mint,
        text: `🔴 LIVE ${p.symbol} is up +${pnlPct.toFixed(0)}% since entry. Possible run-up, check the chart.`
      });
    }

    // Danger early warning. Same rules as the paper watch, but it only warns —
    // it never exits the live position.
    const reasons: string[] = [];
    if (info.liquidityUsd > 0 && info.liquidityUsd < 3000) {
      reasons.push(
        `liquidity collapsed to ${usdShort(info.liquidityUsd)} — near-dead pool, exits may fail`
      );
    } else if (info.liquidityUsd < 8000) {
      reasons.push(`liquidity thin at ${usdShort(info.liquidityUsd)}`);
    }
    if (p.lastLiquidityUsd && info.liquidityUsd < p.lastLiquidityUsd * 0.6) {
      const drop = Math.round((1 - info.liquidityUsd / p.lastLiquidityUsd) * 100);
      reasons.push(`liquidity fell ${drop}% since the last check`);
    }
    if (info.volume24h !== undefined && info.volume24h < 2000) {
      reasons.push("24h volume under $2k, exits will be hard");
    }
    if (p.lastPriceUsd && info.priceUsd < p.lastPriceUsd * 0.7) {
      const drop = Math.round((1 - info.priceUsd / p.lastPriceUsd) * 100);
      reasons.push(`price dumped ${drop}% since the last check`);
    }
    if (reasons.length > 0) {
      if (!dangerAlerted) {
        alerts.push({
          kind: "danger",
          symbol: p.symbol,
          address: p.mint,
          text: `🔴 LIVE ${p.symbol} at risk: ${reasons.join("; ")}. Real money — consider exiting in Phantom.`
        });
      }
      dangerAlerted = true;
    } else {
      dangerAlerted = false; // re-arm now that the position is clean again
    }

    // Bad-data ticks (>1000x entry) are not allowed to lift the peak.
    const peak =
      !priceOk
        ? p.peakPriceUsd
        : p.peakPriceUsd === undefined || info.priceUsd > p.peakPriceUsd
          ? info.priceUsd
          : p.peakPriceUsd;

    flagUpdates.push({
      id: p.id,
      alertedSpike,
      tookHalfProfit: alerted100,
      dangerAlerted,
      lastPriceUsd: info.priceUsd,
      lastLiquidityUsd: info.liquidityUsd,
      peakPriceUsd: peak
    });
  }

  return { alerts, flagUpdates };
}
