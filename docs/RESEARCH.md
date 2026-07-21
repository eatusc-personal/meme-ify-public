# Meme Coin Discovery, Research Notes

Background research behind the Meme Coin tab.
Compiled 2026-05-20 from web research. Sources listed at the end.

---

## The question

How do people discover new meme coins early, and how often does a launch
actually reach "good volume", meaning enough liquidity and two-sided volume
that a position can be exited?

## How people discover new meme coins

Six channels. Serious traders run several at once. Listed roughly from
highest-edge to highest-trap.

1. **Launchpad-native / direct releases.** pump.fun and rivals (LetsBonk,
   Believe) have a live feed and filters (last hour, bonding-curve progress).
   The real edge here is **sniping**: bots subscribe to the pump.fun program ID
   on Solana via Yellowstone gRPC or raw shreds and detect a new mint in 15 to
   100 ms, before it renders in the human feed. A person watching the website
   is already late. There is also a livestream layer where creators launch and
   stream simultaneously.
2. **On-chain scanners and trading terminals.** DexScreener, DexTools,
   GeckoTerminal, Birdeye for screening (volume spike, age, liquidity, holders).
   Full terminals (Axiom, BullX, Photon, GMGN, Trojan, Padre) fuse discovery
   with one-click execution.
3. **Smart-money wallet tracking / copy trading.** Track wallets with proven
   PnL, get alerted when they buy, sometimes auto-copy. GMGN leads here. Caveat:
   "bundle bots" fake whale activity to bait copy-traders.
4. **Telegram, which is two different things.** (a) Trading bots (BonkBot,
   Trojan, Maestro, Banana Gun) that surface launches and execute. Legit
   infrastructure. (b) Caller / "alpha" groups posting "calls". Mostly paid
   promotion or insiders; the call usually goes out after the callers already
   hold.
5. **Twitter / X and KOLs.** Narratives are born here. A few KOLs set sentiment
   for whole sectors. AI agents now act as KOLs (GOAT, Fartcoin).
6. **Sentiment aggregators.** LunarCrush, pump.news, Outlight measure who is
   talking, real community vs bots.

The tool focuses on channels 1 and 2 for discovery (DexScreener + pump.fun) and
uses 4 and 5 only as a lightweight per-coin chatter check (Serper over x.com,
t.me, reddit.com). It deliberately does not rely on caller groups.

## How often a launch reaches good volume (base rates)

This is the important part, and it is grim.

- **Graduation rate.** April 2026: of ~30,000 tokens launched on pump.fun per
  day, fewer than 1 in 200 graduate the bonding curve, so **under 0.5%**. In
  2025 it was ~1.4% graduating to Raydium, dipping to ~0.7 to 0.8% in mid-2025.
- **Liquidity survival.** Of ~7 million pump.fun-style tokens, only ~97,000
  retained $1,000 or more in liquidity. That is roughly **1.4%**.
- **Volume survival.** Fewer than **5%** of launched meme coins sustain high
  volume beyond the first 72 hours. Most do not survive 60 days.
- **Dead on arrival.** Around **43%** of meme coin projects have zero trading
  volume. Only ~57% of volume comes from genuinely liquid tokens.
- **Cross-DEX graduation.** Fewer than ~2.1% of Solana meme coins graduate from
  launchpads to major DEXs.
- **Fraud scale.** 98.6 to 99% of pump.fun-style launches show rug or
  pump-and-dump patterns. Over $500M was lost to meme coin rugs in 2024 alone.

**Takeaway baked into the tool:** finding a coin is not the hard part. The hard
part is that the overwhelming majority never have an exit. So the screener
ranks on exit liquidity, shows the base rate permanently, and flags thin pools.

## Implications for the tool design

- Rank on liquidity depth first, then two-sided volume. Liquidity is the pool
  you sell into. (Exit Score weights liquidity 42%.)
- Penalize extreme turnover (volume far above liquidity): a wash-trading and
  pre-dump signal, not a health signal.
- Treat caller-group / KOL chatter as a weak secondary signal, not a buy
  reason. The research shows those channels are frequently the manipulation.
- Never present a coin as "safe". Verdicts top out at "exitable", not "good".

