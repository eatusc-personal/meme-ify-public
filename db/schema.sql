-- Meme Coin sub-project schema (Phase 1). See docs/ARCHITECTURE.md.
--
-- Applied automatically on dev-server startup by memecoinDbPlugin in
-- vite.config.ts. Every statement is idempotent (IF NOT EXISTS), so running it
-- repeatedly is safe.
--
-- Phase 2 will add the main dashboard tables (social_accounts, communities,
-- opportunities, ...) to this same database.

-- Singleton row: paper account balance + the auto-trade rule settings.
create table if not exists m_paper_account (
  id                 int primary key default 1,
  starting_cash      double precision not null,
  cash               double precision not null,
  auto_trade         boolean not null,
  trade_size_usd     double precision not null,
  max_open_positions int not null,
  min_exit_score     double precision not null,
  min_liquidity_usd  double precision not null,
  take_profit_pct    double precision not null,
  stop_loss_pct      double precision not null,
  max_hold_hours     double precision not null,
  min_age_hours      double precision not null default 24,
  auto_run           boolean not null default false,
  watch_on           boolean not null default false,
  queue_mode             boolean not null default false,
  trade_queue            jsonb not null default '[]'::jsonb,
  fee_pct                double precision not null default 1,
  reentry_cooldown_hours double precision not null default 6,
  daily_loss_limit_pct   double precision not null default 20,
  trading_mode           text not null default 'paper',
  updated_at             timestamptz not null default now(),
  constraint m_paper_account_singleton check (id = 1)
);
-- Add later-added columns to an already-existing m_paper_account table.
alter table m_paper_account add column if not exists auto_run boolean not null default false;
alter table m_paper_account add column if not exists watch_on boolean not null default false;
-- min_age_hours: the min-age buy gate (see MEMECOIN_RESEARCH.md). Existing
-- rows default to 24h.
alter table m_paper_account add column if not exists min_age_hours double precision not null default 24;
-- queue_mode / trade_queue: the Trade queue toggle and its pending intents.
-- Postgres-backed (like auto_run / watch_on) so the queue and its mode survive
-- a cleared browser cache, a different origin, or a private window. Previously
-- localStorage-only, which is why an ON toggle could silently revert.
alter table m_paper_account add column if not exists queue_mode boolean not null default false;
alter table m_paper_account add column if not exists trade_queue jsonb not null default '[]'::jsonb;
-- fee_pct: the estimated fee-per-fill % shown in the trade-stats block. A
-- display setting, Postgres-backed so it survives a cleared browser cache.
alter table m_paper_account add column if not exists fee_pct double precision not null default 1;
-- reentry_cooldown_hours / daily_loss_limit_pct: the re-entry cooldown and the
-- daily-loss circuit breaker (see paper.ts). Editable trading rules.
alter table m_paper_account add column if not exists reentry_cooldown_hours double precision not null default 6;
alter table m_paper_account add column if not exists daily_loss_limit_pct double precision not null default 20;
-- trading_mode: 'paper' or 'real'. The top-level Paper/Real switch on the
-- Meme Coin tab. 'paper' (the default) keeps every existing safety guarantee.
alter table m_paper_account add column if not exists trading_mode text not null default 'paper';
-- max_top_holders_pct: holder concentration gate at the safety stage. A buy is
-- blocked if Jupiter's audit.topHoldersPercentage is above this. Default 35
-- matches the consensus "back away above 30 to 40%" memecoin filter.
alter table m_paper_account add column if not exists max_top_holders_pct double precision not null default 35;
-- trailing_stop_pct / trailing_activation_pct: a trailing stop that activates
-- only once the position has been up at least `trailing_activation_pct` from
-- entry, then proposes a sell if price falls `trailing_stop_pct` from the
-- peak ever reached. 0 disables. Locks in gains on runners that retrace.
alter table m_paper_account add column if not exists trailing_stop_pct double precision not null default 35;
alter table m_paper_account add column if not exists trailing_activation_pct double precision not null default 25;
-- live_daily_loss_limit_usd: real-money daily-loss circuit breaker, in USD.
-- The paper breaker is "% of starting cash"; live has no starting-cash baseline
-- so we use a fixed dollar amount. 0 disables. Pauses live buys when the day's
-- realized live P&L is at or below the negative of this.
alter table m_paper_account add column if not exists live_daily_loss_limit_usd double precision not null default 0;

