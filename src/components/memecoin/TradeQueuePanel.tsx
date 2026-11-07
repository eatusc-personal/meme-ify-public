import { ListChecks } from "lucide-react";
import { useState } from "react";
import { fmtUsd } from "../../lib/markets";
import {
  type PaperSettings,
  type PriceMap,
  type TradeIntent,
  type DismissedBuyIntent
} from "../../lib/paper";
import { type SafetyCheck } from "../../lib/safety";
import { fmtPrice } from "../../lib/format";
import { useCollapsibleSection } from "../../hooks/useCollapsibleSection";
import { PanelTitle } from "../PanelTitle";

// The trade queue: in queue mode the cycle proposes trades here for review.
// Tick the ones to approve, dismiss the rest, approve the selected batch in
// one action. This is the exact flow real-money trading will use.
// One editable row in the Trade queue. Buy rows expose an editable size and an
// optional limit price; sell rows expose a sell %. A sell row can also be
// re-armed: instead of approving or dismissing, hold the position and set a
// price level at which the queue re-proposes it.
function QueueRow({
  intent,
  selected,
  priceNow,
  safety,
  onToggle,
  onEdit,
  onDismiss,
  onRearm,
  onClearRearm,
  onShowCoin
}: {
  intent: TradeIntent;
  selected: boolean;
  priceNow: number | undefined;
  safety?: { loading: boolean; result?: SafetyCheck; error?: string };
  onToggle: () => void;
  onEdit: (patch: Partial<TradeIntent>) => void;
  onDismiss: () => void;
  onRearm: (magnitudePct: number, dir: "floor" | "ceil") => void;
  onClearRearm: () => void;
  onShowCoin: () => void;
}) {
  const isBuy = intent.kind === "buy";
  const [sizeDraft, setSizeDraft] = useState(String(intent.sizeUsd ?? ""));
  const [limitDraft, setLimitDraft] = useState(
    intent.limitPrice != null ? String(intent.limitPrice) : ""
  );
  const [pctDraft, setPctDraft] = useState(String(intent.sellPct ?? 100));
  // A sell that fired on a downside trigger defaults the re-arm to "price
  // falls"; an upside trigger (take-profit, scale-out) defaults to "price rises".
  const downTrigger =
    intent.trigger === "stop-loss" ||
    intent.trigger === "liquidity" ||
    intent.trigger === "max-hold";
  const [rearmOpen, setRearmOpen] = useState(false);
  const [rearmMag, setRearmMag] = useState("50");
  const [rearmDir, setRearmDir] = useState<"floor" | "ceil">(downTrigger ? "floor" : "ceil");
  const rearmMagNum = Number(rearmMag);
  const rearmLevel =
    priceNow && priceNow > 0 && Number.isFinite(rearmMagNum) && rearmMagNum >= 0
      ? rearmDir === "floor"
        ? priceNow * (1 - rearmMagNum / 100)
        : priceNow * (1 + rearmMagNum / 100)
      : 0;

  return (
    <>
      <tr>
        <td>
          <input type="checkbox" checked={selected} onChange={onToggle} />
        </td>
        <td className={isBuy ? "mc-pos" : "mc-neg"}>
          <strong>{isBuy ? "Buy" : "Sell"}</strong>
          {intent.account === "live" && <span className="mc-queue-live">LIVE</span>}
          {!isBuy && intent.trigger && (
            <div className="mc-queue-trigger">{intent.trigger}</div>
          )}
          {isBuy ? (
            <div className="mc-queue-edit">
              <label>
                Size $
                <input
                  type="number"
                  min={1}
                  value={sizeDraft}
                  onChange={(e) => {
                    setSizeDraft(e.target.value);
                    const v = Number(e.target.value);
                    if (e.target.value.trim() !== "" && Number.isFinite(v) && v >= 1) {
                      onEdit({ sizeUsd: v });
                    }
                  }}
                  onBlur={() => {
                    const v = Number(sizeDraft);
                    if (sizeDraft.trim() === "" || !Number.isFinite(v) || v < 1) {
                      setSizeDraft(String(intent.sizeUsd ?? ""));
                    }
                  }}
                />
              </label>
              <label>
                Limit $
                <input
                  type="number"
                  min={0}
                  placeholder="none"
                  value={limitDraft}
                  onChange={(e) => {
                    setLimitDraft(e.target.value);
                    if (e.target.value.trim() === "") {
                      onEdit({ limitPrice: undefined });
                      return;
                    }
                    const v = Number(e.target.value);
                    if (Number.isFinite(v) && v > 0) onEdit({ limitPrice: v });
                  }}
                />
              </label>
            </div>
          ) : (
            <div className="mc-queue-edit">
              <label>
                Sell %
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={pctDraft}
                  onChange={(e) => {
                    setPctDraft(e.target.value);
                    const v = Number(e.target.value);
                    if (
                      e.target.value.trim() !== "" &&
                      Number.isFinite(v) &&
                      v >= 1 &&
                      v <= 100
                    ) {
                      onEdit({ sellPct: v });
                    }
                  }}
                  onBlur={() => {
                    const v = Number(pctDraft);
                    if (pctDraft.trim() === "" || !Number.isFinite(v) || v < 1 || v > 100) {
                      setPctDraft(String(intent.sellPct ?? 100));
                    }
                  }}
                />
              </label>
            </div>
          )}
        </td>
        <td>
          <button
            className="mc-tickerlink"
            title="Open this coin's details"
            onClick={onShowCoin}
          >
            {intent.symbol}
          </button>
          <a
            className="mc-queue-chart"
            href={`https://dexscreener.com/solana/${intent.address}`}
            target="_blank"
            rel="noreferrer"
            title="Open the DexScreener chart for this coin"
          >
            Chart &#8599;
          </a>
        </td>
        <td>
          {intent.reason}
          {isBuy && safety && (
            <div
              className={`mc-queue-safety mc-queue-safety-${
                safety.loading || (!safety.result && !safety.error)
                  ? "pending"
                  : safety.error
                    ? "warn"
                    : safety.result
                      ? safety.result.level
                      : "pending"
              }`}
            >
              {safety.loading
                ? "Safety: checking RugCheck + sellability..."
                : safety.error
                  ? `Safety check unavailable: ${safety.error}`
                  : safety.result
                    ? `Safety: ${
                        safety.result.level === "ok"
                          ? "passed"
                          : safety.result.level === "warn"
                            ? "warning"
                            : "BLOCKED"
                      } — ${safety.result.reasons.slice(0, 2).join(" ")}`
                    : ""}
            </div>
          )}
        </td>
        <td>{new Date(intent.decidedAt).toLocaleTimeString()}</td>
        <td>
          <div className="mc-queue-actions">
            {!isBuy && intent.account !== "live" && (
              <button className="small-button" onClick={() => setRearmOpen((v) => !v)}>
                {rearmOpen ? "Cancel re-arm" : "Re-arm"}
              </button>
            )}
            {!isBuy && intent.account !== "live" && intent.trigger === "rearm" && (
              <button
                className="small-button"
                title="Drop the re-arm level, back to normal sell rules"
                onClick={onClearRearm}
              >
                Clear re-arm
              </button>
            )}
            <button className="small-button" onClick={onDismiss}>
              Dismiss
            </button>
          </div>
        </td>
      </tr>
      {!isBuy && rearmOpen && (
        <tr className="mc-queue-rearm">
          <td></td>
          <td colSpan={5}>
            <div className="mc-queue-rearm-box">
              <span>Don't sell. Re-arm: alert me again when price moves</span>
              <input
                type="number"
                min={0}
                value={rearmMag}
                onChange={(e) => setRearmMag(e.target.value)}
              />
              <span>%</span>
              <select
                value={rearmDir}
                onChange={(e) => setRearmDir(e.target.value as "floor" | "ceil")}
              >
                <option value="floor">down (price falls)</option>
                <option value="ceil">up (price rises)</option>
              </select>
              <span className="mc-queue-rearm-level">
                {rearmLevel > 0 ? `target $${fmtPrice(rearmLevel)}` : "no current price"}
              </span>
              <button
                className="small-button"
                disabled={!(rearmLevel > 0)}
                onClick={() => {
                  onRearm(rearmMagNum, rearmDir);
                  setRearmOpen(false);
                }}
              >
                Re-arm at this level
              </button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export function TradeQueuePanel({
  queue,
  queueMode,
  settings,
  prices,
  safety,
  dismissedBuyIntents,
  onToggleMode,
  onApprove,
  onDismiss,
  onEditIntent,
  onRearm,
  onClearRearm,
  onShowCoin
}: {
  queue: TradeIntent[];
  queueMode: boolean;
  settings: PaperSettings;
  prices: PriceMap;
  safety: Record<string, { loading: boolean; result?: SafetyCheck; error?: string }>;
  // Used to explain an empty queue. When a buy intent is auto-dismissed by
  // the safety gate, the user can land on this panel via the "N trade
  // proposed" toast and see nothing. The empty state surfaces the recent
  // safety dismissals inline so the disappearance has a visible cause.
  dismissedBuyIntents: DismissedBuyIntent[];
  onToggleMode: () => void;
  onApprove: (ids: string[]) => void;
  onDismiss: (id: string) => void;
  onEditIntent: (id: string, patch: Partial<TradeIntent>) => void;
  onRearm: (id: string, magnitudePct: number, dir: "floor" | "ceil") => void;
  onClearRearm: (positionId: string) => void;
  onShowCoin: (address: string) => void;
}) {
  const section = useCollapsibleSection("trade-queue");
  const s = settings;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectedCount = queue.filter((q) => selected.has(q.id)).length;
  return (
    <section className={`panel wide ${section.className}`} id="trade-queue">
      <PanelTitle
        icon={ListChecks}
        title={queue.length > 0 ? `Trade queue (${queue.length} waiting)` : "Trade queue"}
        collapsed={section.collapsed}
        onToggle={section.toggle}
      />
      <p className="muted">
        Queue mode routes the bot's buy and sell decisions here for review
        instead of executing them. Tick the ones you want, dismiss the rest,
        and approve the selected batch in one action. This is the exact flow
        real-money trading will use; for now it books paper trades, the
        real-money version swaps the approve step for one Phantom signature.
      </p>
      <div className="mc-queue-explain">
        <strong>What gets queued each cycle</strong>
        <p>
          <b>Buys</b> — a scanned coin that clears the buy rules: exit score at
          least {s.minExitScore}, liquidity at least {fmtUsd(s.minLiquidityUsd)},
          age at least {s.minAgeHours}h, at least {s.minHolderCount} unique
          holders when Jupiter has the data, a coin you do not already hold,
          not in the re-entry cooldown, and an open slot.
        </p>
        <p>
          <b>Sells</b> — an open position that hits an exit: liquidity collapse
          under $3k, the +100% scale-out (sell half), take profit at +
          {s.takeProfitPct}%, stop loss at -{s.stopLossPct}%, or max hold at{" "}
          {s.maxHoldHours}h.
        </p>
        <p>
          Edit any row before approving: a buy's size or a limit price, a sell's
          %. On a sell you can also <b>Re-arm</b> instead of approving or
          dismissing, which holds the position and re-proposes it only when
          price reaches a level you set. In queue mode the position watch
          proposes sells here too and never auto-sells.
        </p>
      </div>
      <div className="mc-controls">
        <button
          className={queueMode ? "primary-button" : "ghost-button"}
          onClick={onToggleMode}
        >
          {queueMode ? "Queue mode: ON" : "Queue mode: OFF"}
        </button>
        <button
          className="primary-button"
          disabled={selectedCount === 0}
          onClick={() => {
            onApprove([...selected]);
            setSelected(new Set());
          }}
        >
          Approve selected ({selectedCount})
        </button>
      </div>
      {!queueMode && (
        <p className="muted">
          Queue mode is off, so the trade cycle executes paper trades directly.
          Turn it on to route them here for review first.
        </p>
      )}
      {queue.length === 0 ? (
        (() => {
          // When the queue is empty, surface any recent safety-gate auto-dismissals
          // inline. Without this, a user clicking the "N trade proposed" toast lands
          // on an empty queue with no context for what happened to their trades.
          // Window: 5 minutes, matches the position-watch cadence so a recently
          // ticked cycle's dismissals are always visible.
          const RECENT_WINDOW_MS = 5 * 60 * 1000;
          const cutoff = Date.now() - RECENT_WINDOW_MS;
          const recentAuto = dismissedBuyIntents.filter(
            (d) =>
              d.source === "auto-safety-block" &&
              new Date(d.dismissedAt).getTime() >= cutoff
          );
          if (recentAuto.length === 0) {
            return (
              <p className="empty">
                Queue is empty. With queue mode on, run a trade cycle and the bot's
                proposed trades appear here for review.
              </p>
            );
          }
          return (
            <div className="empty mc-queue-recent-dismiss">
              <p>
                <strong>Queue is empty.</strong> The safety gate auto-dismissed{" "}
                {recentAuto.length} proposed trade{recentAuto.length === 1 ? "" : "s"}{" "}
                in the last 5 minutes. If you arrived here from the "N trade
                proposed" toast, this is why nothing's here to review.
              </p>
              <ul className="mc-queue-recent-dismiss-list">
                {recentAuto.slice(0, 10).map((d) => (
                  <li key={`${d.address}-${d.dismissedAt}`}>
                    <strong>{d.symbol}</strong>
                    {d.reason ? <span> &mdash; {d.reason}</span> : null}
                    <span className="muted">
                      {" "}({new Date(d.dismissedAt).toLocaleTimeString()})
                    </span>
                  </li>
                ))}
                {recentAuto.length > 10 && (
                  <li className="muted">
                    + {recentAuto.length - 10} more, see the Alerts log for the
                    full record.
                  </li>
                )}
              </ul>
            </div>
          );
        })()
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Trade</th>
                <th>Coin</th>
                <th>Why the bot proposed it</th>
                <th>Proposed</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {queue.map((q) => (
                <QueueRow
                  key={q.id}
                  intent={q}
                  selected={selected.has(q.id)}
                  priceNow={prices[q.address]?.priceUsd}
                  safety={safety[q.address]}
                  onToggle={() => toggle(q.id)}
                  onEdit={(patch) => onEditIntent(q.id, patch)}
                  onDismiss={() => onDismiss(q.id)}
                  onRearm={(mag, dir) => onRearm(q.id, mag, dir)}
                  onClearRearm={() => q.positionId && onClearRearm(q.positionId)}
                  onShowCoin={() => onShowCoin(q.address)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