---

## Memecoin survival: lifespan, age, and winner patterns

Added 2026-05-21 from a second research pass. This is the data behind the
min-age buy gate (see the decision note below).

### Lifespan: how long the good ones last

- **Average pump.fun token lifespan is ~12 days** (ChainPlay, ~970k tokens via
  Dune; "defunct" = 24h volume falls below 90% of all-time high).
- **~15% are dead within 24 hours, ~31% within a week, only ~2% survive past
  90 days.** Daily churn is roughly 95% (about as many tokens go defunct each
  day as launch).
- **Fewer than 5% sustain high volume past 72 hours.** New launches show
  survival under 8% after 60 days, and most lose over 97% of peak value.
- Of 7M+ pump.fun-style tokens with at least 5 trades, **only ~97k (~1.4%)
  ever held more than $1k of liquidity** (Solidus Labs, Jan 2024 to Mar 2025).
- Practical read: the "good" coins, in the sustained-volume sense, are a tiny
  tail. The genuine multi-month winners (BONK, WIF, POPCAT, Moo Deng) are a
  handful out of millions.

### Age: when they peak

- **Median time-to-graduation is 4.4 minutes** for the ~0.63% that graduate
  (arXiv 2602.14860, 655,770 tokens, Sept to Oct 2025). A typical rug plays out
  in under 5 minutes.
- **92.22% of tokens with 30+ swaps show a detectable dump event.**
- The structure: the first minutes are sniper / bundle territory (adverse
  selection against a manual buyer); the first 24 to 72 hours is where the ~95%
  washout happens; a coin still showing real, non-bot volume past 72 hours has
  already cleared the filter that kills the overwhelming majority. The screening
  edge is using age as a survivorship filter, not trying to catch the peak.

### What drove the winners: press or pumps

- The ~99% are pure mechanical pumps: bundled launch buys, bots running 60 to
  80% of single-token volume, peaking in minutes.
- The rare genuine winners were driven by **external catalysts, not on-chain
  mechanics**: viral real-world memes (Moo Deng), community takeover (Popcat
  climbed after the original dev was removed, roughly $200k to over $230m
  market cap), macro tailwinds, and token-burn events (BONK).
- **A CEX listing marked the top, not a continuation.** Newly listed tokens
  pump ~54% on average then dump ~89% of the time (average 52% drop from peak);
  **37% hit their all-time high on listing day and never recover**; only ~11%
  stay profitable long-term. Binance listings dump ~98% of the time, Bybit ~92%,
  Coinbase is the mildest. CoinGecko's CEX report: only 32% of newly listed
  tokens are positive in the first 30 days, under 10% above issue price at 12
  months. Treat a fresh major-CEX listing as a dump-risk flag.

### Pump-and-dump vs organic: on-chain signals

- ~98.6% of pump.fun tokens and ~93% of Raydium pools show pump-and-dump or
  soft-rug characteristics (Solidus Labs).
- **Strongest graduation predictor** (arXiv 2602.14860): fast liquidity
  accumulation paired with *low* bot participation. Tokens that hit liquidity
  thresholds in fewer trades graduate far more often.
- Rug fingerprints: top-10 holders over 50% (top-5 over 90% is a hard flag),
  bundled same-block launch buys, repeated identical wallet balances (a dev
  hiding holdings across wallets), non-renounced mint or freeze authority, and
  dev-wallet selling (creators are economically incentivized to sell before
  graduation, so any dev selling is an exit signal).
- Raw volume is unreliable because bots are most of it; weight unique buyers
  and holder-distribution shape instead.
- **Fragmented rug pulls** (arXiv 2511.15463): the drain is now spread across
  many small transactions and wallets. Owner-wallet inflated selling appears in
  only ~33% of flagged pools, and ~127,252 wallets were tagged as serial
  scammers. Owner-wallet monitoring alone no longer catches rugs; wallet-cluster
  fingerprinting does.
- Caveat for any "% profitable" stat: CoinGecko's trader-profitability data is
  realized-PnL only, so it understates losses (bagholders who never sold are
  invisible).

## Backtesting the strategy: data sources