-- One row per paper position, open and closed.
create table if not exists m_paper_positions (
  id                   text primary key,
  address              text not null,
  symbol               text not null,
  name                 text not null,
  status               text not null check (status in ('open', 'closed')),
  entry_at             timestamptz not null,
  entry_price_usd      double precision not null,
  cost_usd             double precision not null,
  token_amount         double precision not null,
  entry_exit_score     double precision not null,
  alerted_spike        boolean not null default false,
  took_half_profit     boolean not null default false,
  partial_proceeds_usd double precision,
  partial_realized_usd double precision,
  danger_alerted       boolean not null default false,
  last_price_usd       double precision,
  last_liquidity_usd   double precision,
  exit_at              timestamptz,
  exit_price_usd       double precision,
  exit_reason          text,
  proceeds_usd         double precision,
  pnl_usd              double precision,
  rearm_price          double precision,
  rearm_dir            text,
  partials             jsonb not null default '[]'::jsonb
);
create index if not exists m_paper_positions_status_idx on m_paper_positions (status);
create index if not exists m_paper_positions_exit_at_idx on m_paper_positions (exit_at desc);
-- rearm_price / rearm_dir: a user-set re-arm level from the Trade queue.
alter table m_paper_positions add column if not exists rearm_price double precision;
alter table m_paper_positions add column if not exists rearm_dir text;
-- partials: timestamped partial-sell events ({at, realizedUsd}), so realized
-- P&L from scale-outs / partial sells can be date-filtered (daily-loss limit).
alter table m_paper_positions add column if not exists partials jsonb not null default '[]'::jsonb;
-- peak_price_usd: highest USD price ever observed on this open position. Used
-- by the trailing stop in sellIntentFor: once gain is above the activation
-- threshold, propose a sell if price falls trailing_stop_pct from the peak.
alter table m_paper_positions add column if not exists peak_price_usd double precision;
-- Entry-time feature snapshot. Captured once when the position opens
-- (see openPosition() in paper.ts). Copied to m_trade_log on close so the
-- append-only log carries the feature vector for retrospective analysis.
-- Every column is nullable; existing positions opened before this shipped
-- read as NULL and analysis queries filter on NOT NULL.
alter table m_paper_positions add column if not exists entry_liquidity_usd double precision;
alter table m_paper_positions add column if not exists entry_volume_24h double precision;
alter table m_paper_positions add column if not exists entry_market_cap double precision;
alter table m_paper_positions add column if not exists entry_age_hours double precision;
alter table m_paper_positions add column if not exists entry_price_change_24h double precision;
alter table m_paper_positions add column if not exists entry_buys_24h int;
alter table m_paper_positions add column if not exists entry_sells_24h int;
alter table m_paper_positions add column if not exists entry_buy_ratio double precision;
alter table m_paper_positions add column if not exists entry_top10_holders_pct double precision;
alter table m_paper_positions add column if not exists entry_bot_ratio double precision;
alter table m_paper_positions add column if not exists entry_holder_count int;
alter table m_paper_positions add column if not exists entry_organic_label text;
alter table m_paper_positions add column if not exists entry_rating double precision;
alter table m_paper_positions add column if not exists entry_rating_band text;
alter table m_paper_positions add column if not exists entry_verdict text;
alter table m_paper_positions add column if not exists entry_sources jsonb;
alter table m_paper_positions add column if not exists entry_risk_flags jsonb;
alter table m_paper_positions add column if not exists entry_socials_count int;
alter table m_paper_positions add column if not exists entry_jupiter_enriched_at timestamptz;
alter table m_paper_positions add column if not exists entry_settings_snapshot jsonb;

