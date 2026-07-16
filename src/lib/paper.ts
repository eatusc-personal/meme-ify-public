// Paper trading simulation for the Meme Coin tab.
//
// Fake money only. No private keys, no wallet, no real transactions, ever.
// This module decides simulated buys and sells against real live prices so a
// strategy can be tested with zero risk. See docs/ARCHITECTURE.md, "Trading and
// execution boundary": real execution is never done here or by the agent.

import type { MemeToken } from "./markets";

// Algorithm-version tag. Stamped on every position and dismissal at creation
// time, then carried through to trade_log on close. Lets us partition all
// retrospective analysis by which algorithm produced a trade.
//
// algo1: everything before 2026-05-23 (minAgeHours=24, no minHolderCount,
//        no auto-dismiss, no safety cache).
// algo2: from 2026-05-23 with the reference settings (minAgeHours=72,
//        minHolderCount=500, Jupiter top-40 enrichment, auto-dismiss on
//        RugCheck block, 6h safety cache).
// custom: algo2-era code but with settings tuned away from the reference.
//
// Bump when the gate composition changes in a way that meaningfully shifts
// what trades the cycle proposes. Cosmetic / UI changes don't warrant a bump.
export const ALGO_VERSION = "algo2";

// Reference settings that define "algo2" — used by deriveAlgoVersion to decide
// whether a captured snapshot is algo2-as-shipped or a user-tuned variant.
// If you change either of these values as the new default, bump ALGO_VERSION
// to algo3 and update this constant to match.
export const ALGO2_REFERENCE_SETTINGS = {
  minHolderCount: 500,
  minAgeHours: 72
} as const;

// Derive the algorithm version from the settings snapshot captured at trade
// time, instead of stamping it independently. This makes label/reality drift
// impossible: an algo2 stamp can only land on a row whose snapshot actually
// has the algo2 gates active.
//
// Why this exists: the previous "stamp ALGO_VERSION blindly" approach
// mislabeled trades when settings hydration hadn't resolved at buy time
// (state.settings.minHolderCount was undefined → gate short-circuited → trade
// ran with no holder filter → row still tagged 'algo2'). Same failure shape
// as the 2026-05-21 SPCX manually-corrected row. Derivation eliminates both.
export function deriveAlgoVersion(snapshot: Partial<PaperSettings> | undefined): string {
  if (!snapshot) return "unknown";
  // The minHolderCount field was added in algo2; a snapshot lacking it was
  // either written by pre-algo2 code OR by algo2 code whose settings did not
  // yet have the field hydrated. Both cases mean the algo2 holder gate did
  // not apply to this trade, so labeling it algo1 is honest.
  if (snapshot.minHolderCount === undefined) return "algo1";
  if (
    snapshot.minHolderCount === ALGO2_REFERENCE_SETTINGS.minHolderCount &&
    snapshot.minAgeHours === ALGO2_REFERENCE_SETTINGS.minAgeHours
  ) {
    return "algo2";
  }
  return "custom";
}

// Entry-time feature snapshot captured at the moment a position opens.
// Mirrors the fields from MemeToken that matter for retrospective analysis
// (what predicted the trade outcome). Carried through closePosition to the
// permanent trade_log on close. Every field is optional because positions
// opened before this shipped have none, and analysis filters on NOT NULL.
//
// The same shape is used on LivePosition (with one extra entryExitScore
// because live previously did not track it). Sourced from a MemeToken via
// snapshotMemeToken() at the call site.
export type EntrySnapshot = {
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
  // Full PaperSettings snapshot at the moment of buy. Stored as a JSON blob
  // (entry_settings_snapshot jsonb in the DB) so we can change PaperSettings
  // shape without re-migrating; query individual fields with
  //   entry_settings_snapshot->>'minHolderCount'.
  // Why JSON instead of columns: PaperSettings has ~16 numeric fields, all
  // potentially relevant, and the schema would grow unwieldy if we promoted
  // each one. Promote a specific field to a column only when you need an
  // index on it (e.g. for a dashboard groupby).
  //
  // SQL gotcha: ->> returns text, NOT the original type. Numeric comparisons
  // need an explicit cast or they become string comparisons (where '9' > '500').
  // Right:    (entry_settings_snapshot->>'minHolderCount')::int >= 500
  //           (entry_settings_snapshot->>'takeProfitPct')::float > 40
  // Wrong:    entry_settings_snapshot->>'minHolderCount' >= 500    -- string compare
  // For booleans: (entry_settings_snapshot->>'autoTrade')::boolean.
  // For nested objects use -> (preserves jsonb) rather than ->>.
  entrySettingsSnapshot?: PaperSettings;
};

// Extract the entry-time snapshot from a MemeToken at the moment of buy.
// Anywhere a position opens (paper or live, manual or queued) calls this
// once with the freshest MemeToken in hand, and the result is spread onto
// the new position. Fields the scan didn't enrich (e.g. Jupiter top-10 for
// the 21st-ranked coin) read as undefined; downstream queries filter them.
export function snapshotMemeToken(t: MemeToken): EntrySnapshot {
  return {
    entryLiquidityUsd: t.liquidityUsd,
    entryVolume24h: t.volume24h,
    entryMarketCap: t.marketCap || t.fdv || undefined,
    entryAgeHours: t.ageHours,
    entryPriceChange24h: t.priceChange24h,
    entryBuys24h: t.buys24h,
    entrySells24h: t.sells24h,
    entryBuyRatio: t.buyRatio,
    entryTop10HoldersPct: t.top10HoldersPct,
    entryBotRatio: t.botRatio,
    entryHolderCount: t.jupiterHolderCount,
    entryOrganicLabel: t.jupiterOrganicLabel,
    entryRating: t.rating,
    entryRatingBand: t.ratingBand,
    entryVerdict: t.verdict,
    entrySources: Array.isArray(t.sources) ? t.sources : undefined,
    entryRiskFlags: Array.isArray(t.riskFlags) ? t.riskFlags : undefined,
    entrySocialsCount: Array.isArray(t.socials) ? t.socials.length : undefined,
    entryJupiterEnrichedAt: t.jupiterEnrichedAt
  };
}

export type PaperPosition = {
  id: string;
  address: string;
  symbol: string;
  name: string;
  status: "open" | "closed";
  entryAt: string;
  entryPriceUsd: number;
  costUsd: number;
  tokenAmount: number;
  entryExitScore: number;
  // Algorithm version that opened this position. See ALGO_VERSION above.
  // Optional because positions opened before this field was added carry no
  // value; those rows were backfilled to 'algo1' as a one-shot migration on
  // 2026-05-23. The DB column's actual NOT NULL default is the current
  // ALGO_VERSION ('algo2' as of this writing), so any new row that bypasses
  // the persist code's explicit value still lands tagged with the present
  // algorithm rather than algo1.
  algoVersion?: string;
  // Position-watch tracking (set by evaluatePositionWatch).
  alertedSpike?: boolean;
  tookHalfProfit?: boolean;
  partialProceedsUsd?: number;
  partialRealizedUsd?: number;
  // Timestamped partial-sell events. partialRealizedUsd is the running total;
  // this list keeps each event's time so realized P&L can be date-filtered
  // (the daily-loss circuit breaker counts only today's).
  partials?: { at: string; realizedUsd: number }[];
  dangerAlerted?: boolean;
  lastPriceUsd?: number;
  lastLiquidityUsd?: number;
  // Re-arm: a user-set price level from the Trade queue. While set, the queue
  // suppresses sell proposals for this position until price crosses it, then
  // fires one fresh intent. floor = fire when price falls to/below the level;
  // ceil = fire when price rises to/above it.
  rearmPrice?: number;
  rearmDir?: "floor" | "ceil";
  // Highest USD price ever observed on this open position. Used by the
  // trailing stop in sellIntentFor. Updated on every price observation
  // (evaluatePositionWatch, runSellPass) and seeded at entry.
  peakPriceUsd?: number;
  // Entry-time feature snapshot. Copied from the MemeToken at openPosition
  // time and carried through closePosition unchanged, so trade_log inherits
  // the full feature vector for retrospective analysis. See EntrySnapshot.
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
  exitAt?: string;
  exitPriceUsd?: number;
  exitReason?: string;
  proceedsUsd?: number;
  pnlUsd?: number;
};

