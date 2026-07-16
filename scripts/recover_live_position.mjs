#!/usr/bin/env node
// One-shot recovery for a live buy whose on-chain swap confirmed but whose
// confirmLiveBuy path failed before writing to live_positions.
//
// Reads the on-chain tx via SOLANA_RPC_URL to get the actual fill (USDC spent,
// tokens received), fetches current DexScreener + Jupiter data for the
// entry-feature snapshot, reads paper_account for the settings snapshot,
// derives algo_version from those settings, then INSERTs the live_positions
// row exactly as openLivePosition would have written it.
//
// Idempotent: skips if a row with the same entry_signature already exists.
//
// Usage:
//   node scripts/recover_live_position.mjs \
//     --signature 4ctw... --mint H74C... --symbol "LMAO!" --buyer B2DS...
// Or pass these via env: SIG, MINT, SYMBOL, BUYER.
//
// Why a separate script instead of fixing it in-app: the lost position
// already happened. The retry-on-meta-not-found gap (see the patch in
// App.tsx / live.ts after this) prevents the next one.

import pg from "pg";

const RPC_URL = process.env.SOLANA_RPC_URL;
const DEXSCREENER_BASE = "https://api.dexscreener.com";
const JUPITER_BASE = "https://lite-api.jup.ag";
// Requires Postgres. Set DATABASE_URL in the environment before running.
const PG_URL = process.env.DATABASE_URL;
if (!PG_URL) {
  console.error("DATABASE_URL is not set. Export a PostgreSQL connection URL before running.");
  process.exit(1);
}

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Parse argv: --key value pairs
const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, "")] = argv[i + 1];

const SIG = args.signature || process.env.SIG;
const MINT = args.mint || process.env.MINT;
const SYMBOL = args.symbol || process.env.SYMBOL || "?";
const NAME = args.name || process.env.NAME || SYMBOL;
const BUYER = args.buyer || process.env.BUYER;

if (!SIG || !MINT || !BUYER) {
  console.error("Missing required: --signature, --mint, --buyer");
  process.exit(1);
}
if (!RPC_URL) {
  console.error("SOLANA_RPC_URL not set (read from .env.local). Set in env and retry.");
  process.exit(1);
}