-- Dismissed buy intents. When the user dismisses a buy proposal from the
-- Trade queue, the address and the metric snapshot at dismiss time go here.
-- decideBuyIntents and decideLiveBuyIntents skip an address with a row here
-- unless the rating has climbed by the user-set improvement threshold AND
-- the cooldown has passed (anti-flap floor). Cleared automatically when the
-- user later approves a buy on the same address (a change of mind clears
-- the block). Global per address, not per account: the underlying coin is
-- the same so the user's judgment applies to both paper and live.
create table if not exists m_dismissed_buy_intents (
  address                     text primary key,
  symbol                      text,
  name                        text,
  account                     text,
  dismissed_at                timestamptz not null default now(),
  dismissed_rating            double precision,
  dismissed_exit_score        double precision,
  dismissed_liquidity_usd     double precision
);
create index if not exists m_dismissed_buy_intents_at_idx on m_dismissed_buy_intents (dismissed_at desc);

-- One row per watch alert. Kept until the user dismisses it.
create table if not exists m_paper_alerts (
  id           text primary key,
  at           timestamptz not null,
  kind         text not null,
  text         text not null,
  scroll_to_id text
);
create index if not exists m_paper_alerts_at_idx on m_paper_alerts (at desc);
-- scroll_to_id: the click-to-jump DOM target on a clickable toast (e.g. the
-- Trade queue). Added later; null for ordinary alerts.
alter table m_paper_alerts add column if not exists scroll_to_id text;

-- Persistent per-coin new-coin-alert ledger (added 2026-07-06). The scan
-- scheduler re-alerts a coin ONLY when it materially improves since the last
-- time we showed it: a rating jump (>= NEWCOIN_REALERT_RATING_POINTS) OR a
-- significant, notable mcap move (>= NEWCOIN_REALERT_MOVE_PCT). Before this,
-- suppression was a 6h window over m_paper_alerts, so (a) any coin re-alerted
-- every ~6h just for rotating back into the candidate feed, and (b) purging the
-- alerts log deleted the very rows the dedup read from, resurrecting suppressed
-- coins on the next tick. This ledger is independent of m_paper_alerts, so the
-- user dismissing/purging alerts never resurrects a coin. One row per address;
-- the snapshot is the state at the last emitted alert (the improvement baseline).
create table if not exists m_newcoin_ledger (
  address          text primary key,
  last_alerted_at  timestamptz not null default now(),
  last_rating      double precision,
  last_mcap        double precision
);
create index if not exists m_newcoin_ledger_at_idx on m_newcoin_ledger (last_alerted_at desc);

-- Pump-trigger research log: coins that ran up 50%+, each with one captured
-- social-media scan. A rolling list (newest first, capped in the client),
-- replaced wholesale on each save, like m_paper_alerts.
create table if not exists m_pump_events (
  id            text primary key,
  address       text not null,
  symbol        text not null,
  name          text not null,
  detected_at   timestamptz not null,
  trigger       text not null,
  run_up_pct    double precision not null,
  chatter       jsonb,
  chatter_error text
);
create index if not exists m_pump_events_detected_at_idx on m_pump_events (detected_at desc);

-- Last-known price and liquidity per token address.
create table if not exists m_price_snapshots (
  address       text primary key,
  price_usd     double precision not null,
  liquidity_usd double precision not null,
  volume24h     double precision,
  updated_at    timestamptz not null default now()
);

-- Singleton row: the last scan result, stored as a JSONB blob (a transient
-- UI cache, not a queried entity, so a blob is the right shape here).
create table if not exists m_scan_cache (
  id         int primary key default 1,
  data       jsonb not null,
  scanned_at timestamptz not null,
  constraint m_scan_cache_singleton check (id = 1)
);

