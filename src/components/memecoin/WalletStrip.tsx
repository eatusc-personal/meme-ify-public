import { RefreshCw, Wallet } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  connectPhantom,
  eagerConnectPhantom,
  disconnectPhantom,
  fetchSolBalance,
  fetchTokenBalance
} from "../../lib/wallet";
import { USDC_MINT } from "../../lib/swap";
import { useCollapsibleSection } from "../../hooks/useCollapsibleSection";
import { PanelTitle } from "../PanelTitle";
import { shortAddr } from "../../lib/format";

// Real-wallet connection: read-only. Connects a Phantom wallet and shows its
// address and SOL balance. No transactions here. See docs/ARCHITECTURE.md.
export function WalletStrip({ onAddress }: { onAddress: (a: string | null) => void }) {
  const section = useCollapsibleSection("wallet");
  const [address, setAddress] = useState<string | null>(null);
  const [sol, setSol] = useState<number | null>(null);
  const [usdc, setUsdc] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Fetch SOL and USDC in parallel. SOL goes through the RPC's getBalance;
  // USDC is an SPL token, summed across all the owner's token accounts for
  // the USDC mint. Both reads are independent and one failing should not
  // hide the other.
  async function loadBalance(addr: string) {
    const [s, u] = await Promise.all([
      fetchSolBalance(addr),
      fetchTokenBalance(addr, USDC_MINT)
    ]);
    if (s.ok) setSol(s.sol);
    else setError(`SOL balance read failed: ${s.error}`);
    if (u.ok) setUsdc(u.amount);
    else setError((prev) => prev ?? `USDC balance read failed: ${u.error}`);
  }

  async function connect() {
    setBusy(true);
    setError(null);
    const res = await connectPhantom();
    if (res.ok) {
      connectedRef.current = true;
      setAddress(res.address);
      onAddress(res.address);
      await loadBalance(res.address);
    } else {
      setError(res.error);
    }
    setBusy(false);
  }

  async function disconnect() {
    await disconnectPhantom();
    connectedRef.current = false;
    setAddress(null);
    setSol(null);
    setUsdc(null);
    setError(null);
    onAddress(null);
  }

  // Silent eager-connect on mount. Phantom resolves with the public key if the
  // user has previously approved this site (in Phantom's Connected Apps list);
  // otherwise the promise rejects without showing any popup. Net effect: the
  // dashboard lights up "connected" automatically on page load with no click
  // and no approval prompt, exactly when the user has already authorized us.
  //
  // Phantom injects window.solana before React mounts in normal load order,
  // but we also catch the case where the extension isn't ready yet by deferring
  // one frame and re-trying once. Anything beyond that is a real "not trusted"
  // outcome; the user clicks Connect manually.
  // Ref tracks whether ANY connect path (eager OR manual) has already
  // succeeded, so the 500ms retry doesn't fire a redundant eagerConnect
  // after the user manually clicked Connect during the retry window
  // (or after the first eager pass already succeeded). Used by the
  // useEffect below; also set by `connect()` above.
  const connectedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    async function tryEager() {
      if (connectedRef.current) return;
      const res = await eagerConnectPhantom();
      if (cancelled || connectedRef.current) return;
      if (res.ok) {
        connectedRef.current = true;
        setAddress(res.address);
        onAddress(res.address);
        await loadBalance(res.address);
      }
    }
    void tryEager();
    // Second pass: if Phantom hadn't injected yet on the first call (rare but
    // possible on slow extension load), try once more after a short delay.
    // No-op if connect already succeeded (eager first pass or user clicked).
    const retry = setTimeout(() => {
      if (cancelled || connectedRef.current) return;
      void tryEager();
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(retry);
    };
    // Mount-once; onAddress is stable from the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className={`panel wide ${section.className}`}>
      <PanelTitle
        icon={Wallet}
        title="Wallet (real, non-custodial)"
        collapsed={section.collapsed}
        onToggle={section.toggle}
      />
      <p className="muted">
        Connect a Solana wallet to read its address and balance. Your private key stays inside
        Phantom and the dashboard never sees it. Real swaps are prepared by the app and shown in
        Phantom for explicit approval before they are signed. See docs/ARCHITECTURE.md, "Live
        trading boundary".
      </p>

      {!address ? (
        <div className="mc-controls">
          <button className="primary-button" onClick={connect} disabled={busy}>
            <Wallet size={16} />
            {busy ? "Connecting..." : "Connect Phantom wallet"}
          </button>
        </div>
      ) : (
        <>
          <div className="mc-metrics">
            <div className="mc-metric">
              <span>Connected address</span>
              <strong>{shortAddr(address)}</strong>
            </div>
            <div className="mc-metric">
              <span>SOL balance</span>
              <strong>{sol === null ? "..." : `${sol.toFixed(4)} SOL`}</strong>
            </div>
            <div className="mc-metric">
              <span>USDC balance</span>
              <strong>{usdc === null ? "..." : `${usdc.toFixed(2)} USDC`}</strong>
            </div>
          </div>
          <div className="mc-controls">
            <button className="ghost-button" onClick={() => loadBalance(address)} disabled={busy}>
              <RefreshCw size={15} />
              Refresh balances
            </button>
            <button className="ghost-button" onClick={disconnect}>
              Disconnect
            </button>
          </div>
        </>
      )}

      {error && <p className="danger-text">{error}</p>}
    </section>
  );
}
