import { Workflow } from "lucide-react";
import { type ReactNode } from "react";
import { PanelTitle } from "../PanelTitle";

// System-flow diagram. A dedicated page (tab id `memecoin_flow`) that
// documents every pipeline in the Meme Coin sub-project: what triggers it,
// what runs automatically, what gates exist, and what the user sees. The
// diagram is plain HTML so a PR diff shows exactly what changed; update
// this whenever the pipelines change. Layperson-readable but each step
// carries the file the code lives in for engineers digging deeper. See
// docs/ARCHITECTURE.md "System flow" for the project-doc reflection of this page.
export function FlowChart() {
  return (
    <section className="stack">
    <section id="memecoin-flow" className="panel wide">
      <PanelTitle icon={Workflow} title="System flow" />
      <p className="flow-intro">
        Eight independent pipelines drive everything in the Meme Coin sub-project.
        Browser-tab-driven: the trade cycles (hourly), position watch (5 min), the event-driven
        safety/queue paths, and the user actions. Server-side, running with no tab open (opt-in via the
        <code>SERVER_SCHEDULER_*</code> env flags): the new-coin
        scan scheduler (15 min, chart 8) and a position-watch twin that mirrors chart 4 (5 min). Each
        chart below shows the trigger, the steps, and the gates. The walkthrough under each chart cites
        the file the code lives in. Keep this page in sync with code changes; a stale chart is worse
        than no chart.
      </p>

      {/* ---------- 1. SCAN PIPELINE ---------- */}
      <div className="flow-subflow">
        <h3 className="flow-subtitle">1. Scan pipeline</h3>
        <p className="flow-cadence">
          On demand: <strong>Scan latest meme coins</strong> button. Also runs as the first step of
          every Auto-cycle, Live cycle, and lookup-by-address.
        </p>
        <div className="flow-chart">
          <FlowNode kind="trigger" title="Scan request" sub='Button click, "Look up" box, or a cycle tick' />
          <FlowArrow />
          <FlowNode
            kind="step"
            title="Gather candidates (parallel)"
            sub="Promise.allSettled across 4 feeds, latency = slowest provider"
          />
          <FlowBranch
            cols={[
              <FlowMini key="d" label="DexScreener" detail="boosted + newly profiled" />,
              <FlowMini key="g" label="GeckoTerminal" detail="new + trending Solana pools" />,
              <FlowMini key="j" label="Jupiter v2" detail="recent + toptrending/24h" />,
              <FlowMini key="p" label="pump.fun" detail="newest launches (often gated)" />
            ]}
          />
          <FlowArrow label="merge round-robin · dedupe · cap 60" />
          <FlowNode kind="step" title="Enrich market data" sub="DexScreener tokens/{addrs} in batches of 30 · price, liquidity, age, txns" />
          <FlowArrow label="top 40 only · concurrency pool of 8" />
          <FlowNode
            kind="step"
            title="Jupiter enrichment"
            sub="holder count · top-10 % · organic score · audit fields. In-flight dedup per mint."
          />
          <FlowArrow />
          <FlowNode kind="step" title="Score" sub="exitScore = liq·0.42 + vol·0.28 + turn·0.20 + trades·0.10" />
          <FlowArrow />
          <FlowNode kind="step" title="Momentum vs prior scan" sub="volume + liquidity delta · momentumScore · 'new' tag if absent before" />
          <FlowArrow />
          <FlowNode kind="step" title="Composite rating" sub="exit + corroboration + momentum − risk flags · 0-100, A-F" />
          <FlowArrow />
          <FlowNode kind="outcome" title="Render scan list" sub="default sort: Rating · Hidden coins filtered to Hidden tab" />
        </div>
        <ol className="flow-walkthrough">
          <li><strong>Trigger</strong>: <code>runScan</code> in <code>App.tsx</code>, or step 1 of <code>runCycle</code> / <code>runLiveCycle</code>.</li>
          <li><strong>Gather</strong>: <code>scanMemecoins</code> in <code>src/lib/markets.ts</code> fans out to four candidate sources in parallel via <code>Promise.allSettled</code>; a slow or failing feed cannot stall the others. Source chips on the scan panel show which answered.</li>
          <li><strong>Enrich</strong>: <code>fetchPrices</code> hits DexScreener <code>latest/dex/tokens/{`{addrs}`}</code> 30 at a time. No key.</li>
          <li><strong>Jupiter audit</strong>: top 40 by exit score get a Jupiter Tokens v2 lookup for holder count, top-10 %, and the organic score. <code>runWithConcurrency(8)</code> caps in-flight requests; <code>jupiterInFlight</code> in <code>src/lib/safety.ts</code> dedups concurrent same-mint requests.</li>
          <li><strong>Score</strong>: <code>scoreExit</code> in <code>src/lib/markets.ts</code>, four weighted components. Verdict thresholds: <em>exitable</em> ≥62 score + ≥$25k liq + ≤1 risk flag.</li>
          <li><strong>Rating</strong>: <code>computeRating</code> in <code>src/lib/markets.ts</code> folds in cross-source corroboration (+5 per extra feed, cap +15), momentum, and risk-flag penalty.</li>
          <li><strong>Render</strong>: sorted client-side per the active dropdown. Hide list (<code>memeify-memecoin-hidden-v1</code>) filters the default tab.</li>
        </ol>
      </div>

      {/* ---------- 2. AUTO-CYCLE ---------- */}
      <div className="flow-subflow">
        <h3 className="flow-subtitle">2. Auto-cycle (paper)</h3>
        <p className="flow-cadence">
          <strong>Every 60 minutes</strong> while <em>Auto-run</em> is ON and trading mode is Paper.
          Browser-tab-open required. Skipped when mode is Real (the Live cycle takes over).
        </p>
        <div className="flow-chart">
          <FlowNode kind="trigger" title="60-min interval fires" sub="setInterval · App.tsx · paper auto-run effect" />
          <FlowArrow />
          <FlowNode kind="gate" title="Busy lock?" sub="Shared lock with position watch. If held, skip this tick." />
          <FlowArrow />
          <FlowNode kind="step" title="Scan pipeline" sub="(see chart 1)" />
          <FlowArrow />
          <FlowNode kind="step" title="Re-price held coins not in scan" sub="fetchPrices · merge into priceMap · prune to addresses still referenced" />
          <FlowArrow />
          <FlowNode kind="decision" title="Queue mode ON?" sub="Branch on paper_account.queue_mode" />
          <FlowBranch
            cols={[
              <div key="q" className="flow-branchcol">
                <FlowMini label="YES — propose only" detail="decideSellIntents + decideBuyIntents" />
                <FlowArrow />
                <FlowMini label="Pre-filter against safety cache" detail="drop intents where verdict was 'block' inside the 6h TTL" />
                <FlowArrow />
                <FlowMini label="enqueueIntents" detail="trade_queue jsonb on paper_account" />
                <FlowArrow />
                <FlowMini label='Toast "N proposed"' detail='kind=spike · clicks scroll to "trade-queue"' />
              </div>,
              <div key="e" className="flow-branchcol">
                <FlowMini label="NO — execute now" detail="runSellPass then runBuyPass" />
                <FlowArrow />
                <FlowMini label="Sell pass" detail="take-profit · stop-loss · max hold · liquidity death" />
                <FlowArrow />
                <FlowMini label="Buy pass" detail="execute-mode gates (in firing order): autoTrade on · circuit-breaker · maxOpen · cash ≥ $1 · minExitScore · minLiq · minAge · minHolderCount · price > 0 · not-already-held · not-blacklisted · cooldown. Queue mode skips the autoTrade gate (it's execute-only). Rating is the SORT key, not a gate." />
                <FlowArrow />
                <FlowMini label='Toast "Auto-cycle traded: ..."' detail="kind chosen by sell-vs-buy mix" />
              </div>
            ]}
          />
          <FlowArrow />
          <FlowNode kind="gate" title="Daily loss limit check" sub="circuitBreakerTripped · toast once on transition into tripped" />
        </div>
        <ol className="flow-walkthrough">
          <li><strong>Trigger</strong>: <code>setInterval</code> in the auto-run <code>useEffect</code> in <code>App.tsx</code>, 3600000ms (60 min, slowed from 180000ms on 2026-05-26 to keep Brave inside its $5 free credit). Bails when <code>tradingMode === "real"</code>.</li>
          <li><strong>Busy lock</strong>: <code>paperBusyRef</code> guards <code>runCycle</code>, <code>runPositionWatch</code>, and every manual paper handler so concurrent writes never clobber.</li>
          <li><strong>Scan</strong>: <code>scanMemecoins</code> reused; result also written to <code>scan_cache</code> via the persist debounce.</li>
          <li><strong>Re-price</strong>: held coins not in scan get a separate <code>fetchPrices</code>; the merged price map is then pruned to addresses still referenced (this scan, paper positions, live mints) to keep <code>price_snapshots</code> from growing unbounded.</li>
          <li><strong>Queue mode</strong>: <code>decideSellIntents</code> then <code>decideBuyIntents</code> in <code>src/lib/paper.ts</code> produce intents (sells first, matching the chart and the code in <code>runCycle</code>); the safety cache pre-filters known-blocked coins so the queue isn't churned with auto-dismiss noise.</li>
          <li><strong>Execute mode</strong>: <code>runSellPass</code> then <code>runBuyPass</code> in <code>src/lib/paper.ts</code>. The buy pass runs every gate in firing order: <code>autoTrade</code> on, circuit-breaker, max open, cash ≥ $1, <code>minExitScore</code>, <code>minLiquidityUsd</code>, <code>minAgeHours</code>, <code>minHolderCount</code>, price &gt; 0, not already holding the address, not in the rugged blacklist, not in the re-entry cooldown. <strong>Queue-mode asymmetry</strong>: <code>decideBuyIntents</code> intentionally skips the <code>autoTrade</code> gate because queue mode is "review every trade" by definition; only execute mode honors it. To stop queue-mode proposals entirely, raise the buy gates. Note: the candidate list is pre-sorted best-first by <em>rating</em>, but rating is not itself a gate; <code>minExitScore</code> is.</li>
          <li><strong>Circuit-breaker</strong>: <code>circuitBreakerTripped</code> at the end of the cycle. <code>circuitTrippedRef</code> ensures the toast fires once on transition, not every tick.</li>
        </ol>
      </div>

      {/* ---------- 3. LIVE CYCLE ---------- */}
      <div className="flow-subflow">
        <h3 className="flow-subtitle">3. Live cycle (real money)</h3>
        <p className="flow-cadence">
          <strong>Every 60 minutes</strong> while trading mode is Real. Fires once immediately on
          entering Real mode. The paper Auto-run and Position watch are force-disabled in Real mode.
        </p>
        <div className="flow-chart">
          <FlowNode kind="trigger" title="Real mode entered, OR 60-min tick" sub="setInterval · App.tsx · live cycle effect" />
          <FlowArrow />
          <FlowNode kind="gate" title="Live busy lock?" sub="liveCycleBusyRef · skip if a prior tick is still in flight" />
          <FlowArrow />
          <FlowNode kind="step" title="Scan pipeline" sub="(see chart 1)" />
          <FlowArrow />
          <FlowNode kind="step" title="Decide live BUY intents" sub="decideLiveBuyIntents · against open live positions + dismissed-buy records" />
          <FlowArrow />
          <FlowNode kind="step" title="Re-price live open positions" sub="fetchPrices · lift peakPriceUsd (bad-data ticks blocked from peak)" />
          <FlowArrow />
          <FlowNode kind="step" title="Decide live SELL intents" sub="decideLiveSellIntents · trailing stop · max hold · liquidity death" />
          <FlowArrow />
          <FlowNode kind="gate" title="Pre-filter against safety cache" sub="drop block-cached intents (6h TTL) so the queue stays clean" />
          <FlowArrow />
          <FlowNode kind="step" title="enqueueIntents" sub="proposals only · NEVER auto-executes a real trade" />
          <FlowArrow />
          <FlowNode kind="outcome" title='Toast "Live cycle proposed N trades"' sub='kind=spike · clicks scroll to "trade-queue"' />
        </div>
        <ol className="flow-walkthrough">
          <li><strong>Trigger</strong>: separate <code>useEffect</code> in <code>App.tsx</code>, partner to the paper auto-run. Mutual exclusion guarantees exactly one cycle owns the 60-min cadence per mode.</li>
          <li><strong>Decide buys</strong>: <code>decideLiveBuyIntents</code> in <code>src/lib/live.ts</code> applies the same gates as the paper buy pass plus the live-positions cap.</li>
          <li><strong>Re-price + peaks</strong>: <code>plausibleSellPrice</code> guards the peak so one thin-pool glitch upward doesn't bake a fake peak that later fires trailing as a -99% drawdown.</li>
          <li><strong>Decide sells</strong>: <code>decideLiveSellIntents</code> in <code>src/lib/live.ts</code> reads the lifted peaks for trailing-stop math.</li>
          <li><strong>Safety pre-filter</strong>: same <code>safetyCacheRef</code> + TTL as the paper cycle. Live-mode silently dropping a coin you were watching for is the worse failure mode, so blocked symbols are also written to the cycle log.</li>
          <li><strong>Enqueue, never execute</strong>: by design, the live cycle <em>only</em> proposes. Every real swap requires a Phantom signature in the Queue approval or Manual trade flows.</li>
        </ol>
      </div>

      {/* ---------- 4. POSITION WATCH ---------- */}
      <div className="flow-subflow">
        <h3 className="flow-subtitle">4. Position watch</h3>
        <p className="flow-cadence">
          <strong>Every 5 minutes</strong> while <em>Position watch</em> is ON. Fires once immediately
          on toggle-on. Paper positions only get auto-evaluated; live positions are re-priced for the
          panel display. A server-side twin (<code>positionWatchSchedulerPlugin</code> in
          <code>vite.config.ts</code>, opt-in <code>SERVER_SCHEDULER_WATCH=true</code>) runs this same
          evaluation every 5 min with no tab open. It loads state from
          Postgres, refreshes <code>m_price_snapshots</code>, runs the queue/execute/watchlist branches
          below, and writes alerts straight to <code>m_paper_alerts</code> (no <code>pushAlert</code>;
          the open tab surfaces them on its next state poll).
        </p>
        <div className="flow-chart">
          <FlowNode kind="trigger" title="5-min interval fires" sub="setInterval · App.tsx · watch effect" />
          <FlowArrow />
          <FlowNode kind="gate" title="Busy lock?" sub="Shared with auto-cycle. Empty open lists also short-circuit." />
          <FlowArrow />
          <FlowNode kind="step" title="Fetch prices" sub="paper open addresses + live open mints, deduped" />
          <FlowArrow />
          <FlowNode kind="decision" title="Any prices back?" sub="Empty result = upstream blip; bail to avoid false rugs" />
          <FlowArrow />
          <FlowNode kind="decision" title="Trading mode?" />
          <FlowBranch
            cols={[
              <div key="r" className="flow-branchcol">
                <FlowMini label="REAL mode" detail="re-price live for panel only · stop here" />
              </div>,
              <div key="q" className="flow-branchcol">
                <FlowMini label="PAPER + queue mode" detail="decideSellIntents on paper positions" />
                <FlowArrow />
                <FlowMini label="enqueueIntents" detail="watch keeps the queue fed even with auto-run off" />
                <FlowArrow />
                <FlowMini label='Toast "Watch proposed N sells"' detail='kind=spike · clicks scroll to "trade-queue"' />
              </div>,
              <div key="e" className="flow-branchcol">
                <FlowMini label="PAPER + execute mode" detail="evaluatePositionWatch in src/lib/paper.ts" />
                <FlowArrow />
                <FlowMini label="Per-position rules (one-shot flags)" detail="+50% spike · +100% sell half · danger reasons · liq < $3k force-exit" />
                <FlowArrow />
                <FlowMini label="Toast per alert · log pump triggers for spikes" detail="pushAlert + Notification API + logPumps" />
              </div>
            ]}
          />
        </div>
        <ol className="flow-walkthrough">
          <li><strong>Trigger</strong>: <code>useEffect</code> in <code>App.tsx</code>, 300000ms, plus an immediate first run on toggle-on.</li>
          <li><strong>Prices</strong>: <code>fetchPrices</code> over the deduped paper-open + live-open address set; an empty response sets a soft error and bails the evaluation step.</li>
          <li><strong>Real mode</strong>: live positions are re-priced into <code>prices</code> so the live panel stays current, but no rules run against them. Live sells are exclusively user-clicked.</li>
          <li><strong>Queue mode</strong>: <code>decideSellIntents</code> in <code>src/lib/paper.ts</code> proposes only; the watch never auto-sells in queue mode.</li>
          <li><strong>Execute mode</strong>: <code>evaluatePositionWatch</code> in <code>src/lib/paper.ts</code>. Spike (+50%) and danger alerts are flag-throttled (<code>alertedSpike</code>, <code>dangerAlerted</code>); danger re-arms on a clean tick so a recovery → re-deterioration alerts again. Liquidity 0&lt;x&lt;$3k force-exits.</li>
          <li><strong>Pump log</strong>: every <em>spike</em> alert writes a pump-trigger row with a one-shot social chatter scan (deduped per coin per day).</li>
        </ol>
      </div>

      {/* ---------- 5. SAFETY GATE ---------- */}
      <div className="flow-subflow">
        <h3 className="flow-subtitle">5. Safety gate (event-driven)</h3>
        <p className="flow-cadence">
          Fires <strong>whenever the trade queue changes</strong>, not on a timer. Decides which
          queued buy intents are safe enough to keep, auto-dismisses the rest.
        </p>
        <div className="flow-chart">
          <FlowNode kind="trigger" title="tradeQueue state changed" sub="useEffect dependency · App.tsx · safety effect" />
          <FlowArrow label="for each pending buy intent" />
          <FlowNode kind="gate" title="Cache hit within 6h?" sub="safetyCacheRef · persisted to localStorage" />
          <FlowBranch
            cols={[
              <div key="h" className="flow-branchcol">
                <FlowMini label="YES (cached)" detail="reuse verdict · skip all upstream calls" />
              </div>,
              <div key="m" className="flow-branchcol">
                <FlowMini label="In-flight dedup" detail="safetyInFlightRef Map by mint" />
                <FlowArrow />
                <FlowMini label="runForIntent" detail="runs sequentially per intent" />
                <FlowArrow />
                <FlowMini label="RugCheck report (5min TTL)" detail="mint/freeze auth · insider · LP · transfer fee" />
                <FlowArrow />
                <FlowMini label="Jupiter audit (30min TTL)" detail="organic score · top holders · wash signal" />
                <FlowArrow />
                <FlowMini label="Jupiter quote + sellability sim" detail="buy + sell price-impact check" />
                <FlowArrow />
                <FlowMini label="Cache verdict" detail="ref + localStorage write" />
              </div>
            ]}
          />
          <FlowArrow label="after loop" />
          <FlowNode kind="decision" title="Any verdict = block?" />
          <FlowArrow />
          <FlowNode
            kind="outcome"
            title="Batched auto-dismiss"
            sub="append DismissedBuyIntent (source=auto-safety-block) · remove from queue · one toast per blocked coin"
          />
        </div>
        <ol className="flow-walkthrough">
          <li><strong>Trigger</strong>: the safety <code>useEffect</code> in <code>App.tsx</code> depends on <code>tradeQueue</code>. Adding, removing, or replacing intents re-runs it.</li>
          <li><strong>Cache</strong>: <code>safetyCacheRef</code> + <code>SAFETY_CACHE_TTL_MS</code> (6h). Persisted to <code>memeify-memecoin-safety-cache-v1</code>. Manual user buys deliberately do NOT evict the cache (one-time override, not safety endorsement).</li>
          <li><strong>In-flight dedup</strong>: <code>safetyInFlightRef</code> Map. Concurrent re-renders re-attach to the same Promise instead of issuing redundant RugCheck/Jupiter calls.</li>
          <li><strong>RugCheck + Jupiter</strong>: <code>runSafetyGate</code> in <code>src/lib/safety.ts</code>. Internal TTL split: RugCheck 5min, Jupiter 30min (audit data is slow-moving).</li>
          <li><strong>Auto-dismiss</strong>: batched at end of loop so state mutations don't re-trigger the effect mid-run. Each dismissed coin gets a permanent record with <code>source: "auto-safety-block"</code>, <code>reason</code>, and <code>algoVersion</code>.</li>
        </ol>
      </div>

      {/* ---------- 6. QUEUE APPROVAL ---------- */}
      <div className="flow-subflow">
        <h3 className="flow-subtitle">6. Queue approval (user action)</h3>
        <p className="flow-cadence">
          Triggered by the user ticking intents and clicking <strong>Approve selected</strong> in the
          Trade queue panel. The only place automated proposals become real trades.
        </p>
        <div className="flow-chart">
          <FlowNode kind="trigger" title='User clicks "Approve selected"' sub="TradeQueuePanel · onApprove handler" />
          <FlowArrow label="for each ticked intent" />
          <FlowNode kind="decision" title="Paper or Live intent?" />
          <FlowBranch
            cols={[
              <div key="p" className="flow-branchcol">
                <FlowMini label="PAPER" detail="book directly · no signature needed" />
                <FlowArrow />
                <FlowMini label="applyQueuedIntents in src/lib/paper.ts" detail="updates positions + cash · pushes events to log" />
                <FlowArrow />
                <FlowMini label="setPaper · cycle log · save" detail="debounced persist to Postgres" />
              </div>,
              <div key="l" className="flow-branchcol">
                <FlowMini label="LIVE" detail="real money · requires signature" />
                <FlowArrow />
                <FlowMini label="Build Jupiter swap txns" detail="quote + buildSwapTransaction per intent" />
                <FlowArrow />
                <FlowMini label="signAllTransactions (Phantom)" detail="ONE signature for the whole batch" />
                <FlowArrow />
                <FlowMini label="On-chain confirm + delta read" detail="fetchSwapDelta + fetchSolDelta (5-attempt retry)" />
                <FlowArrow />
                <FlowMini label="openLivePosition / sellLivePosition" detail="record in live_positions · stamps entry_settings_snapshot + algo_version" />
              </div>
            ]}
          />
          <FlowArrow />
          <FlowNode kind="outcome" title="Remove intents from queue · toasts" sub="any failed intent stays in the queue with an error" />
        </div>
        <ol className="flow-walkthrough">
          <li><strong>Trigger</strong>: <code>approveQueued</code> in <code>App.tsx</code>. Bails with a toast if the paper busy lock is held.</li>
          <li><strong>Paper</strong>: <code>applyQueuedIntents</code> in <code>src/lib/paper.ts</code> books all ticked paper trades atomically.</li>
          <li><strong>Live build</strong>: per intent, a Jupiter quote + <code>buildSwapTransaction</code> assembles an unsigned transaction. Pre-buy safety is re-checked against the cache.</li>
          <li><strong>Sign</strong>: <code>signAllTransactions</code> in Phantom signs the whole batch in one popup; the dashboard never touches a key.</li>
          <li><strong>Confirm + record</strong>: <code>fetchSwapDelta</code> + <code>fetchSolDelta</code> in <code>src/lib/wallet.ts</code> read the on-chain delta with a 5-attempt retry (the indexer can lag). <code>openLivePosition</code> / <code>sellLivePosition</code> in <code>src/lib/live.ts</code> write the durable record. The <code>entry_settings_snapshot</code> captures the rule set at trade time so backtests can reason about it later.</li>
          <li><strong>Failure</strong>: a failed intent stays in the queue with an error; the rest of the batch is unaffected.</li>
        </ol>
      </div>

      {/* ---------- 7. MANUAL TRADE ---------- */}
      <div className="flow-subflow">
        <h3 className="flow-subtitle">7. Manual trade (user action)</h3>
        <p className="flow-cadence">
          Triggered by <strong>Buy (paper)</strong>, <strong>Buy (live)</strong>, or <strong>Sell</strong> on a
          scan card, the coin popup, or an open-positions row. Bypasses the queue but still goes
          through the confirmation popup.
        </p>
        <div className="flow-chart">
          <FlowNode kind="trigger" title="Buy / Sell click" sub="Card · popup · open-positions row" />
          <FlowArrow />
          <FlowNode kind="step" title="ConfirmModal" sub="Cancel · Confirm · ESC or backdrop cancels" />
          <FlowArrow />
          <FlowNode kind="decision" title="Paper or Live?" />
          <FlowBranch
            cols={[
              <div key="p" className="flow-branchcol">
                <FlowMini label="PAPER" detail="buyOne / sellOne in App.tsx" />
                <FlowArrow />
                <FlowMini label="Apply to state" detail="positions + cash updated · ignores buy-side gates (manual override)" />
                <FlowArrow />
                <FlowMini label="Save + toast" detail="debounced Postgres write · pushAlert result" />
              </div>,
              <div key="l" className="flow-branchcol">
                <FlowMini label="LIVE" detail="opens BuyLiveModal / SellLiveModal" />
                <FlowArrow />
                <FlowMini label="Pre-buy safety check (buy only)" detail="src/lib/safety.ts · user can override with checkbox" />
                <FlowArrow />
                <FlowMini label="Phantom signs the swap" detail="one popup · slippage capped at 10%" />
                <FlowArrow />
                <FlowMini label="On-chain confirm + delta read" detail="fetchSwapDelta retried 5×" />
                <FlowArrow />
                <FlowMini label="confirmLiveBuy / confirmLiveSell" detail="reads from latest committed siblings · force-saves to Postgres" />
                <FlowArrow />
                <FlowMini label="Toast result" detail="profit kind · partial-sell text if applicable" />
              </div>
            ]}
          />
        </div>
        <ol className="flow-walkthrough">
          <li><strong>Trigger</strong>: every Buy / Sell button on cards, popups, or position rows opens <code>ConfirmModal</code> via a <code>request*</code> helper. Auto-cycle and Queue approval are NOT gated by this modal.</li>
          <li><strong>Paper</strong>: <code>buyOne</code> / <code>sellOne</code> in <code>App.tsx</code>. The shared busy lock holds across the price fetch on sell so a mid-cycle write can't overwrite it.</li>
          <li><strong>Live safety</strong>: <code>runSafetyGate</code> in <code>src/lib/safety.ts</code> (4 checks). Blocking verdicts can be acknowledged with a checkbox; warns show as text only.</li>
          <li><strong>Sign</strong>: <code>signAndSendBase64Tx</code> in <code>src/lib/wallet.ts</code>. Slippage hard-capped at 10% client-side.</li>
          <li><strong>Confirm</strong>: <code>fetchSwapDelta</code> reads the on-chain delta; failure surfaces an error and refuses to record the position (no falsified ledger).</li>
          <li><strong>Force-save</strong>: <code>confirmLiveBuy</code> / <code>confirmLiveSell</code> in <code>App.tsx</code> build the persist payload from <code>persistRef.current</code> (latest committed siblings) so a cycle that ran during the Phantom sign isn't stale-overwritten. The save is non-debounced.</li>
        </ol>
      </div>

      {/* ---------- 8. SERVER NEW-COIN SCAN SCHEDULER ---------- */}
      <div className="flow-subflow">
        <h3 className="flow-subtitle">8. Server new-coin scan scheduler</h3>
        <p className="flow-cadence">
          <strong>Every 15 minutes</strong> server-side, with <em>no browser tab open</em>. Opt-in via
          <code>SERVER_SCHEDULER_SCAN=true</code>; first tick 45s after server start. Free by
          construction — reuses the scan pipeline (chart 1), which hits only keyless feeds and never the
          paid social-chatter providers. This surfaces new-coin alerts while the local server runs.
        </p>
        <div className="flow-chart">
          <FlowNode kind="trigger" title="15-min timer fires" sub="setInterval · scanSchedulerPlugin · vite.config.ts · no tab needed" />
          <FlowArrow />
          <FlowNode kind="gate" title="Busy lock?" sub="Local per-tick lock; skip if the prior tick is still running." />
          <FlowArrow />
          <FlowNode kind="step" title="Scan pipeline" sub="load prior from m_scan_cache → scanMemecoins → write result back (see chart 1)" />
          <FlowArrow />
          <FlowNode kind="gate" title="First-tick seed guard" sub="If first tick after restart AND prior scan stale (>2× interval): seed only, emit nothing this tick." />
          <FlowArrow />
          <FlowNode
            kind="gate"
            title="Quality bar prefilter"
            sub="new-since-last-scan · band ∈ {A} · liq ≥ $50k · vol24h ≥ $75k · verdict exitable (requireExitable)"
          />
          <FlowArrow label="cross-tick dedup: drop addresses alerted <6h ago · cap 5/scan" />
          <FlowNode
            kind="gate"
            title="RugCheck rug-screen (per candidate)"
            sub="skip unverifiable (ok:false) and shady (rugged / honeypot / mint+freeze auth open / insider-bundled / top-holder concentration). Capture the RugCheck score."
          />
          <FlowArrow />
          <FlowNode
            kind="outcome"
            title="Insert enriched alert → m_paper_alerts"
            sub="formatNewCoinAlert: rating/100 · verdict+exit · liq/vol/mcap · 24h price + vol-momentum · buy% · vol/liq · top10% · uniq% · age · #sources · RugCheck score. kind='newcoin', dismissed=false, scroll_to_id=address."
          />
          <FlowArrow label="open tab polls /api/memecoin/state" />
          <FlowNode kind="outcome" title="Toast + OS notification" sub="applyServerState surfaces unseen, undismissed alerts. No tab open → it waits in the Alerts log." />
        </div>
        <ol className="flow-walkthrough">
          <li><strong>Trigger</strong>: <code>scanSchedulerPlugin</code> in <code>vite.config.ts</code> — <code>setTimeout(45s)</code> then <code>setInterval</code> at <code>SCAN_INTERVAL_MIN</code> (default 15 min). Gated on <code>SERVER_SCHEDULER_SCAN==="true"</code> read from <code>loadEnv</code> (not <code>process.env</code>).</li>
          <li><strong>Scan</strong>: <code>scanMemecoins(prior)</code> from <code>src/lib/markets.ts</code>, the same pipeline as chart 1, pointed at the server's own loopback proxy. Result is upserted into <code>m_scan_cache</code> so an opening tab sees fresh data.</li>
          <li><strong>Seed guard</strong>: on the first tick after a restart, if the prior cached scan is stale (<code>priorAgeMs &gt; 2×</code> interval) every coin reads as "new" vs the stale cache, so it seeds silently and emits no alerts that tick.</li>
          <li><strong>Quality bar</strong>: env-tunable — <code>NEWCOIN_BANDS</code> (default A), <code>NEWCOIN_MIN_LIQUIDITY_USD</code> (50k), <code>NEWCOIN_MIN_VOLUME_24H</code> (75k), <code>NEWCOIN_REQUIRE_EXITABLE</code> (default on → <em>exitable</em> only; off → anything not <em>trap risk</em>).</li>
          <li><strong>Dedup + cap</strong>: queries <code>m_paper_alerts</code> for <code>kind='newcoin'</code> rows in the last 6h and skips those addresses; then slices to <code>NEWCOIN_MAX_ALERTS_PER_SCAN</code> (default 5).</li>
          <li><strong>Rug screen</strong>: <code>screenRugCheck</code> in <code>src/lib/safety.ts</code> (free RugCheck), default on via <code>NEWCOIN_RUGCHECK</code>. Unverifiable mints (often too new to be indexed) are skipped, not alerted.</li>
          <li><strong>Alert</strong>: <code>formatNewCoinAlert</code> in <code>vite.config.ts</code> packs every decision criterion the scan already computed (no extra API calls) into one line and inserts it into <code>m_paper_alerts</code> with <code>dismissed=false</code>.</li>
          <li><strong>Delivery</strong>: <code>applyServerState</code> in <code>App.tsx</code> diffs server alerts against what it has seen and fires a toast + OS <code>Notification</code> for each fresh, undismissed one. With no tab open the alert simply waits in the Alerts log until one opens.</li>
        </ol>
      </div>

      <p className="flow-footnote">
        Out of scope above: alert lifecycle (no auto-dismiss timer, alerts persist until clicked; see
        the Alerts log panel on the Meme Coin tab), persistence debouncing (700ms for real changes,
        2500ms for prices-only), and the eager-Phantom auto-connect on mount. These are infrastructure
        that every flow above relies on but doesn't independently trigger.
      </p>
    </section>
    </section>
  );
}