export type PaperSettings = {
  autoTrade: boolean;
  tradeSizeUsd: number;
  maxOpenPositions: number;
  minExitScore: number;
  minLiquidityUsd: number;
  // Min-age buy gate: the buy pass skips coins younger than this many hours.
  // See MEMECOIN_RESEARCH.md, "Decision: min-age buy gate".
  minAgeHours: number;
  // Min unique-wallet gate: a coin is skipped if its Jupiter holderCount is
  // below this. Per the 2026 holder-concentration research, bundled launches
  // (10+ insider networks, like MANIFEST) are mechanically incompatible with
  // a large holder base; a 500-holder floor rejects most bundle-only launches
  // while still admitting day-1 organic distribution. Tokens that were never
  // Jupiter-enriched (rank > enrichment window) have jupiterHolderCount
  // undefined and are NOT blocked here: an unknown holder count is treated
  // as "no data" so we don't drop everything outside the enriched window.
  minHolderCount: number;
  takeProfitPct: number;
  stopLossPct: number;
  maxHoldHours: number;
  // Re-entry cooldown: after a coin is sold, the buy pass will not rebuy it
  // for this many hours. 0 disables. Stops the cycle from re-buying a coin in
  // the same (or next) cycle it just took profit on.
  reentryCooldownHours: number;
  // Daily-loss circuit breaker: if realized P&L for the current day drops
  // past this percent of starting cash, the buy pass stops opening new
  // positions until the next day. 0 disables. Selling is never blocked.
  dailyLossLimitPct: number;
  // Holder concentration gate at the safety stage. A live buy is blocked if
  // Jupiter audit.topHoldersPercentage is above this. 0 disables. Memecoins
  // with > 30 to 40% concentrated in 10 wallets crash easily on a coordinated
  // exit; 35 is the consensus default.
  maxTopHoldersPct: number;
  // Trailing stop. Activates only once the position has been up at least
  // `trailingActivationPct` from entry at some point. Once armed, a sell is
  // proposed when price has fallen `trailingStopPct` from the peak ever seen.
  // Either at 0 disables it. Locks in gains on runners that retrace.
  trailingStopPct: number;
  trailingActivationPct: number;
  // Live daily-loss circuit breaker, in USD (not percent). Paper uses
  // % of starting cash; a live wallet has no starting-cash baseline, so live
  // uses a fixed dollar amount. 0 disables. Pauses live buys when today's
  // realized live P&L is at or below the negative of this.
  liveDailyLossLimitUsd: number;
  // Dismissed-buy re-propose threshold, in absolute rating points. When the
  // user dismisses a buy intent, the queue records the rating at dismissal.
  // A subsequent cycle re-proposes the same coin only if its rating has risen
  // by at least this many points (and a 1-hour anti-flap cooldown has passed).
  // 0 keeps dismissals permanent until manually cleared.
  buyDismissalImprovementPoints: number;
};

// Recorded when the user dismisses a buy intent from the Trade queue. The
// next decideBuyIntents / decideLiveBuyIntents pass skips this address until
// the rating climbs by buyDismissalImprovementPoints above the dismissed
// value, plus a hard 1-hour anti-flap cooldown.
export type DismissedBuyIntent = {
  address: string;
  symbol: string;
  name: string;
  account: "paper" | "live";
  dismissedAt: string;
  dismissedRating?: number;
  dismissedExitScore?: number;
  dismissedLiquidityUsd?: number;
  // How the dismissal got created. "manual" = user clicked Dismiss in the
  // queue. "auto-safety-block" = the pre-buy safety gate flagged it before
  // the user had to triage. Unset on records written before this field was
  // added; treat unset as "manual" for compatibility.
  source?: "manual" | "auto-safety-block";
  // When the dismissal is auto-safety-block, the first safety reason that
  // triggered it, so the user can later see why the coin is being skipped.
  reason?: string;
  // Algorithm version (see ALGO_VERSION). Tags which algo created this
  // dismissal so retrospective "the algo2 auto-dismiss caught N coins"
  // queries are answerable in SQL.
  algoVersion?: string;
};

// Anti-flap floor on dismissals. Even if a coin's rating jumps right after
// dismissal (a noisy scan tick, say), the user's "no" sticks for at least
// this long. Independent of the improvement threshold.
export const DISMISSED_BUY_COOLDOWN_HOURS = 1;

export type PaperState = {
  startingCashUsd: number;
  cashUsd: number;
  positions: PaperPosition[];
  settings: PaperSettings;
  updatedAt: string;
};

export type PriceInfo = { priceUsd: number; liquidityUsd: number; volume24h?: number };
export type PriceMap = Record<string, PriceInfo>;

export type TradeEvent = { kind: "buy" | "sell" | "skip" | "info"; text: string };

export type WatchAlert = {
  // "newcoin" is emitted by the scan scheduler / browser new-coin notifier for a
  // promising coin newly surfaced by a scan; the others come from position watch.
  kind: "spike" | "profit" | "danger" | "newcoin";
  symbol: string;
  // Coin mint address. Carried so consumers (e.g. the pump-trigger log) can
  // match the exact position; memecoins reuse tickers, so symbol is ambiguous.
  address: string;
  text: string;
};

// A dismissible alert shown in the dashboard. `kind` matches WatchAlert's.
// `scrollToId`, when set, makes the toast clickable: clicking it scrolls to
// the DOM element with that id (e.g. the Trade queue panel).
//
// `dismissed` is the "hide from the floating toast stack" flag. The alerts
// log panel always shows every alert (dismissed ones visually muted), so the
// user can clear the toast to see what's underneath without losing the log
// entry. Permanent removal happens only from the alerts log's own buttons.
export type PanelAlert = {
  id: string;
  at: string;
  text: string;
  kind: WatchAlert["kind"];
  scrollToId?: string;
  dismissed?: boolean;
};

const STARTING_CASH = 1000;

export function defaultPaperState(): PaperState {
  return {
    startingCashUsd: STARTING_CASH,
    cashUsd: STARTING_CASH,
    positions: [],
    settings: {
      // Off by default: a fresh paper account should not buy on the first
      // auto-run cycle before the user has had a chance to set thresholds.
      autoTrade: false,
      tradeSizeUsd: 50,
      maxOpenPositions: 8,
      minExitScore: 62,
      minLiquidityUsd: 25000,
      // 72h clears the filter that kills ~95% of launches per the memecoin
      // research; bumped from 24 once the user committed to treating paper
      // and live with the same conservative gate. Editable.
      minAgeHours: 72,
      // 500 unique holders rejects bundle-only launches (which physically
      // cannot hit that count) while still admitting day-1 organic coins
      // that have started distributing. Pairs with maxTopHoldersPct (35) as
      // the structural-distribution layer of the gate. See holder-concentration
      // research, May 2026.
      minHolderCount: 500,
      takeProfitPct: 40,
      stopLossPct: 25,
      // A far backstop, not the primary exit: positions normally close on
      // take-profit, stop-loss, or the liquidity rules well before this.
      maxHoldHours: 720,
      // 6h: long enough that a coin just sold has to re-prove itself before
      // the cycle will buy it back, not so long it locks out a genuine setup.
      reentryCooldownHours: 6,
      // 20%: a down-20%-on-the-day account stops opening new positions.
      dailyLossLimitPct: 20,
      // 35%: consensus "back away" threshold for top-10 holder concentration
      // on memecoins. RugCheck / Jupiter give us this number on every report.
      maxTopHoldersPct: 35,
      // Trailing stop: 25% activation, 35% trail. After +25% peak gain, sell
      // if price falls 35% from the peak. Locks in most of a runner's move
      // even if take-profit is set higher to let it ride.
      trailingStopPct: 35,
      trailingActivationPct: 25,
      // Live daily-loss limit, USD. 0 disables (user must set a value to
      // turn it on). Tight starting fence for real money would be $50.
      liveDailyLossLimitUsd: 0,
      // Dismissed-buy re-propose threshold: rating must climb by at least
      // this many absolute points above the dismissed value before the queue
      // re-proposes a previously-dismissed coin. Default 10 (so a coin
      // dismissed at rating 77 only comes back at 87+). 0 = permanent until
      // user clears the dismissal by manually buying.
      buyDismissalImprovementPoints: 10
    },
    updatedAt: new Date().toISOString()
  };
}