async function fetchJson(url, init) {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

async function fetchTx(sig) {
  const body = {
    jsonrpc: "2.0", id: 1, method: "getTransaction",
    params: [sig, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]
  };
  const r = await fetchJson(RPC_URL, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  if (!r.result) throw new Error(`RPC returned no tx: ${JSON.stringify(r)}`);
  return r.result;
}

function decodeFills(tx, buyer, baseMint, tokenMint) {
  const pre = tx.meta?.preTokenBalances || [];
  const post = tx.meta?.postTokenBalances || [];
  const key = (b) => `${b.mint}|${b.owner}`;
  const preMap = Object.fromEntries(pre.map((b) => [key(b), b.uiTokenAmount.uiAmount || 0]));
  const postMap = Object.fromEntries(post.map((b) => [key(b), b.uiTokenAmount.uiAmount || 0]));
  const all = new Set([...Object.keys(preMap), ...Object.keys(postMap)]);
  let baseSpent = 0, tokenReceived = 0;
  for (const k of all) {
    const [m, o] = k.split("|");
    const d = (postMap[k] || 0) - (preMap[k] || 0);
    if (o === buyer && m === baseMint && d < 0) baseSpent = -d;
    if (o === buyer && m === tokenMint && d > 0) tokenReceived = d;
  }
  return { baseSpent, tokenReceived };
}

async function fetchMemeToken(mint) {
  // DexScreener pair + Jupiter audit, same shape as scanMemecoins enrichment.
  const dex = await fetchJson(`${DEXSCREENER_BASE}/latest/dex/tokens/${mint}`);
  const pairs = (dex.pairs || []).sort(
    (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)
  );
  const p = pairs[0];
  const jup = await fetchJson(`${JUPITER_BASE}/tokens/v2/search?query=${mint}`);
  const hit = (Array.isArray(jup) ? jup : []).find((t) => t?.id === mint) || jup?.[0];
  return {
    name: p?.baseToken?.name || NAME,
    symbol: p?.baseToken?.symbol || SYMBOL,
    liquidityUsd: p?.liquidity?.usd ?? null,
    volume24h: p?.volume?.h24 ?? null,
    marketCap: p?.marketCap ?? null,
    pairCreatedAt: p?.pairCreatedAt ?? null,
    priceChange24h: p?.priceChange?.h24 ?? null,
    buys24h: p?.txns?.h24?.buys ?? null,
    sells24h: p?.txns?.h24?.sells ?? null,
    top10HoldersPct: hit?.audit?.topHoldersPercentage ?? null,
    holderCount: hit?.holderCount ?? null,
    botRatio: null,  // requires the buy/wallets ratio calc; not in lite jup
    organicLabel: hit?.organicLabel ?? null,
    organicScore: hit?.organicScore ?? null,
    rating: null, ratingBand: null, verdict: null
  };
}

function deriveAlgoVersion(s) {
  if (!s) return "unknown";
  if (s.minHolderCount == null) return "algo1";
  if (s.minHolderCount === 500 && s.minAgeHours === 72) return "algo2";
  return "custom";
}

async function main() {
  const pool = new pg.Pool({ connectionString: PG_URL });
  const client = await pool.connect();
  try {
    // Idempotency: already recovered?
    const exists = await client.query(
      "select id from live_positions where entry_signature = $1",
      [SIG]
    );
    if (exists.rows.length > 0) {
      console.log(`Already recovered as id=${exists.rows[0].id}; nothing to do.`);
      return;
    }

    console.log(`Fetching tx ${SIG.slice(0, 12)}...`);
    const tx = await fetchTx(SIG);
    const { baseSpent, tokenReceived } = decodeFills(tx, BUYER, USDC_MINT, MINT);
    if (baseSpent <= 0 || tokenReceived <= 0) {
      throw new Error(
        `Could not decode buy fills from tx (baseSpent=${baseSpent}, tokenReceived=${tokenReceived}). Check --buyer matches the wallet that received the token.`
      );
    }
    const entryPriceUsd = baseSpent / tokenReceived;
    const entryAt = tx.blockTime
      ? new Date(tx.blockTime * 1000).toISOString()
      : new Date().toISOString();
    console.log(`Decoded: spent ${baseSpent} USDC, received ${tokenReceived} tokens @ $${entryPriceUsd.toPrecision(5)}/token`);

    console.log(`Fetching MemeToken snapshot...`);
    const tok = await fetchMemeToken(MINT);

    console.log(`Reading paper_account settings...`);
    const acct = (await client.query("select * from paper_account where id = 1")).rows[0];
    const settings = {
      autoTrade: acct.auto_trade,
      tradeSizeUsd: acct.trade_size_usd,
      maxOpenPositions: acct.max_open_positions,
      minExitScore: acct.min_exit_score,
      minLiquidityUsd: acct.min_liquidity_usd,
      minAgeHours: acct.min_age_hours,
      minHolderCount: acct.min_holder_count,
      takeProfitPct: acct.take_profit_pct,
      stopLossPct: acct.stop_loss_pct,
      maxHoldHours: acct.max_hold_hours,
      reentryCooldownHours: acct.reentry_cooldown_hours,
      dailyLossLimitPct: acct.daily_loss_limit_pct,
      maxTopHoldersPct: acct.max_top_holders_pct,
      trailingStopPct: acct.trailing_stop_pct,
      trailingActivationPct: acct.trailing_activation_pct,
      liveDailyLossLimitUsd: acct.live_daily_loss_limit_usd,
      buyDismissalImprovementPoints: 10
    };
    const algoVersion = deriveAlgoVersion(settings);
    console.log(`Derived algo_version: ${algoVersion}`);

    const ageHours = tok.pairCreatedAt
      ? ((new Date(entryAt).getTime() - tok.pairCreatedAt) / 3.6e6)
      : null;

    const id = `recover_${Date.now().toString(36)}`;
    await client.query(
      `insert into live_positions
         (id, mint, symbol, name, status, base_mint, entry_at, entry_signature,
          entry_base_amount, entry_token_amount, entry_price_usd, slippage_bps,
          buy_price_impact_pct, route_summary, alerted_spike, took_half_profit,
          partial_proceeds_base, partial_realized_base, danger_alerted,
          last_price_usd, last_liquidity_usd, exit_at, exit_signature,
          exit_price_usd, exit_base_amount, exit_reason, pnl_base, pnl_usd,
          peak_price_usd,
          entry_exit_score, entry_liquidity_usd, entry_volume_24h, entry_market_cap,
          entry_age_hours, entry_price_change_24h, entry_buys_24h, entry_sells_24h,
          entry_buy_ratio, entry_top10_holders_pct, entry_bot_ratio, entry_holder_count,
          entry_organic_label, entry_rating, entry_rating_band, entry_verdict,
          entry_sources, entry_risk_flags, entry_socials_count, entry_jupiter_enriched_at,
          algo_version, entry_settings_snapshot)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46,$47,$48,$49,$50,$51)`,
      [
        id, MINT, tok.symbol, tok.name, "open", USDC_MINT, entryAt, SIG,
        baseSpent, tokenReceived, entryPriceUsd, 150,
        null, "recovered via scripts/recover_live_position.mjs", false, false,
        null, null, false,
        entryPriceUsd, tok.liquidityUsd, null, null,
        null, null, null, null, null,
        entryPriceUsd,
        null, tok.liquidityUsd, tok.volume24h, tok.marketCap,
        ageHours, tok.priceChange24h, tok.buys24h, tok.sells24h,
        null, tok.top10HoldersPct, tok.botRatio, tok.holderCount,
        tok.organicLabel, tok.rating, tok.ratingBand, tok.verdict,
        null, null, null, new Date().toISOString(),
        algoVersion,
        JSON.stringify(settings)
      ]
    );
    console.log(`\nRecovered as live_positions.id = ${id}`);
    console.log(`Symbol: ${tok.symbol}  algo_version: ${algoVersion}`);
    console.log(`Cost: $${baseSpent.toFixed(2)}  Tokens: ${tokenReceived}  Entry: $${entryPriceUsd.toPrecision(5)}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