The current stack (DexScreener, GeckoTerminal) returns only live snapshots,
zero history, so the exit-score model and trading rules **cannot be backtested
with it as-is**. Two real paths:

**Path 1, forward test (cleanest test of this model).** Build the server-side
scan-history table (Roadmap, "Spot more opportunities"): every scan writes its
coins and exit scores to Postgres. After a few weeks you have a
survivorship-safe record of exactly the coins the scanner surfaced, and can
measure how many scored "exitable" were still alive at +72h and what the
realized exit P&L would have been. Tests the real model, not a proxy.

**Path 2, historical backtest (external corpus).** Survivorship bias is the
trap: any "current token list" excludes the ~95% that died, so the universe
must be enumerated from launch / create events, not from a token list.

- **MemeTrans dataset** (arXiv 2602.13480, GitHub `git-disl/MemeTrans`): 41,470
  launches Dec 2024 to Mar 2025, 122 features, risk-labeled, 84% high-risk
  included. The closest thing to a ready-made labeled corpus. Best start point.
- **Bitquery**: enumerate every pump.fun `create` event (survivorship-safe),
  build OHLCV from raw trades. Free tier is a one-time 10k points, prototype
  only.
- **Dune / Flipside**: SQL over the pump.fun create tables plus DEX trades.
  Flipside's free tier allows programmatic SQL; Dune's free tier is
  manual-execution only.
- **GeckoTerminal OHLCV endpoint**: free, no key, 30 req/min, 6-month max per
  call. Already wired into `src/lib/charts.ts` for the holdings mosaic.
- **Birdeye / Solana Tracker**: faster OHLCV and holder history. Solana Tracker
  free tier is 10k requests/month; Birdeye's free tier is too thin for bulk.

## Decision: min-age buy gate (2026-05-21)

Decision: **add a min-age buy gate.** A new editable `minAgeHours` trading rule
(default 24) makes the paper auto-trade buy pass skip any coin younger than
that. Coins of unknown age are not blocked, consistent with how `scoreExit`
already treats unknown age.

Rationale: the data above shows age plus sustained volume is the single most
discriminating survivability filter. Roughly 95% of launches die in the first
24 to 72 hours; an older coin still showing live volume has already survived
the regime that kills almost everything. Alternatives considered: keep catching
coins as young as possible (rejected, much higher rug exposure); make age both
a min and a max tunable. The rule is editable, so both philosophies can still
be tested against forward-test or backtest data; the default (24h) leans toward
proven survivors. A natural next step is to raise it toward 72h once the
forward test has data.

## Free discovery sources, rate-limit-friendly (added 2026-05-21)

Research into more ways to find memecoins without tapping rate limits. Core
finding: streaming beats polling. A WebSocket subscription has no per-request
limit; polling does, which is why the pump.fun frontend feed keeps gating the
scanner.

### Added to the scanner this session
- Jupiter Tokens API v2, keyless on `lite-api.jup.ag` (60 req/min shared):
  `/tokens/v2/recent` (new tokens by first pool creation across every Solana
  launchpad, wider and more reliable than the gated pump.fun feed) and
  `/tokens/v2/toptrending/{interval}`. `/toporganicscore/{interval}` is a
  bot/wash-filtered quality ranking, an easy future add.

### Worth adding next (keyless REST)
- DexScreener `/metas/trending/v1` (trending narratives), keyless, 60/min.
- DexScreener `/token-profiles/recent-updates/v1` (relistings / community
  takeovers), keyless, 60/min.
- GeckoTerminal `new_pools` alongside the trending feed.

### The real fix: a streaming collector
A server-side background worker subscribed to streams, writing candidates into
the planned research database; user scans then read the cache, instant and
with zero API hit. This pairs with the research-DB / server-side-collector
plan.
- PumpPortal WebSocket `wss://pumpportal.fun/api/data`: free, keyless,
  `subscribeNewToken` + `subscribeMigration`. The direct replacement for the
  gated pump.fun frontend API. One connection only or the IP is banned.
  pump.fun-only coverage.
- DexScreener WebSocket `wss://api.dexscreener.com`: push version of the
  profile / boost feeds.
