// Browser-side client for meme coin market data.
//
// DexScreener and pump.fun are reached through Vite middleware
// (/api/dexscreener/*, /api/pumpfun/*) so the requests are made server-side.
// That avoids browser CORS and ad-blocker breakage, and matches how the
// Tavily / Serper / Reddit bridges in this repo already work.
//
// What the scoring is for: surface coins where a position could realistically
// be EXITED. That means real pool liquidity, two-sided 24h volume, healthy
// turnover, and an actual trade count. It does NOT predict price and it does
// NOT make a coin "safe".
//
// Base rate, from public research (see the panel banner): under 0.5% of
// pump.fun launches ever complete the bonding curve, only ~1.4% of pump.fun
// tokens hold even $1k of liquidity, and fewer than 5% of memecoins keep real
// volume past 72 hours. This tool ranks the survivors. It cannot change odds.

import { braveSearch } from "./brave";
import { serperSearch } from "./serper";
import { tavilySearch } from "./tavily";
import { fetchJupiterTokenSummary } from "./safety";

// ---------------------------------------------------------------------------
// Upstream shapes (DexScreener)
// ---------------------------------------------------------------------------

export type DexPair = {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken?: { address: string; name: string; symbol: string };
  priceUsd?: string;
  txns?: Record<string, { buys: number; sells: number }>;
  volume?: Record<string, number>;
  priceChange?: Record<string, number>;
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    websites?: { url: string }[];
    socials?: { type: string; url: string }[];
  };
};

// ---------------------------------------------------------------------------
// Normalised token used by the UI
// ---------------------------------------------------------------------------

export type Verdict = "exitable" | "caution" | "trap risk";

export type MemeToken = {
  address: string;
  name: string;
  symbol: string;
  chainId: string;
  dexId: string;
  url: string;
  priceUsd: number;
  volume24h: number;
  liquidityUsd: number;
  marketCap: number;
  fdv: number;
  txns24h: number;
  buys24h: number;
  sells24h: number;
  priceChange24h: number;
  ageHours: number;
  volToLiq: number;
  buyRatio: number;
  exitScore: number;
  verdict: Verdict;
  riskFlags: string[];
  socials: { type: string; url: string }[];
  imageUrl?: string;
  source: string;
  discoveredAt: string;
  discoveryChannel: string;
  discoveryReason: string;
  tradeUrl: string;
  // Momentum vs the previous scan. Undefined when there is no prior data point.
  isNewSinceLastScan?: boolean;
  volMomentumPct?: number;
  liqMomentumPct?: number;
  momentumScore?: number;
  // Cross-referencing: every discovery source that surfaced this coin. A coin
  // corroborated by more independent feeds rates higher.
  sources: string[];
  // Composite rating (0 to 100) and its letter band, the card headline.
  // See computeRating().
  rating: number;
  ratingBand: "A" | "B" | "C" | "D" | "F";
  // Scan-time Jupiter enrichment (top N candidates only). Optional because
  // older cached scans don't have these, and lower-ranked coins skip
  // enrichment to save API budget. The safety gate fills them in at buy
  // time anyway. See scanMemecoins() enrichTopCandidates step.
  top10HoldersPct?: number;
  // Unique wallets / total transactions, in the range 0 to 1. Below 0.02 is
  // sniper-pump territory, below 0.05 is concentrated activity. Works at any
  // volume scale, unlike a raw wash-volume threshold.
  botRatio?: number;
  jupiterHolderCount?: number;
  jupiterOrganicLabel?: string;
  jupiterEnrichedAt?: string;
};

export type ScanResult = {
  tokens: MemeToken[];
  sources: { name: string; ok: boolean; count: number; note?: string }[];
  scannedAt: string;
};

