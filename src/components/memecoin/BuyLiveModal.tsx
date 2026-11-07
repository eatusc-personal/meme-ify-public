import { RefreshCw, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { type MemeToken } from "../../lib/markets";
import { fetchSwapDelta, fetchSolDelta, signAndSendBase64Tx } from "../../lib/wallet";
import {
  getQuote,
  getSwapTransaction,
  confirmSignature,
  getMintDecimals,
  SOL_MINT,
  USDC_MINT,
  SOL_DECIMALS,
  USDC_DECIMALS,
  type JupiterQuote
} from "../../lib/swap";
import { runSafetyGate, type SafetyCheck } from "../../lib/safety";
import { type LiveBaseMint } from "../../lib/live";

// Live trading buy modal. Seeded with a scanned coin; gets a Jupiter quote,
// runs the safety gate, asks Phantom to sign. The dashboard never signs and
// never custodies funds. On confirm, the actual on-chain fill is read back
// from the transaction (not the quoted fill) so the position is recorded
// honestly. See docs/ARCHITECTURE.md "Live trading".
export function BuyLiveModal({
  token,
  walletAddress,
  maxTopHoldersPct,
  defaultAmountUsd,
  onConfirm,
  onSignStart,
  onSignEnd,
  onClose
}: {
  token: MemeToken;
  walletAddress: string;
  maxTopHoldersPct: number;
  // Optional pre-fill for the amount field (in USDC). Set when the buy is
  // launched from a held paper position so the real buy defaults to the paper
  // trade's size. The default base is USDC, so this maps straight to the field.
  defaultAmountUsd?: number;
  onConfirm: (args: {
    signature: string;
    baseMint: LiveBaseMint;
    baseAmountSpent: number;
    tokenAmountReceived: number;
    entryPriceUsdAtFill: number;
    buyPriceImpactPct: number;
    slippageBps: number;
  }) => void;
  onSignStart: () => void;
  onSignEnd: () => void;
  onClose: () => void;
}) {
  // Default to USDC: real-money buys and sells are denominated in USDC. SOL is
  // just for onboarding / gas. SOL stays selectable for the rare manual case.
  const [base, setBase] = useState<LiveBaseMint>(USDC_MINT);
  const [amount, setAmount] = useState(
    defaultAmountUsd && defaultAmountUsd > 0 ? String(defaultAmountUsd) : ""
  );
  const [slippagePct, setSlippagePct] = useState("1.5");
  const [decimals, setDecimals] = useState<number | null>(null);
  const [decimalsError, setDecimalsError] = useState<string | null>(null);
  const [quote, setQuote] = useState<JupiterQuote | null>(null);
  const [safety, setSafety] = useState<SafetyCheck | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const [signing, setSigning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDecimals(null);
    setDecimalsError(null);
    getMintDecimals(token.address).then((r) => {
      if (r.ok) setDecimals(r.decimals);
      else setDecimalsError(r.error);
    });
  }, [token.address]);

  function clearQuote() {
    setQuote(null);
    setSafety(null);
    setAcknowledged(false);
    setError(null);
  }

  async function fetchQuote() {
    clearQuote();
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError("Enter an amount greater than zero.");
      return;
    }
    // Clamp slippage to 10% hard maximum. A fat-finger 150% would open a
    // very wide sandwich window where the fill could land far below the
    // shown quote; Jupiter accepts very large slippage values.
    const slipBps = Math.max(1, Math.min(1000, Math.round(Number(slippagePct) * 100)));
    const baseDecimals = base === SOL_MINT ? SOL_DECIMALS : USDC_DECIMALS;
    const baseUnits = Math.floor(amt * Math.pow(10, baseDecimals));
    setQuoting(true);
    const q = await getQuote(base, token.address, baseUnits, slipBps);
    if (!q.ok) {
      setError(`Quote failed: ${q.error}`);
      setQuoting(false);
      return;
    }
    setQuote(q.quote);
    const safe = await runSafetyGate({
      tokenMint: token.address,
      baseMint: base,
      buyQuote: q.quote,
      acknowledgedHighImpact: false,
      maxTopHoldersPct
    });
    setSafety(safe);
    setQuoting(false);
  }

  async function sign() {
    if (!quote || !safety || decimals === null) return;
    setSigning(true);
    setError(null);
    // Mark the mint as in-flight so the scan card's Buy (live) button
    // refuses a second click while we wait for confirm. Cleared in every
    // exit path below via the `endSign` helper.
    onSignStart();
    const endSign = () => {
      setSigning(false);
      setProgress(null);
      onSignEnd();
    };
    setProgress("Building swap transaction...");
    const tx = await getSwapTransaction(quote.raw, walletAddress);
    if (!tx.ok) {
      setError(`Could not build the swap: ${tx.error}`);
      endSign();
      return;
    }
    setProgress("Waiting for Phantom approval...");
    const sent = await signAndSendBase64Tx(tx.base64);
    if (!sent.ok) {
      setError(`Not sent: ${sent.error}`);
      endSign();
      return;
    }
    setProgress(`Submitted, confirming ${sent.signature.slice(0, 10)}...`);
    const conf = await confirmSignature(sent.signature);
    if (!conf.ok) {
      setError(
        `Could not confirm: ${conf.error}. Check Solscan with the signature. If the swap landed, the position will not show in this ledger (there is no manual-entry screen); your on-chain wallet balance is the record.`
      );
      endSign();
      return;
    }
    setProgress("Reading on-chain fill...");
    const tokenDelta = await fetchSwapDelta(sent.signature, walletAddress, token.address);
    if (!tokenDelta.ok || tokenDelta.delta <= 0) {
      setError(
        `Swap confirmed (${sent.signature}) but the on-chain token fill could not be read (${
          tokenDelta.ok ? "delta=0" : tokenDelta.error
        }). Position not recorded; verify on Solscan.`
      );
      endSign();
      return;
    }
    // Base-side delta: NOT a silent fallback. If the read fails, the user
    // sees an error and the position is not recorded, the same standard
    // applied to the token-side read above. Falling back to the typed
    // amount was a Rule 4 violation (record must reflect actual fill).
    let baseSpent: number;
    if (base === SOL_MINT) {
      const s = await fetchSolDelta(sent.signature, walletAddress);
      if (!s.ok) {
        setError(
          `Swap confirmed (${sent.signature}) but the on-chain SOL debit could not be read: ${s.error}. Position not recorded; verify on Solscan.`
        );
        endSign();
        return;
      }
      baseSpent = Math.abs(s.delta);
    } else {
      const u = await fetchSwapDelta(sent.signature, walletAddress, USDC_MINT);
      if (!u.ok) {
        setError(
          `Swap confirmed (${sent.signature}) but the on-chain USDC debit could not be read: ${u.error}. Position not recorded; verify on Solscan.`
        );
        endSign();
        return;
      }
      baseSpent = Math.abs(u.delta);
    }
    // Entry price from the ACTUAL fill, not the modal-open scanned price.
    // USDC base: baseSpent itself is the USD value (ignoring the trivial
    // USDC depeg). SOL base: ask Jupiter for a spot SOL->USDC quote at the
    // actual SOL spent to get a snapshot rate at confirm time.
    setProgress("Pricing fill in USD...");
    let baseSpentUsd: number;
    if (base === USDC_MINT) {
      baseSpentUsd = baseSpent;
    } else {
      const solLamports = Math.max(1, Math.floor(baseSpent * 1e9));
      const usdQuote = await getQuote(SOL_MINT, USDC_MINT, solLamports);
      if (usdQuote.ok) {
        baseSpentUsd = Number(usdQuote.quote.outAmount) / Math.pow(10, USDC_DECIMALS);
      } else {
        // Last-resort: fall back to the scanned token price. This branch
        // is rare (Jupiter has to be down) and is the only path that uses
        // the stale scanned price; the recorded entry will be approximate.
        baseSpentUsd = token.priceUsd * tokenDelta.delta;
      }
    }
    const entryPriceUsdAtFill =
      tokenDelta.delta > 0 && baseSpentUsd > 0
        ? baseSpentUsd / tokenDelta.delta
        : token.priceUsd;
    const buyImpactPct = Math.abs(Number(quote.priceImpactPct ?? "0")) * 100;
    onConfirm({
      signature: sent.signature,
      baseMint: base,
      baseAmountSpent: baseSpent,
      tokenAmountReceived: tokenDelta.delta,
      entryPriceUsdAtFill,
      buyPriceImpactPct: buyImpactPct,
      slippageBps: Math.max(1, Math.min(1000, Math.round(Number(slippagePct) * 100)))
    });
    endSign();
  }

  const baseSym = base === SOL_MINT ? "SOL" : "USDC";
  const outHuman =
    quote && decimals !== null ? Number(quote.outAmount) / Math.pow(10, decimals) : 0;
  const effectiveLevel: "ok" | "warn" | "block" | null = safety
    ? safety.level === "warn" && acknowledged
      ? "ok"
      : safety.level
    : null;
  const canSign = quote && safety && effectiveLevel === "ok" && decimals !== null && !signing;

  return (
    <div className="mc-modal-overlay" onClick={onClose}>
      <div className="mc-modal" onClick={(e) => e.stopPropagation()}>
        <div className="mc-modal-head">
          <div>
            <strong>Buy {token.symbol} (live)</strong>
            <span>Real money. You sign every trade in Phantom.</span>
          </div>
          <div className="mc-spacer" />
          <button className="mc-modal-close" onClick={onClose} aria-label="close">
            <XCircle size={20} />
          </button>
        </div>
        <div className="mc-modal-body">
          <div className="mc-warn">
            Real Solana mainnet trade. The agent never signs and never holds keys. Every click here
            triggers a Phantom popup that you approve. Start with a small amount. Memecoins commonly
            lose 99%+ within hours.
          </div>

          {decimalsError && (
            <p className="danger-text">Could not read token decimals: {decimalsError}</p>
          )}

          <div className="mc-controls">
            <button
              className={base === SOL_MINT ? "primary-button" : "ghost-button"}
              onClick={() => {
                setBase(SOL_MINT);
                clearQuote();
              }}
            >
              Pay with SOL
            </button>
            <button
              className={base === USDC_MINT ? "primary-button" : "ghost-button"}
              onClick={() => {
                setBase(USDC_MINT);
                clearQuote();
              }}
            >
              Pay with USDC
            </button>
          </div>

          <div className="mc-settings">
            <label className="mc-setting">
              <span>Amount ({baseSym})</span>
              <input
                type="number"
                min={0}
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  clearQuote();
                }}
                placeholder="e.g. 0.05"
              />
            </label>
            <label className="mc-setting">
              <span>Slippage (%)</span>
              <input
                type="number"
                min={0.1}
                max={10}
                step={0.1}
                value={slippagePct}
                onChange={(e) => {
                  setSlippagePct(e.target.value);
                  clearQuote();
                }}
              />
            </label>
          </div>
          {Number(slippagePct) > 10 && (
            <p className="danger-text">
              Slippage above 10% will be clamped to 10%. Memecoin pools move fast but a wider window
              just hands more to MEV bots.
            </p>
          )}
          {Number(slippagePct) > 3 && Number(slippagePct) <= 10 && (
            <p className="danger-text">
              Slippage above 3% opens a wide sandwich window. Lower it if the pool is thin.
            </p>
          )}

          <div className="mc-controls">
            <button
              className="ghost-button"
              onClick={fetchQuote}
              disabled={quoting || signing || decimals === null}
            >
              <RefreshCw size={15} />
              {quoting ? "Quoting + safety..." : "Get quote and safety check"}
            </button>
          </div>

          {quote && (
            <div className="mc-detail">
              <div className="mc-detail-col">
                <span className="mc-detail-label">Quote</span>
                <p className="mc-detail-text">
                  Pay {amount} {baseSym}, expect about {outHuman.toPrecision(6)} {token.symbol}.
                </p>
                <p className="mc-detail-meta">
                  Buy price impact{" "}
                  {(Math.abs(Number(quote.priceImpactPct ?? "0")) * 100).toFixed(2)}% · slippage{" "}
                  {slippagePct}%
                </p>
              </div>
              {safety && (
                <div className="mc-detail-col">
                  <span className="mc-detail-label">Safety</span>
                  <p
                    className={
                      safety.level === "block"
                        ? "danger-text"
                        : safety.level === "warn"
                          ? "mc-detail-text"
                          : "mc-detail-meta"
                    }
                  >
                    <strong>
                      {safety.level === "ok"
                        ? "Passed"
                        : safety.level === "warn"
                          ? "Warning"
                          : "Blocked"}
                    </strong>
                  </p>
                  <ul className="mc-safety-reasons">
                    {safety.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                  <p className="mc-detail-meta">
                    Sellability sim:{" "}
                    {safety.sellSim.ok
                      ? `${safety.sellSim.priceImpactPct.toFixed(2)}% exit impact`
                      : `failed (${safety.sellSim.error})`}
                  </p>
                  <p className="mc-detail-meta">
                    RugCheck:{" "}
                    {safety.rugcheck.ok
                      ? `${safety.rugcheck.risks.length} risk${safety.rugcheck.risks.length === 1 ? "" : "s"}${safety.rugcheck.level ? `, level ${safety.rugcheck.level}` : ""}`
                      : `failed (${safety.rugcheck.error})`}
                  </p>
                  <p className="mc-detail-meta">
                    Jupiter:{" "}
                    {safety.jupiter.ok
                      ? safety.jupiter.found
                        ? `organic score ${safety.jupiter.organicScoreLabel ?? "n/a"}${
                            safety.jupiter.holderCount != null
                              ? `, ${safety.jupiter.holderCount} holders`
                              : ""
                          }${safety.jupiter.isVerified ? ", verified" : ""}`
                        : "no listing yet"
                      : `unavailable (${safety.jupiter.error})`}
                  </p>
                  {safety.level === "warn" && (
                    <label className="mc-ack">
                      <input
                        type="checkbox"
                        checked={acknowledged}
                        onChange={(e) => setAcknowledged(e.target.checked)}
                      />
                      <span>
                        I have read the warnings above and accept the risk. Proceed.
                      </span>
                    </label>
                  )}
                </div>
              )}
            </div>
          )}

          {canSign && (
            <div className="mc-controls">
              <button className="primary-button" onClick={sign} disabled={signing}>
                {signing ? "Waiting for Phantom..." : "Review and sign in Phantom"}
              </button>
            </div>
          )}

          {progress && <p className="mc-detail-meta">{progress}</p>}
          {error && <p className="danger-text">{error}</p>}
        </div>
      </div>
    </div>
  );
}
