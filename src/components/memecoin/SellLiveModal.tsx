import { RefreshCw, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
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
import { baseSymbol, type LivePosition, type LiveBaseMint } from "../../lib/live";

// Live trading sell modal. Seeded with an open live position; gets a Jupiter
// quote for token -> base, asks Phantom to sign. Defaults to selling the full
// position back to whichever base was used to buy, switchable.
export function SellLiveModal({
  position,
  walletAddress,
  currentPriceUsd,
  onConfirm,
  onClose
}: {
  position: LivePosition;
  walletAddress: string;
  currentPriceUsd: number | undefined;
  onConfirm: (args: {
    signature: string;
    tokensSold: number;
    baseAmountReceived: number;
    exitPriceUsd: number;
    reason: string;
  }) => void;
  onClose: () => void;
}) {
  const [base, setBase] = useState<LiveBaseMint>(position.baseMint);
  const [tokenAmount, setTokenAmount] = useState(String(position.entryTokenAmount));
  const [slippagePct, setSlippagePct] = useState("1.5");
  const [decimals, setDecimals] = useState<number | null>(null);
  const [decimalsError, setDecimalsError] = useState<string | null>(null);
  const [quote, setQuote] = useState<JupiterQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [signing, setSigning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getMintDecimals(position.mint).then((r) => {
      if (r.ok) setDecimals(r.decimals);
      else setDecimalsError(r.error);
    });
  }, [position.mint]);

  function clearQuote() {
    setQuote(null);
    setError(null);
  }

  async function fetchQuote() {
    clearQuote();
    const amt = Number(tokenAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError("Enter a token amount greater than zero.");
      return;
    }
    if (decimals === null) {
      setError("Token decimals not loaded yet.");
      return;
    }
    // Clamp slippage to 10% hard maximum. Same reasoning as BuyLiveModal.
    const slipBps = Math.max(1, Math.min(1000, Math.round(Number(slippagePct) * 100)));
    const baseUnits = Math.floor(amt * Math.pow(10, decimals));
    setQuoting(true);
    const q = await getQuote(position.mint, base, baseUnits, slipBps);
    setQuoting(false);
    if (!q.ok) {
      setError(`Quote failed: ${q.error}. The pool may be too thin to exit; try a smaller size.`);
      return;
    }
    setQuote(q.quote);
  }

  async function sign() {
    if (!quote) return;
    setSigning(true);
    setError(null);
    setProgress("Building swap transaction...");
    const tx = await getSwapTransaction(quote.raw, walletAddress);
    if (!tx.ok) {
      setError(`Could not build the swap: ${tx.error}`);
      setSigning(false);
      setProgress(null);
      return;
    }
    setProgress("Waiting for Phantom approval...");
    const sent = await signAndSendBase64Tx(tx.base64);
    if (!sent.ok) {
      setError(`Not sent: ${sent.error}`);
      setSigning(false);
      setProgress(null);
      return;
    }
    setProgress(`Submitted, confirming ${sent.signature.slice(0, 10)}...`);
    const conf = await confirmSignature(sent.signature);
    if (!conf.ok) {
      setError(`Could not confirm: ${conf.error}. Verify with Solscan.`);
      setSigning(false);
      setProgress(null);
      return;
    }
    setProgress("Reading on-chain fill...");
    // Base-side delta: read it honestly or abort. Recording a sell with a
    // user-typed amount would falsify P&L; the live trade log must reflect
    // the actual on-chain credit.
    let baseReceived: number;
    if (base === SOL_MINT) {
      const s = await fetchSolDelta(sent.signature, walletAddress);
      if (!s.ok) {
        setError(
          `Swap confirmed (${sent.signature}) but the on-chain SOL credit could not be read: ${s.error}. Position not closed in the ledger; verify on Solscan.`
        );
        setSigning(false);
        setProgress(null);
        return;
      }
      baseReceived = Math.max(0, s.delta);
    } else {
      const u = await fetchSwapDelta(sent.signature, walletAddress, USDC_MINT);
      if (!u.ok) {
        setError(
          `Swap confirmed (${sent.signature}) but the on-chain USDC credit could not be read: ${u.error}. Position not closed in the ledger; verify on Solscan.`
        );
        setSigning(false);
        setProgress(null);
        return;
      }
      baseReceived = Math.max(0, u.delta);
    }
    // Exit price in USD: derive from the actual fill the same way the buy
    // does. For USDC base, the received USDC is the USD value. For SOL,
    // snapshot a SOL->USDC quote at confirm time and divide.
    let exitPriceUsd = currentPriceUsd ?? 0;
    const tokensSold = Number(tokenAmount);
    if (tokensSold > 0 && baseReceived > 0) {
      if (base === USDC_MINT) {
        exitPriceUsd = baseReceived / tokensSold;
      } else {
        const solLamports = Math.max(1, Math.floor(baseReceived * 1e9));
        const usdQuote = await getQuote(SOL_MINT, USDC_MINT, solLamports);
        if (usdQuote.ok) {
          const usdReceived = Number(usdQuote.quote.outAmount) / Math.pow(10, USDC_DECIMALS);
          exitPriceUsd = usdReceived / tokensSold;
        }
        // If the SOL/USD quote fails, exitPriceUsd stays at currentPriceUsd
        // (the last-known DexScreener reading), which is approximate but
        // honest about its source. The on-chain base amount is correct.
      }
    }
    onConfirm({
      signature: sent.signature,
      tokensSold,
      baseAmountReceived: baseReceived,
      exitPriceUsd,
      reason: "manual"
    });
  }

  const baseSym = base === SOL_MINT ? "SOL" : "USDC";
  const baseDecimals = base === SOL_MINT ? SOL_DECIMALS : USDC_DECIMALS;
  const outHuman = quote ? Number(quote.outAmount) / Math.pow(10, baseDecimals) : 0;
  const tokensHeld = position.entryTokenAmount;
  const tokensRequested = Number(tokenAmount);
  const tokensExceeded = tokensRequested > tokensHeld * 1.0001;

  return (
    <div className="mc-modal-overlay" onClick={onClose}>
      <div className="mc-modal" onClick={(e) => e.stopPropagation()}>
        <div className="mc-modal-head">
          <div>
            <strong>Sell {position.symbol} (live)</strong>
            <span>
              {tokensHeld.toPrecision(6)} {position.symbol} held; entry{" "}
              {position.entryBaseAmount.toFixed(position.baseMint === SOL_MINT ? 4 : 2)}{" "}
              {baseSymbol(position.baseMint)}
            </span>
          </div>
          <div className="mc-spacer" />
          <button className="mc-modal-close" onClick={onClose} aria-label="close">
            <XCircle size={20} />
          </button>
        </div>
        <div className="mc-modal-body">
          <div className="mc-warn">
            Real Solana mainnet trade. You approve in Phantom. Position closes only after the swap
            confirms.
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
              Receive SOL
            </button>
            <button
              className={base === USDC_MINT ? "primary-button" : "ghost-button"}
              onClick={() => {
                setBase(USDC_MINT);
                clearQuote();
              }}
            >
              Receive USDC
            </button>
          </div>

          <div className="mc-settings">
            <label className="mc-setting">
              <span>Token amount</span>
              <input
                type="number"
                min={0}
                value={tokenAmount}
                onChange={(e) => {
                  setTokenAmount(e.target.value);
                  clearQuote();
                }}
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
              Slippage above 10% will be clamped to 10%.
            </p>
          )}
          {Number(slippagePct) > 3 && Number(slippagePct) <= 10 && (
            <p className="danger-text">
              Slippage above 3% opens a wide sandwich window. Lower it if the pool is thin.
            </p>
          )}
          {tokensExceeded && (
            <p className="danger-text">
              You only hold {tokensHeld.toPrecision(6)} {position.symbol}. The swap will likely
              fail.
            </p>
          )}
          {!tokensExceeded && tokensRequested > 0 && tokensRequested < tokensHeld * 0.9999 && (
            <p className="mc-detail-meta">
              Partial sell: {tokensRequested.toPrecision(6)} of {tokensHeld.toPrecision(6)}{" "}
              {position.symbol}. The remaining {(tokensHeld - tokensRequested).toPrecision(6)} stays
              open as a live position with its cost basis reduced proportionally.
            </p>
          )}

          <div className="mc-controls">
            <button
              className="ghost-button"
              onClick={fetchQuote}
              disabled={quoting || signing || decimals === null}
            >
              <RefreshCw size={15} />
              {quoting ? "Quoting..." : "Get quote"}
            </button>
            <button
              className="ghost-button"
              onClick={() => {
                setTokenAmount(String(tokensHeld));
                clearQuote();
              }}
              disabled={signing}
            >
              Use full balance
            </button>
          </div>

          {quote && (
            <div className="mc-detail">
              <div className="mc-detail-col">
                <span className="mc-detail-label">Quote</span>
                <p className="mc-detail-text">
                  Sell {tokenAmount} {position.symbol}, expect about {outHuman.toFixed(
                    base === SOL_MINT ? 6 : 4
                  )}{" "}
                  {baseSym}.
                </p>
                <p className="mc-detail-meta">
                  Price impact {(Math.abs(Number(quote.priceImpactPct ?? "0")) * 100).toFixed(2)}% ·
                  slippage {slippagePct}%
                </p>
              </div>
              <div className="mc-detail-col">
                <span className="mc-detail-label">Sign</span>
                <p className="mc-detail-meta">
                  This builds the transaction and opens Phantom. You approve there.
                </p>
                <button className="primary-button" onClick={sign} disabled={signing}>
                  {signing ? "Waiting for Phantom..." : "Review and sign in Phantom"}
                </button>
              </div>
            </div>
          )}

          {progress && <p className="mc-detail-meta">{progress}</p>}
          {error && <p className="danger-text">{error}</p>}
        </div>
      </div>
    </div>
  );
}
