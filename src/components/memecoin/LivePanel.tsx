import { Coins, LayoutGrid, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { fmtUsd, fmtAge } from "../../lib/markets";
import { type PriceMap } from "../../lib/paper";
import { fetchSolBalance, fetchTokenBalance } from "../../lib/wallet";
import { SOL_MINT, USDC_MINT } from "../../lib/swap";
import {
  liveStats,
  liveValueUsd,
  livePriceUsd,
  baseSymbol,
  type LiveState,
  type LivePosition
} from "../../lib/live";
import { useCollapsibleSection } from "../../hooks/useCollapsibleSection";
import { PanelTitle } from "../PanelTitle";
import { signedUsd } from "../../lib/format";

// Live trading panel. Real positions; wallet balance read from Phantom on
// connect and after every confirmed swap. The agent never executes; every
// row's Sell button opens a quote modal that requires a Phantom signature.
export function LivePanel({
  live,
  prices,
  walletAddress,
  onSell,
  onShowCoin,
  onShowMosaic
}: {
  live: LiveState;
  prices: PriceMap;
  walletAddress: string | null;
  onSell: (pos: LivePosition) => void;
  onShowCoin: (mint: string) => void;
  onShowMosaic: () => void;
}) {
  const liveSection = useCollapsibleSection("live-trading");
  const stats = liveStats(live, prices);
  const open = live.positions.filter((p) => p.status === "open");
  const closed = live.positions.filter((p) => p.status === "closed");
  const [sol, setSol] = useState<number | null>(null);
  const [usdc, setUsdc] = useState<number | null>(null);
  const [balancesError, setBalancesError] = useState<string | null>(null);

  async function refreshBalances() {
    if (!walletAddress) return;
    const [s, u] = await Promise.all([
      fetchSolBalance(walletAddress),
      fetchTokenBalance(walletAddress, USDC_MINT)
    ]);
    if (s.ok) setSol(s.sol);
    else setBalancesError(`SOL balance read failed: ${s.error}`);
    if (u.ok) setUsdc(u.amount);
    else setBalancesError(`USDC balance read failed: ${u.error}`);
  }

  // Re-read balances when the wallet connects and whenever an open position
  // count changes (proxy for "a swap just confirmed"). Debounced 1s so a
  // burst of state changes from one batch-confirm (each confirm sets `live`
  // separately when going through the modal path) coalesces into one
  // SOL+USDC fetch instead of N.
  useEffect(() => {
    const id = setTimeout(() => {
      void refreshBalances();
    }, 1000);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress, open.length, closed.length]);

  return (
    <section id="live-positions" className={`panel wide ${liveSection.className}`}>
      <PanelTitle
        icon={Coins}
        title="Live trading (real money)"
        collapsed={liveSection.collapsed}
        onToggle={liveSection.toggle}
      />
      <div className="mc-warn">
        Real positions on Solana mainnet. You sign every buy and sell in Phantom. The agent never
        executes and never holds keys. Under 0.5% of pump.fun launches graduate; fewer than 5% of
        memecoins keep volume past 72 hours. Even a passed safety check does not make a coin safe.
        See docs/ARCHITECTURE.md, "Live trading".
      </div>

      {!walletAddress ? (
        <p className="empty">Connect a Phantom wallet in the panel above to enable live trading.</p>
      ) : (
        <>
          <div className="mc-metrics">
            <div className="mc-metric">
              <span>SOL balance</span>
              <strong>{sol === null ? "..." : sol.toFixed(4)}</strong>
            </div>
            <div className="mc-metric">
              <span>USDC balance</span>
              <strong>{usdc === null ? "..." : usdc.toFixed(2)}</strong>
            </div>
            <div className="mc-metric">
              <span>Open value (USD)</span>
              <strong>{fmtUsd(stats.openValueUsd)}</strong>
            </div>
            <div className="mc-metric">
              <span>Unrealized (USD)</span>
              <strong className={stats.unrealizedUsd >= 0 ? "mc-pos" : "mc-neg"}>
                {signedUsd(stats.unrealizedUsd)}
              </strong>
            </div>
            <div className="mc-metric">
              <span>Realized (USD)</span>
              <strong className={stats.realizedUsd >= 0 ? "mc-pos" : "mc-neg"}>
                {signedUsd(stats.realizedUsd)}
              </strong>
            </div>
            <div className="mc-metric">
              <span>Realized (base)</span>
              <strong className={stats.realizedBase >= 0 ? "mc-pos" : "mc-neg"}>
                {stats.realizedBase >= 0 ? "+" : ""}
                {stats.realizedBase.toFixed(4)}
              </strong>
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
                {stats.closedCount
                  ? `${stats.winRate.toFixed(0)}% (${stats.wins}/${stats.closedCount})`
                  : "n/a"}
              </strong>
            </div>
          </div>

          <div className="mc-controls">
            <button className="ghost-button" onClick={refreshBalances}>
              <RefreshCw size={15} />
              Refresh balances
            </button>
          </div>

          {balancesError && <p className="danger-text">{balancesError}</p>}

          <div className="mc-subhead-row">
            <h3 className="mc-subhead">Open live positions ({open.length})</h3>
            {open.length > 0 && (
              <button className="ghost-button mc-mosaic-btn" onClick={onShowMosaic}>
                <LayoutGrid size={14} />
                Chart mosaic
              </button>
            )}
          </div>
          {open.length === 0 ? (
            <p className="empty">No open live positions.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Coin</th>
                    <th>Entry</th>
                    <th>Now</th>
                    <th>Paid</th>
                    <th>Value</th>
                    <th>P&amp;L</th>
                    <th>Opened</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {open.map((p) => {
                    const now = livePriceUsd(p, prices);
                    const valueUsd = liveValueUsd(p, prices);
                    const costUsd = p.entryTokenAmount * p.entryPriceUsd;
                    const pnl = valueUsd - costUsd;
                    const pnlPct = costUsd > 0 ? (pnl / costUsd) * 100 : 0;
                    return (
                      <tr key={p.id}>
                        <td>
                          <button
                            className="mc-tickerlink"
                            title="Open this coin"
                            onClick={() => onShowCoin(p.mint)}
                          >
                            {p.symbol}
                          </button>
                          <small>{p.name}</small>
                        </td>
                        <td>${p.entryPriceUsd.toPrecision(4)}</td>
                        <td>{now > 0 ? `$${now.toPrecision(4)}` : "no price"}</td>
                        <td>
                          {p.entryBaseAmount.toFixed(p.baseMint === SOL_MINT ? 4 : 2)}{" "}
                          {baseSymbol(p.baseMint)}
                        </td>
                        <td>{fmtUsd(valueUsd)}</td>
                        <td className={pnl >= 0 ? "mc-pos" : "mc-neg"}>
                          {signedUsd(pnl)} ({pnl >= 0 ? "+" : ""}
                          {pnlPct.toFixed(0)}%)
                        </td>
                        <td>{fmtAge((Date.now() - new Date(p.entryAt).getTime()) / 3.6e6)}</td>
                        <td>
                          <button className="small-button" onClick={() => onSell(p)}>
                            Sell (live)
                          </button>
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
              <h3 className="mc-subhead">Closed live trades ({closed.length})</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Coin</th>
                      <th>Algo</th>
                      <th>Entry</th>
                      <th>Exit</th>
                      <th>Paid</th>
                      <th>Got back</th>
                      <th>P&amp;L (USD)</th>
                      <th>P&amp;L (base)</th>
                      <th>Reason</th>
                      <th>Closed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {closed.slice(0, 30).map((p) => {
                      const algo = p.algoVersion ?? "algo1";
                      return (
                      <tr key={p.id}>
                        <td>
                          <button
                            className="mc-tickerlink"
                            onClick={() => onShowCoin(p.mint)}
                          >
                            {p.symbol}
                          </button>
                        </td>
                        <td>
                          <span
                            className={`mc-algo-pill mc-algo-pill-${algo}`}
                            title={`Trade opened under ${algo}.`}
                          >
                            {algo}
                          </span>
                        </td>
                        <td>${p.entryPriceUsd.toPrecision(4)}</td>
                        <td>
                          {p.exitPriceUsd ? `$${p.exitPriceUsd.toPrecision(4)}` : "-"}
                        </td>
                        <td>
                          {p.entryBaseAmount.toFixed(p.baseMint === SOL_MINT ? 4 : 2)}{" "}
                          {baseSymbol(p.baseMint)}
                        </td>
                        <td>
                          {(p.exitBaseAmount ?? 0).toFixed(p.baseMint === SOL_MINT ? 4 : 2)}{" "}
                          {baseSymbol(p.baseMint)}
                        </td>
                        <td className={(p.pnlUsd ?? 0) >= 0 ? "mc-pos" : "mc-neg"}>
                          {signedUsd(p.pnlUsd ?? 0)}
                        </td>
                        <td className={(p.pnlBase ?? 0) >= 0 ? "mc-pos" : "mc-neg"}>
                          {(p.pnlBase ?? 0) >= 0 ? "+" : ""}
                          {(p.pnlBase ?? 0).toFixed(4)}
                        </td>
                        <td>{p.exitReason ?? ""}</td>
                        <td>{p.exitAt ? new Date(p.exitAt).toLocaleString() : ""}</td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
