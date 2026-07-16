// Pre-buy safety gate for the Meme Coin live trading path.
//
// Four checks. A "block" cannot be overridden; a "warn" can be acknowledged
// in the modal:
//   1. Buy-side price impact ceiling. >5% requires explicit acknowledgment;
//      >15% blocks. Read from the buy quote you already have in hand.
//   2. Sellability simulation. Get a Jupiter quote for token -> baseMint at
//      the amount we'd receive from the buy. If the quote fails or its
//      price impact is >25%, the position cannot be exited at size and the
//      buy is blocked. This is the single most important honeypot guard.
//   3. RugCheck report. Public API, no key. Blocks on the "Danger" risk
//      level or on critical risks (mint authority not renounced, freeze
//      authority active, LP not locked / not burned). The same report is
//      then mined (no extra call) for insider networks, the creator's
//      launch history, a transfer fee, and the LP-provider count.
//   4. Jupiter Tokens v2 cross-check. Free, no key. An independent read of
//      mint/freeze authority, plus Jupiter's organic (bot-vs-real) score
//      and 24h trader counts. A failure or a missing listing here does NOT
//      block: brand-new mints are often not indexed yet.
//
// Stack sources, do not replace them: RugCheck and Jupiter disagreeing is
// itself signal, and each catches a different scam category. Results are
// cached per mint for the browser session so repeat clicks on the same coin
// do not re-burn upstream rate limits.

import { getQuote, type JupiterQuote } from "./swap";

const BUY_IMPACT_WARN_PCT = 5;
const BUY_IMPACT_BLOCK_PCT = 15;
const SELL_IMPACT_BLOCK_PCT = 25;
// A creator wallet with this many prior token launches reads as a serial
// launcher, a rug-history signal.
const CREATOR_PRIOR_TOKENS_WARN = 5;
// 24h volume at or above this from fewer than WASH_MAX_TRADERS unique wallets
// reads as wash trading rather than real demand.
const WASH_MIN_VOLUME_USD = 50000;
const WASH_MAX_TRADERS = 30;
// Bot-ratio thresholds: unique_traders / total_tx. Below 2% blocks (almost
// all trades come from a handful of wallets, the sniper-pump signature);
// below 5% warns. Works at any volume scale, unlike the wash-volume gate.
const BOT_RATIO_BLOCK = 0.02;
const BOT_RATIO_WARN = 0.05;
// Top-5 wallet concentration hard flag. RugCheck returns topHolders[]; if
// the first five collectively hold >= 90% of supply, a coordinated exit
// crashes the price. Distinct from the Jupiter top-10 % gate at the safety
// level; this catches the rarer "5 wallets own everything" case.
const TOP5_HARD_FLAG_PCT = 90;