// Visual primitives for the FlowChart. Kept tiny on purpose — every node is
// just a styled box with a title and a subtitle, every arrow is a labeled
// chevron, every branch is a horizontal row of mini-nodes. No layout library.
function FlowNode({
  kind,
  title,
  sub
}: {
  kind: "trigger" | "step" | "decision" | "gate" | "outcome";
  title: string;
  sub?: string;
}) {
  return (
    <div className={`flow-node flow-node-${kind}`}>
      <div className="flow-node-title">{title}</div>
      {sub && <div className="flow-node-sub">{sub}</div>}
    </div>
  );
}

function FlowArrow({ label }: { label?: string }) {
  return (
    <div className="flow-arrow">
      <span className="flow-arrow-line">↓</span>
      {label && <span className="flow-arrow-label">{label}</span>}
    </div>
  );
}

function FlowBranch({ cols }: { cols: ReactNode[] }) {
  return (
    <div className="flow-branch" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(0, 1fr))` }}>
      {cols.map((c, i) => (
        <div key={i} className="flow-branchwrap">
          {c}
        </div>
      ))}
    </div>
  );
}

function FlowMini({ label, detail }: { label: string; detail?: string }) {
  return (
    <div className="flow-mini">
      <div className="flow-mini-label">{label}</div>
      {detail && <div className="flow-mini-detail">{detail}</div>}
    </div>
  );
}
