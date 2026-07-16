// Jupiter swap client for the Meme Coin tab (Phase B real trading).
//
// Gets a price quote and an UNSIGNED swap transaction from Jupiter's free API
// (proxied at /api/jupiter). The unsigned transaction is handed to the wallet
// to sign. Nothing in this file ever touches a private key. Confirmation is
// read back through the Solana RPC proxy. See docs/ARCHITECTURE.md "Real trading".
//
// The mint and slippage parameters are intentionally generic so the same
// client serves both the SOL/USDC SwapPanel (Phase B v1) and the live
// memecoin trading path (Phase B v2). Memecoin swaps default to 150 bps
// slippage because pools move during the sign window.

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SOL_DECIMALS = 9;
export const USDC_DECIMALS = 6;

export type JupiterQuote = {
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  raw: unknown; // the full quote object, passed back to the swap endpoint
};

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Price quote. Free, no signing, no key. amountBaseUnits is in the input
// token's smallest unit (lamports for SOL, 1e-6 for USDC).
export async function getQuote(
  inputMint: string,
  outputMint: string,
  amountBaseUnits: number,
  slippageBps = 50
): Promise<{ ok: true; quote: JupiterQuote } | { ok: false; error: string }> {
  try {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: String(Math.floor(amountBaseUnits)),
      slippageBps: String(slippageBps)
    });
    const res = await fetch(`/api/jupiter/swap/v1/quote?${params.toString()}`);
    const data = await res.json();
    if (!res.ok || data.error || !data.outAmount) {
      return { ok: false, error: data.error || data.message || `HTTP ${res.status}` };
    }
    return {
      ok: true,
      quote: {
        inAmount: String(data.inAmount),
        outAmount: String(data.outAmount),
        priceImpactPct: String(data.priceImpactPct ?? "0"),
        raw: data
      }
    };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

// Build the unsigned swap transaction for the given quote and wallet.
export async function getSwapTransaction(
  quoteRaw: unknown,
  userPublicKey: string
): Promise<{ ok: true; base64: string } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/jupiter/swap/v1/swap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quoteRaw,
        userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto"
      })
    });
    const data = await res.json();
    if (!res.ok || data.error || !data.swapTransaction) {
      return { ok: false, error: data.error || data.message || `HTTP ${res.status}` };
    }
    return { ok: true, base64: data.swapTransaction };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

// Look up an SPL mint's decimals on-chain via the Solana RPC proxy.
// Used by the live trading path so a memecoin quote can convert human
// amounts to base units without a hardcoded decimals table. Result is
// cached for the session because mint decimals never change.
const mintDecimalsCache = new Map<string, number>();

export async function getMintDecimals(
  mint: string
): Promise<{ ok: true; decimals: number } | { ok: false; error: string }> {
  if (mint === SOL_MINT) return { ok: true, decimals: SOL_DECIMALS };
  if (mint === USDC_MINT) return { ok: true, decimals: USDC_DECIMALS };
  const cached = mintDecimalsCache.get(mint);
  if (cached !== undefined) return { ok: true, decimals: cached };
  try {
    const res = await fetch("/api/solana-rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [mint, { encoding: "jsonParsed" }]
      })
    });
    const data = await res.json();
    if (data.error) {
      return { ok: false, error: data.error.message || JSON.stringify(data.error) };
    }
    const decimals = data.result?.value?.data?.parsed?.info?.decimals;
    if (typeof decimals !== "number") {
      return { ok: false, error: "Mint account did not return a decimals field." };
    }
    mintDecimalsCache.set(mint, decimals);
    return { ok: true, decimals };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

// Broadcast an already-signed (base64) transaction via the RPC proxy. Used
// after signAllBase64Txs: Phantom signs the batch in one approval, then each
// signed transaction is sent here. Returns the on-chain signature.
export async function sendRawTx(
  signedBase64: string
): Promise<{ ok: true; signature: string } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/solana-rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendTransaction",
        params: [signedBase64, { encoding: "base64", maxRetries: 3 }]
      })
    });
    const data = await res.json();
    if (data.error) {
      return { ok: false, error: data.error.message || JSON.stringify(data.error) };
    }
    if (typeof data.result !== "string") {
      return { ok: false, error: "RPC returned no transaction signature." };
    }
    return { ok: true, signature: data.result };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

// Poll the RPC until the transaction confirms, or time out.
export async function confirmSignature(
  signature: string
): Promise<{ ok: true; status: string } | { ok: false; error: string }> {
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch("/api/solana-rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getSignatureStatuses",
          params: [[signature], { searchTransactionHistory: true }]
        })
      });
      const data = await res.json();
      const st = data.result?.value?.[0];
      if (st) {
        if (st.err) return { ok: false, error: "Transaction failed on-chain" };
        if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") {
          return { ok: true, status: st.confirmationStatus };
        }
      }
    } catch {
      /* transient RPC error, keep polling */
    }
    await sleep(1500);
  }
  return { ok: false, error: "Not confirmed within 30s. It may still land; check the explorer." };
}
