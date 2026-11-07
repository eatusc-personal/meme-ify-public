import { ExternalLink, XCircle } from "lucide-react";
import { fmtUsd, type MemeToken } from "../../lib/markets";
import { type PaperState } from "../../lib/paper";
import { type ChatterState, type Holding } from "./types";
import { MemeCoinCard } from "./MemeCoinCard";
import { signedUsd } from "../../lib/format";

// Coin detail popup. Opened by clicking a ticker in the open positions or
// closed trades tables. Shows the live scan card if the coin is in the current
// scan, plus this wallet's full trade history for that coin. Dismissible.
export function CoinPopup({
  address,
  token,
  positions,
  priceNow,
  holding,
  chatter,
  onChatter,
  onBuy,
  onClose
}: {
  // The mint address the popup was opened for. Always set (popupCoin upstream),
  // even when the coin isn't in the current scan and has no positions — needed
  // to build the DexScreener / Jupiter / Birdeye URLs for old closed trades
  // and for watchlist clicks where positions is empty.
  address: string;
  token: MemeToken | undefined;
  positions: PaperState["positions"];
  priceNow: number | undefined;
  holding?: Holding;
  chatter: ChatterState | undefined;
  onChatter: () => void;
  onBuy: () => void;
  onClose: () => void;
}) {
  const symbol = token?.symbol ?? positions[0]?.symbol ?? "Coin";
  const name = token?.name ?? positions[0]?.name ?? "";
  return (
    <div className="mc-modal-overlay" onClick={onClose}>
      <div className="mc-modal" onClick={(e) => e.stopPropagation()}>
        <div className="mc-modal-head">
          <div>
            <strong>{symbol}</strong>
            <span>{name}</span>
          </div>
          <div className="mc-spacer" />
          <button className="mc-modal-close" onClick={onClose} aria-label="close">
            <XCircle size={20} />
          </button>
        </div>
        <div className="mc-modal-body">
          {token ? (
            <MemeCoinCard
              token={token}
              holding={holding}
              chatter={chatter}
              onChatter={onChatter}
              onBuy={onBuy}
            />
          /* Buy (live) button is intentionally omitted from the popup view: the
             popup is a history detail, not a primary entry point, and we want
             live trades initiated from the live scan card with full context. */
          ) : (
            <>
              <p className="muted">
                {symbol} is not in the current scan, so there is no live scan card for it.
                {priceNow ? ` Last known price $${priceNow.toPrecision(4)}.` : ""} Run a scan to
                refresh the list, or use the chart link below to see the coin's current state on
                DexScreener / Jupiter.
              </p>
              {/* When the coin is no longer in the scan (typical for older closed
                  trades and for watchlist entries), the MemeCoinCard above isn't
                  rendered, so the user loses the chart/trade affordances it
                  provides. Reproduce the two most useful links here so any
                  popup can jump to the live DexScreener chart and Jupiter swap
                  page regardless of scan freshness. Mirrors the styling of the
                  MemeCoinCard action row. */}
              <div className="mc-actions" style={{ marginTop: 12 }}>
                <a
                  className="small-button"
                  href={`https://dexscreener.com/solana/${address}`}
                  target="_blank"
                  rel="noreferrer"
                  title="Open the live DexScreener chart for this coin"
                >
                  <ExternalLink size={14} />
                  DexScreener chart
                </a>
                <a
                  className="small-button"
                  href={`https://jup.ag/swap/USDC-${address}`}
                  target="_blank"
                  rel="noreferrer"
                  title="Open Jupiter to swap USDC for this coin"
                >
                  <ExternalLink size={14} />
                  Trade on Jupiter
                </a>
                <a
                  className="small-button"
                  href={`https://solscan.io/token/${address}`}
                  target="_blank"
                  rel="noreferrer"
                  title="Open Solscan token page (holders, transactions, transfers)"
                >
                  <ExternalLink size={14} />
                  Solscan
                </a>
              </div>
            </>
          )}
          {positions.length > 0 && (
            <>
              <h3 className="mc-subhead">
                Your {symbol} trades ({positions.length})
              </h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>Cost</th>
                      <th>Entry</th>
                      <th>Exit</th>
                      <th>P&amp;L</th>
                      <th>Opened</th>
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map((p) => (
                      <tr key={p.id}>
                        <td>{p.status}</td>
                        <td>{fmtUsd(p.costUsd)}</td>
                        <td>${p.entryPriceUsd.toPrecision(4)}</td>
                        <td>{p.exitPriceUsd ? `$${p.exitPriceUsd.toPrecision(4)}` : "open"}</td>
                        <td className={(p.pnlUsd ?? 0) >= 0 ? "mc-pos" : "mc-neg"}>
                          {p.pnlUsd != null ? signedUsd(p.pnlUsd) : "open"}
                        </td>
                        <td>{new Date(p.entryAt).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