-- Permanent, append-only record of every closed paper trade, for long-term
-- reporting and analysis. A row is inserted once, when a trade first appears
-- closed, and is never updated or deleted. "Reset paper account" clears the
-- live tables (m_paper_account, m_paper_positions, ...) but NEVER touches this one,
-- so trade history accumulates across resets and stays queryable indefinitely.
create table if not exists m_trade_log (
  id                   text primary key,
  address              text not null,
  symbol               text not null,
  name                 text not null,
  entry_at             timestamptz not null,
  exit_at              timestamptz,
  entry_price_usd      double precision not null,
  exit_price_usd       double precision,
  cost_usd             double precision not null,
  proceeds_usd         double precision,
  pnl_usd              double precision,
  entry_exit_score     double precision,
  exit_reason          text,
  took_half_profit     boolean,
  partial_realized_usd double precision,
  logged_at            timestamptz not null default now()
);
create index if not exists m_trade_log_symbol_idx on m_trade_log (symbol);
create index if not exists m_trade_log_exit_at_idx on m_trade_log (exit_at desc);
create index if not exists m_trade_log_reason_idx on m_trade_log (exit_reason);
-- Entry-time feature snapshot mirrored from m_paper_positions, written on close.
-- Once-written, never updated (the row uses ON CONFLICT DO NOTHING). Old rows
-- inserted before this shipped stay NULL.
alter table m_trade_log add column if not exists entry_liquidity_usd double precision;
alter table m_trade_log add column if not exists entry_volume_24h double precision;
alter table m_trade_log add column if not exists entry_market_cap double precision;
alter table m_trade_log add column if not exists entry_age_hours double precision;
alter table m_trade_log add column if not exists entry_price_change_24h double precision;
alter table m_trade_log add column if not exists entry_buys_24h int;
alter table m_trade_log add column if not exists entry_sells_24h int;
alter table m_trade_log add column if not exists entry_buy_ratio double precision;
alter table m_trade_log add column if not exists entry_top10_holders_pct double precision;
alter table m_trade_log add column if not exists entry_bot_ratio double precision;
alter table m_trade_log add column if not exists entry_holder_count int;
alter table m_trade_log add column if not exists entry_organic_label text;
alter table m_trade_log add column if not exists entry_rating double precision;
alter table m_trade_log add column if not exists entry_rating_band text;
alter table m_trade_log add column if not exists entry_verdict text;
alter table m_trade_log add column if not exists entry_sources jsonb;
alter table m_trade_log add column if not exists entry_risk_flags jsonb;
alter table m_trade_log add column if not exists entry_socials_count int;
alter table m_trade_log add column if not exists entry_jupiter_enriched_at timestamptz;
alter table m_trade_log add column if not exists entry_settings_snapshot jsonb;

-- Live trading (Phase B v2). Real positions on Solana mainnet, opened by the
-- user clicking Sign in Phantom. The agent never executes; this is just a
-- ledger of the swap transactions the user signed. See docs/ARCHITECTURE.md
-- "Live trading".
create table if not exists m_live_positions (
  id                    text primary key,
  mint                  text not null,
  symbol                text not null,
  name                  text not null,
  status                text not null check (status in ('open', 'closed')),
  base_mint             text not null,
  entry_at              timestamptz not null,
  entry_signature       text not null,
  entry_base_amount     double precision not null,
  entry_token_amount    double precision not null,
  entry_price_usd       double precision not null,
  slippage_bps          int not null,
  buy_price_impact_pct  double precision,
  route_summary         text,
  alerted_spike         boolean not null default false,
  took_half_profit      boolean not null default false,
  partial_proceeds_base double precision,
  partial_realized_base double precision,
  danger_alerted        boolean not null default false,
  last_price_usd        double precision,
  last_liquidity_usd    double precision,
  exit_at               timestamptz,
  exit_signature        text,
  exit_price_usd        double precision,
  exit_base_amount      double precision,
  exit_reason           text,
  pnl_base              double precision,
  pnl_usd               double precision
);
create index if not exists m_live_positions_status_idx on m_live_positions (status);
create index if not exists m_live_positions_exit_at_idx on m_live_positions (exit_at desc);
create index if not exists m_live_positions_mint_idx on m_live_positions (mint);
-- peak_price_usd: highest USD price observed on the live position since open.
-- Drives the trailing-stop rule the same way as on m_paper_positions.
alter table m_live_positions add column if not exists peak_price_usd double precision;
-- Entry-time feature snapshot, mirrors m_paper_positions. Captured once when
-- openLivePosition is called (the snapshot is derived from the MemeToken at
-- the moment we book the confirmed swap). Copied to m_live_trade_log on close.
alter table m_live_positions add column if not exists entry_liquidity_usd double precision;
alter table m_live_positions add column if not exists entry_volume_24h double precision;
alter table m_live_positions add column if not exists entry_market_cap double precision;
alter table m_live_positions add column if not exists entry_age_hours double precision;
alter table m_live_positions add column if not exists entry_price_change_24h double precision;
alter table m_live_positions add column if not exists entry_buys_24h int;
alter table m_live_positions add column if not exists entry_sells_24h int;
alter table m_live_positions add column if not exists entry_buy_ratio double precision;
alter table m_live_positions add column if not exists entry_top10_holders_pct double precision;
alter table m_live_positions add column if not exists entry_bot_ratio double precision;
alter table m_live_positions add column if not exists entry_holder_count int;
alter table m_live_positions add column if not exists entry_organic_label text;
alter table m_live_positions add column if not exists entry_rating double precision;
alter table m_live_positions add column if not exists entry_rating_band text;
alter table m_live_positions add column if not exists entry_verdict text;
alter table m_live_positions add column if not exists entry_exit_score double precision;
alter table m_live_positions add column if not exists entry_sources jsonb;
alter table m_live_positions add column if not exists entry_risk_flags jsonb;
alter table m_live_positions add column if not exists entry_socials_count int;
alter table m_live_positions add column if not exists entry_jupiter_enriched_at timestamptz;
alter table m_live_positions add column if not exists entry_settings_snapshot jsonb;

