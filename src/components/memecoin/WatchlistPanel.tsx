import { Eye, Plus, XCircle } from "lucide-react";
import { useState } from "react";
import { type PriceMap } from "../../lib/paper";
import { type WatchlistEntry } from "../../lib/memecoinStore";
import { useCollapsibleSection } from "../../hooks/useCollapsibleSection";
import { PanelTitle } from "../PanelTitle";

// Watchlist panel: user-set price alerts. The position-watch tick fires
// when any active row's target hits. Triggered rows stay in the list as
// history; user can "Re-arm" (clears triggered_at) or "Remove" to clean up.
//
// Add flow: inline form at the top takes mint + target $ + direction.
// Also wired from the closed-trades row in PaperPanel (a "+ Watch" button
// that pre-fills mint+symbol) for the common "re-enter at a dip" workflow.
export function WatchlistPanel({
  watchlist,
  prices,
  onAdd,
  onDelete,
  onResetTrigger,
  onShowCoin
}: {
  watchlist: WatchlistEntry[];
  prices: PriceMap;
  onAdd: (args: {
    mint: string;
    symbol?: string | null;
    name?: string | null;
    targetPriceUsd: number;
    direction: "below" | "above";
    note?: string | null;
  }) => void;
  onDelete: (id: string) => void;
  onResetTrigger: (id: string) => void;
  onShowCoin: (address: string) => void;
}) {
  const section = useCollapsibleSection("watchlist");
  const [addMint, setAddMint] = useState("");
  const [addTarget, setAddTarget] = useState("");
  const [addDir, setAddDir] = useState<"below" | "above">("below");
  const active = watchlist.filter((w) => w.triggeredAt == null);
  const triggered = watchlist.filter((w) => w.triggeredAt != null);

  function handleAdd() {
    const mint = addMint.trim();
    const target = parseFloat(addTarget);
    if (!mint) return;
    if (!Number.isFinite(target) || target <= 0) return;
    onAdd({ mint, targetPriceUsd: target, direction: addDir });
    setAddMint("");
    setAddTarget("");
    setAddDir("below");
  }

  return (
    <section id="watchlist" className={`panel wide ${section.className}`}>
      <PanelTitle
        icon={Eye}
        title={
          watchlist.length === 0
            ? "Watchlist"
            : `Watchlist (${active.length} active${triggered.length > 0 ? `, ${triggered.length} triggered` : ""})`
        }
        collapsed={section.collapsed}
        onToggle={section.toggle}
      />
      <p className="muted">
        Price alerts for any coin, whether you currently hold it or not. The position-watch tick
        (every 5 min when Watch is ON) fetches prices for every active row; when a target is hit
        a toast fires and the row moves to "Triggered." Use this to set buy-back levels on coins
        you've already closed, or to flag coins you're interested in before they appear in your
        scan.
      </p>
      <div className="mc-watch-addrow">
        <input
          type="text"
          placeholder="Mint address (paste from the Look up box or DexScreener URL)"
          value={addMint}
          onChange={(e) => setAddMint(e.target.value)}
          className="mc-rule-input"
          style={{ flex: 2 }}
        />
        <input
          type="number"
          placeholder="Target USD price"
          value={addTarget}
          onChange={(e) => setAddTarget(e.target.value)}
          step="any"
          min="0"
          className="mc-rule-input"
          style={{ flex: 1 }}
        />
        <select
          value={addDir}
          onChange={(e) => setAddDir(e.target.value === "above" ? "above" : "below")}
          className="mc-rule-input"
        >
          <option value="below">Below (dip alert)</option>
          <option value="above">Above (breakout alert)</option>
        </select>
        <button className="primary-button" onClick={handleAdd}>
          <Plus size={14} /> Add watch
        </button>
      </div>

      {watchlist.length === 0 ? (
        <p className="empty">
          No watches yet. Add one above, or use the "+ Watch" button on any closed-trades row to
          set a buy-back alert.
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Coin</th>
                <th>Target</th>
                <th>Direction</th>
                <th>Current</th>
                <th>Status</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {watchlist.map((w) => {
                const current = prices[w.mint]?.priceUsd ?? 0;
                const triggered = w.triggeredAt != null;
                return (
                  <tr key={w.id} className={triggered ? "mc-watchrow-triggered" : ""}>
                    <td>
                      <button
                        className="mc-tickerlink"
                        onClick={() => onShowCoin(w.mint)}
                        title="Open coin details + buy"
                      >
                        {w.symbol ?? w.mint.slice(0, 8) + "…"}
                      </button>
                    </td>
                    <td>${w.targetPriceUsd.toPrecision(4)}</td>
                    <td>{w.direction === "below" ? "↓ below" : "↑ above"}</td>
                    <td>{current > 0 ? `$${current.toPrecision(4)}` : <span className="muted">no data</span>}</td>
                    <td>
                      {triggered ? (
                        <span className="mc-watch-status-triggered">
                          triggered at ${(w.triggeredPrice ?? 0).toPrecision(4)}
                        </span>
                      ) : (
                        <span className="mc-watch-status-active">active</span>
                      )}
                    </td>
                    <td className="muted">{new Date(w.createdAt).toLocaleString()}</td>
                    <td style={{ display: "flex", gap: 6 }}>
                      {triggered && (
                        <button
                          className="ghost-button small-button"
                          onClick={() => onResetTrigger(w.id)}
                          title="Re-arm: clear the trigger so this watch fires again next time the price hits."
                        >
                          Re-arm
                        </button>
                      )}
                      <button
                        className="ghost-button small-button"
                        onClick={() => onDelete(w.id)}
                        aria-label="remove watch"
                      >
                        <XCircle size={13} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
