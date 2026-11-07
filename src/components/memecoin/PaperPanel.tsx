import { BarChart3, ChevronDown, ChevronRight, Eye, LayoutGrid, RefreshCw } from "lucide-react";
import { useState } from "react";
import { aiReview } from "../../lib/claude";
import { fmtUsd, fmtAge } from "../../lib/markets";
import {
  portfolioStats,
  positionValue,
  tradeStats,
  sanityCheck,
  type PaperState,
  type PaperSettings,
  type PriceMap,
  type TradeEvent,
  type SanityFinding,
  type PaperPosition
} from "../../lib/paper";
import { useCollapsibleSection } from "../../hooks/useCollapsibleSection";
import { PanelTitle } from "../PanelTitle";
import { signedUsd, reasonTooltip, fmtPrice } from "../../lib/format";
import { NotifPermButton } from "./NotifPermButton";
import { NewCoinBarButton } from "./NewCoinBarButton";
import { buildAiReviewPrompt } from "../../lib/aiReviewPrompt";
import { SanityResults, AiReviewResult } from "./ReviewResults";
import { TradeStatsBlock } from "./TradeStatsBlock";
import { TradingRules } from "./TradingRules";

export function PaperPanel({
  paper,
  prices,
  cycleLog,
  cycleRunning,
  autoRun,
  watchOn,
  onRunCycle,
  onToggleAuto,
  onToggleWatch,
  onUpdateSettings,
  onSell,
  sellingId,
  onBuyReal,
  walletConnected,
  onClearRearm,
  onReset,
  onTopUp,
  onShowCoin,
  onShowMosaic,
  feePct,
  onFeePct,
  saveStatus,
  tradingMode,
  closedExpanded,
  onSetClosedExpanded,
  onAddWatch,
  serverSchedulesWatch
}: {
  paper: PaperState;
  prices: PriceMap;
  cycleLog: { at: string; events: TradeEvent[] } | null;
  cycleRunning: boolean;
  autoRun: boolean;
  watchOn: boolean;
  onRunCycle: () => void;
  onToggleAuto: () => void;
  onToggleWatch: () => void;
  onUpdateSettings: (patch: Partial<PaperSettings>) => void;
  onSell: (positionId: string) => void;
  sellingId: string | null;
  // "Buy real" on an open-position row: opens the live USDC buy flow for the
  // held coin, pre-filled with the paper position's dollar size. Disabled when
  // no wallet is connected (the live buy modal needs one to sign).
  onBuyReal: (position: PaperPosition) => void;
  walletConnected: boolean;
  onClearRearm: (positionId: string) => void;
  onReset: () => void;
  onTopUp: () => void;
  onShowCoin: (address: string) => void;
  onShowMosaic: () => void;
  feePct: number;
  closedExpanded: boolean;
  onSetClosedExpanded: (v: boolean) => void;
  // "+ Watch" button on each closed-trades row uses this to pre-fill mint +
  // symbol + name and open a quick-add prompt. See PaperPanel closed-trades
  // table for the wire-up.
  onAddWatch: (args: {
    mint: string;
    symbol?: string | null;
    name?: string | null;
    targetPriceUsd: number;
    direction: "below" | "above";
    note?: string | null;
  }) => void;
  onFeePct: (pct: number) => void;
  saveStatus: "saved" | "saving" | "error";
  tradingMode: "paper" | "real";
  // True when the server-side scheduler is firing the watch tick; the panel
  // copy below adjusts to match so the user knows the cycle runs regardless
  // of whether the browser tab is open.
  serverSchedulesWatch: boolean;
}) {
  const paperSection = useCollapsibleSection("paper-trading");
  const stats = portfolioStats(paper, prices);
  const open = paper.positions.filter((p) => p.status === "open");
  const closed = paper.positions.filter((p) => p.status === "closed");
  const tStats = tradeStats(paper, feePct);
  const [sanity, setSanity] = useState<SanityFinding[] | null>(null);
  const [aiReviewState, setAiReviewState] = useState<{
    loading: boolean;
    text?: string;
    error?: string;
  } | null>(null);
  const [closedSearch, setClosedSearch] = useState("");
  const [closedPage, setClosedPage] = useState(0);
  // Collapsed by default for fresh users; current value comes from userPrefs
  // (Postgres-backed, follows the account across devices). Setter calls the
  // prop which routes through setUserPrefs in MemeCoinPanel. Was previously
  // localStorage-only — see the 2026-05-24 "no-localStorage-for-settings"
  // migration in docs/ARCHITECTURE.md. Wrap so callers can still use the functional
  // updater pattern setClosedExpanded(v => !v).
  const setClosedExpanded = (next: boolean | ((v: boolean) => boolean)) => {
    onSetClosedExpanded(typeof next === "function" ? next(closedExpanded) : next);
  };
  const CLOSED_PAGE_SIZE = 25;
  const closedQuery = closedSearch.trim().toLowerCase();
  const closedFiltered = closedQuery
    ? closed.filter(
        (p) =>
          p.symbol.toLowerCase().includes(closedQuery) ||
          p.name.toLowerCase().includes(closedQuery)
      )
    : closed;
  const closedPageCount = Math.max(1, Math.ceil(closedFiltered.length / CLOSED_PAGE_SIZE));
  const closedPageSafe = Math.min(Math.max(0, closedPage), closedPageCount - 1);
  const closedPageItems = closedFiltered.slice(
    closedPageSafe * CLOSED_PAGE_SIZE,
    closedPageSafe * CLOSED_PAGE_SIZE + CLOSED_PAGE_SIZE
  );

  // Open positions: ticker search + click-to-sort columns.
  const [openSearch, setOpenSearch] = useState("");
  const [openSort, setOpenSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(null);
  // Selling is confirmed in the ConfirmModal popup (onSell opens it), so the
  // Sell button here is a single click.
  const openQuery = openSearch.trim().toLowerCase();
  const openFiltered = openQuery
    ? open.filter(
        (p) =>
          p.symbol.toLowerCase().includes(openQuery) ||
          p.name.toLowerCase().includes(openQuery)
      )
    : open;
  const openSortVal = (p: PaperPosition, key: string): number | string => {
    if (key === "coin") return p.symbol.toLowerCase();
    if (key === "entry") return p.entryPriceUsd;
    if (key === "now") return prices[p.address]?.priceUsd ?? 0;
    if (key === "cost") return p.costUsd;
    if (key === "value") return positionValue(p, prices);
    if (key === "pnl") return positionValue(p, prices) - p.costUsd;
    if (key === "held") return new Date(p.entryAt).getTime();
    return 0;
  };
  const openView = openSort
    ? [...openFiltered].sort((a, b) => {
        const va = openSortVal(a, openSort.key);
        const vb = openSortVal(b, openSort.key);
        const cmp =
          typeof va === "string" && typeof vb === "string"
            ? va.localeCompare(vb)
            : Number(va) - Number(vb);
        return openSort.dir === "asc" ? cmp : -cmp;
      })
    : openFiltered;
  const toggleOpenSort = (key: string) => {
    setOpenSort((cur) =>
      cur && cur.key === key
        ? { key, dir: cur.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "coin" ? "asc" : "desc" }
    );
  };
  const sortTh = (key: string, label: string) => (
    <th>
      <button className="mc-sort-th" onClick={() => toggleOpenSort(key)}>
        {label}
        {openSort?.key === key ? (openSort.dir === "asc" ? " ↑" : " ↓") : ""}
      </button>
    </th>
  );

  return (
    <section className={`panel wide ${paperSection.className}`}>
      <PanelTitle
        icon={BarChart3}
        title="Paper trading (simulation)"
        collapsed={paperSection.collapsed}
        onToggle={paperSection.toggle}
      />
      <p className="muted">
        Fake money, no wallet, no keys, no real transactions. The system buys and sells against
        real live prices so the scoring strategy can be tested at zero risk. Real execution is never
        done here or by the agent. See docs/ARCHITECTURE.md, "Trading and execution boundary".
      </p>
      <p className="muted">
        Position watch (every 5 min while it is on): alerts on a +50% run-up, sells half at +100%,
        and flags positions at risk of going to zero (collapsing liquidity, dead volume, a sudden
        dump). Alerts pop up at the top right.{" "}
        {serverSchedulesWatch
          ? "Running on the server: ticks fire whether or not this browser tab is open. An open tab polls for new alert rows and can show OS pop-ups; if the browser is closed, missed alerts surface when you reopen."
          : "It needs the dev server running and this browser tab open."}
      </p>

      <div className="mc-metrics">
        <div className="mc-metric">
          <span>Equity</span>
          <strong>{fmtUsd(stats.equity)}</strong>
        </div>
        <div className="mc-metric">
          <span>Total P&amp;L</span>
          <strong className={stats.totalPnl >= 0 ? "mc-pos" : "mc-neg"}>
            {signedUsd(stats.totalPnl)}
          </strong>
        </div>
        <div className="mc-metric">
          <span>Realized</span>
          <strong className={stats.realized >= 0 ? "mc-pos" : "mc-neg"}>
            {signedUsd(stats.realized)}
          </strong>
        </div>
        <div className="mc-metric">
          <span>Unrealized</span>
          <strong className={stats.unrealized >= 0 ? "mc-pos" : "mc-neg"}>
            {signedUsd(stats.unrealized)}
          </strong>
        </div>
        <div className="mc-metric">
          <span>Cash</span>
          <strong>{fmtUsd(paper.cashUsd)}</strong>
        </div>
        <div className="mc-metric">
          <span>Open / closed</span>
          <strong>
            {stats.openCount} / {stats.closedCount}
          </strong>
        </div>
        <div className="mc-metric">
          <span>Win rate</span>
          <strong>
            {stats.closedCount ? `${stats.winRate.toFixed(0)}% (${stats.wins}/${stats.closedCount})` : "n/a"}
          </strong>
        </div>
      </div>

      <div className="mc-controls">
        <button className="primary-button" onClick={onRunCycle} disabled={cycleRunning}>
          <RefreshCw size={16} />
          {cycleRunning ? "Running cycle..." : "Run trade cycle now"}
        </button>
        <button
          className={autoRun ? "primary-button" : "ghost-button"}
          onClick={onToggleAuto}
          disabled={tradingMode === "real"}
          title={
            tradingMode === "real"
              ? "Paper automation is off in Real mode"
              : undefined
          }
        >
          {autoRun ? "Auto-run: ON (every 60 min)" : "Auto-run: OFF"}
        </button>
        <button
          className={watchOn ? "primary-button" : "ghost-button"}
          onClick={onToggleWatch}
          disabled={tradingMode === "real"}
          title={
            tradingMode === "real"
              ? "Paper automation is off in Real mode"
              : undefined
          }
        >
          {watchOn ? "Position watch: ON (5 min)" : "Position watch: OFF"}
        </button>
        <NotifPermButton />
        <NewCoinBarButton />
        <button className="ghost-button" onClick={() => setSanity(sanityCheck(paper))}>
          Sanity check
        </button>
        <button
          className="ghost-button"
          disabled={aiReviewState?.loading}
          onClick={async () => {
            setAiReviewState({ loading: true });
            const res = await aiReview(buildAiReviewPrompt(paper, stats, tStats));
            setAiReviewState(
              res.ok
                ? { loading: false, text: res.text }
                : { loading: false, error: res.error }
            );
          }}
        >
          {aiReviewState?.loading ? "AI reviewing..." : "AI review"}
        </button>
        <button className="ghost-button" onClick={onTopUp}>
          Add $1,000 cash
        </button>
        <button className="ghost-button" onClick={onReset}>
          Reset paper account
        </button>
      </div>

      {sanity && <SanityResults findings={sanity} onDismiss={() => setSanity(null)} />}

      {aiReviewState && (
        <AiReviewResult state={aiReviewState} onDismiss={() => setAiReviewState(null)} />
      )}

      {cycleLog && (
        <div className="mc-cyclelog">
          <strong>Last action {new Date(cycleLog.at).toLocaleTimeString()}</strong>
          {cycleLog.events.map((ev, i) => (
            <div key={i} className={`mc-logline mc-log-${ev.kind}`}>
              {ev.text}
            </div>
          ))}
        </div>
      )}

      <div className="mc-subhead-row">
        <h3 className="mc-subhead">
          Open positions (
          {openQuery ? `${openFiltered.length} of ${open.length}` : open.length})
        </h3>
        {open.length > 0 && (
          <input
            className="mc-rule-input mc-closed-search"
            type="text"
            placeholder="Search ticker"
            value={openSearch}
            onChange={(e) => setOpenSearch(e.target.value)}
          />
        )}
        {open.length > 0 && (
          <button className="ghost-button mc-mosaic-btn" onClick={onShowMosaic}>
            <LayoutGrid size={14} />
            Chart mosaic
          </button>
        )}
      </div>
      {open.length === 0 ? (
        <p className="empty">No open paper positions.</p>
      ) : openFiltered.length === 0 ? (
        <p className="empty">No open positions match "{openSearch}".</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {sortTh("coin", "Coin")}
                {sortTh("entry", "Entry")}
                {sortTh("now", "Now")}
                {sortTh("cost", "Cost")}
                {sortTh("value", "Value")}
                {sortTh("pnl", "P&L")}
                {sortTh("held", "Held")}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {openView.map((p) => {
                const now = prices[p.address]?.priceUsd ?? 0;
                const value = positionValue(p, prices);
                const pnl = value - p.costUsd;
                const pnlPct = p.costUsd > 0 ? (pnl / p.costUsd) * 100 : 0;
                return (
                  <tr key={p.id}>
                    <td>
                      <button
                        className="mc-tickerlink"
                        title="Open this coin"
                        onClick={() => onShowCoin(p.address)}
                      >
                        {p.symbol}
                      </button>
                      <small>
                        {p.name}
                        {p.tookHalfProfit ? " · half sold" : ""}
                        {p.dangerAlerted ? " · flagged" : ""}
                      </small>
                      {p.rearmPrice !== undefined && p.rearmDir && (
                        <div className="mc-rearm-tag">
                          <span>
                            re-armed {p.rearmDir === "floor" ? "↓" : "↑"} $
                            {fmtPrice(p.rearmPrice)}
                          </span>
                          <button
                            className="mc-rearm-clear"
                            title="Clear the re-arm: back to the normal sell rules"
                            onClick={() => onClearRearm(p.id)}
                          >
                            ✕
                          </button>
                        </div>
                      )}
                    </td>
                    <td>${p.entryPriceUsd.toPrecision(4)}</td>
                    <td>{now > 0 ? `$${now.toPrecision(4)}` : "no price"}</td>
                    <td>{fmtUsd(p.costUsd)}</td>
                    <td>{fmtUsd(value)}</td>
                    <td className={pnl >= 0 ? "mc-pos" : "mc-neg"}>
                      {signedUsd(pnl)} ({pnl >= 0 ? "+" : ""}
                      {pnlPct.toFixed(0)}%)
                    </td>
                    <td>{fmtAge((Date.now() - new Date(p.entryAt).getTime()) / 3.6e6)}</td>
                    <td>
                      <div className="mc-row-actions">
                        <button
                          className="small-button mc-buyreal-btn"
                          disabled={!walletConnected}
                          title={
                            walletConnected
                              ? `Buy ${p.symbol} for real with USDC from your wallet (defaults to ${fmtUsd(p.costUsd)}, the paper size). Opens the live buy flow; you sign in Phantom.`
                              : "Connect your Phantom wallet first to buy for real."
                          }
                          onClick={() => onBuyReal(p)}
                        >
                          Buy real
                        </button>
                        <button
                          className="small-button"
                          disabled={sellingId !== null}
                          onClick={() => onSell(p.id)}
                        >
                          {sellingId === p.id ? "Selling..." : "Sell"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {closed.length > 0 && (
        <>
          <div className="mc-subhead-row">
            <button
              type="button"
              className="mc-collapse-toggle"
              aria-expanded={closedExpanded}
              onClick={() => setClosedExpanded((v) => !v)}
              title={closedExpanded ? "Collapse closed trades" : "Expand closed trades"}
            >
              {closedExpanded ? (
                <ChevronDown size={16} aria-hidden />
              ) : (
                <ChevronRight size={16} aria-hidden />
              )}
              <h3 className="mc-subhead">
                Closed trades (
                {closedQuery && closedExpanded
                  ? `${closedFiltered.length} of ${closed.length}`
                  : closed.length}
                )
              </h3>
            </button>
            {closedExpanded && (
              <input
                className="mc-rule-input mc-closed-search"
                type="text"
                placeholder="Search ticker"
                value={closedSearch}
                onChange={(e) => {
                  setClosedSearch(e.target.value);
                  setClosedPage(0);
                }}
              />
            )}
          </div>
          {closedExpanded && (closedFiltered.length === 0 ? (
            <p className="empty">No closed trades match "{closedSearch}".</p>
          ) : (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Coin</th>
                      <th>Algo</th>
                      <th>Entry</th>
                      <th>Exit</th>
                      <th>Now</th>
                      <th>Cost</th>
                      <th>P&amp;L</th>
                      <th>Reason</th>
                      <th>Closed</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {closedPageItems.map((p) => {
                      const now = prices[p.address]?.priceUsd ?? 0;
                      const exit = p.exitPriceUsd ?? 0;
                      const algo = p.algoVersion ?? "algo1";
                      return (
                        <tr key={p.id}>
                          <td>
                            <button
                              className="mc-tickerlink"
                              title="Open this coin"
                              onClick={() => onShowCoin(p.address)}
                            >
                              {p.symbol}
                            </button>
                          </td>
                          <td>
                            <span
                              className={`mc-algo-pill mc-algo-pill-${algo}`}
                              title={`Trade opened under ${algo}. See the Algorithm performance block below for the comparison.`}
                            >
                              {algo}
                            </span>
                          </td>
                          <td>${p.entryPriceUsd.toPrecision(4)}</td>
                          <td>${exit.toPrecision(4)}</td>
                          <td className={now > exit ? "mc-pos" : now > 0 ? "mc-neg" : ""}>
                            {now > 0 ? `$${now.toPrecision(4)}` : "-"}
                          </td>
                          <td>{fmtUsd(p.costUsd)}</td>
                          <td className={(p.pnlUsd ?? 0) >= 0 ? "mc-pos" : "mc-neg"}>
                            {signedUsd(p.pnlUsd ?? 0)}
                          </td>
                          <td>
                            {(() => {
                              // Render the exit_reason as a colored pill. "Manual" is the
                              // most common reason but the least informative on its own —
                              // append a ↑/↓ arrow based on realized P&L so the reader sees
                              // profit-take vs loss-cut without reading the P&L column too.
                              // Other reasons render verbatim; the color reflects outcome.
                              const reason = p.exitReason ?? "unknown";
                              const pnl = p.pnlUsd ?? 0;
                              const kind = pnl > 0 ? "pos" : pnl < 0 ? "neg" : "flat";
                              const isManual = reason === "manual";
                              const display = isManual
                                ? `manual ${pnl > 0 ? "↑" : pnl < 0 ? "↓" : "="}`
                                : reason;
                              const tooltip = reasonTooltip(reason, pnl);
                              return (
                                <span
                                  className={`mc-exit-reason mc-exit-reason-${kind}`}
                                  title={tooltip}
                                >
                                  {display}
                                </span>
                              );
                            })()}
                          </td>
                          <td>{p.exitAt ? new Date(p.exitAt).toLocaleString() : ""}</td>
                          <td>
                            <button
                              className="ghost-button small-button"
                              title="Set a price alert on this coin (buy-back, breakout, etc.). Prompts for target price and direction; lands in the Watchlist panel."
                              onClick={() => {
                                const ref = now > 0 ? now : exit;
                                const suggested = ref > 0 ? (ref * 0.6).toPrecision(4) : "";
                                const raw = window.prompt(
                                  `Watch ${p.symbol} at what USD price?\n\n` +
                                    `Current: ${now > 0 ? "$" + now.toPrecision(4) : "no price"}\n` +
                                    `Exit:    $${exit.toPrecision(4)}\n\n` +
                                    `Defaulting to -40% from current ($${suggested}); edit to taste.\n` +
                                    `Prefix with > for "alert when price rises ABOVE" (e.g. >0.00020).`,
                                  suggested
                                );
                                if (!raw) return;
                                const direction = raw.trim().startsWith(">") ? "above" : "below";
                                const target = parseFloat(raw.trim().replace(/^>/, ""));
                                if (!Number.isFinite(target) || target <= 0) {
                                  window.alert("Invalid target price.");
                                  return;
                                }
                                onAddWatch({
                                  mint: p.address,
                                  symbol: p.symbol,
                                  name: p.name,
                                  targetPriceUsd: target,
                                  direction
                                });
                              }}
                            >
                              <Eye size={12} /> Watch
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {closedPageCount > 1 && (
                <div className="mc-pager">
                  <button
                    className="ghost-button"
                    disabled={closedPageSafe === 0}
                    onClick={() => setClosedPage(closedPageSafe - 1)}
                  >
                    Prev
                  </button>
                  <span>
                    Page {closedPageSafe + 1} of {closedPageCount} · {closedFiltered.length} trades
                  </span>
                  <button
                    className="ghost-button"
                    disabled={closedPageSafe >= closedPageCount - 1}
                    onClick={() => setClosedPage(closedPageSafe + 1)}
                  >
                    Next
                  </button>
                </div>
              )}
            </>
          ))}
        </>
      )}

      <TradeStatsBlock stats={tStats} feePct={feePct} onFeePct={onFeePct} />

      <TradingRules settings={paper.settings} onUpdate={onUpdateSettings} saveStatus={saveStatus} />
    </section>
  );
}
