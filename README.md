# meme-ify

meme-ify is a local-first dashboard for researching Solana memecoins, testing
rules with paper money, and manually approving swaps through Phantom.

It combines market discovery, liquidity and holder-risk signals, paper-trading
accounting, a review queue, alerts, and an explicit non-custodial live-trading
boundary. It is an experimental research tool, not a trading service.

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
- Supports optional Postgres persistence and background scan/watch jobs.
- Includes an optional, disabled-by-default local Claude CLI risk review.

## Requirements

- Node.js 20.19 or newer
- npm 10 or newer
- PostgreSQL 14 or newer for durable state
- Phantom only if you choose to inspect or manually approve live swaps

## Quick start

```bash
git clone <your-repository-url>
cd meme-ify-public
npm ci
cp .env.example .env.local
createdb meme_ify
npm run dev
```

Open <http://127.0.0.1:5176>. The database schema in `db/schema.sql` is applied
idempotently when the local server starts.

The server is intentionally bound to loopback and rejects non-loopback Host
headers. Do not change it to `0.0.0.0`, place it behind a public tunnel, or
deploy it as a public multi-user service. Its local API can write trading state
and proxy requests through credentials in `.env.local`.

## Configuration

`DATABASE_URL` is the only setting needed for durable state. Public market
feeds work without search-provider keys, while Brave, Tavily, Serper,
CoinGecko, Helius, and a dedicated Solana RPC improve coverage or reliability.

Copy `.env.example` to `.env.local` and fill only the integrations you want.
Never commit `.env.local`. Background schedulers and the local Claude bridge
are disabled by default.

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

## Project status

This is experimental single-user software. The paper and live accounting
paths have unit coverage, but external data providers and wallets can change
independently. Review every transaction in Phantom and verify the mint, amount,
route, and price impact before approving it.

## License

MIT. See [LICENSE](LICENSE).