-- Append-only permanent log of every closed live trade. Same contract as
-- m_trade_log: insert once on close, never updated or deleted. Survives
-- everything except an explicit drop.
create table if not exists m_live_trade_log (
  id                    text primary key,
  mint                  text not null,
  symbol                text not null,
  name                  text not null,
  base_mint             text not null,
  entry_at              timestamptz not null,
  exit_at               timestamptz,
  entry_signature       text not null,
  exit_signature        text,
  entry_base_amount     double precision not null,
  entry_token_amount    double precision not null,
  entry_price_usd       double precision not null,
  exit_price_usd        double precision,
  exit_base_amount      double precision,
  pnl_base              double precision,
  pnl_usd               double precision,
  exit_reason           text,
  slippage_bps          int not null,
  buy_price_impact_pct  double precision,
  logged_at             timestamptz not null default now()
);
create index if not exists m_live_trade_log_symbol_idx on m_live_trade_log (symbol);
create index if not exists m_live_trade_log_exit_at_idx on m_live_trade_log (exit_at desc);
-- Entry-time feature snapshot mirrored from m_live_positions, written on close.
-- ON CONFLICT DO NOTHING preserves rows logged before this shipped as-is.
alter table m_live_trade_log add column if not exists entry_liquidity_usd double precision;
alter table m_live_trade_log add column if not exists entry_volume_24h double precision;
alter table m_live_trade_log add column if not exists entry_market_cap double precision;
alter table m_live_trade_log add column if not exists entry_age_hours double precision;
alter table m_live_trade_log add column if not exists entry_price_change_24h double precision;
alter table m_live_trade_log add column if not exists entry_buys_24h int;
alter table m_live_trade_log add column if not exists entry_sells_24h int;
alter table m_live_trade_log add column if not exists entry_buy_ratio double precision;
alter table m_live_trade_log add column if not exists entry_top10_holders_pct double precision;
alter table m_live_trade_log add column if not exists entry_bot_ratio double precision;
alter table m_live_trade_log add column if not exists entry_holder_count int;
alter table m_live_trade_log add column if not exists entry_organic_label text;
alter table m_live_trade_log add column if not exists entry_rating double precision;
alter table m_live_trade_log add column if not exists entry_rating_band text;
alter table m_live_trade_log add column if not exists entry_verdict text;
alter table m_live_trade_log add column if not exists entry_exit_score double precision;
alter table m_live_trade_log add column if not exists entry_sources jsonb;
alter table m_live_trade_log add column if not exists entry_risk_flags jsonb;
alter table m_live_trade_log add column if not exists entry_socials_count int;
alter table m_live_trade_log add column if not exists entry_jupiter_enriched_at timestamptz;
alter table m_live_trade_log add column if not exists entry_settings_snapshot jsonb;

