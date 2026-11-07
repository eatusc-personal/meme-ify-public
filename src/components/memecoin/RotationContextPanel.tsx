import { RefreshCw, TrendingUp } from "lucide-react";
import { useEffect, useState } from "react";
import { fmtUsd } from "../../lib/markets";
import {
  fetchCoinGeckoTrending,
  fetchMemecoinCategory,
  fetchSolanaUsdcFlow,
  type TrendingCoin,
  type MemecoinCategory,
  type StablecoinFlow
} from "../../lib/integrations";
import { useCollapsibleSection } from "../../hooks/useCollapsibleSection";
import { PanelTitle } from "../PanelTitle";

// Rotation context panel. Macro overlay: search-trending memecoins from
// CoinGecko + memecoin sector P&L + DefiLlama USDC inflow on Solana. None of
// this is a per-coin signal; it's the "is the broader memecoin tide rising or
// receding" framing that informs how to read individual pumps.
export function RotationContextPanel() {
  const section = useCollapsibleSection("rotation-context");
  const [trending, setTrending] = useState<TrendingCoin[]>([]);
  const [category, setCategory] = useState<MemecoinCategory | null>(null);
  const [flow, setFlow] = useState<StablecoinFlow | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  async function reload() {
    setRefreshing(true);
    try {
      const [t, c, f] = await Promise.all([
        fetchCoinGeckoTrending(),
        fetchMemecoinCategory(),
        fetchSolanaUsdcFlow()
      ]);
      setTrending(t);
      setCategory(c);
      setFlow(f);
      setLoadedAt(new Date().toISOString());
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void reload();
    // 3-minute refresh matches the cycle cadence; CoinGecko Demo tier limits
    // are well above this, and the server-side cache absorbs HMR clicks.
    const id = setInterval(() => void reload(), 180_000);
    return () => clearInterval(id);
  }, []);

  // Read the sector direction once for a one-glance "rising / falling / flat"
  // headline. Thresholds chosen to mark moves worth acting on, not noise.
  const sectorDir =
    category == null
      ? "unknown"
      : category.marketCapChange24hPct > 5
        ? "rising"
        : category.marketCapChange24hPct < -5
          ? "falling"
          : "flat";
  const flowDir =
    flow == null
      ? "unknown"
      : flow.delta24hPct > 1
        ? "inflow"
        : flow.delta24hPct < -1
          ? "outflow"
          : "flat";

  return (
    <section id="rotation-context" className={`panel wide ${section.className}`}>
      <PanelTitle
        icon={TrendingUp}
        title="Rotation context"
        collapsed={section.collapsed}
        onToggle={section.toggle}
      />
      <p className="muted">
        Macro context for reading scans. <strong>Sector</strong> = memecoin category 24h
        mcap change from CoinGecko. <strong>USDC on Solana</strong> = DefiLlama's
        per-day USDC supply on Solana; inflow often precedes a memecoin rotation
        by 6-24h. <strong>Trending searches</strong> = top coins by coingecko.com
        search volume in the last 24h. None of this is a per-coin signal; it's
        "is the broader tide rising or receding" framing that tells you whether
        the pumps you see in the scanner are likely to be sticky or fade.
      </p>
      <div className="mc-controls">
        <button className="ghost-button" onClick={() => void reload()} disabled={refreshing}>
          <RefreshCw size={14} />
          {refreshing ? "Refreshing..." : "Refresh"}
        </button>
        {loadedAt && (
          <span className="muted" style={{ fontSize: 12 }}>
            Last refresh {new Date(loadedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      <div className="mc-rotation-grid">
        <div className={`mc-rotation-card mc-rotation-card-${sectorDir}`}>
          <div className="mc-rotation-label">Memecoin sector 24h</div>
          <div className="mc-rotation-headline">
            {category ? `${category.marketCapChange24hPct >= 0 ? "+" : ""}${category.marketCapChange24hPct.toFixed(2)}%` : "—"}
          </div>
          <div className="mc-rotation-sub">
            {category
              ? `${fmtUsd(category.marketCapUsd)} mcap · ${fmtUsd(category.volume24hUsd)} 24h vol`
              : "CoinGecko unreachable"}
          </div>
        </div>
        <div className={`mc-rotation-card mc-rotation-card-${flowDir}`}>
          <div className="mc-rotation-label">USDC on Solana 24h</div>
          <div className="mc-rotation-headline">
            {flow ? `${flow.delta24hPct >= 0 ? "+" : ""}${flow.delta24hPct.toFixed(2)}%` : "—"}
          </div>
          <div className="mc-rotation-sub">
            {flow
              ? `${flow.delta24hUsd >= 0 ? "+" : ""}${fmtUsd(Math.abs(flow.delta24hUsd))} delta · ${fmtUsd(flow.totalUsdcOnSolana)} supply`
              : "DefiLlama unreachable"}
          </div>
        </div>
        <div className="mc-rotation-card">
          <div className="mc-rotation-label">Trending searches</div>
          <div className="mc-rotation-trending">
            {trending.length === 0 ? (
              <span className="muted">CoinGecko unreachable</span>
            ) : (
              trending.slice(0, 8).map((c) => (
                <a
                  key={c.id}
                  href={`https://www.coingecko.com/en/coins/${c.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mc-rotation-trending-chip"
                  title={`Rank #${c.marketCapRank ?? "?"} · click to view on CoinGecko`}
                >
                  {c.thumb && (
                    <img src={c.thumb} alt="" width={14} height={14} className="mc-rotation-trending-thumb" />
                  )}
                  {c.symbol.toUpperCase()}
                </a>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