function pid(): string {
  return `pp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function hoursSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 3.6e6;
}

// A sell price more than 1000x above entry is almost certainly a bad data
// tick from a thin pool, not a real move. Refuse to book the fake profit.
// The downside is NOT guarded: real memecoin rugs routinely take a coin
// 1000x below entry, and that fill needs to be honored so the loss is booked.
// Exported so the live trading path (runLiveCycle in App.tsx) can guard its
// own peak-lift against the same kind of bad tick.
export function plausibleSellPrice(price: number, entryPriceUsd: number): boolean {
  if (price <= 0 || entryPriceUsd <= 0) return false;
  return price / entryPriceUsd <= 1000;
}

function openPosition(
  state: PaperState,
  token: MemeToken,
  sizeUsd: number
): { state: PaperState; event: TradeEvent } {
  if (token.priceUsd <= 0) {
    return { state, event: { kind: "skip", text: `${token.symbol}: no price, skipped` } };
  }
  const size = Math.min(sizeUsd, state.cashUsd);
  if (size < 1) {
    return { state, event: { kind: "skip", text: `${token.symbol}: out of paper cash` } };
  }
  // Diagnostic warning: a token reaching openPosition with no ageHours means
  // the call path lost the enriched MemeToken somewhere upstream (e.g. the
  // queue approval re-creating a stub from the intent instead of looking up
  // the latest scan). This is the symptom of the entry-feature-NULL bug.
  // Catching it here points at the first reproduction rather than us
  // re-querying the DB and guessing days later.
  if (token.ageHours == null) {
    console.warn(
      `[paper.openPosition] ${token.symbol} (${token.address}) has no ageHours — entry feature snapshot will write NULL. Check the call path; the caller probably passed a stub MemeToken instead of the enriched scan record.`
    );
  }
  const pos: PaperPosition = {
    id: pid(),
    address: token.address,
    symbol: token.symbol,
    name: token.name,
    status: "open",
    entryAt: new Date().toISOString(),
    entryPriceUsd: token.priceUsd,
    costUsd: size,
    tokenAmount: size / token.priceUsd,
    entryExitScore: token.exitScore,
    // Seed the peak at entry so the trailing stop has a baseline. The watch
    // raises it on every observation when price prints a higher high.
    peakPriceUsd: token.priceUsd,
    // Full settings snapshot + DERIVED algo tag. The algo tag is computed
    // from the snapshot (not stamped blindly) so a row can never claim a
    // gate regime its captured settings don't satisfy. See deriveAlgoVersion.
    entrySettingsSnapshot: { ...state.settings },
    algoVersion: deriveAlgoVersion(state.settings),
    // Entry-time feature snapshot for retrospective analysis. Carried to
    // trade_log on close. Spread, so adding fields to EntrySnapshot picks
    // them up automatically here.
    ...snapshotMemeToken(token)
  };
  return {
    state: {
      ...state,
      cashUsd: state.cashUsd - size,
      positions: [pos, ...state.positions],
      updatedAt: new Date().toISOString()
    },
    event: {
      kind: "buy",
      text: `Bought ${token.symbol} for $${size.toFixed(2)} at $${token.priceUsd.toPrecision(4)}`
    }
  };
}

function closePosition(pos: PaperPosition, price: number, reason: string): PaperPosition {
  const proceeds = pos.tokenAmount * Math.max(price, 0);
  return {
    ...pos,
    status: "closed",
    exitAt: new Date().toISOString(),
    exitPriceUsd: Math.max(price, 0),
    exitReason: reason,
    proceedsUsd: proceeds,
    pnlUsd: proceeds - pos.costUsd
  };
}

// Manual paper buy of one coin (the "Buy (paper)" button on a card).
export function buyManual(
  state: PaperState,
  token: MemeToken
): { state: PaperState; event: TradeEvent } {
  if (state.positions.some((p) => p.status === "open" && p.address === token.address)) {
    return { state, event: { kind: "skip", text: `${token.symbol}: already holding` } };
  }
  return openPosition(state, token, state.settings.tradeSizeUsd);
}

// Manual paper sell of one open position. `pct` is the fraction to sell:
// 100 (default) closes the position; below 100 is a partial sell / scale-out
// that banks the fraction and leaves the rest open.
export function sellManual(
  state: PaperState,
  positionId: string,
  price: number,
  pct = 100
): { state: PaperState; event: TradeEvent } {
  const pos = state.positions.find((p) => p.id === positionId && p.status === "open");
  if (!pos) return { state, event: { kind: "skip", text: "Position not open" } };
  const fillPrice = price > 0 ? price : pos.entryPriceUsd;
  if (!plausibleSellPrice(fillPrice, pos.entryPriceUsd)) {
    return {
      state,
      event: {
        kind: "skip",
        text: `${pos.symbol}: price reading looks like bad data (${(fillPrice / pos.entryPriceUsd).toFixed(0)}x entry). Sell skipped, try again in a moment.`
      }
    };
  }
  // Partial sell (a scale-out, or a user-set sell % on a queued intent): bank
  // the fraction sold, keep the rest open. A position trimmed once is not
  // auto-proposed for another scale-out (tookHalfProfit).
  const frac = Math.max(0, Math.min(1, pct / 100));
  if (frac > 0 && frac < 0.9999) {
    const soldTokens = pos.tokenAmount * frac;
    const soldCost = pos.costUsd * frac;
    const proceeds = soldTokens * fillPrice;
    const updated: PaperPosition = {
      ...pos,
      tokenAmount: pos.tokenAmount - soldTokens,
      costUsd: pos.costUsd - soldCost,
      partialProceedsUsd: (pos.partialProceedsUsd ?? 0) + proceeds,
      partialRealizedUsd: (pos.partialRealizedUsd ?? 0) + (proceeds - soldCost),
      partials: [
        ...(pos.partials ?? []),
        { at: new Date().toISOString(), realizedUsd: proceeds - soldCost }
      ],
      tookHalfProfit: true
    };
    return {
      state: {
        ...state,
        cashUsd: state.cashUsd + proceeds,
        positions: state.positions.map((p) => (p.id === pos.id ? updated : p)),
        updatedAt: new Date().toISOString()
      },
      event: {
        kind: "sell",
        text: `Sold ${Math.round(frac * 100)}% of ${pos.symbol}, banked $${proceeds.toFixed(
          2
        )} (P&L $${(proceeds - soldCost).toFixed(2)})`
      }
    };
  }
  const closed = closePosition(pos, fillPrice, "manual");
  return {
    state: {
      ...state,
      cashUsd: state.cashUsd + (closed.proceedsUsd ?? 0),
      positions: state.positions.map((p) => (p.id === pos.id ? closed : p)),
      updatedAt: new Date().toISOString()
    },
    event: { kind: "sell", text: `Sold ${pos.symbol}, P&L $${(closed.pnlUsd ?? 0).toFixed(2)}` }
  };
}

// Sell pass: close open positions that hit take-profit, stop-loss, max hold,
// or whose pool liquidity has effectively vanished (a paper "rug").
export function runSellPass(
  state: PaperState,
  prices: PriceMap
): { state: PaperState; events: TradeEvent[] } {
  const events: TradeEvent[] = [];
  let cash = state.cashUsd;
  const { takeProfitPct, stopLossPct, maxHoldHours } = state.settings;

  const { trailingStopPct, trailingActivationPct } = state.settings;

  const positions = state.positions.map((p) => {
    if (p.status !== "open") return p;
    const info = prices[p.address];

    if (!info || info.priceUsd <= 0) {
      // Price fetch failed for this address this cycle. Leave the position
      // alone instead of force-closing as rugged: an upstream hiccup at
      // DexScreener was previously closing live positions as fake rugs.
      // A genuine rug still trips the liquidity-dried-up branch below as
      // soon as a price comes back, and the user can always sell manually.
      events.push({
        kind: "info",
        text: `${p.symbol}: no price this cycle, left open. Will retry next cycle.`
      });
      return p;
    }

    // Lift peak before any rule check so the trailing stop sees today's high.
    // Bad-data ticks (>1000x entry) are NOT allowed to lift the peak; the
    // existing plausibility check below skips the actual sell, so guarding
    // the peak too keeps a glitch from corrupting trailing-stop math on the
    // next normal tick.
    const priceOk = plausibleSellPrice(info.priceUsd, p.entryPriceUsd);
    const peak =
      !priceOk
        ? p.peakPriceUsd
        : p.peakPriceUsd === undefined || info.priceUsd > p.peakPriceUsd
          ? info.priceUsd
          : p.peakPriceUsd;
    const carried: PaperPosition = peak === p.peakPriceUsd ? p : { ...p, peakPriceUsd: peak };

    const pnlPct = ((info.priceUsd - p.entryPriceUsd) / p.entryPriceUsd) * 100;
    // peak can be undefined on the first tick of a position opened before the
    // peak field shipped, AND when a bad-data tick was rejected from lifting.
    // In either case, treat trailing as off this cycle. Also defensively
    // ignore a historical >1000x peak (the same guard sellIntentFor uses).
    const peakOk =
      peak !== undefined && peak > 0 && peak / p.entryPriceUsd <= 1000;
    const peakGainPct = peakOk ? ((peak! - p.entryPriceUsd) / p.entryPriceUsd) * 100 : 0;
    const dropFromPeakPct = peakOk ? ((info.priceUsd - peak!) / peak!) * 100 : 0;
    const heldH = hoursSince(p.entryAt);
    let reason = "";
    if (info.liquidityUsd > 0 && info.liquidityUsd < 3000) reason = "liquidity dried up";
    else if (
      trailingStopPct > 0 &&
      peakOk &&
      peakGainPct >= trailingActivationPct &&
      dropFromPeakPct <= -trailingStopPct
    )
      reason = "trailing stop";
    else if (pnlPct >= takeProfitPct) reason = "take profit";
    else if (pnlPct <= -stopLossPct) reason = "stop loss";
    else if (heldH >= maxHoldHours) reason = "max hold time";
    if (!reason) return carried;

    if (!plausibleSellPrice(info.priceUsd, p.entryPriceUsd)) {
      events.push({
        kind: "info",
        text: `${p.symbol}: price reading looked like bad data, sell skipped this cycle`
      });
      return carried;
    }

    const closed = closePosition(carried, info.priceUsd, reason);
    cash += closed.proceedsUsd ?? 0;
    events.push({
      kind: "sell",
      text: `${p.symbol}: ${reason}, P&L $${(closed.pnlUsd ?? 0).toFixed(2)} (${
        pnlPct >= 0 ? "+" : ""
      }${pnlPct.toFixed(0)}%)`
    });
    return closed;
  });

  return {
    state: { ...state, cashUsd: cash, positions, updatedAt: new Date().toISOString() },
    events
  };
}

// Exit reasons that mean the pool collapsed under the position, a "rug" in
// practice. A coin closed for one of these is never bought again.
const RUG_EXIT_REASONS = ["liquidity dried up", "liquidity death"];

// Addresses of coins that rugged on us: any closed position whose exit reason
// was a liquidity collapse. The buy pass and the queue never rebuy these.
// Derived from position history, so a paper reset (which clears positions)
// also clears it.
export function ruggedAddresses(state: PaperState): Set<string> {
  const out = new Set<string>();
  for (const p of state.positions) {
    if (
      p.status === "closed" &&
      p.exitReason &&
      RUG_EXIT_REASONS.some((r) => p.exitReason!.includes(r))
    ) {
      out.add(p.address);
    }
  }
  return out;
}

// True if `address` was sold within the re-entry cooldown window, so the buy
// pass should not rebuy it yet.
export function inReentryCooldown(state: PaperState, address: string): boolean {
  const hrs = state.settings.reentryCooldownHours;
  if (!hrs || hrs <= 0) return false;
  let lastExit = 0;
  for (const p of state.positions) {
    if (p.status === "closed" && p.address === address && p.exitAt) {
      const t = new Date(p.exitAt).getTime();
      if (t > lastExit) lastExit = t;
    }
  }
  if (lastExit === 0) return false;
  return (Date.now() - lastExit) / 3.6e6 < hrs;
}

function sameLocalDay(iso: string, now: Date): boolean {
  const d = new Date(iso);
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

// Realized P&L booked on the current calendar day. Two sources, both dated:
// a full close's pnlUsd (by exitAt) and each partial-sell / scale-out event
// (by its own timestamp). Without the partials a partial loss on a still-open
// position would be invisible here and the circuit breaker would under-count.
export function dailyRealizedUsd(state: PaperState): number {
  const now = new Date();
  let sum = 0;
  for (const p of state.positions) {
    if (p.status === "closed" && p.exitAt && p.pnlUsd !== undefined && sameLocalDay(p.exitAt, now)) {
      sum += p.pnlUsd;
    }
    for (const ps of p.partials ?? []) {
      if (sameLocalDay(ps.at, now)) sum += ps.realizedUsd;
    }
  }
  return sum;
}

// True if the day's realized loss has passed the circuit-breaker limit. When
// tripped, the buy pass opens nothing; selling is never blocked.
export function circuitBreakerTripped(state: PaperState): boolean {
  const limit = state.settings.dailyLossLimitPct;
  if (!limit || limit <= 0) return false;
  return dailyRealizedUsd(state) <= -(limit / 100) * state.startingCashUsd;
}

// Buy pass: open positions on the top-ranked candidates that clear the rules.
// Candidates must already be sorted best-first by rating (scanMemecoins does
// this); the buy filters below still gate on exit score, liquidity, and age.
export function runBuyPass(
  state: PaperState,
  candidates: MemeToken[]
): { state: PaperState; events: TradeEvent[] } {
  const events: TradeEvent[] = [];
  if (!state.settings.autoTrade) {
    // This gate is execute-mode only. decideBuyIntents (queue mode) intentionally
    // does NOT check autoTrade — queue mode is "I review every trade", so the
    // setting only makes sense for the execute path. See the matching note on
    // decideBuyIntents below.
    return { state, events: [{ kind: "info", text: "Auto-execute is off, no buys booked this cycle" }] };
  }
  if (circuitBreakerTripped(state)) {
    return {
      state,
      events: [
        {
          kind: "info",
          text: `Daily loss limit hit (down $${Math.abs(dailyRealizedUsd(state)).toFixed(
            0
          )} realized today). Buying paused until tomorrow; selling still runs.`
        }
      ]
    };
  }

  let next = state;
  const {
    maxOpenPositions,
    minExitScore,
    minLiquidityUsd,
    minAgeHours,
    minHolderCount,
    tradeSizeUsd
  } = state.settings;
  const rugged = ruggedAddresses(state);
  let rugSkips = 0;
  let cooldownSkips = 0;

  for (const token of candidates) {
    const openCount = next.positions.filter((p) => p.status === "open").length;
    if (openCount >= maxOpenPositions) {
      events.push({ kind: "info", text: `Max ${maxOpenPositions} open positions reached` });
      break;
    }
    if (next.cashUsd < 1) {
      events.push({ kind: "info", text: "Out of paper cash" });
      break;
    }
    if (token.exitScore < minExitScore) continue;
    if (token.liquidityUsd < minLiquidityUsd) continue;
    // Min-age gate. Per MEMECOIN_RESEARCH.md, ~95% of launches die in the
    // first 24-72h, so an older coin still showing live volume has cleared
    // that filter. ageHours === 0 means DexScreener returned no pairCreatedAt;
    // an unknown age is not blocked here.
    if (minAgeHours > 0 && token.ageHours > 0 && token.ageHours < minAgeHours) continue;
    // Min-holders gate. undefined = no Jupiter data, treated as unknown (allow
    // through). When data exists, block coins below the threshold; the bundle-
    // launch pattern (10+ insider networks) is mechanically incompatible with
    // a large organic holder base.
    if (
      minHolderCount > 0 &&
      token.jupiterHolderCount !== undefined &&
      token.jupiterHolderCount < minHolderCount
    )
      continue;
    if (token.priceUsd <= 0) continue;
    if (next.positions.some((p) => p.status === "open" && p.address === token.address)) continue;
    // Never rebuy a coin that rugged on us.
    if (rugged.has(token.address)) {
      rugSkips++;
      continue;
    }
    // Honor the re-entry cooldown after a recent sale, so the cycle does not
    // rebuy a coin in the same or next cycle it just took profit on.
    if (inReentryCooldown(state, token.address)) {
      cooldownSkips++;
      continue;
    }

    const res = openPosition(next, token, tradeSizeUsd);
    next = res.state;
    events.push(res.event);
  }

  if (rugSkips > 0) {
    events.push({
      kind: "info",
      text: `Skipped ${rugSkips} coin${rugSkips === 1 ? "" : "s"} blacklisted as rugged`
    });
  }
  if (cooldownSkips > 0) {
    events.push({
      kind: "info",
      text: `Skipped ${cooldownSkips} coin${cooldownSkips === 1 ? "" : "s"} inside the re-entry cooldown`
    });
  }
  if (events.length === 0) {
    events.push({ kind: "info", text: "No coins met the buy rules this cycle" });
  }
  return { state: next, events };
}

function usdShort(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}

// Position watch. Runs on a short interval (every ~5 min) over OPEN positions.
// Three jobs:
//   1. Run-up: at +50% raise a "spike" alert; at +100% sell half ("profit").
//   2. Danger: flag positions at risk of going to zero (thin or fast-falling
//      liquidity, dead volume, a sudden price dump) with a "danger" alert.
//   3. Safety net: if liquidity is effectively gone, exit the paper position
//      so a watched coin cannot quietly round-trip to zero.
// Run-up and danger alerts each fire once per position to avoid spam.
export function evaluatePositionWatch(
  state: PaperState,
  prices: PriceMap
): { state: PaperState; alerts: WatchAlert[]; events: TradeEvent[] } {
  const alerts: WatchAlert[] = [];
  const events: TradeEvent[] = [];
  let cash = state.cashUsd;

  const positions = state.positions.map((p) => {
    if (p.status !== "open") return p;
    const info = prices[p.address];

    // No price this tick. Leave the position alone; upstream blips were
    // previously force-closing live positions as fake rugs. Genuine rugs
    // still come through the liquidity-collapse branch below once a price
    // is available, and the user can always sell manually.
    if (!info || info.priceUsd <= 0) {
      return p;
    }

    // Safety net: liquidity has collapsed. Exit before it round-trips to zero.
    if (info.liquidityUsd > 0 && info.liquidityUsd < 3000) {
      const closed = closePosition(p, info.priceUsd, "liquidity death (watch exit)");
      cash += closed.proceedsUsd ?? 0;
      events.push({
        kind: "sell",
        text: `${p.symbol}: liquidity under $3k, watch exited, P&L $${(closed.pnlUsd ?? 0).toFixed(2)}`
      });
      alerts.push({
        kind: "danger",
        symbol: p.symbol,
        address: p.address,
        text: `${p.symbol}: liquidity collapsed to ${usdShort(info.liquidityUsd)}. Watch sold the paper position before it goes to zero.`
      });
      return closed;
    }

    let next = p;
    const pnlPct = ((info.priceUsd - p.entryPriceUsd) / p.entryPriceUsd) * 100;

    // Run-up: +100% sells half once, +50% alerts once. A price more than
    // 1000x off entry is a bad-data tick, so it triggers neither.
    if (
      pnlPct >= 100 &&
      !p.tookHalfProfit &&
      plausibleSellPrice(info.priceUsd, p.entryPriceUsd)
    ) {
      const halfTokens = next.tokenAmount / 2;
      const halfCost = next.costUsd / 2;
      const proceeds = halfTokens * info.priceUsd;
      cash += proceeds;
      next = {
        ...next,
        tokenAmount: next.tokenAmount - halfTokens,
        costUsd: next.costUsd - halfCost,
        partialProceedsUsd: (next.partialProceedsUsd ?? 0) + proceeds,
        partialRealizedUsd: (next.partialRealizedUsd ?? 0) + (proceeds - halfCost),
        partials: [
          ...(next.partials ?? []),
          { at: new Date().toISOString(), realizedUsd: proceeds - halfCost }
        ],
        tookHalfProfit: true,
        alertedSpike: true
      };
      events.push({
        kind: "sell",
        text: `${p.symbol}: +${pnlPct.toFixed(0)}%, sold half, banked $${proceeds.toFixed(2)}`
      });
      alerts.push({
        kind: "profit",
        symbol: p.symbol,
        address: p.address,
        text: `${p.symbol} hit +${pnlPct.toFixed(0)}%. Sold half the paper position and banked $${proceeds.toFixed(2)}. The rest keeps riding.`
      });
    } else if (
      pnlPct >= 50 &&
      !p.alertedSpike &&
      plausibleSellPrice(info.priceUsd, p.entryPriceUsd)
    ) {
      next = { ...next, alertedSpike: true };
      alerts.push({
        kind: "spike",
        symbol: p.symbol,
        address: p.address,
        text: `${p.symbol} is up +${pnlPct.toFixed(0)}% since entry. Possible run-up, check the chart.`
      });
    }

    // Danger early warning. The flag throttles repeats while a danger
    // condition holds, but resets on a clean tick so a position that
    // recovers and then deteriorates again will alert a second time.
    const reasons: string[] = [];
    if (info.liquidityUsd < 8000) {
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
      if (!next.dangerAlerted) {
        alerts.push({
          kind: "danger",
          symbol: p.symbol,
          address: p.address,
          text: `${p.symbol} is at risk of going to zero: ${reasons.join("; ")}. Consider exiting.`
        });
      }
      next = { ...next, dangerAlerted: true };
    } else if (next.dangerAlerted) {
      // Re-arm now that the position is clean again.
      next = { ...next, dangerAlerted: false };
    }

    // Record this check's values so the next check can measure the deltas,
    // and lift the peak if we just printed a new high (the trailing stop
    // reads peakPriceUsd in sellIntentFor). Bad-data ticks (>1000x entry)
    // are NOT allowed to lift the peak: otherwise one glitch permanently
    // corrupts the peak and the next normal tick fires trailing as a fake
    // -99% drawdown. lastPriceUsd / lastLiquidityUsd still update so the
    // delta-based danger checks see fresh data.
    const priceOk = plausibleSellPrice(info.priceUsd, p.entryPriceUsd);
    const peak =
      !priceOk
        ? next.peakPriceUsd
        : next.peakPriceUsd === undefined || info.priceUsd > next.peakPriceUsd
          ? info.priceUsd
          : next.peakPriceUsd;
    next = {
      ...next,
      lastPriceUsd: info.priceUsd,
      lastLiquidityUsd: info.liquidityUsd,
      peakPriceUsd: peak
    };
    return next;
  });

  return {
    state: { ...state, cashUsd: cash, positions, updatedAt: new Date().toISOString() },
    alerts,
    events
  };
}

// Alert-only sibling of evaluatePositionWatch, for QUEUE MODE. Queue mode never
// auto-sells, so the full evaluator (which banks half at +100% and force-exits
// on liquidity death) must NOT run there. This reproduces only the *advisory*
// signals — the +50% spike heads-up and the danger early-warnings — plus the
// throttle bookkeeping (alertedSpike / dangerAlerted) and the last-seen
// price/liquidity used for delta-based danger detection. It mutates NOTHING
// about cash, token amounts, status, partials, or peak: the actual sells are
// proposed by decideSellIntents and approved by the user from the Trade queue.
// The +100% sell-half and liquidity-death branches are intentionally dropped —
// in queue mode those become sell intents, not auto-sales. Keep the spike and
// danger thresholds here in sync with evaluatePositionWatch.
export function watchAdvisoryAlerts(
  state: PaperState,
  prices: PriceMap
): {
  alerts: WatchAlert[];
  flagUpdates: {
    id: string;
    alertedSpike: boolean;
    dangerAlerted: boolean;
    lastPriceUsd: number;
    lastLiquidityUsd: number;
  }[];
} {
  const alerts: WatchAlert[] = [];
  const flagUpdates: {
    id: string;
    alertedSpike: boolean;
    dangerAlerted: boolean;
    lastPriceUsd: number;
    lastLiquidityUsd: number;
  }[] = [];

  for (const p of state.positions) {
    if (p.status !== "open") continue;
    const info = prices[p.address];
    if (!info || info.priceUsd <= 0) continue;

    let alertedSpike = !!p.alertedSpike;
    let dangerAlerted = !!p.dangerAlerted;
    const pnlPct = ((info.priceUsd - p.entryPriceUsd) / p.entryPriceUsd) * 100;

    // +50% run-up heads-up, once per position.
    if (pnlPct >= 50 && !alertedSpike && plausibleSellPrice(info.priceUsd, p.entryPriceUsd)) {
      alertedSpike = true;
      alerts.push({
        kind: "spike",
        symbol: p.symbol,
        address: p.address,
        text: `${p.symbol} is up +${pnlPct.toFixed(0)}% since entry. Possible run-up, check the chart — a sell may be proposed in the Trade queue.`
      });
    }

    // Danger early warning. The flag throttles repeats while a danger condition
    // holds, but resets on a clean tick so a position that recovers and then
    // deteriorates again alerts a second time.
    const reasons: string[] = [];
    if (info.liquidityUsd < 8000) {
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
          address: p.address,
          text: `${p.symbol} is at risk of going to zero: ${reasons.join("; ")}. Consider exiting from the Trade queue.`
        });
      }
      dangerAlerted = true;
    } else {
      dangerAlerted = false;
    }

    flagUpdates.push({
      id: p.id,
      alertedSpike,
      dangerAlerted,
      lastPriceUsd: info.priceUsd,
      lastLiquidityUsd: info.liquidityUsd
    });
  }

  return { alerts, flagUpdates };
}

export function portfolioStats(state: PaperState, prices: PriceMap) {
  const open = state.positions.filter((p) => p.status === "open");
  const closed = state.positions.filter((p) => p.status === "closed");

  let openValue = 0;
  let unrealized = 0;
  for (const p of open) {
    const info = prices[p.address];
    const price = info && info.priceUsd > 0 ? info.priceUsd : p.entryPriceUsd;
    const value = p.tokenAmount * price;
    openValue += value;
    unrealized += value - p.costUsd;
  }

  // Realized = final P&L of closed trades + profit already banked from any
  // partial (sell-half) exits, on both open and closed positions.
  const realizedClosed = closed.reduce((s, p) => s + (p.pnlUsd ?? 0), 0);
  const realizedPartial = state.positions.reduce((s, p) => s + (p.partialRealizedUsd ?? 0), 0);
  const realized = realizedClosed + realizedPartial;
  const equity = state.cashUsd + openValue;
  const wins = closed.filter((p) => (p.pnlUsd ?? 0) > 0).length;

  return {
    equity,
    openValue,
    unrealized,
    realized,
    totalPnl: equity - state.startingCashUsd,
    winRate: closed.length ? (wins / closed.length) * 100 : 0,
    openCount: open.length,
    closedCount: closed.length,
    wins
  };
}

// Current value of one open position given the latest price map.
export function positionValue(pos: PaperPosition, prices: PriceMap): number {
  const info = prices[pos.address];
  const price = info && info.priceUsd > 0 ? info.priceUsd : pos.entryPriceUsd;
  return pos.tokenAmount * price;
}

export type TradeStats = {
  opened: number;
  open: number;
  closed: number;
  byReason: { reason: string; count: number }[];
  scaledOut: number;
  buyFills: number;
  sellFills: number;
  totalFills: number;
  volumeTradedUsd: number;
  estFeesUsd: number;
  realizedGrossUsd: number;
  realizedNetUsd: number;
  // Breakdown of closed trades by the algorithm that opened them, so a user
  // can answer "is algo2 actually doing better than algo1?" without SQL.
  // Sorted by closed count, descending. See deriveAlgoVersion for the
  // possible values ('algo1' | 'algo2' | 'custom').
  byAlgo: {
    algoVersion: string;
    closed: number;
    wins: number;
    winRate: number; // 0..100, undefined→0 when closed === 0
    pnlUsd: number; // sum of closed-trade pnlUsd; excludes partial-realized
    avgPnlUsd: number;
  }[];
};

// Trade-activity counts plus an estimated fee total. Paper trading books no
// fees; this is a what-if estimate of what the same activity would cost for
// real. `feePerFillPct` is the assumed cost of each swap as a percent of its
// USD size, which is how a Solana DEX/AMM pool fee works (it scales with the
// trade size, it is not flat). One fill = one swap = one fee event: a buy, a
// close, or a +100% scale-out half.
export function tradeStats(state: PaperState, feePerFillPct: number): TradeStats {
  const positions = state.positions;
  const closedPositions = positions.filter((p) => p.status === "closed");
  const opened = positions.length;
  const closed = closedPositions.length;
  const open = opened - closed;
  const scaledOut = positions.filter((p) => p.tookHalfProfit).length;

  const reasonCounts = new Map<string, number>();
  for (const p of closedPositions) {
    const r = p.exitReason || "other";
    reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
  }
  const byReason = [...reasonCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  const buyFills = opened; // one buy per position opened
  const sellFills = closed + scaledOut; // each close, plus each scale-out half
  const totalFills = buyFills + sellFills;

  // USD value swapped on each fill. Fees scale with these, not with the count.
  const buyNotional = positions.reduce((s, p) => s + p.costUsd, 0);
  const sellNotional = closedPositions.reduce((s, p) => s + (p.proceedsUsd ?? 0), 0);
  const partialNotional = positions.reduce((s, p) => s + (p.partialProceedsUsd ?? 0), 0);
  const volumeTradedUsd = buyNotional + sellNotional + partialNotional;

  const estFeesUsd = (Math.max(0, feePerFillPct) / 100) * volumeTradedUsd;

  // Realized = closed-trade P&L plus profit banked from +100% scale-outs, the
  // same definition portfolioStats() uses.
  const realizedClosed = closedPositions.reduce((s, p) => s + (p.pnlUsd ?? 0), 0);
  const realizedPartial = positions.reduce((s, p) => s + (p.partialRealizedUsd ?? 0), 0);
  const realizedGrossUsd = realizedClosed + realizedPartial;

  // Algo breakdown over CLOSED positions only. Open positions aren't yet
  // realized, so including them would muddy the win-rate / pnl columns.
  // A position with no algoVersion (only possible on rows that pre-date the
  // tag and never got the in-memory backfill) is bucketed as 'algo1' for
  // parity with the DB collapse — see the schema's "Collapse 'unknown' →
  // 'algo1'" section.
  const algoMap = new Map<string, { closed: number; wins: number; pnlUsd: number }>();
  for (const p of closedPositions) {
    const key = p.algoVersion ?? "algo1";
    const cur = algoMap.get(key) ?? { closed: 0, wins: 0, pnlUsd: 0 };
    cur.closed += 1;
    if ((p.pnlUsd ?? 0) > 0) cur.wins += 1;
    cur.pnlUsd += p.pnlUsd ?? 0;
    algoMap.set(key, cur);
  }
  const byAlgo = [...algoMap.entries()]
    .map(([algoVersion, v]) => ({
      algoVersion,
      closed: v.closed,
      wins: v.wins,
      winRate: v.closed > 0 ? (v.wins / v.closed) * 100 : 0,
      pnlUsd: v.pnlUsd,
      avgPnlUsd: v.closed > 0 ? v.pnlUsd / v.closed : 0
    }))
    .sort((a, b) => b.closed - a.closed);

  return {
    opened,
    open,
    closed,
    byReason,
    scaledOut,
    buyFills,
    sellFills,
    totalFills,
    volumeTradedUsd,
    estFeesUsd,
    realizedGrossUsd,
    realizedNetUsd: realizedGrossUsd - estFeesUsd,
    byAlgo
  };
}

export type SanityLevel = "error" | "warn" | "ok";
export type SanityFinding = { level: SanityLevel; title: string; detail: string };

// Validate the paper-trading settings and the account ledger for likely
// mistakes: a fat-fingered threshold, a self-defeating rule combination, a
// broken balance. A linter for the trading rules. Returns a single "ok"
// finding when nothing looks wrong.
export function sanityCheck(state: PaperState): SanityFinding[] {
  const out: SanityFinding[] = [];
  const s = state.settings;
  const closed = state.positions.filter((p) => p.status === "closed");

  // Stop loss. The headline check: a value far below memecoin volatility is
  // almost always a typo (the 2-vs-25 mistake this button exists to catch).
  if (s.stopLossPct <= 0) {
    out.push({
      level: "error",
      title: "Stop loss is not set",
      detail: `Stop loss is ${s.stopLossPct}%. It must be a positive percent.`
    });
  } else if (s.stopLossPct < 8) {
    out.push({
      level: "error",
      title: `Stop loss looks like a typo (${s.stopLossPct}%)`,
      detail: `A ${s.stopLossPct}% stop is far tighter than normal memecoin swings, so positions get stopped out on noise. Typical is 20 to 40%. If you meant 25, fix it.`
    });
  } else if (s.stopLossPct > 95) {
    out.push({
      level: "warn",
      title: `Stop loss is very wide (${s.stopLossPct}%)`,
      detail: `At ${s.stopLossPct}% the stop barely protects you; most of a bad move is booked before it ever triggers.`
    });
  }

  // Take profit.
  if (s.takeProfitPct <= 0) {
    out.push({
      level: "error",
      title: "Take profit is not set",
      detail: `Take profit is ${s.takeProfitPct}%. It must be a positive percent.`
    });
  } else if (s.takeProfitPct < 10) {
    out.push({
      level: "warn",
      title: `Take profit is very low (${s.takeProfitPct}%)`,
      detail: `A ${s.takeProfitPct}% target closes winners almost immediately and caps the upside on every trade.`
    });
  }
  if (s.takeProfitPct > 0 && s.takeProfitPct < 100) {
    out.push({
      level: "warn",
      title: "Take profit pre-empts the 2x scale-out",
      detail: `Take profit (${s.takeProfitPct}%) closes the whole position before +100%, so with auto-run on the "Scale out at 2x" watch rule almost never fires. Raise it above 100% if you want runners to ride.`
    });
  }
  if (s.takeProfitPct > 0 && s.stopLossPct > 0 && s.takeProfitPct < s.stopLossPct) {
    out.push({
      level: "warn",
      title: "Take profit is smaller than stop loss",
      detail: `You aim for +${s.takeProfitPct}% but risk -${s.stopLossPct}% per trade. With a low memecoin win rate, a target below the stop is hard to make profitable.`
    });
  }

  // Min exit score (0 to 100).
  if (s.minExitScore > 100) {
    out.push({
      level: "error",
      title: `Min exit score is above 100 (${s.minExitScore})`,
      detail: `No coin can score above 100, so the auto-trade buy pass will never buy anything.`
    });
  } else if (s.minExitScore <= 0) {
    out.push({
      level: "warn",
      title: "Min exit score is 0",
      detail: `The buy pass will take any coin that clears the liquidity and age rules, including low-quality ones.`
    });
  }

  // Min liquidity.
  if (s.minLiquidityUsd <= 0) {
    out.push({
      level: "warn",
      title: "Min liquidity is 0",
      detail: `The buy pass will not filter on pool depth at all; near-dead pools can be bought.`
    });
  } else if (s.minLiquidityUsd < 5000) {
    out.push({
      level: "warn",
      title: `Min liquidity is very low ($${Math.round(s.minLiquidityUsd)})`,
      detail: `Pools this thin move hard against you on the way out. $10k and up is safer for an exit.`
    });
  }

  // Trade size vs cash.
  if (s.tradeSizeUsd <= 0) {
    out.push({
      level: "error",
      title: "Trade size is not set",
      detail: `Trade size is $${s.tradeSizeUsd}. It must be positive or the buy pass cannot open a position.`
    });
  } else if (state.cashUsd >= 0 && s.tradeSizeUsd > state.cashUsd) {
    out.push({
      level: "warn",
      title: "Trade size is larger than your cash",
      detail: `Trade size $${Math.round(s.tradeSizeUsd)} is more than the $${Math.round(state.cashUsd)} cash available; the next buy will be capped or skipped.`
    });
  }

  // Max open positions, max hold, min age.
  if (s.maxOpenPositions < 1) {
    out.push({
      level: "error",
      title: "Max open positions is below 1",
      detail: `With max open positions at ${s.maxOpenPositions}, the buy pass can never open a position.`
    });
  }
  if (s.maxHoldHours < 1) {
    out.push({
      level: "error",
      title: `Max hold is too short (${s.maxHoldHours}h)`,
      detail: `Positions would be force-sold almost as soon as they are bought.`
    });
  }
  if (s.minAgeHours < 0) {
    out.push({
      level: "error",
      title: "Min age is negative",
      detail: `Min age hours cannot be negative.`
    });
  }
  if (s.minHolderCount < 0) {
    out.push({
      level: "error",
      title: "Min holder count is negative",
      detail: `Min holder count cannot be negative.`
    });
  }

  // Ledger.
  if (state.cashUsd < 0) {
    out.push({
      level: "error",
      title: "Cash balance is negative",
      detail: `Paper cash is $${state.cashUsd.toFixed(2)}. The ledger is inconsistent; consider Reset paper account.`
    });
  }

  // Outcome check: an unusually high stop-out rate is itself a symptom of a
  // stop set too tight. This is what would have surfaced the 2% mistake.
  if (closed.length >= 5) {
    const stopped = closed.filter((p) => p.exitReason === "stop loss").length;
    const pct = (stopped / closed.length) * 100;
    if (pct >= 60) {
      out.push({
        level: "warn",
        title: `${stopped} of ${closed.length} closed trades hit stop-loss`,
        detail: `${pct.toFixed(0)}% of closed trades stopped out. An unusually high stop-out rate usually means the stop-loss percent is too tight for memecoin volatility.`
      });
    }
  }

  if (out.length === 0) {
    out.push({
      level: "ok",
      title: "No problems found",
      detail: "The trading rules and the account ledger all look sane."
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Trade queue. In queue mode the cycle does not execute: it proposes trades as
// intents, the user reviews and approves a selected subset, and only then are
// they booked. This is the exact shape the real-money flow will use, with the
// approve step there being a single Phantom signature instead of a paper book.
// ---------------------------------------------------------------------------

// What triggered a sell intent. Drives the queue row's label and the default
// re-arm direction.
export type SellTrigger =
  | "take-profit"
  | "stop-loss"
  | "max-hold"
  | "liquidity"
  | "scale-out"
  | "trailing-stop"
  | "rearm";

export type TradeIntent = {
  id: string;
  kind: "buy" | "sell";
  // Which account the intent acts on. Absent or "paper" = the paper sim;
  // "live" = a real position / a real buy, executed by signing in Phantom.
  account?: "paper" | "live";
  address: string;
  symbol: string;
  name: string;
  positionId?: string; // sell only: which open position to close
  reason: string;
  decidedAt: string;
  // Buy intents: editable size, and an optional limit price (the buy is
  // skipped at approve time if the current price is above it).
  sizeUsd?: number;
  limitPrice?: number;
  // Sell intents: what fraction to sell (100 = full, 50 = a scale-out half),
  // and what condition raised the intent.
  sellPct?: number;
  trigger?: SellTrigger;
  // Buy intents only: a snapshot of the metrics that drove the proposal,
  // baked in at decideBuyIntents/decideLiveBuyIntents time. dismissQueued
  // copies these onto the DismissedBuyIntent record so the next decider can
  // require the rating to climb above ratingAtProposal + threshold before
  // re-proposing the same coin.
  ratingAtProposal?: number;
  exitScoreAtProposal?: number;
  liquidityAtProposal?: number;
};

export function intentId(): string {
  return `ti_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// True if a previously dismissed buy intent for `address` should still
// block the queue from re-proposing it. Two conditions must both fail for
// re-propose to be allowed: the anti-flap cooldown must have passed, and
// the rating must have climbed above the dismissed value by at least the
// user's improvement threshold. A missing dismissedRating means the record
// predates the snapshot column, so the cooldown alone gates it.
export function buyDismissalBlocks(
  t: MemeToken,
  dismissals: DismissedBuyIntent[],
  improvementPoints: number
): boolean {
  const d = dismissals.find((x) => x.address === t.address);
  if (!d) return false;
  const ageHours = (Date.now() - new Date(d.dismissedAt).getTime()) / 3.6e6;
  if (ageHours < DISMISSED_BUY_COOLDOWN_HOURS) return true;
  if (typeof d.dismissedRating !== "number") return true;
  // Defensive guard: a missing / non-finite improvementPoints used to fail
  // OPEN (NaN comparisons return false, so the gate let dismissed coins back
  // through). The setting wasn't persisted to Postgres before this fix, so
  // every page reload silently zeroed it out. Now: an unknown value falls
  // back to the conservative default (10 points) so dismissals stay
  // dismissed across reloads even if a future bug breaks persistence.
  const pts =
    typeof improvementPoints === "number" && Number.isFinite(improvementPoints)
      ? improvementPoints
      : 10;
  if (pts <= 0) return true;
  return t.rating < d.dismissedRating + pts;
}

// Queue-mode buy decisions. Same gates as runBuyPass EXCEPT autoTrade — that
// gate is intentionally execute-mode-only. In queue mode the user reviews
// every trade, so the autoTrade setting (which means "execute without me")
// would defeat the point. To stop proposals entirely, raise the buy gates or
// turn queue mode off. The UI label on autoTrade is "Auto-execute buys
// (execute mode only)" and explains this asymmetry.
export function decideBuyIntents(
  state: PaperState,
  candidates: MemeToken[],
  dismissals: DismissedBuyIntent[] = []
): {
  intents: TradeIntent[];
  skipped: { rugged: number; cooldown: number; dismissed: number };
} {
  const { maxOpenPositions, minExitScore, minLiquidityUsd, minAgeHours, minHolderCount } =
    state.settings;
  // Circuit breaker pauses new buys; nothing is proposed when it is tripped.
  if (circuitBreakerTripped(state))
    return { intents: [], skipped: { rugged: 0, cooldown: 0, dismissed: 0 } };
  const openCount = state.positions.filter((p) => p.status === "open").length;
  const slots = Math.max(0, maxOpenPositions - openCount);
  const rugged = ruggedAddresses(state);
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
    if (state.positions.some((p) => p.status === "open" && p.address === t.address)) continue;
    if (rugged.has(t.address)) {
      ruggedSkips++;
      continue;
    }
    if (inReentryCooldown(state, t.address)) {
      cooldownSkips++;
      continue;
    }
    if (
      buyDismissalBlocks(t, dismissals, state.settings.buyDismissalImprovementPoints)
    ) {
      dismissedSkips++;
      continue;
    }
    intents.push({
      id: intentId(),
      kind: "buy",
      address: t.address,
      symbol: t.symbol,
      name: t.name,
      sizeUsd: state.settings.tradeSizeUsd,
      reason: `Clears your buy rules. Rating ${t.rating}, exit score ${t.exitScore}, liquidity $${Math.round(t.liquidityUsd / 1000)}k.`,
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

// The minimal position shape the sell rules need. Both a PaperPosition and a
// (mint-mapped) LivePosition satisfy it, so paper and live share one rule
// implementation, see sellIntentFor / decideSellIntents / decideLiveSellIntents.
export type DecidablePosition = {
  id: string;
  address: string;
  symbol: string;
  name: string;
  entryPriceUsd: number;
  entryAt: string;
  tookHalfProfit?: boolean;
  rearmPrice?: number;
  rearmDir?: "floor" | "ceil";
  // Highest USD price ever observed on this open position. The trailing stop
  // needs the peak to measure drop-from-peak; an undefined value here just
  // disables trailing for this position until the watch seeds a value.
  peakPriceUsd?: number;
};

// Decide whether one open position should be sold, applying the same rules the
// Trade queue uses: liquidity collapse (a hard safety net), the re-arm gate,
// the +100% scale-out, take-profit, stop-loss, max-hold. Returns one intent or
// null. Shared by paper and live so the two can never drift apart.
export function sellIntentFor(
  p: DecidablePosition,
  info: PriceInfo,
  settings: PaperSettings,
  account: "paper" | "live"
): TradeIntent | null {
  if (info.priceUsd <= 0) return null;
  const { takeProfitPct, stopLossPct, maxHoldHours } = settings;
  const pnlPct = ((info.priceUsd - p.entryPriceUsd) / p.entryPriceUsd) * 100;
  const heldH = hoursSince(p.entryAt);
  const make = (trigger: SellTrigger, sellPct: number, reason: string): TradeIntent => ({
    id: intentId(),
    kind: "sell",
    account,
    address: p.address,
    symbol: p.symbol,
    name: p.name,
    positionId: p.id,
    trigger,
    sellPct,
    reason,
    decidedAt: new Date().toISOString()
  });

  // Liquidity collapse is a hard safety net: it fires even on a re-armed
  // position and even on a bad-data price tick. Liquidity is read separately
  // from price, so a real rug still trips this branch.
  if (info.liquidityUsd > 0 && info.liquidityUsd < 3000) {
    return make(
      "liquidity",
      100,
      "Pool liquidity collapsed under $3k. Exit before it round-trips to zero."
    );
  }
  // Re-arm gate: while a re-arm level is set, suppress the price-based rules
  // until price crosses it, then fire one fresh intent.
  if (p.rearmPrice !== undefined && p.rearmDir) {
    const hit =
      p.rearmDir === "floor" ? info.priceUsd <= p.rearmPrice : info.priceUsd >= p.rearmPrice;
    if (!hit) return null;
    return make(
      "rearm",
      100,
      `Re-arm level reached: price ${
        p.rearmDir === "floor" ? "fell to" : "rose to"
      } the level you set. Now ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(0)}% from entry.`
    );
  }
  // Bad-data guard: a price >1000x entry is almost certainly a thin-pool
  // glitch, not a real move. Don't propose price-derived sells on that tick;
  // the queue should not show "scale out at +449,677%" garbage. Liquidity
  // collapse above already fired if the rug is real. Next normal tick the
  // real rules fire as expected. Defense in depth: runSellPass and sellManual
  // also refuse to book a bad-data sell at execute time.
  if (!plausibleSellPrice(info.priceUsd, p.entryPriceUsd)) return null;
  if (pnlPct >= 100 && !p.tookHalfProfit) {
    return make(
      "scale-out",
      50,
      `Up +${pnlPct.toFixed(0)}% from entry. Scale out: sell half, bank the gain, let the rest ride.`
    );
  }
  // Trailing stop. Fires only after the position has been up by at least
  // trailingActivationPct at some point (peakGainPct >= activation), and only
  // when price has fallen trailingStopPct from that peak. peakPriceUsd is
  // undefined on positions opened before this rule shipped; the watch seeds
  // it on the next observation, so trailing is effectively off until then.
  // Bad-peak guard: a peak more than 1000x entry came from a bad-data tick
  // that snuck into peak-lifting (older code without the plausibility guard
  // could write 4000x prices into peak). Treat such a peak as not set, so a
  // BABYTROLL-style fake high cannot spuriously stop out a real position.
  const trailPct = settings.trailingStopPct;
  const trailActPct = settings.trailingActivationPct;
  const peakIsPlausible =
    p.peakPriceUsd !== undefined &&
    p.peakPriceUsd > 0 &&
    p.peakPriceUsd / p.entryPriceUsd <= 1000;
  if (trailPct > 0 && peakIsPlausible) {
    const peakGainPct = ((p.peakPriceUsd! - p.entryPriceUsd) / p.entryPriceUsd) * 100;
    const dropFromPeakPct = ((info.priceUsd - p.peakPriceUsd!) / p.peakPriceUsd!) * 100;
    if (peakGainPct >= trailActPct && dropFromPeakPct <= -trailPct) {
      return make(
        "trailing-stop",
        100,
        `Trailing stop: price down ${Math.abs(dropFromPeakPct).toFixed(0)}% from peak ($${p.peakPriceUsd!.toPrecision(4)}), peak was +${peakGainPct.toFixed(0)}% from entry. Locks in +${pnlPct.toFixed(0)}%.`
      );
    }
  }
  if (pnlPct >= takeProfitPct) {
    return make(
      "take-profit",
      100,
      `Up +${pnlPct.toFixed(0)}% from entry, hit your +${takeProfitPct}% take-profit target.`
    );
  }
  if (pnlPct <= -stopLossPct) {
    return make(
      "stop-loss",
      100,
      `Down ${Math.abs(pnlPct).toFixed(0)}% from entry, hit your -${stopLossPct}% stop-loss.`
    );
  }
  if (heldH >= maxHoldHours) {
    return make("max-hold", 100, `Held ${Math.round(heldH)}h, past your ${maxHoldHours}h max hold.`);
  }
  return null;
}

// Queue-mode sell decisions for the paper account. Thin wrapper over
// sellIntentFor; the live account uses decideLiveSellIntents in live.ts.
export function decideSellIntents(state: PaperState, prices: PriceMap): TradeIntent[] {
  const intents: TradeIntent[] = [];
  for (const p of state.positions) {
    if (p.status !== "open") continue;
    const info = prices[p.address];
    if (!info || info.priceUsd <= 0) continue;
    const it = sellIntentFor(p, info, state.settings, "paper");
    if (it) intents.push(it);
  }
  return intents;
}

// Execute a set of approved intents against the paper account. The analog of
// signing the batch: in real money the wallet signs here; this books paper
// trades. Buys need the coin's current MemeToken from the latest scan.
export function applyQueuedIntents(
  state: PaperState,
  intents: TradeIntent[],
  tokens: MemeToken[],
  prices: PriceMap
): { state: PaperState; events: TradeEvent[] } {
  let next = state;
  const events: TradeEvent[] = [];
  const rugged = ruggedAddresses(state);
  for (const it of intents) {
    if (it.kind === "buy") {
      const token = tokens.find((t) => t.address === it.address);
      if (!token || token.priceUsd <= 0) {
        events.push({
          kind: "skip",
          text: `${it.symbol}: no fresh price, buy skipped. Re-scan and try again.`
        });
        continue;
      }
      // Limit price: skip the buy if the coin has run above the user's cap.
      if (it.limitPrice !== undefined && it.limitPrice > 0 && token.priceUsd > it.limitPrice) {
        events.push({
          kind: "skip",
          text: `${it.symbol}: price $${token.priceUsd.toPrecision(4)} is above your $${it.limitPrice.toPrecision(4)} limit, buy skipped.`
        });
        continue;
      }
      if (next.positions.some((p) => p.status === "open" && p.address === it.address)) {
        events.push({ kind: "skip", text: `${it.symbol}: already holding` });
        continue;
      }
      // Re-check the buy gates at approve time, not just at propose time: the
      // breaker may have tripped, or the coin entered cooldown / been
      // blacklisted, between the cycle proposing it and this approval.
      if (circuitBreakerTripped(next)) {
        events.push({ kind: "skip", text: `${it.symbol}: daily loss limit hit, buy skipped.` });
        continue;
      }
      if (rugged.has(it.address)) {
        events.push({
          kind: "skip",
          text: `${it.symbol}: blacklisted as a rugged coin, buy skipped.`
        });
        continue;
      }
      if (inReentryCooldown(next, it.address)) {
        events.push({
          kind: "skip",
          text: `${it.symbol}: inside the re-entry cooldown, buy skipped.`
        });
        continue;
      }
      const size = it.sizeUsd && it.sizeUsd > 0 ? it.sizeUsd : next.settings.tradeSizeUsd;
      const res = openPosition(next, token, size);
      next = res.state;
      events.push(res.event);
    } else {
      const price = prices[it.address]?.priceUsd ?? 0;
      const res = sellManual(next, it.positionId ?? "", price, it.sellPct ?? 100);
      next = res.state;
      events.push(res.event);
    }
  }
  return { state: next, events };
}