-- ---------------------------------------------------------------------------
-- Algorithm-version tagging (added 2026-05-23).
--
-- "algo1" = all trades / dismissals produced before the holder-concentration
-- research and the auto-dismiss-on-safety-block change. "algo2" = everything
-- written from 2026-05-23 forward, with these gates active:
--   - minAgeHours = 72 (was 24)
--   - minHolderCount = 500 (new)
--   - Jupiter enrichment widened to top-40 (was top-20)
--   - Auto-dismiss on RugCheck safety-block
--   - 6h safety-verdict cache
-- The column default is set to 'algo2' so any new write that doesn't pass
-- the value explicitly still lands in the right partition. Existing rows
-- have been backfilled to 'algo1' via the migration that ran on 2026-05-23.
-- A fresh database from this schema starts with 'algo2' as the default;
-- a later algorithm change should bump the default to 'algo3' and so on.
-- ---------------------------------------------------------------------------
alter table m_paper_positions add column if not exists algo_version text not null default 'algo2';
alter table m_trade_log add column if not exists algo_version text not null default 'algo2';
alter table m_live_positions add column if not exists algo_version text not null default 'algo2';
alter table m_live_trade_log add column if not exists algo_version text not null default 'algo2';
alter table m_dismissed_buy_intents add column if not exists algo_version text not null default 'algo2';

create index if not exists m_paper_positions_algo_idx on m_paper_positions (algo_version);
create index if not exists m_trade_log_algo_idx on m_trade_log (algo_version);
create index if not exists m_live_trade_log_algo_idx on m_live_trade_log (algo_version);

-- DismissedBuyIntent gained source/reason fields when auto-dismiss-on-safety-block
-- shipped. Source: 'manual' (user clicked Dismiss) or 'auto-safety-block'.
-- Reason: the first safety reason when auto-dismissed.
alter table m_dismissed_buy_intents add column if not exists source text;
alter table m_dismissed_buy_intents add column if not exists reason text;

-- min_holder_count: algo2 holder floor (added 2026-05-23). Existing rows
-- backfill to the algo2 default of 500; the persist code always writes an
-- explicit value going forward so the default only catches mistakes.
alter table m_paper_account add column if not exists min_holder_count int not null default 500;

-- buy_dismissal_improvement_points: the rating-point threshold a dismissed
-- coin must climb above its dismissed value before the cycle re-proposes
-- it. Was previously unpersisted, which meant the in-memory value zeroed
-- out to undefined on every page reload, silently disabling the dismissal
-- gate (the comparison `rating < dismissedRating + undefined` is NaN-false,
-- so blocked coins came back). Persisting it closes that hole; the
-- defensive guard in buyDismissalBlocks (paper.ts) treats undefined as
-- the default 10 in case persistence ever breaks again. Default 10 matches
-- the in-memory PaperSettings default.
alter table m_paper_account add column if not exists buy_dismissal_improvement_points
  double precision not null default 10;

-- ---------------------------------------------------------------------------
-- User-preference columns (added 2026-05-24, "no-localStorage-for-settings"
-- migration). Everything below was previously per-browser localStorage; moving
-- to Postgres so user prefs follow the account across browsers / machines /
-- a future Supabase migration. The pre-hydration localStorage cache for
-- BULK trade data (paper, live, alerts, prices, scan) stays — that's a
-- transient performance helper for fast first paint, not a setting.
--
-- sort_by / sort_dir: scan list sort key + direction.
-- hide_view: which of the Visible / Hidden tabs is active on the scan list.
-- hidden_mints: jsonb array of mint addresses the user has hidden from the
--   scan. Was the per-browser hidden list (memeify-memecoin-hidden-v1).
-- closed_expanded: closed-trades panel collapse state.
-- collapsed_sections: jsonb array of section ids the user has collapsed.
--   Was the per-browser memeify-memecoin-collapsed-sections-v1 map.
-- ---------------------------------------------------------------------------
alter table m_paper_account add column if not exists sort_by
  text not null default 'rating';
alter table m_paper_account add column if not exists sort_dir
  text not null default 'desc';
alter table m_paper_account add column if not exists hide_view
  text not null default 'visible';