- Solana `logsSubscribe` on a free Helius RPC: real-time detection of
  non-pump.fun launchpads (LetsBonk, LaunchLab, Moonshot) by program ID.

### Not worth it
Bitquery free tier is a one-time 1,000-point trial. SolanaStreaming free quota
is 100 events. LunarCrush has no real free API. X/Twitter has no free read
tier. Reddit is now throttled to ~10 req/min. Birdeye and Solana Tracker free
tiers are too thin to poll often; use them only as low-frequency confirmation.

## AI agents and LLMs for memecoin work (added 2026-05-21)

What people are actually doing, filtered for substance.

- Autonomous AI trading bots do not work for retail memecoins. 2026 has many
  documented blowups; retail loses the speed race and pays 1 to 5% in priority
  fees just to transact. Human-in-the-loop wins. This project's rule that the
  AI layer never executes a trade is the correct call.
- The "AI agent framework" tokens (ai16z / ElizaOS, Virtuals) are mostly
  token-launch vehicles; ai16z is down ~99.9% and in a class-action alleging
  "a manual system disguised as autonomous technology." The open-source SDKs
  (GOAT SDK, Solana Agent Kit) are real tooling; the tokens are distressed.
- What genuinely works: the LLM as a triage layer over hard on-chain data,
  narrative / meta clustering, rug triage, scoring and explaining a token list
  before a human looks. What does not work: raw social sentiment as a signal,
  a multi-year backtest found paid sentiment feeds reduced predictive accuracy.
- MCP servers are the most relevant piece, since the dashboard runs in a
  Claude Code context: Bitquery MCP (raw Solana DEX data), SolEnrich MCP
  (wallet / whale / rug due-diligence, pay-per-call in cents), SendAI Solana
  MCP (local, open-source). `tony-42069/solana-mcp` is an early-stage
  "Memecoin Observatory" MCP, useful as a reference design.
- Products: GMGN AI (good rug / security scanner, weak copy-trader), Kolscan
  (free KOL / wallet tracking, acquired by pump.fun).
- Realistic local setup: the LLM as a rubric-driven triage / explanation layer
  over the scan output, using the existing `lib/claude.ts`. A research
  assistant, not an autonomous trader. No LLM setup reliably predicts price.

## Sources

- OSL, How Do Traders Discover New Memecoins Early: https://www.osl.com/hk-en/academy/article/how-do-traders-discover-new-memecoins-early
- CoinGecko, How traders find memecoins: https://www.coingecko.com/learn/how-traders-find-memecoins
- CryptoNews, 7 Ways to Find New Meme Coins Early: https://cryptonews.com/cryptocurrency/how-to-find-meme-coins-early/
- Flashift, Pump.fun Strategy 2026: https://flashift.app/blog/how-to-spot-the-next-viral-meme-coin-on-pump-fun-safely/
- Shyft, Stream new pump.fun token launches in real-time: https://shyft.to/blog/how-to-stream-new-token-launches-on-pump-fun-in-real-time
- Trojan, Best Solana Trading Terminal 2026 comparison: https://trojan.com/blog/best-solana-trading-terminal-2026-comparison
- DEXTools, How Smart Money Wallet Tracking Works: https://news.dextools.io/tutorials/how-smart-money-wallet-tracking-works
- CoinDesk, $500M+ lost to memecoin rug pulls in 2024: https://www.coindesk.com/business/2025/02/11/crypto-investors-lost-over-usd500m-in-memecoin-rug-pulls-and-scams-in-2024
- OpenPR / VoluTools, The Pump.fun Graduation Gap (the 1%): https://www.openpr.com/news/4455934/the-pump-fun-graduation-gap-what-the-1-of-solana-tokens-that
- AInvest, Meme Coin Liquidity Crisis, volume collapse: https://www.ainvest.com/news/meme-coin-liquidity-crisis-volume-collapse-price-impact-2603/
- CoinLaw, Memecoin Statistics 2026: https://coinlaw.io/memecoin-statistics/
- Webopedia, 7 Memecoin Scams to Avoid in 2026: https://www.webopedia.com/crypto/learn/memecoin-scams/

Added 2026-05-21 (lifespan / age / winner-pattern and backtesting research):

