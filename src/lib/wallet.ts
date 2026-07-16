// Non-custodial Solana wallet connection for the Meme Coin tab.
//
// Phase A (this file): connect a Phantom wallet and read its public address
// and SOL balance. READ-ONLY. No transactions, no signing, no private keys.
// The key never leaves the Phantom extension and the dashboard never sees it.
//
// Phase B: prepare-and-sign swaps via Jupiter. The wallet signs and the user
// approves every trade in Phantom's own popup. The dashboard only ever hands
// Phantom an unsigned transaction. See docs/ARCHITECTURE.md "Real trading".

import { Transaction, VersionedTransaction } from "@solana/web3.js";

type AnyTx = VersionedTransaction | Transaction;

type PhantomProvider = {
  isPhantom?: boolean;
  publicKey?: { toString(): string } | null;
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: { toString(): string } }>;
  disconnect: () => Promise<void>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  signAndSendTransaction: (tx: AnyTx) => Promise<{ signature: string }>;
  // Batch signing: one approval, N transactions. The caller broadcasts them.
  signAllTransactions?: (txs: AnyTx[]) => Promise<AnyTx[]>;
};

function deserializeTx(base64: string): AnyTx {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  // Jupiter usually returns a v0 transaction; some routes return legacy.
  try {
    return VersionedTransaction.deserialize(bytes);
  } catch {
    return Transaction.from(bytes);
  }
}

function txToBase64(tx: AnyTx): string {
  const bytes = tx.serialize();
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function getPhantom(): PhantomProvider | null {
  const w = window as unknown as {
    solana?: PhantomProvider;
    phantom?: { solana?: PhantomProvider };
  };
  if (w.solana?.isPhantom) return w.solana;
  if (w.phantom?.solana?.isPhantom) return w.phantom.solana;
  return null;
}

export function phantomAvailable(): boolean {
  return getPhantom() !== null;
}

export async function connectPhantom(): Promise<
  { ok: true; address: string } | { ok: false; error: string }
> {
  const p = getPhantom();
  if (!p) {
    return {
      ok: false,
      error: "Phantom wallet not detected. Install the Phantom browser extension, then reload."
    };
  }
  try {
    const res = await p.connect();
    return { ok: true, address: res.publicKey.toString() };
  } catch (e) {
    // User rejecting the connection prompt lands here too.
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Silent eager-connect: only succeeds if the user has previously approved this
// site in Phantom (the "trusted apps" list). Phantom does NOT show a popup
// when the site is trusted — it just resolves with the public key. If it
// isn't trusted, the promise rejects silently (no popup either) and we leave
// the user in the disconnected state until they click Connect manually.
//
// Spec: https://docs.phantom.com/solana/integrating-phantom/eagerly-connect-to-phantom-1
export async function eagerConnectPhantom(): Promise<
  { ok: true; address: string } | { ok: false }
> {
  const p = getPhantom();
  if (!p) return { ok: false };
  try {
    const res = await p.connect({ onlyIfTrusted: true });
    return { ok: true, address: res.publicKey.toString() };
  } catch {
    // Either Phantom isn't installed, the site isn't trusted, or the user
    // revoked trust. Any of these mean "stay disconnected, no popup."
    return { ok: false };
  }
}

export async function disconnectPhantom(): Promise<void> {
  const p = getPhantom();
  if (p) {
    try {
      await p.disconnect();
    } catch {
      /* ignore: disconnecting is best-effort */
    }
  }
}

// Hand an unsigned (base64) transaction to Phantom. Phantom shows its own
// approval popup, the user approves, Phantom signs and broadcasts it. The
// dashboard never sees the key and never signs. Returns the tx signature.
export async function signAndSendBase64Tx(
  base64: string
): Promise<{ ok: true; signature: string } | { ok: false; error: string }> {
  const p = getPhantom();
  if (!p) return { ok: false, error: "Phantom wallet not detected." };
  try {
    const result = await p.signAndSendTransaction(deserializeTx(base64));
    return { ok: true, signature: result.signature };
  } catch (e) {
    // User rejecting the Phantom popup lands here too.
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Batch-sign N unsigned (base64) transactions in a single Phantom approval.
// Returns the signed transactions as base64; the caller broadcasts each via
// the RPC (sendRawTx in swap.ts). The dashboard never sees the key. Used by
// the Trade queue's "Approve selected" so a batch of real trades is one click.
export async function signAllBase64Txs(
  base64s: string[]
): Promise<{ ok: true; signed: string[] } | { ok: false; error: string }> {
  const p = getPhantom();
  if (!p) return { ok: false, error: "Phantom wallet not detected." };
  if (typeof p.signAllTransactions !== "function") {
    return {
      ok: false,
      error: "This wallet does not support batch signing (signAllTransactions)."
    };
  }
  try {
    const signed = await p.signAllTransactions(base64s.map(deserializeTx));
    return { ok: true, signed: signed.map(txToBase64) };
  } catch (e) {
    // User rejecting the Phantom approval lands here too.
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// SOL balance via the proxied Solana JSON-RPC. Read-only.
export async function fetchSolBalance(
  address: string
): Promise<{ ok: true; sol: number } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/solana-rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [address] })
    });
    const data = await res.json();
    if (data.error) {
      return { ok: false, error: data.error.message || JSON.stringify(data.error) };
    }
    const lamports = data.result?.value ?? 0;
    return { ok: true, sol: lamports / 1e9 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// SPL token balance for a given owner and mint. Sums every token account the
// owner controls for that mint. Returns 0 with ok:true when the owner has no
// account for the mint (a fresh wallet that has never held the token).
export async function fetchTokenBalance(
  owner: string,
  mint: string
): Promise<{ ok: true; amount: number } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/solana-rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenAccountsByOwner",
        params: [owner, { mint }, { encoding: "jsonParsed" }]
      })
    });
    const data = await res.json();
    if (data.error) {
      return { ok: false, error: data.error.message || JSON.stringify(data.error) };
    }
    const accounts: Array<{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: number | null } } } } } }> =
      data.result?.value ?? [];
    let total = 0;
    for (const a of accounts) {
      const ui = a?.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
      if (typeof ui === "number") total += ui;
    }
    return { ok: true, amount: total };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// getTransaction with retry-on-empty-meta. Right after a swap confirms, the
