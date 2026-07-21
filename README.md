# meme-ify

meme-ify is a local-first dashboard for researching Solana memecoins, testing
rules with paper money, and manually approving swaps through Phantom.

The engineering centers on three ideas:

- **Non-custodial by construction.** Every live swap is built as an unsigned
  transaction and handed to the Phantom extension to review and sign; the app
  never sees or stores a private key. Position records come from the confirmed
  transaction's on-chain pre/post token balance deltas, so the books reflect
  the actual fill, not the quoted one.
- **Layered pre-buy safety gates.** Before a live buy can proceed, the app
  blocks on excessive buy-side price impact, simulates the exit (a failed or
  high-impact sell quote blocks the buy, the primary honeypot guard), blocks
  on RugCheck danger levels, authority, and liquidity-lock risks, cross-checks
  Jupiter's independent audit, and flags wash-trading and bot-ratio patterns.
- **Deterministic accounting.** The paper and live position math in
  `src/lib/paper.ts` and `src/lib/live.ts` is network-free and covered by
  unit tests that run without touching a wallet, a database, or any API.

It combines market discovery, liquidity and holder-risk signals, paper-trading
accounting, a review queue, and alerts. It is an experimental research tool,
not a trading service.

> **Risk warning:** memecoins are exceptionally volatile and frequently
> manipulated. Safety checks can fail, RPC and pricing data can be stale, and
> sampled stop-loss logic cannot guarantee an exit price. This project is not
> financial advice. Start in paper mode. If you test live swaps, use a separate
> wallet with an amount you can afford to lose.

## Highlights

- Aggregates new and trending Solana pools from multiple public feeds.
- Scores liquidity, activity, holder distribution, momentum, and exit risk.
- Runs deterministic paper-trading rules with auditable entry snapshots.
- Simulates sellability and checks RugCheck/Jupiter data before live buys.
- Keeps signing inside Phantom; the app never receives a private key.
- Uses Postgres for durable state and supports optional background scan/watch jobs.
- Includes an optional, disabled-by-default local Claude CLI risk review.

## Requirements

- Node.js 20.19 or newer
- npm 10 or newer
- PostgreSQL 14 or newer for normal operation
- Phantom only if you choose to inspect or manually approve live swaps

## Local setup checklist

### 1. Clone and install

```bash
git clone https://github.com/eatusc/meme-ify-public.git
cd meme-ify-public
npm ci
```

### 2. Create a Postgres database

If PostgreSQL is installed locally:

```bash
createdb meme_ify
```

Alternatively, start an isolated Postgres container:

```bash
docker run --name meme-ify-postgres \
  -e POSTGRES_PASSWORD=memeify \
  -e POSTGRES_DB=meme_ify \
  -p 127.0.0.1:5432:5432 \
  -d postgres:16
```

The container option uses this connection URL:

```text
postgresql://postgres:memeify@127.0.0.1:5432/meme_ify
```

### 3. Create local configuration

```bash
cp .env.example .env.local
```

Open `.env.local` and set `DATABASE_URL` to your database. For a default local
Postgres installation, the example value may work unchanged. For the Docker
command above, use the container connection URL shown above.

All API keys are optional. Leave unused values blank. Never commit
`.env.local`.

### 4. Verify the installation

```bash
npm run check
```

This runs strict TypeScript checks, the deterministic accounting tests, and a
production build. It does not contact a wallet, submit a trade, or exercise
paid API accounts.

### 5. Start the local app

```bash
npm run dev
```

Open <http://127.0.0.1:5176>. The database schema in `db/schema.sql` is applied
idempotently when the local server starts. Missing optional integrations are
reported in the Integrations panel and do not prevent the basic market scanner
or paper-trading UI from loading.

The server is intentionally bound to loopback and rejects non-loopback Host
headers. Do not change it to `0.0.0.0`, place it behind a public tunnel, or
deploy it as a public multi-user service. Its local API can write trading state
and proxy requests through credentials in `.env.local`.

## Optional features and what they require