alter table m_paper_account add column if not exists hidden_mints
  jsonb not null default '[]'::jsonb;
alter table m_paper_account add column if not exists closed_expanded
  boolean not null default false;
alter table m_paper_account add column if not exists collapsed_sections
  jsonb not null default '[]'::jsonb;

-- Algo-version DB defaults changed from 'algo2' to 'unknown' (2026-05-23).
-- Rationale: a default of 'algo2' silently mislabeled any insert that
-- bypassed the app's explicit value (which happened twice — once during the
-- algo1→algo2 migration window, once when settings hydration hadn't resolved
-- before a buy). 'unknown' is informative; you catch the first missed-write
-- by greping the column. App code now derives the label from the snapshot
-- via deriveAlgoVersion() (see src/lib/paper.ts), so the default should be
-- a guardrail that fires on bugs rather than a silent re-label.
alter table m_paper_positions       alter column algo_version set default 'unknown';
alter table m_trade_log             alter column algo_version set default 'unknown';
alter table m_live_positions        alter column algo_version set default 'unknown';
alter table m_live_trade_log        alter column algo_version set default 'unknown';
alter table m_dismissed_buy_intents alter column algo_version set default 'unknown';

-- ---------------------------------------------------------------------------
-- Collapse 'unknown' → 'algo1' (2026-05-23, late).
--
-- The 'unknown' guardrail default never fired in practice — every code path
-- that opens a position or records a dismissal goes through deriveAlgoVersion
-- in src/lib/paper.ts, which only returns 'algo1' / 'algo2' / 'custom'. The
-- guardrail was defensive coding for a class of bug that didn't materialize.
-- It also confused stats consumers ("what is unknown?"), since logically a
-- row is either algo1 (pre-2026-05-23, no holder gate) or algo2 (post, with
-- the gate). 'custom' = algo2 with the user's settings tweaked off-reference.
--
-- Action: any row still tagged 'unknown' is converted to 'algo1' (the safe
-- assumption — it was written by code that didn't set the field, meaning the
-- holder gate did not apply, meaning algo1 is honest). The DB default is
-- flipped to 'algo1' too, so any FUTURE bug-write lands in the larger,
-- semantically correct bucket rather than a third UI category. Detection of
-- "code forgot to derive" should come from greping persist-call sites, not
-- from a third-class column value.
-- ---------------------------------------------------------------------------
update m_paper_positions       set algo_version = 'algo1' where algo_version = 'unknown';
update m_trade_log             set algo_version = 'algo1' where algo_version = 'unknown';
update m_live_positions        set algo_version = 'algo1' where algo_version = 'unknown';
update m_live_trade_log        set algo_version = 'algo1' where algo_version = 'unknown';
update m_dismissed_buy_intents set algo_version = 'algo1' where algo_version = 'unknown';

alter table m_paper_positions       alter column algo_version set default 'algo1';
alter table m_trade_log             alter column algo_version set default 'algo1';
alter table m_live_positions        alter column algo_version set default 'algo1';
alter table m_live_trade_log        alter column algo_version set default 'algo1';
alter table m_dismissed_buy_intents alter column algo_version set default 'algo1';

-- ---------------------------------------------------------------------------
-- m_pump_candidates: real-time PumpPortal WebSocket feed of new pump.fun mints.
--
-- Replaces the polled `frontend-api-v3.pump.fun/coins` source (which gates
-- aggressively and routinely returns 403/429 to non-browser clients) with a
-- push stream. The pumpPortalCollectorPlugin holds ONE WebSocket connection
-- per dev-server lifetime (PumpPortal bans IPs that open multiple), parses
-- the `subscribeNewToken` and `subscribeMigration` events, and upserts a row
-- here per mint. The scan reads recent rows as a fifth candidate source.
--
-- Why a separate table (not extending m_scan_cache): m_scan_cache is a transient
-- per-scan blob, written/overwritten in one shot by the browser. PumpPortal
-- writes asynchronously and continuously from the server, and we want the
-- per-mint history (when first seen, when bonding-curve migration happened)
-- to survive any one scan's lifetime.
--
-- Indexed on `seen_at desc` for the "last N minutes" query the scan uses.
-- ---------------------------------------------------------------------------
create table if not exists m_pump_candidates (
  mint            text primary key,
  symbol          text,
  name            text,
  uri             text,
  -- The PumpPortal event types we subscribe to. 'new-token' is a fresh mint
  -- on the bonding curve; 'migration' is graduation to Raydium / Meteora.
  -- 'trade' could be added later if we want size-filtered noise; for now we
  -- only persist mint-lifecycle events.
  source_event    text not null,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  -- Raw event payload kept for debugging and for fields we don't surface
  -- yet (initial buy, creator, market cap at mint). JSONB so future readers
  -- can extract without a schema bump.
  payload         jsonb
);

