#!/usr/bin/env node
// Algo2 retroactive backtest against historical m_trade_log rows.
//
// Purpose: even though entry-time feature columns are NULL on every historical
// trade (Phase 1 capture bug, separate issue), we can still ask "would algo2
// have bought this coin?" by re-fetching DexScreener + Jupiter NOW.
//
// Limitations to keep in mind reading the output:
//   - Age gate: EXACT. pairCreatedAt is a fact about the pool, not a snapshot.
//   - Holder count, top-10 %: APPROXIMATE. Current values used as a proxy for
//     entry-time. Both metrics usually distribute over time, so a coin that
//     passes the holder floor NOW probably did NOT at entry. This makes the
//     backtest slightly OPTIMISTIC for the holder/top-10 gates (under-rejects).
//   - Safety gate: NOT included here. RugCheck has aggressive rate limits and
//     93 calls would take a while; can be added in a follow-up.
//
// Output:
//   - Per-mint verdict saved to the `m_algo2_backtest` table for SQL analysis.
//   - Aggregated summary printed to stdout.
//
// Usage: node scripts/backtest_algo2.mjs

import pg from "pg";

const DEXSCREENER_BASE = "https://api.dexscreener.com";
const JUPITER_BASE = "https://lite-api.jup.ag";
// Requires Postgres. Set DATABASE_URL in the environment before running.
const PG_URL = process.env.DATABASE_URL;
if (!PG_URL) {
  console.error("DATABASE_URL is not set. Export a PostgreSQL connection URL before running.");
  process.exit(1);
}