- ChainPlay, Lifespan of Pump.fun memecoins: https://chainplay.gg/blog/lifespan-pump-fun-memecoins-analysis/
- Solidus Labs, Solana rug pulls and pump-and-dumps report: https://www.soliduslabs.com/reports/solana-rug-pulls-pump-dumps-crypto-compliance
- BestBrokers, The Heat Death of Memecoins: https://www.bestbrokers.com/crypto-brokers/the-heat-death-of-memecoins/
- arXiv 2602.14860, Predicting the success of new crypto-tokens (the Pump.fun case): https://arxiv.org/html/2602.14860v1
- arXiv 2511.15463, How To Cook The Fragmented Rug Pull: https://arxiv.org/pdf/2511.15463
- arXiv 2602.13480 + GitHub git-disl/MemeTrans, labeled memecoin launch dataset: https://arxiv.org/html/2602.13480v1 , https://github.com/git-disl/MemeTrans
- CryptoNinjas, study on CEX listing effects: https://www.cryptoninjas.net/exchange/study-cex-listing-effects/
- PANews / CoinGecko CEX Spot Market Report: https://www.panewslab.com/en/articles/019d8679-6904-7244-91e7-fb1a5d4b761f
- CoinGecko Research, Pump.fun Traders Are Making a Comeback: https://www.coingecko.com/research/publications/pump-fun-traders-are-making-a-comeback
- Flintr, Anatomy of a Rug Pull on pump.fun: https://www.flintr.io/articles/anatomy-of-a-rug-pull-identify-scams-on-pumpfun
- Backtesting data APIs: GeckoTerminal OHLCV https://apiguide.geckoterminal.com/ , Bitquery Pump.fun API https://docs.bitquery.io/docs/blockchain/Solana/Pumpfun/Pump-Fun-API/ , Dune pump.fun tables https://dune.com/adam_tehc/pumpfun , Flipside Solana docs https://docs.flipsidecrypto.xyz/blockchain-data/solana/overview , Solana Tracker data API https://www.solanatracker.io/data-api

Added 2026-05-21 (free discovery sources and the AI-agent / LLM landscape):

- PumpPortal real-time API: https://pumpportal.fun/data-api/real-time/
- Jupiter Tokens API v2: https://dev.jup.ag/docs/tokens/v2/token-information
- DexScreener API reference: https://docs.dexscreener.com/api/reference
- DexScreener WebSockets: https://docs.dexscreener.com/api/websockets
- Helius plans and LaserStream: https://www.helius.dev/docs/billing/plans
- Solana logsSubscribe (pump.fun mint detection): https://docs.chainstack.com/docs/solana-listening-to-pumpfun-token-mint-using-only-logssubscribe
- ElizaOS / ai16z class action: https://cryptorank.io/news/feed/0d429-ai16z-elizaos-creators-sued-fake-ai-hype
- GOAT SDK: https://github.com/goat-sdk/goat
- SendAI Solana MCP: https://github.com/sendaifun/solana-mcp
- SolEnrich MCP: https://www.solenrich.com/
- tony-42069 Solana memecoin MCP: https://github.com/tony-42069/solana-mcp
- GMGN AI review: https://aitradingcamp.com/reviews/gmgn-ai
- LLM-for-crypto backtest lessons: https://medium.com/@sean.j.moran/i-used-gpt4o-to-analyse-the-cryptocurrency-market-these-are-my-lessons-learnt-1429d0d9eea0

---

## Rug-pull detection and token-validity guide (added 2026-05-21)

Synthesized from 13 sources (Smithii, DEXTools, DeFade, GoPlus docs, Jupiter
docs and blog, RugCheck Swagger and analytics, a Token-2022 security writeup,
Bubblemaps). This is the spec for the rating system's safety / validity
component (the Stage 1 / Stage 2 rubric in section G). Every signal has a
threshold and the API field that exposes it.

### A. Rug-pull red-flag checklist