create index if not exists m_pump_candidates_seen_idx on m_pump_candidates (last_seen_at desc);
create index if not exists m_pump_candidates_event_idx on m_pump_candidates (source_event, last_seen_at desc);

-- ---------------------------------------------------------------------------
-- API usage log (added 2026-05-24). One row per outbound upstream call from
-- a Vite middleware proxy that has a metered budget (Tavily, Serper for
-- now). Used by the in-app rate-limit banner and any future cost-attribution
-- analytics. Append-only; no UPDATE / DELETE in the write path. Index covers
-- the "calls this month per provider" hot query the banner runs every minute.
-- ---------------------------------------------------------------------------
create table if not exists m_api_usage (
  id          bigserial primary key,
  provider    text not null,
  endpoint    text not null,
  status_code int,
  ok          boolean,
  called_at   timestamptz not null default now()
);
create index if not exists m_api_usage_provider_time_idx on m_api_usage (provider, called_at desc);

-- ---------------------------------------------------------------------------
-- Watchlist: user-set price alerts for coins, regardless of whether the
-- coin is currently held. Common use case: "alert me when PTROLL drops
-- back to $0.00005, I want to re-enter." The position-watch tick (every
-- 5 min in App.tsx) extends to fetch prices for every active row here and
-- fires a toast when the target hits. Persists across paper resets and
-- across machines (Postgres, not localStorage), per the
-- no-localStorage-for-settings architecture.
--
-- direction: 'below' means "fire when price <= target_price_usd";
--            'above' means "fire when price >= target_price_usd".
-- triggered_at: NULL while the watch is active; set once the alert fires
--   so the watch becomes a historical record instead of a re-firing loop.
--   The user can re-arm by deleting + re-adding from the UI.
-- ---------------------------------------------------------------------------
create table if not exists m_watchlist (
  id                text primary key,
  mint              text not null,
  symbol            text,
  name              text,
  target_price_usd  double precision not null,
  direction         text not null check (direction in ('below', 'above')),
  note              text,
  created_at        timestamptz not null default now(),
  triggered_at      timestamptz,
  -- The price at trigger time. Useful for analysis ("did the alert fire on
  -- a fleeting wick or a sustained move?") and for the toast text.
  triggered_price   double precision
);

create index if not exists m_watchlist_active_idx on m_watchlist (mint) where triggered_at is null;
create index if not exists m_watchlist_created_idx on m_watchlist (created_at desc);

-- dismissed: PanelAlert.dismissed (added 2026-05-25). When the user clicks
-- "Hide all" on the toast stack OR per-row hide on a single toast, the
-- alert is marked dismissed=true so the floating toast stack hides it but
-- the alerts log panel keeps showing it (visually muted). Previously the
-- field lived only in React state; persistence dropped it silently because
-- the column didn't exist, so refresh brought hidden toasts back as visible.
-- Same four-touch-point bug class documented in docs/ARCHITECTURE.md.
alter table m_paper_alerts add column if not exists dismissed boolean not null default false;

-- ---------------------------------------------------------------------------
-- m_algo2_backtest. One row per (mint, run_at). Written by scripts/backtest_
-- algo2.mjs to compare what algo2's holder/age gates would have done against
-- past trades in m_trade_log. Inlined here (was previously created lazily by
-- the backtest script) so a fresh setup against a hosted Postgres / Supabase
-- has the table available before the script first runs.
-- ---------------------------------------------------------------------------
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
