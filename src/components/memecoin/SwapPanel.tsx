import { Coins, RefreshCw } from "lucide-react";
import { useState } from "react";
import { signAndSendBase64Tx } from "../../lib/wallet";
import {
  getQuote,
  getSwapTransaction,
  confirmSignature,
  SOL_MINT,
  USDC_MINT,
  SOL_DECIMALS,
  USDC_DECIMALS,
  type JupiterQuote
} from "../../lib/swap";
import { useCollapsibleSection } from "../../hooks/useCollapsibleSection";
import { PanelTitle } from "../PanelTitle";

// Phase B real trading: SOL <-> USDC swap. Quote from Jupiter, sign in Phantom.
// SOL/USDC only on purpose, so the first real tests carry no rug risk.
export function SwapPanel({ walletAddress }: { walletAddress: string | null }) {
  const section = useCollapsibleSection("swap");
  const [direction, setDirection] = useState<"sol-usdc" | "usdc-sol">("sol-usdc");
  const [amount, setAmount] = useState("0.03");
  const [quote, setQuote] = useState<JupiterQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [signing, setSigning] = useState(false);
  const [result, setResult] = useState<{ signature: string; status: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const inputIsSol = direction === "sol-usdc";
  const inputSym = inputIsSol ? "SOL" : "USDC";
  const outputSym = inputIsSol ? "USDC" : "SOL";
  const inputDecimals = inputIsSol ? SOL_DECIMALS : USDC_DECIMALS;
  const outputDecimals = inputIsSol ? USDC_DECIMALS : SOL_DECIMALS;
  const inputMint = inputIsSol ? SOL_MINT : USDC_MINT;
  const outputMint = inputIsSol ? USDC_MINT : SOL_MINT;

  function resetQuote() {
    setQuote(null);
    setResult(null);
    setError(null);
  }

  async function getQuoteClick() {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError("Enter an amount greater than zero.");
      return;
    }
    setQuoting(true);
    setError(null);
    setResult(null);
    const base = Math.floor(amt * Math.pow(10, inputDecimals));
    const res = await getQuote(inputMint, outputMint, base);
    if (res.ok) {
      setQuote(res.quote);
    } else {
      setQuote(null);
      setError(`Quote failed: ${res.error}`);
    }
    setQuoting(false);
  }

  async function signClick() {
    if (!walletAddress || !quote) return;
    setSigning(true);
    setError(null);
    const tx = await getSwapTransaction(quote.raw, walletAddress);
    if (!tx.ok) {
      setError(`Could not build the swap: ${tx.error}`);
      setSigning(false);
      return;
    }
    const sent = await signAndSendBase64Tx(tx.base64);
    if (!sent.ok) {
      setError(`Not sent: ${sent.error}`);
      setSigning(false);
      return;
    }
    setResult({ signature: sent.signature, status: "submitted, confirming..." });
    const conf = await confirmSignature(sent.signature);
    if (conf.ok) {
      setResult({ signature: sent.signature, status: conf.status });
    } else {
      setResult({ signature: sent.signature, status: "unconfirmed" });
      setError(conf.error);
    }
    setSigning(false);
  }

  const outHuman = quote ? Number(quote.outAmount) / Math.pow(10, outputDecimals) : 0;

  return (
    <section className={`panel wide ${section.className}`}>
      <PanelTitle
        icon={Coins}
        title="Swap (real money)"
        collapsed={section.collapsed}
        onToggle={section.toggle}
      />
      <div className="mc-warn">
        Real funds on Solana mainnet. Every swap is approved by you in the Phantom popup; the
        dashboard never signs. Phase B v1 is SOL and USDC only, on purpose, so the first tests
        carry no rug risk. Start with a tiny amount.
      </div>

      <div className="mc-controls">
        <button
          className={inputIsSol ? "primary-button" : "ghost-button"}
          onClick={() => {
            setDirection("sol-usdc");
            resetQuote();
          }}
        >
          SOL to USDC
        </button>
        <button
          className={!inputIsSol ? "primary-button" : "ghost-button"}
          onClick={() => {
            setDirection("usdc-sol");
            resetQuote();
          }}
        >
          USDC to SOL
        </button>
      </div>

      <div className="mc-settings">
        <label className="mc-setting">
          <span>Amount ({inputSym})</span>
          <input
            type="number"
            min={0}
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              resetQuote();
            }}
          />
        </label>
      </div>

      <div className="mc-controls">
        <button className="ghost-button" onClick={getQuoteClick} disabled={quoting || signing}>
          <RefreshCw size={15} />
          {quoting ? "Getting quote..." : "Get quote"}
        </button>
      </div>

      {quote && (
        <div className="mc-detail">
          <div className="mc-detail-col">
            <span className="mc-detail-label">Quote</span>
            <p className="mc-detail-text">
              Pay {amount} {inputSym}, receive about {outHuman.toFixed(inputIsSol ? 4 : 6)}{" "}
              {outputSym}.
            </p>
            <p className="mc-detail-meta">
              Price impact {(Number(quote.priceImpactPct) * 100).toFixed(3)}% · slippage limit 0.5%
            </p>
          </div>
          <div className="mc-detail-col">
            <span className="mc-detail-label">Sign</span>
            <p className="mc-detail-meta">
              {walletAddress
                ? "This builds the transaction and opens Phantom. You approve it there."
                : "Connect your wallet in the panel above first."}
            </p>
            <button
              className="primary-button"
              onClick={signClick}
              disabled={!walletAddress || signing}
            >
              {signing ? "Waiting for Phantom..." : "Review and sign in Phantom"}
            </button>
          </div>
        </div>
      )}

      {result && (
        <div className="mc-cyclelog">
          <strong>Swap {result.status}</strong>
          <div className="mc-logline mc-log-buy">Signature: {result.signature}</div>
          <div className="mc-logline">
            <a href={`https://solscan.io/tx/${result.signature}`} target="_blank" rel="noreferrer">
              View on Solscan
            </a>
          </div>
        </div>
      )}

      {error && <p className="danger-text">{error}</p>}
    </section>
  );
}