| # | Red flag | Rule / threshold | Where to get it |
|---|---|---|---|
| A1 | Mint authority active | Creator can mint unlimited supply. Should be revoked after launch. Active is a hard fail. | GoPlus `mintable`; RugCheck `mintAuthority` (null = safe); Jupiter `audit.mintAuthorityDisabled` |
| A2 | Freeze authority active | Creator can freeze any wallet and block selling. Hard fail unless a known legitimate locker. | GoPlus `freezable`; RugCheck `freezeAuthority`; Jupiter `audit.freezeAuthorityDisabled` |
| A3 | Liquidity not burned or locked | LP unlocked in the creator wallet is removable any time. Locks under 30 days are suspicious; legit projects lock 6 to 12 months. | GoPlus `is_locked` + `locked_detail`; RugCheck `lockers`, `markets`, `totalLPProviders` |
| A4 | Thin liquidity | Under $10,000 means heavy slippage and easy draining. | RugCheck `totalMarketLiquidity`; Jupiter `liquidity` |
| A5 | Concentrated holders | Top 10 over 30 to 40%, after excluding the LP pool, bonding curve and program accounts. | RugCheck `topHolders` + `knownAccounts`; Jupiter `audit.topHoldersPercentage`; Bubblemaps |
| A6 | Bundle activity at launch | 5+ wallets buying in the first slot, all funded from one source. Bundled supply over 15% is a cost advantage; over 30% is high-risk. | DeFade; RugCheck `graphInsidersDetected`; Bubblemaps |
| A7 | Serial-rugger creator | Creator wallet that launched 5 or more prior short-lived tokens. | RugCheck `creator` + on-chain history |
| A8 | Dev wallet early selling | Dev selling over 20 to 30% of its allocation within hours of launch. | RugCheck `creator` balance + `events` |
| A9 | Sniper-bot dominance | First 10 to 20 buyers are bots; 50%+ of initial volume is sniper activity. | Jupiter organic stats (`numOrganicBuyers` vs `numBuys`) |
| A10 | No or fake socials | Missing, or freshly created accounts with bought followers. Soft signal. | Off-chain; Jupiter `isVerified` / `tags` is a partial proxy |
| A11 | Mutable metadata | Name / symbol / metadata still changeable, a bait-and-switch risk. | RugCheck `risks[]` "Mutable metadata" |
| A12 | Honeypot | Sell simulation reverts; on a chart, only green buys and no red sells. Hard fail. | GoPlus honeypot checks; Honeypot.is; DEXTools candle pattern |
| A13 | Retained authorities / Token-2022 traps | The Solana equivalent of an upgradeable contract. See section D. | RugCheck `verification`, `token_extensions` |
| A14 | Fake / wash volume | Identical trade sizes; volume not matching unique-buyer count. | Jupiter total vs organic volume (`buyVolume` vs `buyOrganicVolume`) |
| A15 | High composite rug score | RugCheck HIGH/CRITICAL risks, low Jupiter organic score. | RugCheck `score_normalised`; Jupiter `organicScore` |

### B. Bundle / sniper-launch detection

Bundle sniping abuses Solana's atomic transaction bundling. Insiders create
fresh wallets funded from one common source, then submit their buys in the
same bundle as the liquidity-add, guaranteeing they buy at floor price before
any outside buyer. The on-chain fingerprint has three markers: temporal
coordination (wallets buying in the same slot), funding lineage (SOL traces
back to one wallet), and account age (bundle wallets created minutes before
launch, no history). The manual signature is one transaction batch of create,
add liquidity, buy, buy, buy. Thresholds: bundled supply 20 to 50%+ correlates
with elevated rug risk, 30%+ is statistically high-risk; a healthy launch
keeps the bundle under 5%. Surfaced by DeFade (automated), RugCheck
`graphInsiderReport` / `graphInsidersDetected`, the Bubblemaps bundle checker,
and Jupiter organic stats (a sniper-dominated launch shows low
`numOrganicBuyers` vs `numBuys`).

### C. Insider networks / coordinated wallets (RugCheck)

