// Client-side fetchers for the two server-managed external-service surfaces:
//
//   /api/integrations    — health snapshot of every wired key/service. The
//                          IntegrationsPanel renders this so the user can see
//                          at a glance what's wired vs missing vs erroring.
//
//   /api/coingecko/*     — proxied CoinGecko calls. The RotationContextPanel
//                          uses the trending + memecoin-category endpoints.
//
// Both are read-only. Errors surface as `ok: false` payloads so the panels
// can render an inline reason instead of throwing.

export type IntegrationHealth = {
  configured: boolean;
  healthy: boolean | null;
  lastOkAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  extras?: Record<string, unknown>;
};

export type IntegrationEntry = {
  key: string;
  label: string;
  powers: string;
  envVar: string;
  docs?: string;
  status: IntegrationHealth;
};

export async function fetchIntegrations(): Promise<IntegrationEntry[]> {
  try {
    const res = await fetch("/api/integrations");
    const data = (await res.json()) as { ok?: boolean; integrations?: IntegrationEntry[] };
    return data.ok && Array.isArray(data.integrations) ? data.integrations : [];
  } catch {
    return [];
  }
}

// CoinGecko search-trending: top 15 coins by search volume on coingecko.com
// over the last 24h. Useful as a "what is investor attention rotating into"
// signal that's distinct from on-chain volume. We slice to the memecoin-ish
// hits for the rotation panel header.
export type TrendingCoin = {
  id: string;
  symbol: string;
  name: string;
  marketCapRank: number | null;
  priceBtc: number | null;
  // CoinGecko's trending payload includes a content-score and a thumbnail.
  // Kept narrow on purpose: anything else the panel doesn't read is dropped.
  thumb?: string;
};

export async function fetchCoinGeckoTrending(): Promise<TrendingCoin[]> {
  try {
    const res = await fetch("/api/coingecko/search/trending");
    if (!res.ok) return [];
    const data = (await res.json()) as {
      coins?: { item?: { id?: string; symbol?: string; name?: string; market_cap_rank?: number; price_btc?: number; thumb?: string } }[];
    };
    const coins = Array.isArray(data.coins) ? data.coins : [];
    const out: TrendingCoin[] = [];
    for (const c of coins) {
      const it = c.item ?? {};
      if (!it.id || !it.symbol || !it.name) continue;
      out.push({
        id: it.id,
        symbol: it.symbol,
        name: it.name,
        marketCapRank: it.market_cap_rank ?? null,
        priceBtc: it.price_btc ?? null,
        thumb: it.thumb
      });
    }
    return out;
  } catch {
    return [];
  }
}

// Memecoin-category aggregate. CoinGecko exposes a per-category summary with
// 24h volume + market-cap-change-percentage. Sector flow signal: if the meme
// category as a whole is +X% 24h and volume is up, that's macro tailwind;
// the opposite is a sign to dial down position size or skip the cycle.
export type MemecoinCategory = {
  marketCapUsd: number;
  volume24hUsd: number;
  marketCapChange24hPct: number;
  topCoins: string[]; // ids of the top-5 by mcap, for context
  updatedAt: string;
};

export async function fetchMemecoinCategory(): Promise<MemecoinCategory | null> {
  try {
    // The /coins/categories endpoint returns all categories; we filter for
    // "Meme" (the canonical category id is `meme-token` on CoinGecko).
    const res = await fetch("/api/coingecko/coins/categories");
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{
      id?: string;
      market_cap?: number;
      volume_24h?: number;
      market_cap_change_24h?: number;
      top_3_coins_id?: string[];
      updated_at?: string;
    }>;
    if (!Array.isArray(data)) return null;
    const meme = data.find((c) => c.id === "meme-token");
    if (!meme) return null;
    return {
      marketCapUsd: meme.market_cap ?? 0,
      volume24hUsd: meme.volume_24h ?? 0,
      marketCapChange24hPct: meme.market_cap_change_24h ?? 0,
      topCoins: Array.isArray(meme.top_3_coins_id) ? meme.top_3_coins_id.slice(0, 3) : [],
      updatedAt: meme.updated_at ?? new Date().toISOString()
    };
  } catch {
    return null;
  }
}

// DefiLlama stablecoin flow: USDC supply moves on Solana often precede a
// memecoin rotation by 6-24h. Keyless, no rate limits in practice. Returns
// the most recent 24h USDC delta on Solana so the rotation panel can show
// "fresh capital inbound" vs "capital leaving".
export type StablecoinFlow = {
  totalUsdcOnSolana: number;
  delta24hUsd: number;
  delta24hPct: number;
};

export async function fetchSolanaUsdcFlow(): Promise<StablecoinFlow | null> {
  try {
    // DefiLlama's stablecoincharts/Solana returns a per-day series. Take the
    // last two points to compute the 24h delta. Keyless endpoint, no proxy
    // needed (CORS-friendly).
    const res = await fetch("https://stablecoins.llama.fi/stablecoincharts/Solana?stablecoin=2");
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{ date?: number; totalCirculatingUSD?: { peggedUSD?: number } }>;
    if (!Array.isArray(data) || data.length < 2) return null;
    const last = data[data.length - 1];
    const prev = data[data.length - 2];
    const lastTotal = last?.totalCirculatingUSD?.peggedUSD ?? 0;
    const prevTotal = prev?.totalCirculatingUSD?.peggedUSD ?? 0;
    const delta24hUsd = lastTotal - prevTotal;
    const delta24hPct = prevTotal > 0 ? (delta24hUsd / prevTotal) * 100 : 0;
    return { totalUsdcOnSolana: lastTotal, delta24hUsd, delta24hPct };
  } catch {
    return null;
  }
}