// algo2 gate parameters. Keep in sync with PaperSettings defaults; if these
// drift, re-run the backtest with the matching values.
const ALGO2 = {
  minAgeHours: 72,
  minHolderCount: 500,
  maxTopHoldersPct: 35
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "meme-ify-backtest/1" }
  });
  if (!res.ok) {
    return { ok: false, status: res.status, error: `HTTP ${res.status}` };
  }
  try {
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// DexScreener: returns the strongest pair for the mint. We use it for
// pairCreatedAt only; current liquidity is shown for sanity but not gated.
async function fetchDexscreener(mint) {
  const r = await fetchJson(`${DEXSCREENER_BASE}/latest/dex/tokens/${mint}`);
  if (!r.ok) return { ok: false, error: r.error };
  const pairs = Array.isArray(r.data?.pairs) ? r.data.pairs : [];
  if (pairs.length === 0) return { ok: false, error: "no pairs" };
  // Pick the highest-liquidity pair, matching the lib's selection logic.
  pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const p = pairs[0];
  return {
    ok: true,
    pairCreatedAt: p.pairCreatedAt ?? null,
    liquidityUsd: p.liquidity?.usd ?? null,
    priceUsd: p.priceUsd ? parseFloat(p.priceUsd) : null
  };
}

// Jupiter: organic-stats audit. Returns current top10/holderCount, which we
// use as an approximation of entry-time values.
async function fetchJupiter(mint) {
  const r = await fetchJson(`${JUPITER_BASE}/tokens/v2/search?query=${mint}`);
  if (!r.ok) return { ok: false, error: r.error };
  const arr = Array.isArray(r.data) ? r.data : [];
  const hit = arr.find((t) => t?.id === mint) || arr[0];
  if (!hit) return { ok: false, error: "not in jupiter" };
  const audit = hit.audit || {};
  return {
    ok: true,
    top10HoldersPct: typeof audit.topHoldersPercentage === "number" ? audit.topHoldersPercentage : null,
    holderCount: typeof hit.holderCount === "number" ? hit.holderCount : null,
    organicScore: typeof hit.organicScore === "number" ? hit.organicScore : null
  };
}

async function ensureBacktestTable(client) {
  // Schema: one row per (mint, run_at). Keep history so we can compare runs
  // (e.g. when minHolderCount changes). cascade joins to m_trade_log on mint.
  await client.query(`
    create table if not exists m_algo2_backtest (
      mint                     text not null,
      run_at                   timestamptz not null default now(),
      pair_created_at          timestamptz,
      age_at_entry_hours       double precision,
      current_holder_count     int,
      current_top10_pct        double precision,
      current_liquidity_usd    double precision,
      current_organic_score    double precision,
      block_age                boolean,
      block_holders            boolean,
      block_top10              boolean,
      block_any                boolean,
      fetch_error              text,
      primary key (mint, run_at)
    );
    create index if not exists m_algo2_backtest_mint_idx on m_algo2_backtest (mint);
    create index if not exists m_algo2_backtest_block_idx on m_algo2_backtest (block_any);
  `);
}

async function main() {
  const pool = new pg.Pool({ connectionString: PG_URL });
  const client = await pool.connect();
  try {
    await ensureBacktestTable(client);

    // One row per distinct mint across m_paper_positions + m_trade_log, with the
    // earliest entry_at (the actual buy time we'd apply the age gate to).
    const { rows } = await client.query(`
      select address as mint, min(entry_at) as entry_at
      from (
        select address, entry_at from m_paper_positions
        union all
        select address, entry_at from m_trade_log
      ) u
      group by address
      order by 2
    `);

    console.log(`Running algo2 backtest on ${rows.length} distinct mints...\n`);

    const runAt = new Date().toISOString();
    let done = 0;

    for (const r of rows) {
      const mint = r.mint;
      const entryAtMs = new Date(r.entry_at).getTime();
      let dex, jup, err;
      try {
        dex = await fetchDexscreener(mint);
        await sleep(150); // be polite, well under 300/min
        jup = await fetchJupiter(mint);
        await sleep(150);
      } catch (e) {
        err = e.message;
      }

      const ageAtEntryHours = dex?.ok && dex.pairCreatedAt
        ? (entryAtMs - dex.pairCreatedAt) / 3.6e6
        : null;
      const holderCount = jup?.ok ? jup.holderCount : null;
      const top10Pct = jup?.ok ? jup.top10HoldersPct : null;

      const blockAge =
        typeof ageAtEntryHours === "number" && ageAtEntryHours < ALGO2.minAgeHours;
      const blockHolders =
        typeof holderCount === "number" && holderCount < ALGO2.minHolderCount;
      const blockTop10 =
        typeof top10Pct === "number" && top10Pct > ALGO2.maxTopHoldersPct;
      const blockAny = blockAge || blockHolders || blockTop10;

      const fetchError = err || (!dex?.ok ? `dex:${dex?.error}` : !jup?.ok ? `jup:${jup?.error}` : null);

      await client.query(
        `insert into m_algo2_backtest
           (mint, run_at, pair_created_at, age_at_entry_hours,
            current_holder_count, current_top10_pct, current_liquidity_usd,
            current_organic_score, block_age, block_holders, block_top10,
            block_any, fetch_error)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         on conflict (mint, run_at) do update set
           pair_created_at = excluded.pair_created_at,
           age_at_entry_hours = excluded.age_at_entry_hours,
           current_holder_count = excluded.current_holder_count,
           current_top10_pct = excluded.current_top10_pct,
           current_liquidity_usd = excluded.current_liquidity_usd,
           current_organic_score = excluded.current_organic_score,
           block_age = excluded.block_age,
           block_holders = excluded.block_holders,
           block_top10 = excluded.block_top10,
           block_any = excluded.block_any,
           fetch_error = excluded.fetch_error`,
        [
          mint,
          runAt,
          dex?.ok && dex.pairCreatedAt ? new Date(dex.pairCreatedAt).toISOString() : null,
          ageAtEntryHours,
          holderCount,
          top10Pct,
          dex?.ok ? dex.liquidityUsd : null,
          jup?.ok ? jup.organicScore : null,
          blockAge,
          blockHolders,
          blockTop10,
          blockAny,
          fetchError
        ]
      );

      done++;
      if (done % 10 === 0) {
        console.log(`  ${done}/${rows.length}...`);
      }
    }

    console.log(`\nDone. Summary:\n`);
    // Aggregate against m_trade_log so we tie back to actual P&L outcomes.
    const summary = await client.query(`
      with bt as (
        select * from m_algo2_backtest where run_at = $1
      )
      select
        count(*) as total_trades,
        count(*) filter (where bt.block_any) as would_block,
        count(*) filter (where not coalesce(bt.block_any, false)) as would_keep,
        count(*) filter (where bt.block_age) as block_age_only,
        count(*) filter (where bt.block_holders) as block_holders_only,
        count(*) filter (where bt.block_top10) as block_top10_only,
        count(*) filter (where bt.fetch_error is not null) as fetch_errors,
        round(sum(tl.pnl_usd)::numeric, 2) as algo1_total_pnl_usd,
        round(sum(case when bt.block_any then tl.pnl_usd else 0 end)::numeric, 2) as blocked_pnl_usd,
        round(sum(case when not coalesce(bt.block_any, false) then tl.pnl_usd else 0 end)::numeric, 2) as algo2_implied_pnl_usd
      from m_trade_log tl
      join bt on bt.mint = tl.address
      where tl.pnl_usd is not null
    `, [runAt]);

    console.log(summary.rows[0]);
    console.log("\nPer-block-reason P&L:\n");
    const byReason = await client.query(`
      with bt as (
        select * from m_algo2_backtest where run_at = $1
      )
      select
        case
          when bt.block_age then 'age < 72h'
          when bt.block_holders then 'holders < 500'
          when bt.block_top10 then 'top10 > 35%'
          else 'kept'
        end as outcome,
        count(*) as trades,
        round(sum(tl.pnl_usd)::numeric, 2) as total_pnl_usd,
        round(avg(tl.pnl_usd)::numeric, 2) as avg_pnl_usd
      from m_trade_log tl
      join bt on bt.mint = tl.address
      where tl.pnl_usd is not null
      group by 1
      order by 1
    `, [runAt]);
    console.table(byReason.rows);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