Rug pulls usually involve collusion across wallets (deployers, vesters,
liquidity managers) draining liquidity together. RugCheck's Insider Networks
(BETA) flags suspicious connections between top holders and privileged-role
wallets. It uses a behavioral engine (repeated consolidation transfers, rapid
round-tripping, pre-liquidity coordination), graph-theory metrics (betweenness
and closeness centrality flag wallets that bridge subgraphs or act as fund
conduits), and timing heuristics (rapid CEX deposits before unlocks). The
insider graph endpoint `GET /tokens/{id}/insiders/graph` returns nodes with a
per-wallet 0 to 100 risk score and edges weighted by transaction frequency.
The main report carries `graphInsiderReport` and `graphInsidersDetected`, and
`topHolders` has a per-holder insider flag. Reading rule: any insider-flagged
top holder, a non-zero `graphInsidersDetected`, or an abnormal centrality
spike is a coordinated-wallet red flag.

### D. Token-2022 extension risks

Solana's Token-2022 program adds optional extensions, several abusable by a
malicious mint.

| Extension | Why dangerous | Detection |
|---|---|---|
| Transfer Hook | Runs arbitrary issuer code on every transfer, reintroducing callback / reentrancy bugs; can conditionally block transfers (selective honeypot). Unknown / unverified hook is a hard fail. | RugCheck `token_extensions`; GoPlus SPL2022; inspect the hook program address |
| Permanent Delegate | A designated address can transfer or burn tokens from ANY holder, permanently. Hard fail unless a trusted known authority. | RugCheck `token_extensions`; GoPlus SPL2022 |
| Transfer Fee | A fee on every transfer (sell tax); breaks escrow / DEX math; high or mutable fee is effectively a tax. | RugCheck `transferFee`; GoPlus tax checks |
| Non-Transferable | Disables Transfer entirely. On a tradable memecoin this is a permanent honeypot. Hard fail. | RugCheck `token_extensions`; GoPlus |
| Default Account State (frozen) | New accounts frozen by default, an authority-gated honeypot. | RugCheck `token_extensions` / GoPlus |
| Mint Close Authority | A closed mint can be reinitialized at the same address, orphaning accounts. | RugCheck `token_extensions` |

### E. Holder concentration done right

The raw "top 10 = X%" number is misleading until non-circulating holders are
removed. Exclude before computing: LP / DEX pool accounts, the bonding-curve
account, and known program accounts (lockers, vesting, CEX hot wallets, burn
address). RugCheck `knownAccounts` and `markets` exist precisely so you can
subtract these; GoPlus `locked_detail` identifies locker holdings. Jupiter
`audit.topHoldersPercentage` is a convenient pre-computed proxy but does not
say what it excluded, so prefer computing it yourself. Post-exclusion
thresholds: top 10 over 30 to 40% is dump risk; a single Bubblemaps cluster
over 30% is extreme risk. Bubblemaps colors wallets likely controlled by the
same entity and draws transfer links: a healthy map has multiple unconnected
clusters, CEX/DEX wallets among holders, a near-empty deployer wallet, and
bundle under 5%; red flags are one cluster over 30%, bundled supply over 15%,
wallets fragmenting into fresh addresses (pre-dump distribution), or a
deployer created hours before launch. Sophisticated ruggers spread supply
across dozens of wallets, so always cross-check funding lineage, not just the
per-wallet list.

### F. The validity data sources, compared

**GoPlus Token Security API (Solana).** `GET https://api.gopluslabs.io/api/v1/solana/token_security`,
query param `contract_addresses`, Bearer token for higher tiers. Covers SPL
Token and Token-2022. Returns mint/freeze authority, taxes, transfer-hook and
other extension flags, `is_locked` + `locked_detail` (lock status across
Raydium, Streamflow), holder distribution, liquidity. Exact free-tier rate
limits are not published; implement 429 backoff.

**RugCheck API.** API key in `X-API-KEY` header. Endpoints:
`GET /v1/tokens/{id}/report` (full report), `GET /tokens/{id}/insiders/graph`
(insider graph), `GET /wallets/{address}/risk`. Key report fields: `score` /
`score_normalised` (0 to 100, higher = riskier), `risks[]` (named flags with
severity), `rugged` (boolean), `mintAuthority` / `freezeAuthority` (null =
safe), `creator`, `topHolders` + `knownAccounts`, `markets` /
`totalMarketLiquidity` / `totalLPProviders`, `lockers`, `graphInsiderReport` /
`graphInsidersDetected`, `tokenProgram` / `token_extensions` / `transferFee`,
`verification`. Solana-only, no off-chain or team data.

