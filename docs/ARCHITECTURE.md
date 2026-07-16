# Architecture

## Runtime model

meme-ify is a single-user React application with a loopback-only Node process.
Vite serves the frontend and hosts small middleware adapters for Postgres and
external APIs. The same middleware is registered for development and preview,
so `npm run preview` exercises the built frontend against real JSON endpoints.

```text
React dashboard
  -> loopback-only Vite middleware
      -> PostgreSQL
      -> Solana RPC and Jupiter
      -> DexScreener, GeckoTerminal, RugCheck, PumpPortal
      -> optional search providers and local Claude CLI
  -> Phantom extension for explicit transaction approval
```

This is intentionally not a public web-service architecture. There is no
multi-user authentication layer, and the server rejects non-loopback Host
headers.

## Scan and decision flow

The scanner normalizes candidates from several discovery feeds, enriches their
market and holder data, and computes an exit score plus a broader rating. The
paper-trading functions in `src/lib/paper.ts` consume those normalized records
without accessing the network. This separation makes decisions reproducible
and unit-testable.

Queue mode proposes intents for review. Paper approvals update simulated cash
and positions. Live approvals continue through the safety gate and Phantom.

## Live trading boundary

The application never receives a private key. For a live buy or sell it:

1. Requests a current Jupiter quote.
2. Applies price-impact, sellability, RugCheck, and Jupiter audit checks.
3. Requests an unsigned swap transaction.
4. Hands the transaction to Phantom.
5. Records a position only after a confirmed signature and on-chain balance
   deltas are available.

No screen, score, or risk label guarantees that a token is safe or sellable.
The user must review every Phantom approval.

## Storage

PostgreSQL is the durable source of truth when `DATABASE_URL` is configured.
The schema is applied idempotently from `db/schema.sql` on startup. Browser
localStorage is a startup cache and resilience fallback, not a secrets store.

This is a single-user model. Multiple tabs can still race on whole-state writes;
prefer one open dashboard tab when changing trading settings.

## Background jobs

The position watcher and new-coin scanner are disabled by default. They can be
enabled independently with `SERVER_SCHEDULER_WATCH` and
`SERVER_SCHEDULER_SCAN`. Background jobs propose or record alerts; they do not
possess a signing key and cannot approve a Phantom transaction.

## Known limitations

- Stop losses are sampled, not continuously resting on an exchange.
- Upstream schemas, rate limits, and token audits can change without notice.
- A successful quote does not guarantee the same execution price later.
- Database migrations are currently idempotent schema SQL rather than a
  versioned migration framework.
- The frontend remains large and would benefit from component-level splitting
  and lazy loading.
- This project is for local experimentation, not hosted multi-user operation.
