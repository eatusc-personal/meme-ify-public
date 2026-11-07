import { useEffect, useState } from "react";
import { fmtUsd } from "../../lib/markets";
import { type TradeStats } from "../../lib/paper";
import { signedUsd } from "../../lib/format";

// Trade-activity counts and an estimated fee total, shown below the closed
// trades. Paper trading books no fees; the cost figures are a what-if estimate.
const REASON_LABELS: Record<string, string> = {
  "take profit": "Take-profit",
  "stop loss": "Stop-loss",
  "trailing stop": "Trailing stop",
  "max hold time": "Max hold",
  "liquidity dried up": "Liquidity death",
  "liquidity death (watch exit)": "Liquidity death (watch)",
  manual: "Manual"
};

export function TradeStatsBlock({
  stats,
  feePct,
  onFeePct
}: {
  stats: TradeStats;
  feePct: number;
  onFeePct: (pct: number) => void;
}) {
  // Local draft so the fee field can be cleared and retyped, same pattern as
  // RuleNum.
  const [feeDraft, setFeeDraft] = useState(String(feePct));
  useEffect(() => {
    setFeeDraft(String(feePct));
  }, [feePct]);

  return (
    <>
      <h3 className="mc-subhead">Trade stats and estimated cost</h3>
      <p className="muted">
        Activity for this paper account (cleared on Reset). Paper trading books no fees, so the
        cost below is a what-if estimate of what the same trading would cost for real, at the fee
        rate you set. The estimate is a percent of each swap's size, which is how a Solana DEX pool
        fee works: it scales with trade size and with how often the bot trades.
      </p>

      <div className="mc-metrics">
        <div className="mc-metric">
          <span>Positions opened</span>
          <strong>{stats.opened}</strong>
        </div>
        <div className="mc-metric">
          <span>Still open</span>
          <strong>{stats.open}</strong>
        </div>
        <div className="mc-metric">
          <span>Closed</span>
          <strong>{stats.closed}</strong>
        </div>
        <div className="mc-metric">
          <span>Scaled out at 2x</span>
          <strong>{stats.scaledOut}</strong>
        </div>
        <div className="mc-metric">
          <span>Buys</span>
          <strong>{stats.buyFills}</strong>
        </div>
        <div className="mc-metric">
          <span>Sells</span>
          <strong>{stats.sellFills}</strong>
        </div>
        <div className="mc-metric">
          <span>Total fills</span>
          <strong>{stats.totalFills}</strong>
        </div>
      </div>

      {stats.byReason.length > 0 && (
        <div className="mc-metrics">
          {stats.byReason.map((r) => (
            <div className="mc-metric" key={r.reason}>
              <span>{REASON_LABELS[r.reason] ?? r.reason}</span>
              <strong>{r.count}</strong>
            </div>
          ))}
        </div>
      )}

      {stats.byAlgo.length > 0 && (
        <div className="mc-algo-block">
          <div className="mc-rules-group">Algorithm performance (closed trades)</div>
          <p className="muted">
            Per-algo win rate and realized P&amp;L over CLOSED paper trades. <code>algo1</code> = pre-2026-05-23
            (no holder gate, min age 24h). <code>algo2</code> = current defaults (min age 72h, min holders 500,
            wider Jupiter enrichment, safety auto-dismiss). <code>custom</code> = algo2 with your settings tweaked
            off-reference. The tag is derived from the settings snapshot at trade-open time, not stamped, so the
            label always matches the rules the trade actually ran under. Realized P&amp;L excludes partial
            (+100% scale-out) profits.
          </p>
          <div className="table-wrap">
            <table className="mc-algo-table">
              <thead>
                <tr>
                  <th>Algo</th>
                  <th>Closed</th>
                  <th>Wins</th>
                  <th>Win rate</th>
                  <th>Realized P&amp;L</th>
                  <th>Avg / trade</th>
                </tr>
              </thead>
              <tbody>
                {stats.byAlgo.map((a) => (
                  <tr key={a.algoVersion}>
                    <td>
                      <span className={`mc-algo-pill mc-algo-pill-${a.algoVersion}`}>
                        {a.algoVersion}
                      </span>
                    </td>
                    <td>{a.closed}</td>
                    <td>{a.wins}</td>
                    <td>{a.winRate.toFixed(0)}%</td>
                    <td className={a.pnlUsd >= 0 ? "mc-pos" : "mc-neg"}>
                      {a.pnlUsd >= 0 ? "+" : ""}
                      {fmtUsd(a.pnlUsd)}
                    </td>
                    <td className={a.avgPnlUsd >= 0 ? "mc-pos" : "mc-neg"}>
                      {a.avgPnlUsd >= 0 ? "+" : ""}
                      {fmtUsd(a.avgPnlUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="mc-rules">
        <div className="mc-rules-group">Estimated trading cost</div>
        <div className="mc-rule">
          <div className="mc-rule-text">
            <strong>Fee per fill, %</strong>
            <span>
              Assumed cost of each buy and each sell, as a percent of its size. Roughly 0.25% to 1%
              is typical for a Solana memecoin DEX pool; default 1%.
            </span>
          </div>
          <input
            className="mc-rule-input"
            type="number"
            min={0}
            step={0.05}
            value={feeDraft}
            onChange={(e) => {
              setFeeDraft(e.target.value);
              const v = Number(e.target.value);
              if (e.target.value.trim() !== "" && Number.isFinite(v) && v >= 0) {
                onFeePct(v);
              }
            }}
            onBlur={() => {
              const v = Number(feeDraft);
              if (feeDraft.trim() === "" || !Number.isFinite(v) || v < 0) {
                setFeeDraft(String(feePct));
              }
            }}
          />
        </div>
      </div>

      <div className="mc-metrics">
        <div className="mc-metric">
          <span>Volume traded</span>
          <strong>{fmtUsd(stats.volumeTradedUsd)}</strong>
        </div>
        <div className="mc-metric">
          <span>Estimated fees</span>
          <strong className="mc-neg">
            {stats.estFeesUsd > 0 ? `-${fmtUsd(stats.estFeesUsd)}` : "$0"}
          </strong>
        </div>
        <div className="mc-metric">
          <span>Realized P&amp;L (gross)</span>
          <strong className={stats.realizedGrossUsd >= 0 ? "mc-pos" : "mc-neg"}>
            {signedUsd(stats.realizedGrossUsd)}
          </strong>
        </div>
        <div className="mc-metric">
          <span>Realized P&amp;L (after est. fees)</span>
          <strong className={stats.realizedNetUsd >= 0 ? "mc-pos" : "mc-neg"}>
            {signedUsd(stats.realizedNetUsd)}
          </strong>
        </div>
      </div>
    </>
  );
}