| Feature | Requirement |
| --- | --- |
| Durable positions, settings, alerts, and scan history | `DATABASE_URL` |
| Social-chatter search | At least one of `BRAVE_API_KEY`, `TAVILY_API_KEY`, or `SERPER_API_KEY` |
| Rotation context | `COINGECKO_API_KEY` |
| More reliable wallet and confirmation reads | A dedicated `SOLANA_RPC_URL` |
| Helius integration status (planned smart-money webhooks, optional RPC upgrade) | `HELIUS_API_KEY` |
| Live swaps | Phantom browser extension and a funded experimental wallet |
| Local AI risk review | Claude CLI installed and authenticated, plus `ENABLE_LOCAL_CLAUDE=true` |
| Background position watch | `SERVER_SCHEDULER_WATCH=true` |
| Background new-coin scans | `SERVER_SCHEDULER_SCAN=true` |

Background schedulers and the Claude bridge are intentionally disabled by
default. Review [.env.example](.env.example) and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before enabling them.

## Before trying live mode

1. Run in paper mode first and confirm persistence survives a restart.
2. Install Phantom and create a separate low-balance experimental wallet.
3. Confirm the page origin is exactly `http://127.0.0.1:5176`.
4. Review the mint, input amount, expected output, route, slippage, and price
   impact in every Phantom approval.
5. Assume any token can become unsellable and any stop loss can fill far below
   its configured threshold.

The automated test suite does not connect to Phantom, submit mainnet
transactions, spend paid-provider quota, or test a user-supplied Postgres
instance. Those boundaries must be validated by each user with their own
accounts and deliberately small test amounts.

## Publishing the source versus hosting the app

Publishing this repository's source code is supported. Hosting the running app
as a public website is not.

The local server has no user-account authorization layer and can write trading
state or proxy requests through credentials in `.env.local`. Keep it bound to
`127.0.0.1`. Do not change it to `0.0.0.0`, expose it through a public tunnel,
or deploy it as a shared multi-user service without designing a separate,
authenticated backend.

## Commands

```bash
npm run dev        # local development server plus API middleware
npm run build      # type-check and create the frontend build
npm run preview    # serve the build with the same loopback-only API middleware
npm test           # deterministic trading/accounting unit tests
npm run lint       # strict TypeScript plus unused-code checks
npm run check      # lint, tests, and production build
```

## Architecture and security

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for data flow, the live-trading
boundary, persistence, and known limitations. See [SECURITY.md](SECURITY.md)
before enabling live swaps, background jobs, or the Claude bridge.

The longer research notes behind the current filters are in
[docs/RESEARCH.md](docs/RESEARCH.md). Treat them as design context, not as
validated investment claims.

## Incidents and lessons

One real-money incident is documented in the code rather than hidden.

On 2026-05-23, a live swap confirmed on-chain but its position record was
lost. The cause: immediately after a swap confirms, the RPC node knows the
signature but has not yet indexed the transaction meta (token balances, fee).
A single immediate `getTransaction` call returned success with an empty meta,
which the code misclassified as "transaction could not be read" and abandoned
the position record. The wallet held the tokens; the books did not.

The fix, in `src/lib/wallet.ts` (`getTransactionWithRetry`):

- Retry with backoff (1s, 2s, 3s, 5s, 8s) until the meta is present; the
  typical wait is 1 to 3 seconds.
- Deduplicate in-flight reads so multiple balance-delta reads of the same
  signature share one retry chain instead of each paying the full budget.
- Cache only successful reads, with a short TTL sized to the confirm path.

The lost position was reconstructed from on-chain data with
[scripts/recover_live_position.mjs](scripts/recover_live_position.mjs), which
reads the confirmed transaction's actual fill and re-inserts the position row
idempotently. The lesson generalizes: treat "confirmed" and "readable" as
separate states, and never let a read failure discard a record of money that
already moved.

## Project status

This is experimental single-user software. The paper and live accounting
paths have unit coverage, but external data providers and wallets can change
independently. Review every transaction in Phantom and verify the mint, amount,
route, and price impact before approving it.

## License

MIT. See [LICENSE](LICENSE).
