import { AlertTriangle, Copy, ExternalLink, Eye, EyeOff, Plus, Search } from "lucide-react";
import { useState } from "react";
import { fmtUsd, fmtAge, type MemeToken } from "../../lib/markets";
import { type ChatterState, type Holding } from "./types";
import { shortAddr, signedUsd } from "../../lib/format";

export function MemeCoinCard({
  token,
  chatter,
  onChatter,
  onBuy,
  onBuyLive,
  walletConnected,
  liveHeld,
  livePending,
  holding,
  hidden,
  onHide,
  onUnhide,
  anchorId,
  highlight
}: {
  token: MemeToken;
  chatter: ChatterState | undefined;
  onChatter: () => void;
  onBuy: () => void;
  onBuyLive?: () => void;
  walletConnected?: boolean;
  liveHeld?: boolean;
  livePending?: boolean;
  holding?: Holding;
  hidden?: boolean;
  onHide?: () => void;
  onUnhide?: () => void;
  // Scroll anchor: set to the coin address so new-coin alerts can jump here via
  // getElementById. Only the research-list card sets it; the history modal
  // reuses MemeCoinCard without an id to avoid a duplicate element id.
  anchorId?: string;
  // Brief highlight pulse after an alert jump (see jumpToCoin).
  highlight?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const verdictClass =
    token.verdict === "exitable" ? "exitable" : token.verdict === "caution" ? "caution" : "trap";
  const chg = token.priceChange24h;
  // Defensive: a token from a scan cached before the rating fields existed
  // would be missing these. Fall back so the card never crashes.
  const sources = token.sources ?? [token.source];
  const rating = typeof token.rating === "number" ? token.rating : token.exitScore;
  const ratingBand = token.ratingBand ?? "F";

  function copyAddress() {
    navigator.clipboard?.writeText(token.address).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {
        /* clipboard blocked; the address is still visible to select manually */
      }
    );
  }

  return (
    <div
      className={`mc-card${highlight ? " mc-card-flash" : ""}`}
      id={anchorId}
    >
      <div className="mc-card-head">
        {token.imageUrl ? (
          <img className="mc-logo" src={token.imageUrl} alt="" />
        ) : (
          <div className="mc-logo" />
        )}
        <div className="mc-name">
          <strong>{token.symbol}</strong>
          <span>
            {token.name} · {token.dexId} ·{" "}
            {sources.length > 1 ? `${sources.length} sources` : token.source}
          </span>
        </div>
        <div className="mc-spacer" />
        <span className={`mc-verdict ${verdictClass}`}>{token.verdict}</span>
        <div className="mc-score">
          <strong>{rating}</strong>
          <span>
            rating {ratingBand} · exit {token.exitScore}
          </span>
        </div>
      </div>

      {holding && (
        <div className={`mc-holding ${holding.pnlUsd >= 0 ? "pos" : "neg"}`}>
          You hold this. {fmtUsd(holding.costUsd)} in, {signedUsd(holding.pnlUsd)} (
          {holding.pnlPct >= 0 ? "+" : ""}
          {holding.pnlPct.toFixed(0)}%) right now.
        </div>
      )}

      {token.isNewSinceLastScan ? (
        <div className="mc-momentum new">New since last scan</div>
      ) : token.momentumScore !== undefined ? (
        <div className={`mc-momentum ${token.momentumScore >= 0 ? "up" : "down"}`}>
          Since last scan: volume {(token.volMomentumPct ?? 0) >= 0 ? "+" : ""}
          {(token.volMomentumPct ?? 0).toFixed(0)}%, liquidity{" "}
          {(token.liqMomentumPct ?? 0) >= 0 ? "+" : ""}
          {(token.liqMomentumPct ?? 0).toFixed(0)}%
        </div>
      ) : null}

      <div className="mc-metrics">
        <div className="mc-metric">
          <span>Liquidity</span>
          <strong>{fmtUsd(token.liquidityUsd)}</strong>
        </div>
        <div className="mc-metric">
          <span>24h volume</span>
          <strong>{fmtUsd(token.volume24h)}</strong>
        </div>
        <div
          className="mc-metric"
          title="Turnover = 24h volume divided by liquidity. Roughly 0.5x to 10x is healthy two-sided trading. Above ~25x usually means wash trading or churn before a dump."
        >
          <span>Turnover</span>
          <strong>{token.volToLiq.toFixed(1)}x</strong>
        </div>
        <div className="mc-metric">
          <span>24h trades</span>
          <strong>
            {token.txns24h} ({token.buys24h}b / {token.sells24h}s)
          </strong>
        </div>
        <div className="mc-metric">
          <span>Age</span>
          <strong>{fmtAge(token.ageHours)}</strong>
        </div>
        <div className="mc-metric">
          <span>24h price</span>
          <strong className={chg >= 0 ? "mc-pos" : "mc-neg"}>
            {chg >= 0 ? "+" : ""}
            {chg.toFixed(1)}%
          </strong>
        </div>
        <div className="mc-metric">
          <span>Market cap</span>
          <strong>{fmtUsd(token.marketCap || token.fdv)}</strong>
        </div>
        {token.top10HoldersPct !== undefined && (
          <div
            className="mc-metric"
            title="Percent of supply held by the top 10 wallets, from the Jupiter audit. Above 30 to 40% is the consensus 'back away' threshold for memecoins. Edit the Max top-10 holders rule in Trading rules to change the live-buy block threshold."
          >
            <span>Top-10 holders</span>
            <strong
              className={
                token.top10HoldersPct >= 50
                  ? "mc-neg"
                  : token.top10HoldersPct >= 25
                    ? ""
                    : "mc-pos"
              }
            >
              {token.top10HoldersPct.toFixed(1)}%
            </strong>
          </div>
        )}
        {token.botRatio !== undefined && (
          <div
            className="mc-metric"
            title="Unique wallets divided by total 24h transactions, from the Jupiter audit. Below 2% blocks a live buy in the safety gate (sniper-pump signature); below 5% warns. A healthy organic memecoin is usually 10%+ here."
          >
            <span>Unique wallets</span>
            <strong
              className={
                token.botRatio < 0.02 ? "mc-neg" : token.botRatio < 0.05 ? "" : "mc-pos"
              }
            >
              {(token.botRatio * 100).toFixed(1)}%
              {token.jupiterHolderCount !== undefined
                ? ` (${token.jupiterHolderCount.toLocaleString()} holders)`
                : ""}
            </strong>
          </div>
        )}
        {(() => {
          // Holders/day = adoption velocity. A coin with 500 holders after 3 days
          // (~167/day) passes the absolute threshold but is much weaker than the
          // same 500 holders after 1 day (~500/day). Caps at 24h age to avoid
          // divide-by-zero on freshly-launched coins.
          if (token.jupiterHolderCount === undefined || token.ageHours <= 0) return null;
          const days = Math.max(token.ageHours / 24, 1 / 24);
          const hpd = token.jupiterHolderCount / days;
          return (
            <div
              className="mc-metric"
              title="Unique holders per day = jupiterHolderCount / (ageHours / 24). Adoption velocity. The green (>= 200/day) and red (< 50/day) cutoffs are PRELIMINARY: picked from research, not calibrated against your own outcomes. Treat the color as a hint, not a verdict, until a few weeks of algo2 trade data lets us tune the thresholds from actual win-rate."
            >
              <span>Holders/day</span>
              <strong className={hpd >= 200 ? "mc-pos" : hpd < 50 ? "mc-neg" : ""}>
                {hpd >= 1000 ? `${(hpd / 1000).toFixed(1)}k` : Math.round(hpd).toLocaleString()}
              </strong>
            </div>
          );
        })()}
      </div>

      {token.riskFlags.length > 0 && (
        <div className="mc-flags">
          {token.riskFlags.map((f) => (
            <div key={f} className="mc-flag">
              <AlertTriangle size={13} />
              <span>{f}</span>
            </div>
          ))}
        </div>
      )}

      <div className="mc-detail">
        <div className="mc-detail-col">
          <span className="mc-detail-label">Why it showed up</span>
          <p className="mc-detail-text">
            <span className="mc-channel">{token.discoveryChannel}</span>
            {token.discoveryReason}
          </p>
          <p className="mc-detail-meta">
            Discovered {new Date(token.discoveredAt).toLocaleString()}
          </p>
          <p className="mc-detail-meta">First traded {fmtAge(token.ageHours)} ago</p>
        </div>
        <div className="mc-detail-col">
          <span className="mc-detail-label">Where to trade</span>
          <p className="mc-detail-meta">
            Chain: {token.chainId} · liquidity pool on {token.dexId}
          </p>
          <div className="mc-contract">
            <code>{shortAddr(token.address)}</code>
            <button className="mc-copy" onClick={copyAddress}>
              <Copy size={12} />
              {copied ? "copied" : "copy CA"}
            </button>
          </div>
          <p className="mc-detail-meta">
            Wallet: Phantom, Solflare, or Backpack. Swap through Jupiter, which routes to
            Raydium / PumpSwap / Meteora.
          </p>
        </div>
      </div>

      <div className="mc-actions">
        <a className="small-button" href={token.tradeUrl} target="_blank" rel="noreferrer">
          <ExternalLink size={14} />
          Trade on Jupiter
        </a>
        <a className="small-button" href={token.url} target="_blank" rel="noreferrer">
          <ExternalLink size={14} />
          DexScreener chart
        </a>
        <button className="small-button" onClick={onBuy} disabled={!!holding}>
          <Plus size={14} />
          {holding ? "Holding" : "Buy (paper)"}
        </button>
        {onBuyLive && (
          <button
            className="small-button"
            onClick={onBuyLive}
            disabled={!walletConnected || liveHeld || livePending}
            title={
              !walletConnected
                ? "Connect Phantom in the wallet panel to enable live buys."
                : liveHeld
                  ? "You already hold this live. Sell the open position before buying again."
                  : livePending
                    ? "A buy for this coin is signing or confirming. Wait for it to finish."
                    : "Real money. Opens a quote modal; you approve in Phantom."
            }
          >
            <Plus size={14} />
            {liveHeld
              ? "Holding (live)"
              : livePending
                ? "Pending..."
                : "Buy (live)"}
          </button>
        )}
        <button className="small-button" onClick={onChatter} disabled={chatter?.loading}>
          <Search size={14} />
          {chatter?.loading ? "Checking..." : "Check X / Reddit chatter"}
        </button>
        {hidden
          ? onUnhide && (
              <button
                className="small-button"
                onClick={onUnhide}
                title="Bring this coin back to the Visible list."
              >
                <Eye size={14} />
                Unhide
              </button>
            )
          : onHide && (
              <button
                className="small-button"
                onClick={onHide}
                title="Hide this coin from the Visible list. Find it again under the Hidden tab."
              >
                <EyeOff size={14} />
                Hide
              </button>
            )}
      </div>

      {chatter && !chatter.loading && (
        <div className="mc-chatter">
          {chatter.error && <p className="danger-text">{chatter.error}</p>}
          {chatter.data && (
            <>
              <div className="mc-chatter-counts">
                <span className="mc-count">X: {chatter.data.byPlatform.x}</span>
                <span className="mc-count">Reddit: {chatter.data.byPlatform.reddit}</span>
                <span className="mc-count">Other: {chatter.data.byPlatform.other}</span>
              </div>
              {chatter.data.items.length === 0 ? (
                <p className="muted">
                  No recent posts found. Could mean the coin is too new, or that there is no organic
                  interest yet.
                </p>
              ) : (
                chatter.data.items.slice(0, 8).map((it) => (
                  <div key={it.url} className="mc-chatter-item">
                    <span className="plat">{it.platform}</span>
                    <a href={it.url} target="_blank" rel="noreferrer">
                      {it.title}
                    </a>
                  </div>
                ))
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