**Jupiter Tokens API v2 + organic score.** Endpoints include `search`,
`tag?query=verified`, `toporganicscore/{interval}`, `recent`. Audit object:
`mintAuthorityDisabled`, `freezeAuthorityDisabled`, `topHoldersPercentage`.
Organic: `organicScore` (0 to 100 float) and `organicScoreLabel` (high /
medium / low). Organic stats per interval: `buyVolume`/`sellVolume` vs
`buyOrganicVolume`/`sellOrganicVolume`, `numTraders`, `numOrganicBuyers`. The
score combines organic volume, holders, traders and buyers, rewards early
growth with diminishing returns, and is normalized against the ecosystem. It
flags trading routed through known non-organic channels (sniping, copy-trading
bots); wallets not matching a known channel default to organic. Filter on the
raw `organicScore` float, not the wide label. Reference points: SOL 98.9,
JUP 93.6, TRUMP 85.3.

Cross-source rule: authorities and Token-2022 extensions are deterministic
on-chain facts, all three sources must agree. Concentration, bundles, insiders
and organic score are probabilistic: take holder/insider data from RugCheck,
organic/bot data from Jupiter, lock detail from GoPlus, visual cluster
confirmation from Bubblemaps. Never rely on a single tool.

### G. Proposed safety / validity scoring rubric

A two-stage model: hard blocks first, then a 100-point weighted score.

**Stage 1, hard blocks (any one means rating = unsafe / F):**
1. Mint authority active.
2. Freeze authority active without a known legitimate reason.
3. Honeypot (sell simulation reverts).
4. Token-2022 unverified transfer hook present.
5. Permanent delegate present and not trusted.
6. Non-transferable extension on a tradable token.
7. RugCheck `rugged` = true, or a CRITICAL `risks[]` flag.
8. Liquidity not locked/burned AND LP held in the creator wallet.

**Stage 2, weighted score (start at 100, deduct), only if Stage 1 passes:**

| Signal | Deduction |
|---|---|
| Holder concentration (post-exclusion) | -25 if top10 over 40%; -15 if 30 to 40%; -5 if 20 to 30% |
| Bundle / insider supply | -25 if over 30%; -15 if 15 to 30%; -5 if 5 to 15% |
| Insider network detected | -15 if `graphInsidersDetected` > 0 or a top-holder insider flag |
| Weak LP lock | -15 if unlocked but not creator-held; -8 if lock under 30 days |
| Thin liquidity | -10 if under $10k; -5 if under $25k |
| Low organic score | -15 if `organicScore` under 40; -8 if 40 to 60; -10 if sniper-dominated |
| Serial-rugger creator | -20 if 5+ prior short-lived tokens; -10 if 2 to 4 |
| Dev wallet early selling | -15 if sold over 30% within hours; -8 if 15 to 30% |
| Mutable metadata | -8 |
| Transfer fee (Token-2022) | -10 if over 5% or fee authority not revoked; -5 if 1 to 5% |
| Mint-close authority / default-frozen | -10 each |
| No / fake socials | -5 |
| RugCheck HIGH-severity risks | -10 per flag, cap -30 |
| Fake / wash volume | -10 if total vs organic volume diverge sharply |

**Tier mapping:** Stage-1 fail = F (unsafe). 0 to 39 = D (high risk).
40 to 59 = C (elevated). 60 to 79 = B (moderate). 80 to 100 = A (strong).

This rubric is the spec for the rating system's "confirmed" safety component.
The current scan rating is "provisional" (exitability + corroboration +
momentum + risk flags); folding Stage 1 / Stage 2 in is the next build.

Sources for this guide: Smithii top-3 Solana rug detection tools; DEXTools
rug-pull 2026 checklist and free contract-analysis tools; DeFade bundle-sniping
and 10-red-flags articles; GoPlus Solana token_security docs and changelog;
Jupiter Tokens v2 docs and the organic-score blog; RugCheck Swagger and the
RugCheck insider-analytics writeup; a Token-2022 transfer-hooks security
writeup; the Bubblemaps holder-analysis guide.