export type ChatterResult = {
  total: number;
  byPlatform: { x: number; reddit: number; other: number };
  items: { title: string; url: string; snippet: string; platform: string }[];
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function num(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : 0;
  return Number.isFinite(n) ? n : 0;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// All upstreams are reached through relative /api/* paths, which resolve
// against the page origin in the browser. When scanMemecoins runs server-side
// (the scan scheduler in vite.config.ts), there is no page origin, so set a
// base here pointing at the dev server's own loopback address; the relative
// paths then hit the exact same proxy middleware the browser uses. No-op in the
// browser (apiBase stays "").
let apiBase = "";
export function setMarketsApiBase(base: string): void {
  apiBase = base.replace(/\/$/, "");
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(apiBase + url);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

export function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "$0";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  if (abs >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toPrecision(2)}`;
}

export function fmtAge(hours: number): string {
  if (!hours || hours <= 0) return "unknown";
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

// ---------------------------------------------------------------------------
// Scoring: can a position be exited?
// ---------------------------------------------------------------------------

function scoreExit(m: {
  liquidityUsd: number;
  volume24h: number;
  txns24h: number;
  volToLiq: number;
  buyRatio: number;
  ageHours: number;
  marketCap: number;
}): { exitScore: number; verdict: Verdict; riskFlags: string[] } {
  // Liquidity depth is the pool you actually sell into. Log-scaled $1k..$250k.
  const liqScore =
    m.liquidityUsd > 0 ? clamp(((Math.log10(m.liquidityUsd) - 3) / (5.4 - 3)) * 100, 0, 100) : 0;

  // 24h volume means active counterparties exist. Log-scaled $1k..$1M.
  const volScore =
    m.volume24h > 0 ? clamp(((Math.log10(m.volume24h) - 3) / (6 - 3)) * 100, 0, 100) : 0;

  // Turnover (volume / liquidity). Healthy band is roughly 0.5x..10x per day.
  // Below that the pool is stagnant. Far above it usually means wash trading
  // or churn right before a coordinated dump.
  let turnScore = 0;
  if (m.volToLiq >= 0.5 && m.volToLiq <= 10) turnScore = 100;
  else if (m.volToLiq > 10 && m.volToLiq <= 25) turnScore = 100 - ((m.volToLiq - 10) / 15) * 70;
  else if (m.volToLiq > 25) turnScore = 20;
  else if (m.volToLiq > 0) turnScore = (m.volToLiq / 0.5) * 60;

  // Trade count. 0..600 trades per day.
  const tradeScore = clamp((m.txns24h / 600) * 100, 0, 100);

  const exitScore = Math.round(liqScore * 0.42 + volScore * 0.28 + turnScore * 0.2 + tradeScore * 0.1);

  const riskFlags: string[] = [];
  if (m.liquidityUsd < 15000) riskFlags.push("Thin liquidity (under $15k): exits move price hard");
  if (m.liquidityUsd < 5000) riskFlags.push("Near-dead pool (under $5k liquidity)");
  if (m.volToLiq > 25) riskFlags.push("Volume far above liquidity: likely wash trading or churn");
  if (m.txns24h < 50) riskFlags.push("Under 50 trades in 24h: little real activity");
  if (m.ageHours > 0 && m.ageHours < 2) riskFlags.push("Under 2h old: unproven, no exit history");
  if (m.buyRatio > 0.92) riskFlags.push("Almost all buys: one-sided, exit depth never tested");
  if (m.buyRatio < 0.12 && m.txns24h > 30) riskFlags.push("Almost all sells: holders are exiting");
  if (m.marketCap > 0 && m.liquidityUsd > 0 && m.marketCap / m.liquidityUsd > 50) {
    riskFlags.push("Market cap over 50x liquidity: little real money backs the price");
  }

  let verdict: Verdict = "trap risk";
  if (exitScore >= 62 && m.liquidityUsd >= 25000 && riskFlags.length <= 1) verdict = "exitable";
  else if (exitScore >= 40 && m.liquidityUsd >= 10000) verdict = "caution";

  return { exitScore, verdict, riskFlags };
}

// Plain-language explanation of why a coin surfaced in the scan.
function describeDiscovery(source: string): { channel: string; reason: string } {
  switch (source) {
    case "boosted":
      return {
        channel: "Paid boost",
        reason:
          "Surfaced in DexScreener's boosted / trending feed. Someone paid to promote it, so treat the attention as bought, not organic interest."
      };
    case "new profile":
      return {
        channel: "DEX scan",
        reason:
          "Caught by scanning DexScreener's newest token profiles. The project just got listed and added its social links."
      };
    case "pump.fun new":
      return {
        channel: "Launchpad",
        reason: "Pulled straight from pump.fun's newest-launches feed. A fresh mint."
      };
    case "geckoterminal new":
      return {
        channel: "DEX scan",
        reason: "Caught in GeckoTerminal's newest Solana pools feed. A brand-new pool."
      };
    case "geckoterminal trending":
      return {
        channel: "Trending",
        reason:
          "In GeckoTerminal's trending Solana pools, ranked by recent trading activity across DEXs."
      };
    case "jupiter new":
      return {
        channel: "Launchpad",
        reason:
          "Pulled from Jupiter's recent-tokens feed: first pool creation across every Solana launchpad. A fresh listing."
      };
    case "jupiter trending":
      return {
        channel: "Trending",
        reason:
          "In Jupiter's trending tokens, ranked by recent trading activity across Solana DEXs."
      };
    case "search":
      return { channel: "Manual lookup", reason: "You searched for this coin directly." };
    default:
      return { channel: "DEX scan", reason: "Found while scanning live on-chain market data." };
  }
}

function toMemeToken(p: DexPair, sources: string[], discoveredAt: string): MemeToken {
  const primarySource = sources[0] ?? "discovered";
  const liquidityUsd = num(p.liquidity?.usd);
  const volume24h = num(p.volume?.h24);
  const buys24h = num(p.txns?.h24?.buys);
  const sells24h = num(p.txns?.h24?.sells);
  const txns24h = buys24h + sells24h;
  const marketCap = num(p.marketCap);
  const fdv = num(p.fdv);
  const priceChange24h = num(p.priceChange?.h24);
  const ageHours = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 3.6e6 : 0;
  const volToLiq = liquidityUsd > 0 ? volume24h / liquidityUsd : 0;
  const buyRatio = txns24h > 0 ? buys24h / txns24h : 0.5;

  const { exitScore, verdict, riskFlags } = scoreExit({
    liquidityUsd,
    volume24h,
    txns24h,
    volToLiq,
    buyRatio,
    ageHours,
    marketCap
  });

  const disc = describeDiscovery(primarySource);
  // Jupiter is the Solana DEX aggregator: it routes the swap through whichever
  // pool (Raydium, PumpSwap, Meteora, Orca) has the liquidity.
  const tradeUrl =
    p.chainId === "solana" ? `https://jup.ag/swap/SOL-${p.baseToken.address}` : p.url;

  return {
    address: p.baseToken.address,
    name: p.baseToken.name || p.baseToken.symbol || "Unknown",
    symbol: p.baseToken.symbol || "?",
    chainId: p.chainId,
    dexId: p.dexId,
    url: p.url,
    priceUsd: num(p.priceUsd),
    volume24h,
    liquidityUsd,
    marketCap,
    fdv,
    txns24h,
    buys24h,
    sells24h,
    priceChange24h,
    ageHours,
    volToLiq,
    buyRatio,
    exitScore,
    verdict,
    riskFlags,
    socials: p.info?.socials ?? [],
    imageUrl: p.info?.imageUrl,
    source: primarySource,
    discoveredAt,
    discoveryChannel: disc.channel,
    discoveryReason: disc.reason,
    tradeUrl,
    sources,
    rating: 0,
    ratingBand: "F"
  };
}

// Composite rating (0 to 100), the card headline. Folds exitability together
// with cross-reference corroboration (how many independent discovery feeds
// surfaced the coin) and momentum, then docks risk flags. Live safety checks
// (RugCheck etc.) are not folded in here yet, so until they are the rating is
// "provisional". Weights are tunable; if you change them, update docs/ARCHITECTURE.md.
function computeRating(t: MemeToken): { rating: number; ratingBand: MemeToken["ratingBand"] } {
  let r = t.exitScore;
  // Cross-reference corroboration: each independent feed beyond the first
  // that surfaced this coin adds confidence, capped at three extra.
  const extraSources = Math.max(0, t.sources.length - 1);
  r += Math.min(extraSources, 3) * 5;
  // Momentum vs the previous scan.
  const m = t.momentumScore;
  if (typeof m === "number") {
    if (m > 25) r += 6;
    else if (m > 0) r += 3;
    else if (m < -35) r -= 8;
  }
  // Risk flags drag it down.
  r -= t.riskFlags.length * 3;
  const rating = Math.max(0, Math.min(100, Math.round(r)));
  const ratingBand =
    rating >= 80 ? "A" : rating >= 65 ? "B" : rating >= 50 ? "C" : rating >= 35 ? "D" : "F";
  return { rating, ratingBand };
}

// For each token address, keep the single deepest-liquidity pair.
function buildTokens(
  pairs: DexPair[],
  sourcesByAddr: Map<string, string[]>,
  discoveredAt: string,
  defaultSource = "discovered"
): MemeToken[] {
  const byAddr = new Map<string, DexPair>();
  for (const p of pairs) {
    const addr = p?.baseToken?.address;
    if (!addr) continue;
    const existing = byAddr.get(addr);
    if (!existing || num(p.liquidity?.usd) > num(existing.liquidity?.usd)) byAddr.set(addr, p);
  }
  const tokens: MemeToken[] = [];
  for (const [addr, p] of byAddr) {
    tokens.push(toMemeToken(p, sourcesByAddr.get(addr) ?? [defaultSource], discoveredAt));
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Candidate sourcing
// ---------------------------------------------------------------------------

type Candidate = { address: string; chainId: string; source: string };

async function dexCandidates(): Promise<Candidate[]> {
  const out: Candidate[] = [];
  // Boosted tokens: paid promotion, but a reliable feed of what is being pushed.
  try {
    const boosts = await getJson("/api/dexscreener/token-boosts/top/v1");
    if (Array.isArray(boosts)) {
      for (const b of boosts) {
        if (b?.chainId === "solana" && b?.tokenAddress) {
          out.push({ address: b.tokenAddress, chainId: "solana", source: "boosted" });
        }
      }
    }
  } catch {
    /* fall through, profiles below may still work */
  }
  // Freshly profiled tokens: newest tokens that added socials / a description.
  try {
    const profiles = await getJson("/api/dexscreener/token-profiles/latest/v1");
    if (Array.isArray(profiles)) {
      for (const p of profiles) {
        if (p?.chainId === "solana" && p?.tokenAddress) {
          out.push({ address: p.tokenAddress, chainId: "solana", source: "new profile" });
        }
      }
    }
  } catch {
    /* fall through */
  }
  return out;
}

// Known quote mints (wrapped SOL, USDC) so they are not scanned as "coins".
const QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
]);

async function geckoCandidates(): Promise<Candidate[]> {
  const out: Candidate[] = [];
  // GeckoTerminal public API: free, no key. Trending and brand-new Solana pools.
  for (const path of ["trending_pools", "new_pools"]) {
    try {
      const data = (await getJson(`/api/geckoterminal/networks/solana/${path}`)) as {
        data?: Array<{ relationships?: { base_token?: { data?: { id?: string } } } }>;
      };
      const pools = Array.isArray(data?.data) ? data.data : [];
      for (const pool of pools) {
        const id = pool?.relationships?.base_token?.data?.id;
        if (typeof id === "string" && id.startsWith("solana_")) {
          const address = id.slice(7);
          if (QUOTE_MINTS.has(address)) continue;
          out.push({
            address,
            chainId: "solana",
            source: path === "new_pools" ? "geckoterminal new" : "geckoterminal trending"
          });
        }
      }
    } catch {
      /* fall through */
    }
  }
  return out;
}

async function pumpCandidates(): Promise<Candidate[]> {
  // Best effort. pump.fun's frontend API is frequently rate-limited or gated;
  // when it fails the scan still runs on DexScreener data alone.
  try {
    const coins = await getJson(
      "/api/pumpfun/coins?offset=0&limit=40&sort=created_timestamp&order=DESC&includeNsfw=false"
    );
    if (Array.isArray(coins)) {
      return coins
        .filter((c) => c?.mint)
        .map((c) => ({ address: String(c.mint), chainId: "solana", source: "pump.fun new" }));
    }
  } catch {
    /* fall through */
  }
  return [];
}

// Jupiter Tokens API v2 discovery feeds. Free, keyless on the lite-api host,
// reached through the existing /api/jupiter proxy. `/recent` is new tokens by
// first pool creation across every Solana launchpad (pump.fun, LetsBonk,
// LaunchLab, Moonshot, ...), wider and more reliable than the often-gated
// pump.fun feed. `/toptrending/24h` is tokens trending on recent activity.
async function jupiterCandidates(): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const feeds: { path: string; source: string }[] = [
    { path: "/api/jupiter/tokens/v2/recent", source: "jupiter new" },
    { path: "/api/jupiter/tokens/v2/toptrending/24h", source: "jupiter trending" }
  ];
  for (const feed of feeds) {
    try {
      const data = await getJson(feed.path);
      const list = Array.isArray(data) ? data : [];
      for (const t of list) {
        const id = (t as { id?: unknown })?.id;
        if (typeof id === "string" && id && !QUOTE_MINTS.has(id)) {
          out.push({ address: id, chainId: "solana", source: feed.source });
        }
      }
    } catch {
      /* fall through; the scan still runs on the other sources */
    }
  }
  return out;
}

// PumpPortal candidates. Read from the local pump_candidates table populated
// by the server-side WebSocket collector (see pumpPortalCollectorPlugin in
// vite.config.ts). This is the fifth and most timely candidate source:
// PumpPortal pushes new pump.fun mints in real time, no polling, no gated
// REST. The collector is one connection per dev-server process; this read is
// just a recent-window query against Postgres.
async function pumpPortalCandidates(): Promise<Candidate[]> {
  try {
    // 30-minute window matches the cycle cadence: anything older than that
    // either made it into a prior scan and got enriched, or is already dying.
    const data = await getJson("/api/pumpcandidates/recent?minutes=30&limit=60");
    const list = (data as { candidates?: unknown })?.candidates;
    if (!Array.isArray(list)) return [];
    const out: Candidate[] = [];
    for (const row of list) {
      const mint = (row as { mint?: unknown })?.mint;
      if (typeof mint === "string" && mint && !QUOTE_MINTS.has(mint)) {
        out.push({ address: mint, chainId: "solana", source: "pumpportal" });
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Momentum: compare each token to the previous scan. Surfaces coins whose
// volume and liquidity are rising fastest, which catches moves earlier than a
// static "what is big now" ranking.
function applyMomentum(tokens: MemeToken[], previous?: ScanResult): MemeToken[] {
  if (!previous) return tokens;
  const prevByAddr = new Map(previous.tokens.map((t) => [t.address, t]));
  return tokens.map((t) => {
    const prev = prevByAddr.get(t.address);
    if (!prev) return { ...t, isNewSinceLastScan: true, momentumScore: 0 };
    const volMomentumPct =
      prev.volume24h > 0 ? ((t.volume24h - prev.volume24h) / prev.volume24h) * 100 : 0;
    const liqMomentumPct =
      prev.liquidityUsd > 0 ? ((t.liquidityUsd - prev.liquidityUsd) / prev.liquidityUsd) * 100 : 0;
    return {
      ...t,
      isNewSinceLastScan: false,
      volMomentumPct,
      liqMomentumPct,
      momentumScore: volMomentumPct * 0.6 + liqMomentumPct * 0.4
    };
  });
}

// Pass the previous ScanResult to get momentum (rising volume / liquidity).
export async function scanMemecoins(previous?: ScanResult): Promise<ScanResult> {
  const scannedAt = new Date().toISOString();
  const sources: ScanResult["sources"] = [];

  // Candidate feeds hit independent upstreams (DexScreener, GeckoTerminal,
  // Jupiter, pump.fun REST, PumpPortal WebSocket cache) with no shared
  // rate-limit constraint, so they run in parallel rather than serially.
  // Promise.allSettled so one provider being down doesn't fail the others.
  // PumpPortal is the most timely (real-time WebSocket → Postgres → here),
  // and the read is a local DB query so it's effectively free.
  const [dexResult, geckoResult, jupResult, pfResult, ppResult] = await Promise.allSettled([
    dexCandidates(),
    geckoCandidates(),
    jupiterCandidates(),
    pumpCandidates(),
    pumpPortalCandidates()
  ]);
  const dex = dexResult.status === "fulfilled" ? dexResult.value : [];
  const gecko = geckoResult.status === "fulfilled" ? geckoResult.value : [];
  const jup = jupResult.status === "fulfilled" ? jupResult.value : [];
  const pf = pfResult.status === "fulfilled" ? pfResult.value : [];
  const pp = ppResult.status === "fulfilled" ? ppResult.value : [];
  sources.push({
    name: "DexScreener (boosted + new profiles)",
    ok: dex.length > 0,
    count: dex.length,
    note: dex.length === 0 ? "no Solana tokens returned" : undefined
  });
  sources.push({
    name: "GeckoTerminal (new + trending pools)",
    ok: gecko.length > 0,
    count: gecko.length,
    note: gecko.length === 0 ? "no data" : undefined
  });
  sources.push({
    name: "Jupiter Tokens v2 (recent + trending)",
    ok: jup.length > 0,
    count: jup.length,
    note: jup.length === 0 ? "no data" : undefined
  });
  sources.push({
    name: "pump.fun (newest launches, REST)",
    ok: pf.length > 0,
    count: pf.length,
    note: pf.length === 0 ? "no data, endpoint rate-limited or gated" : undefined
  });
  sources.push({
    name: "PumpPortal (real-time mint stream)",
    ok: pp.length > 0,
    count: pp.length,
    note:
      pp.length === 0
        ? "no recent mints in the 30-minute window (collector may still be connecting; see Integrations panel)"
        : undefined
  });

  // Cross-reference: collect every source that surfaced each address, across
  // all buckets, before the cap. computeRating() rewards coins that multiple
  // independent feeds agree on.
  const buckets = [dex, gecko, jup, pf, pp];
  const sourcesByAddr = new Map<string, string[]>();
  for (const bucket of buckets) {
    for (const c of bucket) {
      if (c.chainId !== "solana") continue;
      const list = sourcesByAddr.get(c.address) ?? [];
      if (!list.includes(c.source)) list.push(c.source);
      sourcesByAddr.set(c.address, list);
    }
  }

  // Round-robin merge so each bucket is represented, dedupe, cap at 60.
  const seen = new Set<string>();
  const addrs: string[] = [];
  for (let i = 0; addrs.length < 60; i++) {
    let advanced = false;
    for (const bucket of buckets) {
      const c = bucket[i];
      if (!c) continue;
      advanced = true;
      if (c.chainId !== "solana" || seen.has(c.address)) continue;
      seen.add(c.address);
      addrs.push(c.address);
      if (addrs.length >= 60) break;
    }
    if (!advanced) break;
  }

  if (addrs.length === 0) {
    return { tokens: [], sources, scannedAt };
  }

  // Enrich with market data, batched (DexScreener allows 30 addresses/call).
  let tokens: MemeToken[] = [];
  try {
    const allPairs: DexPair[] = [];
    for (let i = 0; i < addrs.length; i += 30) {
      const batch = addrs.slice(i, i + 30);
      const data = (await getJson(`/api/dexscreener/latest/dex/tokens/${batch.join(",")}`)) as {
        pairs?: DexPair[];
      };
      if (Array.isArray(data?.pairs)) allPairs.push(...data.pairs);
    }
    tokens = buildTokens(allPairs, sourcesByAddr, scannedAt);
    sources.push({ name: "DexScreener market data", ok: tokens.length > 0, count: tokens.length });
  } catch (e) {
    sources.push({ name: "DexScreener market data", ok: false, count: 0, note: errMsg(e) });
  }

  tokens = applyMomentum(tokens, previous);
  tokens = tokens.map((t) => ({ ...t, ...computeRating(t) }));
  tokens.sort((a, b) => b.rating - a.rating);

  // Scan-time Jupiter enrichment for the top N by initial rating. One call
  // per mint, cached for 5 minutes (shared cache with the buy-time safety
  // gate, so a scan also warms the gate's cache and vice versa). Lower-
  // ranked coins skip enrichment so we don't burn 60 calls per scan on
  // candidates the user is unlikely to inspect anyway. Widened from 20 to
  // 40 so the minHolderCount filter (added May 2026) can act on more of
  // the queue, since unenriched coins are treated as "no data, allow".
  tokens = await enrichTopCandidates(tokens, 40);

  sources.push({
    name: "Jupiter enrichment (top 40)",
    ok: true,
    count: tokens.filter((t) => t.jupiterEnrichedAt !== undefined).length
  });
  return { tokens, sources, scannedAt };
}

// Enrich the top-N candidates by rating with Jupiter Tokens v2 data
// (top-10 holders %, bot ratio, holder count, organic label). Parallel, with
// each call independently swallowing failure so one bad mint cannot poison
// the whole pass. The Jupiter response is cached in safety.ts so the same
// mint inspected at buy time minutes later reuses this fetch.
// Concurrency cap for the enrichment burst. At topN=40, the previous
// "fire all 40 in parallel" pattern could collide with Jupiter's free-tier
// 60-rpm limit if a scan triggered while a safety-gate run was also
// hitting Jupiter. A pool of 8 keeps the burst inside the budget while
// still finishing fast (5 batches of 8, each ~200ms = ~1s total). Pair
// this with the in-flight dedup in safety.ts so two concurrent enrichments
// for the same mint share one upstream call.
const ENRICH_CONCURRENCY = 8;
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

async function enrichTopCandidates(
  tokens: MemeToken[],
  topN: number
): Promise<MemeToken[]> {
  if (tokens.length === 0) return tokens;
  const enrichedAt = new Date().toISOString();
  const candidates = tokens.slice(0, topN);
  const results = await runWithConcurrency(candidates, ENRICH_CONCURRENCY, (t) =>
    fetchJupiterTokenSummary(t.address)
  );
  const byAddr = new Map<string, { top: number | null; holders: number | null; label: string | null; numTraders: number | null; numTx: number | null }>();
  for (let i = 0; i < candidates.length; i++) {
    const r = results[i];
    if (r.status !== "fulfilled") continue;
    const out = r.value;
    if (!out.ok || !out.data) continue;
    const s = out.data;
    const numTx =
      (typeof s.numBuys === "number" ? s.numBuys : 0) +
      (typeof s.numSells === "number" ? s.numSells : 0);
    byAddr.set(candidates[i].address, {
      top: s.topHoldersPct,
      holders: s.holderCount,
      label: s.organicScoreLabel,
      numTraders: s.numTraders,
      numTx: numTx > 0 ? numTx : null
    });
  }
  return tokens.map((t) => {
    const e = byAddr.get(t.address);
    if (!e) return t;
    const ratio =
      e.numTraders !== null && e.numTx !== null && e.numTx > 0
        ? e.numTraders / e.numTx
        : undefined;
    return {
      ...t,
      top10HoldersPct: e.top ?? undefined,
      jupiterHolderCount: e.holders ?? undefined,
      jupiterOrganicLabel: e.label ?? undefined,
      botRatio: ratio,
      jupiterEnrichedAt: enrichedAt
    };
  });
}

// Validate a single ticker, name, or contract address on demand.
export async function lookupToken(query: string): Promise<MemeToken[]> {
  const scannedAt = new Date().toISOString();
  const data = (await getJson(
    `/api/dexscreener/latest/dex/search?q=${encodeURIComponent(query)}`
  )) as { pairs?: DexPair[] };
  const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
  const tokens = buildTokens(pairs, new Map(), scannedAt, "search").map((t) => ({
    ...t,
    ...computeRating(t)
  }));
  tokens.sort((a, b) => b.rating - a.rating);
  return tokens.slice(0, 12);
}

export type PriceSnapshot = { priceUsd: number; liquidityUsd: number; volume24h: number };

// Current price + liquidity for a set of token addresses. Used by the paper
// trader to value open positions and run its sell rules.
export async function fetchPrices(
  addresses: string[]
): Promise<Record<string, PriceSnapshot>> {
  const out: Record<string, PriceSnapshot> = {};
  if (addresses.length === 0) return out;

  for (let i = 0; i < addresses.length; i += 30) {
    const batch = addresses.slice(i, i + 30);
    try {
      const data = (await getJson(`/api/dexscreener/latest/dex/tokens/${batch.join(",")}`)) as {
        pairs?: DexPair[];
      };
      const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
      for (const p of pairs) {
        const addr = p?.baseToken?.address;
        if (!addr) continue;
        const liq = num(p.liquidity?.usd);
        const existing = out[addr];
        // Keep the deepest-liquidity pair per token.
        if (!existing || liq > existing.liquidityUsd) {
          out[addr] = {
            priceUsd: num(p.priceUsd),
            liquidityUsd: liq,
            volume24h: num(p.volume?.h24)
          };
        }
      }
    } catch {
      /* leave this batch missing; a missing price is NOT treated as a rug.
         The sell pass and watch leave the position open and re-price it next
         cycle. See docs/ARCHITECTURE.md "No false-rug auto-closes". */
    }
  }
  return out;
}

function classifyPlatform(url: string): string {
  const u = url.toLowerCase();
  if (u.includes("x.com") || u.includes("twitter.com")) return "X";
  if (u.includes("reddit.com")) return "Reddit";
  return "Other";
}

// X and Reddit are the web-indexed social platforms. Telegram (t.me) was
// dropped: its content is not indexed by search engines, so a domain-filtered
// search of it consistently returned nothing.
const SOCIAL_DOMAINS = ["x.com", "twitter.com", "reddit.com"];

function toChatter(raw: { title: string; url: string; snippet: string }[]): ChatterResult {
  const items = raw.map((r) => ({ ...r, platform: classifyPlatform(r.url) }));
  const byPlatform = { x: 0, reddit: 0, other: 0 };
  for (const it of items) {
    if (it.platform === "X") byPlatform.x++;
    else if (it.platform === "Reddit") byPlatform.reddit++;
    else byPlatform.other++;
  }
  return { total: items.length, byPlatform, items };
}

// Per-coin social check.
//
// Three-tier provider cascade: Brave → (preferred secondary) → (other secondary).
// Brave is always tier 1 because its free quota is the largest (2000/mo) and
// its $-per-call on paid tiers is the lowest of the three. The preferProvider
// option only decides which of Tavily / Serper is the next fallback after
// Brave fails, and which comes last:
//   - "tavily" (default): Brave → Tavily → Serper. Use this for manual
//     research where Tavily's curated snippets are worth a fallback hit.
//   - "serper": Brave → Serper → Tavily. Use this for bulk fire-and-forget
//     paths (auto pump-event logging) where we never want to land on the
//     scarce Tavily budget if we can avoid it.
//
// Note on query operators: Serper's free tier rejects `site:` / `OR` /
// parentheses with HTTP 400. Tavily uses `includeDomains` as a parameter,
// not an operator. Brave honors `site:` natively. So the chatter query stays
// plain and we classify results by URL domain after the fact (toChatter);
// Tavily is the only provider that gets a domain-restricted query.
export async function checkSocialChatter(
  symbol: string,
  name: string,
  opts?: { preferProvider?: "tavily" | "serper" }
): Promise<{ ok: true; data: ChatterResult } | { ok: false; error: string }> {
  const query = `${symbol} ${name} memecoin`.trim();
  const preferProvider = opts?.preferProvider ?? "tavily";

  const tryBrave = async () => {
    const r = await braveSearch({ query, count: 12, timeRange: "month" });
    if (!r.ok) return r;
    const results = (r.data.web?.results ?? []).map((x) => ({
      title: x.title,
      url: x.url,
      snippet: x.description
    }));
    return { ok: true as const, results };
  };
  const tryTavily = async () => {
    const r = await tavilySearch({
      query,
      includeDomains: SOCIAL_DOMAINS,
      maxResults: 12,
      timeRange: "month"
    });
    if (!r.ok) return r;
    const results = r.data.results.map((x) => ({
      title: x.title,
      url: x.url,
      snippet: x.content
    }));
    return { ok: true as const, results };
  };
  const trySerper = async () => {
    const r = await serperSearch({ query, numResults: 12, timeRange: "month" });
    if (!r.ok) return r;
    const results = (r.data.organic || []).map((x) => ({
      title: x.title,
      url: x.link,
      snippet: x.snippet
    }));
    return { ok: true as const, results };
  };

  const cascade =
    preferProvider === "serper"
      ? [["brave", tryBrave], ["serper", trySerper], ["tavily", tryTavily]] as const
      : [["brave", tryBrave], ["tavily", tryTavily], ["serper", trySerper]] as const;

  const errors: string[] = [];
  for (const [name, run] of cascade) {
    const r = await run();
    if (r.ok) return { ok: true, data: toChatter(r.results) };
    errors.push(`${name}: ${r.error}`);
  }
  return {
    ok: false,
    error: `All search providers failed. ${errors.join(" | ")}`
  };
}
