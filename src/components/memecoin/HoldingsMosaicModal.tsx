import { Download, RefreshCw, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { type PriceMap } from "../../lib/paper";
import { CHART_TIMEFRAMES, type ChartTimeframe } from "../../lib/charts";
import { type HeldCoin } from "../../lib/heldCoins";
import { type MosaicCacheEntry } from "../../lib/memecoinPrefs";
import { drawHoldingsMosaic } from "../../lib/mosaicDraw";

// Presentational only. The candle cache and the in-flight load live in the
// MemeCoinPanel, so this modal just draws whatever is cached for the selected
// timeframe and dispatches timeframe / reload actions upward.
export function HoldingsMosaicModal({
  coins,
  prices,
  timeframe,
  entry,
  loading,
  anyLoading,
  progress,
  onTimeframe,
  onReload,
  onClose
}: {
  coins: HeldCoin[];
  prices: PriceMap;
  timeframe: ChartTimeframe;
  entry: MosaicCacheEntry | undefined;
  loading: boolean;
  anyLoading: boolean;
  progress: { done: number; total: number };
  onTimeframe: (tf: ChartTimeframe) => void;
  onReload: () => void;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const series = useMemo(() => entry?.series ?? {}, [entry]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Redraw on every data update (tiles fill in as coins arrive) and on a
  // timeframe switch.
  useEffect(() => {
    if (canvasRef.current) {
      drawHoldingsMosaic(canvasRef.current, coins, series, prices, timeframe, loading, entry?.loadedAt);
    }
  }, [series, coins, prices, timeframe, loading, entry]);

  function downloadPng() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `holdings-mosaic-${timeframe}-${new Date().toISOString().slice(0, 10)}.png`;
    a.click();
  }

  const failed = coins.filter((c) => {
    const s = series[c.address];
    return s && !s.candles.length;
  }).length;

  return (
    <div className="mc-modal-overlay" onClick={onClose}>
      <div className="mc-modal mc-modal-mosaic" onClick={(e) => e.stopPropagation()}>
        <div className="mc-modal-head">
          <div>
            <strong>Holdings chart mosaic</strong>
            <span>
              {coins.length} open position{coins.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="mc-spacer" />
          <div className="mc-mosaic-tabs">
            {CHART_TIMEFRAMES.map((tf) => (
              <button
                key={tf.id}
                className={timeframe === tf.id ? "primary-button" : "ghost-button"}
                onClick={() => onTimeframe(tf.id)}
                disabled={anyLoading}
              >
                {tf.label}
              </button>
            ))}
          </div>
          <button
            className="ghost-button"
            onClick={onReload}
            disabled={anyLoading || coins.length === 0}
          >
            <RefreshCw size={15} />
            Reload
          </button>
          <button className="ghost-button" onClick={downloadPng} disabled={anyLoading}>
            <Download size={15} />
            PNG
          </button>
          <button className="mc-modal-close" onClick={onClose} aria-label="close">
            <XCircle size={20} />
          </button>
        </div>
        <div className="mc-modal-body">
          {coins.length === 0 ? (
            <p className="empty">No open positions to chart. Buy a coin (paper or live) first.</p>
          ) : (
            <>
              {loading ? (
                <p className="muted">
                  Loading candles from GeckoTerminal: {progress.done} of {progress.total}. Tiles
                  fill in as data arrives, and the load keeps running even if you close this
                  window. Free-API rate limits mean a full portfolio can take a minute or two.
                </p>
              ) : entry ? (
                <p className="muted">
                  Loaded {new Date(entry.loadedAt).toLocaleString()}, cached until you hit Reload.
                  {failed > 0
                    ? ` ${failed} of ${coins.length} coin${
                        failed === 1 ? "" : "s"
                      } had no candle data upstream.`
                    : ""}
                </p>
              ) : (
                <p className="muted">Starting load...</p>
              )}
              <div className="mc-mosaic-canvas-wrap">
                <canvas ref={canvasRef} className="mc-mosaic-canvas" />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