// RPC node has the signature in its commitment status but the meta payload
// (token balances, fee, etc.) hasn't been indexed yet. A single immediate
// call returns ok:true with an empty meta, which used to be misclassified as
// "could not be read" and abandoned the position record. Real-money 2026-05-23
// hit this: confirmed LMAO! swap, lost the position record, recovered via
// scripts/recover_live_position.mjs. The retry loop here is the fix.
//
// Backoff: 1s, 2s, 3s, 5s, 8s. Worst case ~19s; typical 1-3s. Helius reliably
// has meta within the first 3 attempts.
// Module-level cache + in-flight dedup so multiple callers reading deltas off
// the SAME transaction signature (e.g. fetchSwapDelta token + fetchSwapDelta
// USDC for one buy, called back-to-back in executeLiveBatch) share one
// upstream getTransaction + retry chain. Each live trade used to pay the full
// 1/2/3/5/8s retry budget twice; now it's once per signature for 60s.
//
// TTL is short (60s) because we only need the dedup window long enough to
// cover all the delta-reads any single confirm-path makes for one signature.
// We aren't trying to cache long-term — confirmed txs don't change but the
// memory cost of holding them indefinitely isn't worth it.
type CachedTx = { ok: true; result: any } | { ok: false; error: string };
const txCache = new Map<string, { entry: CachedTx; at: number }>();
const txInFlight = new Map<string, Promise<CachedTx>>();
const TX_CACHE_TTL_MS = 60_000;