function usdShort(n: number): string {
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}k`;
  return `$${Math.round(n)}`;
}

export type SafetyLevel = "ok" | "warn" | "block";

export type SafetyCheck = {
  level: SafetyLevel;
  reasons: string[]; // bullet-list of why the level is what it is
  buy: { priceImpactPct: number };
  sellSim:
    | { ok: true; priceImpactPct: number; quotedOutBase: string }
    | { ok: false; error: string };
  rugcheck:
    | { ok: true; score: number | null; level: string | null; risks: { name: string; level: string }[] }
    | { ok: false; error: string };
  jupiter:
    | {
        ok: true;
        found: boolean;
        organicScoreLabel: string | null;
        holderCount: number | null;
        // Percent of supply held by the top 10 wallets, when Jupiter returns
        // it. Surfaced so the queue safety badge can show why a buy blocked
        // on the holder concentration gate.
        topHoldersPct: number | null;
        isVerified: boolean;
      }
    | { ok: false; error: string };
};

type RugCheckReport = {
  score?: number;
  score_normalised?: number;
  rugged?: boolean;
  risks?: { name: string; description?: string; level?: string; value?: string }[];
  tokenMeta?: unknown;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  // Array of { address, pct, ... }, ordered by holding size descending. The
  // top-5 hard flag in mineRugCheck reads this.
  topHolders?: { address?: string; pct?: number }[] | null;
  markets?: unknown;
  // Mined by mineRugCheck() for gates beyond the risks[] list.
  creator?: string | null;
  creatorTokens?: unknown[] | null;
  graphInsidersDetected?: number;
  insiderNetworks?: unknown[] | null;
  totalLPProviders?: number;
  transferFee?: { pct?: number; maxAmount?: number; authority?: string } | null;
};

const reportCache = new Map<string, { at: number; data: RugCheckReport }>();
// RugCheck TTL stays short: insider-network detection and freeze-authority
// status can change as upstream re-scans, and a 5-min stale window is the
// most we want to act on for a safety verdict.
const REPORT_TTL_MS = 5 * 60 * 1000;
// Jupiter Tokens v2 audit (organic score, holder count, top-10 %) changes far
// more slowly than 5 min — these are properties of the holder graph, not of
// any single trade. 30 min covers ~10 of our 3-min scan cycles, so a coin
// that lingers in the top-40 burst across multiple scans only pays one Jupiter
// call per half hour instead of every 5 min. Buy-time safety still uses this
// cache; if a position is being opened on a coin whose audit hasn't been
// refreshed in 30 min, the worst case is acting on a 30-min-old (but stable)
// holder snapshot, which is fine.
const JUPITER_TTL_MS = 30 * 60 * 1000;

// Relative /api/* paths resolve against the page origin in the browser. When
// the safety screen runs server-side (the scan scheduler), set a base pointing
// at the dev server's loopback so the same proxy middleware is reused. No-op in
// the browser (apiBase stays "").
let apiBase = "";
export function setSafetyApiBase(base: string): void {
  apiBase = base.replace(/\/$/, "");
}

async function fetchRugCheck(
  mint: string
): Promise<{ ok: true; data: RugCheckReport } | { ok: false; error: string }> {
  const cached = reportCache.get(mint);
  if (cached && Date.now() - cached.at < REPORT_TTL_MS) {
    return { ok: true, data: cached.data };
  }
  try {
    const res = await fetch(`${apiBase}/api/rugcheck/tokens/${mint}/report`);
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    const data = JSON.parse(text) as RugCheckReport;
    reportCache.set(mint, { at: Date.now(), data });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Critical RugCheck risk patterns that always block a buy, even if RugCheck
// itself tags the risk at "warn" instead of "danger". These are honeypot /
// pump-and-rug fingerprints; the pool can look healthy while the owner can
// still drain it. Substrings, case-insensitive, matched against r.name.
//
// In practice RugCheck currently returns all of these at level="danger" so
// the catch-all below picks them up; this list is belt-and-suspenders for
// a level relabel on RugCheck's side. Strings here were observed against
// real reports for fresh pump.fun and new-pool tokens (see verification
// run, docs/ARCHITECTURE.md "Live trading, safety gate, RugCheck risk strings").
const CRITICAL_RISK_PATTERNS = [
  "freeze authority", // "Freeze Authority still enabled"
  "mint authority", // "Mint Authority still enabled"
  "honeypot",
  "lp unlocked", // "Large Amount of LP Unlocked"
  "single holder", // "Single holder ownership"
  "top 10 holders high ownership",
  "creator history of rugged",
  "copycat"
];

function summarizeRugCheck(data: RugCheckReport): {
  score: number | null;
  level: string | null;
  risks: { name: string; level: string }[];
  blockers: string[];
} {
  const score =
    typeof data.score_normalised === "number"
      ? data.score_normalised
      : typeof data.score === "number"
        ? data.score
        : null;
  const risks = (data.risks ?? []).map((r) => ({ name: r.name, level: r.level ?? "warn" }));
  // RugCheck does not return a single overall level; we infer from the
  // highest individual risk level present.
  const levels = risks.map((r) => r.level.toLowerCase());
  const level = levels.includes("danger")
    ? "danger"
    : levels.includes("warn") || levels.includes("warning")
      ? "warn"
      : risks.length > 0
        ? "info"
        : "ok";
  const blockers: string[] = [];
  if (data.rugged) blockers.push("RugCheck has already flagged this mint as rugged.");
  for (const r of risks) {
    const nameLc = r.name.toLowerCase();
    if (r.level.toLowerCase() === "danger") blockers.push(`RugCheck danger: ${r.name}.`);
    else if (CRITICAL_RISK_PATTERNS.some((p) => nameLc.includes(p))) {
      blockers.push(`RugCheck critical risk: ${r.name}.`);
    }
  }
  return { score, level, risks, blockers };
}

// Mine the RugCheck report for signals beyond the risks[] list. Same JSON,
// no extra call. Each gate is guarded with a strict type check so a missing
// or differently-shaped field simply skips that gate (no false block).
function mineRugCheck(data: RugCheckReport): { blockers: string[]; warnings: string[] } {
  const blockers: string[] = [];
  const warnings: string[] = [];

  // Insider network: a detected cluster of coordinated wallets, the
  // fingerprint of a bundled launch.
  const networks = Array.isArray(data.insiderNetworks) ? data.insiderNetworks : [];
  const insiderWallets =
    typeof data.graphInsidersDetected === "number" ? data.graphInsidersDetected : 0;
  if (networks.length > 0) {
    blockers.push(
      `RugCheck detected ${networks.length} insider network${networks.length === 1 ? "" : "s"}` +
        `${insiderWallets > 0 ? ` across ${insiderWallets} linked wallets` : ""}: a coordinated ` +
        "wallet cluster, the fingerprint of a bundled launch."
    );
  } else if (insiderWallets > 0) {
    warnings.push(
      `RugCheck flagged ${insiderWallets} insider-linked wallet${insiderWallets === 1 ? "" : "s"}. ` +
        "Possible coordinated holders; check the holder graph."
    );
  }

  // Creator history: a serial launcher is a rug-history red flag.
  const priorTokens = Array.isArray(data.creatorTokens) ? data.creatorTokens.length : 0;
  if (priorTokens >= CREATOR_PRIOR_TOKENS_WARN) {
    warnings.push(
      `The creator wallet has launched ${priorTokens} other tokens. Serial launchers are a ` +
        "rug-history signal; check whether the earlier ones survived."
    );
  }

  // Transfer fee: a Token-2022 tax on every trade that the price-impact
  // check does not see.
  const feePct =
    data.transferFee && typeof data.transferFee.pct === "number" ? data.transferFee.pct : 0;
  if (feePct > 0) {
    warnings.push(
      `Token charges a ${feePct}% transfer fee on every trade. It is a built-in tax the ` +
        "price-impact check does not include, and it eats into every exit."
    );
  }

  // LP-provider count: a single provider is fragile, one wallet can pull it.
  if (
    typeof data.totalLPProviders === "number" &&
    data.totalLPProviders > 0 &&
    data.totalLPProviders <= 1
  ) {
    warnings.push(
      "Only one liquidity provider in the pool: a single wallet can pull all of it at once."
    );
  }

  // Top-5 holders hard flag. RugCheck's topHolders[] is ordered by holding
  // descending. If the first five collectively hold >= TOP5_HARD_FLAG_PCT,
  // a coordinated exit from a handful of wallets crashes the price. Stricter
  // than the Jupiter top-10 % gate; covers the rarer "5 wallets own everything"
  // case the top-10 gate could pass when the 6th-10th holders are tiny.
  if (Array.isArray(data.topHolders) && data.topHolders.length >= 5) {
    let top5 = 0;
    for (let i = 0; i < 5; i++) {
      const h = data.topHolders[i];
      if (h && typeof h.pct === "number") top5 += h.pct;
    }
    if (top5 >= TOP5_HARD_FLAG_PCT) {
      blockers.push(
        `Top 5 wallets hold ${top5.toFixed(1)}% of supply, near-total concentration. A coordinated exit from these wallets would crash the price.`
      );
    }
  }

  return { blockers, warnings };
}

// Lightweight, RugCheck-only safety screen for the new-coin alert path. Unlike
// runSafetyGate it needs no Jupiter buy-quote / sellability sim, so it's cheap
// enough to run on every candidate a scan surfaces. It reuses the exact rug
// logic the buy gate uses (rugged flag, danger risks, mint/freeze authority,
// honeypot, LP-unlocked, single/top-holder concentration, insider networks).
// RugCheck is a free, keyless public API. `blocked` true => shady, do not alert.
// ok:false => RugCheck could not verify (often a brand-new, not-yet-indexed
// mint); the caller decides whether to treat "unverified" as "skip".
export type RugScreen =
  | { ok: true; blocked: boolean; level: string | null; score: number | null; blockers: string[] }
  | { ok: false; error: string };

export async function screenRugCheck(mint: string): Promise<RugScreen> {
  const rug = await fetchRugCheck(mint);
  if (!rug.ok) return { ok: false, error: rug.error };
  const summary = summarizeRugCheck(rug.data);
  const mined = mineRugCheck(rug.data);
  const blockers = [...summary.blockers, ...mined.blockers];
  return {
    ok: true,
    blocked: blockers.length > 0,
    level: summary.level,
    score: summary.score,
    blockers
  };
}

// ---------------------------------------------------------------------------
// Jupiter Tokens API v2: an independent second opinion. Free, no key, through
// the existing /api/jupiter proxy. Gives an organic (bot-vs-real) score, a
// mint/freeze authority audit, holder count, and 24h trader stats.
// ---------------------------------------------------------------------------

type JupiterTokenInfo = {
  id?: string;
  organicScore?: number;
  organicScoreLabel?: string;
  holderCount?: number;
  isVerified?: boolean;
  tags?: string[];
  audit?: {
    mintAuthorityDisabled?: boolean;
    freezeAuthorityDisabled?: boolean;
    topHoldersPercentage?: number;
    devMigrations?: number;
  };
  stats24h?: {
    buyVolume?: number;
    sellVolume?: number;
    numTraders?: number;
    numBuys?: number;
    numSells?: number;
  };
};

const jupiterCache = new Map<string, { at: number; data: JupiterTokenInfo | null }>();
// In-flight dedup: when scanMemecoins enriches 40 candidates in parallel and
// any two callers race on the same mint (e.g. two adjacent scans, or scan +
// safety gate landing in the same tick), they share one fetch instead of
// issuing two identical Jupiter calls. Resolved Promises are dropped from the
// map; subsequent requests after resolution hit the time-based cache above.
const jupiterInFlight = new Map<
  string,
  Promise<{ ok: true; data: JupiterTokenInfo | null } | { ok: false; error: string }>
>();

async function fetchJupiterToken(
  mint: string
): Promise<{ ok: true; data: JupiterTokenInfo | null } | { ok: false; error: string }> {
  const cached = jupiterCache.get(mint);
  if (cached && Date.now() - cached.at < JUPITER_TTL_MS) {
    return { ok: true, data: cached.data };
  }
  const inFlight = jupiterInFlight.get(mint);
  if (inFlight) return inFlight;
  const p = (async () => {
    try {
      const res = await fetch(`/api/jupiter/tokens/v2/search?query=${encodeURIComponent(mint)}`);
      const text = await res.text();
      if (!res.ok) {
        return { ok: false as const, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      }
      const parsed = JSON.parse(text) as unknown;
      const list: unknown[] = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { tokens?: unknown[] })?.tokens)
          ? (parsed as { tokens: unknown[] }).tokens
          : [];
      const tokens = list as JupiterTokenInfo[];
      const lc = mint.toLowerCase();
      // Searching by the mint should return that token; match it exactly, and
      // fall back to a lone result. No match means "not indexed", not an error.
      const match =
        tokens.find((t) => String(t?.id ?? "").toLowerCase() === lc) ??
        (tokens.length === 1 ? tokens[0] : null);
      jupiterCache.set(mint, { at: Date.now(), data: match });
      return { ok: true as const, data: match };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  })();
  jupiterInFlight.set(mint, p);
  try {
    return await p;
  } finally {
    jupiterInFlight.delete(mint);
  }
}

// Gate the Jupiter token data. Strict checks: a missing field skips its gate.
function mineJupiter(
  t: JupiterTokenInfo,
  maxTopHoldersPct?: number
): { blockers: string[]; warnings: string[] } {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const audit = t.audit ?? {};

  // Authority audit, an independent cross-check of the RugCheck read.
  if (audit.mintAuthorityDisabled === false) {
    blockers.push(
      "Jupiter audit: mint authority is still enabled. The supply can be inflated at will."
    );
  }
  if (audit.freezeAuthorityDisabled === false) {
    blockers.push(
      "Jupiter audit: freeze authority is still enabled. Holders can be frozen, which blocks every sell."
    );
  }

  // Holder concentration. Consensus pre-buy filter on memecoins: top 10 wallets
  // holding 30 to 40%+ means a small handful of wallets can crash the price by
  // exiting together. Gate only fires when Jupiter returns the number AND the
  // user has set a positive threshold; otherwise the gate is silently off.
  const topPct =
    typeof audit.topHoldersPercentage === "number" ? audit.topHoldersPercentage : null;
  if (topPct !== null && maxTopHoldersPct !== undefined && maxTopHoldersPct > 0) {
    if (topPct > maxTopHoldersPct) {
      blockers.push(
        `Top 10 holders own ${topPct.toFixed(1)}% of supply, above your ${maxTopHoldersPct}% cap. A coordinated exit from a handful of wallets would crash the price.`
      );
    }
  }

  // Organic score: Jupiter's own bot-vs-real-wallet measure.
  const label = typeof t.organicScoreLabel === "string" ? t.organicScoreLabel.toLowerCase() : "";
  if (label.includes("low")) {
    const n = typeof t.organicScore === "number" ? ` (${Math.round(t.organicScore)})` : "";
    warnings.push(
      `Jupiter organic score is "${t.organicScoreLabel}"${n}: most activity reads as bots, ` +
        "not real wallets."
    );
  }

  // Wash check: real volume but very few unique traders.
  const s = t.stats24h ?? {};
  const vol =
    (typeof s.buyVolume === "number" ? s.buyVolume : 0) +
    (typeof s.sellVolume === "number" ? s.sellVolume : 0);
  if (
    vol >= WASH_MIN_VOLUME_USD &&
    typeof s.numTraders === "number" &&
    s.numTraders > 0 &&
    s.numTraders < WASH_MAX_TRADERS
  ) {
    warnings.push(
      `Jupiter 24h stats: ${usdShort(vol)} of volume from only ${s.numTraders} unique traders. ` +
        "Volume that concentrated is usually wash trading, not real demand."
    );
  }

  // Bot ratio: unique wallets divided by total transactions. Works at any
  // volume scale, unlike the wash-volume gate above. A few wallets churning
  // many trades = sniper / wash signature. Both gates can fire together and
  // usually agree; the ratio is the more general signal.
  const numTx =
    (typeof s.numBuys === "number" ? s.numBuys : 0) +
    (typeof s.numSells === "number" ? s.numSells : 0);
  if (numTx >= 50 && typeof s.numTraders === "number" && s.numTraders > 0) {
    const ratio = s.numTraders / numTx;
    if (ratio < BOT_RATIO_BLOCK) {
      blockers.push(
        `Bot ratio ${(ratio * 100).toFixed(1)}%: only ${s.numTraders} unique wallets across ${numTx} trades. Almost all activity comes from a handful of wallets, the sniper-pump signature.`
      );
    } else if (ratio < BOT_RATIO_WARN) {
      warnings.push(
        `Bot ratio ${(ratio * 100).toFixed(1)}%: ${s.numTraders} unique wallets across ${numTx} trades. Activity is concentrated in a small wallet set.`
      );
    }
  }

  return { blockers, warnings };
}

// Public summary used by the scanner. Same Jupiter Tokens v2 call as the
// safety gate, same 5-min cache, so a scan-time enrichment also warms the
// cache for a later buy-time safety check (and vice versa). Returns null
// when Jupiter has no listing yet (common for brand-new mints).
export type JupiterTokenSummary = {
  topHoldersPct: number | null;
  holderCount: number | null;
  organicScoreLabel: string | null;
  isVerified: boolean;
  numTraders: number | null;
  numBuys: number | null;
  numSells: number | null;
};

export async function fetchJupiterTokenSummary(
  mint: string
): Promise<{ ok: true; data: JupiterTokenSummary | null } | { ok: false; error: string }> {
  const res = await fetchJupiterToken(mint);
  if (!res.ok) return { ok: false, error: res.error };
  if (!res.data) return { ok: true, data: null };
  const t = res.data;
  const s = t.stats24h ?? {};
  const audit = t.audit ?? {};
  return {
    ok: true,
    data: {
      topHoldersPct:
        typeof audit.topHoldersPercentage === "number" ? audit.topHoldersPercentage : null,
      holderCount: typeof t.holderCount === "number" ? t.holderCount : null,
      organicScoreLabel: typeof t.organicScoreLabel === "string" ? t.organicScoreLabel : null,
      isVerified: t.isVerified === true,
      numTraders: typeof s.numTraders === "number" ? s.numTraders : null,
      numBuys: typeof s.numBuys === "number" ? s.numBuys : null,
      numSells: typeof s.numSells === "number" ? s.numSells : null
    }
  };
}

// Run the full safety gate. Caller has already obtained the buy quote.
// `baseMint` is whatever the user is paying with (SOL or USDC), used as the
// destination of the sellability simulation. `tokenMint` is the memecoin.
export async function runSafetyGate(opts: {
  tokenMint: string;
  baseMint: string;
  buyQuote: JupiterQuote;
  acknowledgedHighImpact: boolean;
  // Block the buy if Jupiter's audit.topHoldersPercentage is above this.
  // Undefined or 0 disables the gate (no number returned = no gate either).
  maxTopHoldersPct?: number;
}): Promise<SafetyCheck> {
  const reasons: string[] = [];
  let level: SafetyLevel = "ok";

  // 1. Buy-side price impact.
  const buyImpactPct = Math.abs(Number(opts.buyQuote.priceImpactPct ?? "0")) * 100;
  if (buyImpactPct >= BUY_IMPACT_BLOCK_PCT) {
    reasons.push(`Buy price impact ${buyImpactPct.toFixed(1)}% is above the ${BUY_IMPACT_BLOCK_PCT}% hard limit.`);
    level = "block";
  } else if (buyImpactPct >= BUY_IMPACT_WARN_PCT) {
    reasons.push(
      `Buy price impact ${buyImpactPct.toFixed(1)}% is above ${BUY_IMPACT_WARN_PCT}%. Tick the acknowledgment box to proceed.`
    );
    if (!opts.acknowledgedHighImpact) level = "warn";
  }

  // 2. Sellability simulation. Quote token -> baseMint at the amount the
  // buy would have given us, to verify the position can be exited at size.
  const sellSim = await getQuote(opts.tokenMint, opts.baseMint, Number(opts.buyQuote.outAmount));
  let sellSimResult: SafetyCheck["sellSim"];
  if (!sellSim.ok) {
    reasons.push(`Sellability sim failed: ${sellSim.error}. The position may not be exitable at this size.`);
    sellSimResult = { ok: false, error: sellSim.error };
    level = "block";
  } else {
    const sellImpactPct = Math.abs(Number(sellSim.quote.priceImpactPct ?? "0")) * 100;
    sellSimResult = {
      ok: true,
      priceImpactPct: sellImpactPct,
      quotedOutBase: sellSim.quote.outAmount
    };
    if (sellImpactPct >= SELL_IMPACT_BLOCK_PCT) {
      reasons.push(
        `Sellability sim shows ${sellImpactPct.toFixed(1)}% exit impact, above the ${SELL_IMPACT_BLOCK_PCT}% limit.`
      );
      level = "block";
    }
  }

  // 3. RugCheck.
  const rug = await fetchRugCheck(opts.tokenMint);
  let rugcheckResult: SafetyCheck["rugcheck"];
  if (!rug.ok) {
    // Treat a RugCheck failure as a hard block: a buy without a sellability
    // / authority read is exactly the regime the gate exists to prevent.
    reasons.push(`RugCheck call failed: ${rug.error}. Try again, or skip this coin.`);
    rugcheckResult = { ok: false, error: rug.error };
    level = "block";
  } else {
    const summary = summarizeRugCheck(rug.data);
    rugcheckResult = {
      ok: true,
      score: summary.score,
      level: summary.level,
      risks: summary.risks
    };
    for (const b of summary.blockers) {
      reasons.push(b);
      level = "block";
    }
    // Mine the same report for signals beyond the risks[] list.
    const mined = mineRugCheck(rug.data);
    for (const b of mined.blockers) {
      reasons.push(b);
      level = "block";
    }
    for (const w of mined.warnings) {
      reasons.push(w);
      if (level === "ok") level = "warn";
    }
  }

  // 4. Jupiter Tokens v2 cross-check. A failure or a missing listing is NOT
  // a block: brand-new mints are often not indexed yet, and Jupiter is a
  // secondary opinion, not the primary gate.
  const jup = await fetchJupiterToken(opts.tokenMint);
  let jupiterResult: SafetyCheck["jupiter"];
  if (!jup.ok) {
    reasons.push(
      `Jupiter cross-check unavailable (${jup.error}). Proceeding on RugCheck and the sellability sim only.`
    );
    jupiterResult = { ok: false, error: jup.error };
  } else if (!jup.data) {
    reasons.push(
      "Jupiter has no listing for this mint yet (common for very new tokens). Cross-check skipped."
    );
    jupiterResult = {
      ok: true,
      found: false,
      organicScoreLabel: null,
      holderCount: null,
      topHoldersPct: null,
      isVerified: false
    };
  } else {
    const t = jup.data;
    const mined = mineJupiter(t, opts.maxTopHoldersPct);
    for (const b of mined.blockers) {
      reasons.push(b);
      level = "block";
    }
    for (const w of mined.warnings) {
      reasons.push(w);
      if (level === "ok") level = "warn";
    }
    jupiterResult = {
      ok: true,
      found: true,
      organicScoreLabel: typeof t.organicScoreLabel === "string" ? t.organicScoreLabel : null,
      holderCount: typeof t.holderCount === "number" ? t.holderCount : null,
      topHoldersPct:
        typeof t.audit?.topHoldersPercentage === "number" ? t.audit.topHoldersPercentage : null,
      isVerified: t.isVerified === true
    };
  }

  if (level === "ok") reasons.push("All safety checks passed.");
  return {
    level,
    reasons,
    buy: { priceImpactPct: buyImpactPct },
    sellSim: sellSimResult,
    rugcheck: rugcheckResult,
    jupiter: jupiterResult
  };
}