async function getTransactionWithRetry(
  signature: string,
  opts: { attempts?: number } = {}
): Promise<CachedTx> {
  // Cache hit.
  const cached = txCache.get(signature);
  if (cached && Date.now() - cached.at < TX_CACHE_TTL_MS) {
    return cached.entry;
  }
  // In-flight hit — re-await the same Promise instead of re-issuing.
  const inFlight = txInFlight.get(signature);
  if (inFlight) return inFlight;

  const p = (async (): Promise<CachedTx> => {
    const delays = [1000, 2000, 3000, 5000, 8000];
    const attempts = opts.attempts ?? delays.length;
    let lastError = "Transaction meta not found yet, try again in a moment.";
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch("/api/solana-rpc", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getTransaction",
            params: [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]
          })
        });
        const data = await res.json();
        if (data.error) {
          // Hard RPC error (e.g. invalid signature) — no point retrying in
          // this call. Returned uncached so a follow-up call gets a fresh
          // attempt rather than the stale failure (see the cache write
          // below for why we don't cache failures at all).
          const result: CachedTx = {
            ok: false,
            error: data.error.message || JSON.stringify(data.error)
          };
          return result;
        }
        if (data.result?.meta) {
          return { ok: true, result: data.result };
        }
        lastError = "Transaction meta not found yet (gave up after retries).";
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, delays[i] ?? 8000));
      }
    }
    return { ok: false, error: lastError };
  })();
  txInFlight.set(signature, p);
  try {
    const entry = await p;
    // Cache only success. The retry-exhausted failure path (line ~281) is
    // typically transient — node lag, propagation delay — and caching it for
    // 60s would freeze in a stale failure for any caller that comes in
    // during that window. The 2026-05-23 LMAO! recovery (line ~211) was
    // exactly this failure mode amplified; caching it would make it worse.
    // In-flight dedup above still gives us the concurrent-call savings; this
    // only changes behavior for back-to-back calls after the first resolves.
    if (entry.ok) {
      txCache.set(signature, { entry, at: Date.now() });
    }
    return entry;
  } finally {
    txInFlight.delete(signature);
  }
}

// After a swap confirms, read the actual change in the owner's token balance
// for a given mint by diffing the transaction's pre/post token balances.
// Used by the live trading path so the position records the ACTUAL fill, not
// the quoted one. Returns the amount in human (uiAmount) units. Retries the
// underlying getTransaction call on empty meta — see getTransactionWithRetry.
export async function fetchSwapDelta(
  signature: string,
  owner: string,
  mint: string
): Promise<{ ok: true; delta: number } | { ok: false; error: string }> {
  const tx = await getTransactionWithRetry(signature);
  if (!tx.ok) return tx;
  const meta = tx.result.meta;
  const pre: Array<{ owner?: string; mint?: string; uiTokenAmount: { uiAmount: number | null } }> =
    meta.preTokenBalances ?? [];
  const post: Array<{ owner?: string; mint?: string; uiTokenAmount: { uiAmount: number | null } }> =
    meta.postTokenBalances ?? [];
  const sum = (rows: typeof pre) =>
    rows
      .filter((r) => r.owner === owner && r.mint === mint)
      .reduce((s, r) => s + (r.uiTokenAmount?.uiAmount ?? 0), 0);
  return { ok: true, delta: sum(post) - sum(pre) };
}

// Same as fetchSwapDelta but for native SOL balance, used when the user pays
// in SOL (or sells back to SOL). Solana stores SOL in account lamports, not
// token accounts, so this reads pre/postBalances at the owner's index.
export async function fetchSolDelta(
  signature: string,
  owner: string
): Promise<{ ok: true; delta: number } | { ok: false; error: string }> {
  const tx = await getTransactionWithRetry(signature);
  if (!tx.ok) return tx;
  const meta = tx.result.meta;
  const message = tx.result.transaction?.message;
  const keys: Array<{ pubkey: string }> = message?.accountKeys ?? [];
  const idx = keys.findIndex((k) => k.pubkey === owner);
  if (idx < 0) {
    return { ok: false, error: "Owner not present in transaction account list." };
  }
  const preLamports: number = meta.preBalances?.[idx] ?? 0;
  const postLamports: number = meta.postBalances?.[idx] ?? 0;
  // Subtract the fee from the SOL delta so a buy in SOL reports the
  // actual SOL spent on the swap, not swap+fee combined.
  const fee: number = meta.fee ?? 0;
  const adjustedPre = preLamports;
  const adjustedPost = postLamports + fee;
  return { ok: true, delta: (adjustedPost - adjustedPre) / 1e9 };
}
