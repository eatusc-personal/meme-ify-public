import { type PriceMap } from "./paper";
import { type ChartSeries, type ChartTimeframe } from "./charts";
import { type HeldCoin } from "./heldCoins";
import { fmtPrice } from "./format";

const MOSAIC_COLORS = {
  bg: "#f5f6f1",
  tile: "#ffffff",
  line: "#d8ded3",
  text: "#17211c",
  muted: "#6c756f",
  up: "#15863f",
  down: "#c4392f"
};

const MOSAIC_FONT = "-apple-system, system-ui, 'Segoe UI', sans-serif";

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Trim text with an ellipsis so it fits maxW at the current ctx font.
function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
  return s + "…";
}

function drawMosaicTile(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  coin: HeldCoin,
  s: ChartSeries | undefined,
  price: PriceMap[string] | undefined,
  loading: boolean
) {
  const C = MOSAIC_COLORS;
  const candles = s?.candles ?? [];
  const padX = 12;
  const inX = x + padX;

  // tile background
  roundRectPath(ctx, x, y, w, h, 10);
  ctx.fillStyle = C.tile;
  ctx.fill();
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1;
  ctx.stroke();

  // current price: last candle close, falling back to the live price map
  const lastClose = candles.length ? candles[candles.length - 1].c : 0;
  const nowPrice = lastClose > 0 ? lastClose : price?.priceUsd ?? 0;
  const entry = coin.entryPriceUsd;
  const pnlPct = entry > 0 && nowPrice > 0 ? ((nowPrice - entry) / entry) * 100 : null;
  const pnlColor = pnlPct == null ? C.muted : pnlPct >= 0 ? C.up : C.down;

  // symbol
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = C.text;
  ctx.font = `700 15px ${MOSAIC_FONT}`;
  ctx.fillText(ellipsize(ctx, coin.symbol, w - 96), inX, y + 23);

  // side badge, top-right
  const badge =
    coin.side === "live" ? "LIVE" : coin.side === "paper+live" ? "PAPER+LIVE" : "PAPER";
  ctx.font = `700 9px ${MOSAIC_FONT}`;
  const bw = ctx.measureText(badge).width + 12;
  roundRectPath(ctx, x + w - padX - bw, y + 11, bw, 16, 4);
  ctx.fillStyle = coin.side === "paper" ? C.muted : C.up;
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.fillText(badge, x + w - padX - bw + 6, y + 22);

  // name
  ctx.fillStyle = C.muted;
  ctx.font = `11px ${MOSAIC_FONT}`;
  ctx.fillText(ellipsize(ctx, coin.name, w - 2 * padX), inX, y + 39);

  // current price + P&L vs entry
  ctx.fillStyle = C.text;
  ctx.font = `12px ${MOSAIC_FONT}`;
  ctx.fillText(`now $${fmtPrice(nowPrice)}`, inX, y + 57);
  if (pnlPct != null) {
    const txt = `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(Math.abs(pnlPct) >= 100 ? 0 : 1)}%`;
    ctx.font = `700 13px ${MOSAIC_FONT}`;
    const tw = ctx.measureText(txt).width;
    ctx.fillStyle = pnlColor;
    ctx.fillText(txt, x + w - padX - tw, y + 57);
  }

  // chart body
  const chTop = y + 68;
  const chBot = y + h - 12;
  const chLeft = inX;
  const chRight = x + w - padX;
  const chW = chRight - chLeft;
  const chH = chBot - chTop;

  if (!s || candles.length < 2) {
    ctx.fillStyle = C.muted;
    ctx.font = `11px ${MOSAIC_FONT}`;
    const msg = !s
      ? loading
        ? "loading candles..."
        : "not in last load — hit Reload"
      : s.error
        ? `No chart data — ${s.error}`
        : "Not enough candle data";
    ctx.fillText(ellipsize(ctx, msg, chW), chLeft, chTop + chH / 2);
    return;
  }

  // price range, widened to keep the entry line on-screen
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of candles) {
    lo = Math.min(lo, c.l);
    hi = Math.max(hi, c.h);
  }
  if (entry > 0) {
    lo = Math.min(lo, entry);
    hi = Math.max(hi, entry);
  }
  if (!(hi > lo)) {
    const mid = lo || 1;
    hi = mid * 1.05;
    lo = mid * 0.95;
  }
  const span = hi - lo;
  lo -= span * 0.08;
  hi += span * 0.08;
  const yOf = (v: number) => chBot - ((v - lo) / (hi - lo)) * chH;

  // entry reference line
  if (entry > 0) {
    const ey = yOf(entry);
    ctx.strokeStyle = C.muted;
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(chLeft, ey);
    ctx.lineTo(chRight, ey);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = C.muted;
    ctx.font = `9px ${MOSAIC_FONT}`;
    ctx.fillText(`entry $${fmtPrice(entry)}`, chLeft + 2, ey - 3);
  }

  // candlesticks
  const cw = chW / candles.length;
  const bodyW = Math.max(1, Math.min(11, cw * 0.66));
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const cx = chLeft + cw * (i + 0.5);
    const color = c.c >= c.o ? C.up : C.down;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, yOf(c.h));
    ctx.lineTo(cx, yOf(c.l));
    ctx.stroke();
    const yO = yOf(c.o);
    const yC = yOf(c.c);
    ctx.fillRect(cx - bodyW / 2, Math.min(yO, yC), bodyW, Math.max(1, Math.abs(yC - yO)));
  }
}

export function drawHoldingsMosaic(
  canvas: HTMLCanvasElement,
  coins: HeldCoin[],
  series: Record<string, ChartSeries>,
  prices: PriceMap,
  timeframe: ChartTimeframe,
  loading: boolean,
  loadedAt: string | undefined
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const scale = 2; // render at 2x for a crisp downloadable PNG
  const pad = 18;
  const titleH = 50;
  const tileW = 326;
  const tileH = 214;
  const gap = 14;
  const n = coins.length;
  const cols = Math.max(1, Math.min(5, Math.ceil(Math.sqrt(n))));
  const rows = Math.max(1, Math.ceil(n / cols));

  const W = pad * 2 + cols * tileW + (cols - 1) * gap;
  const H = pad * 2 + titleH + rows * tileH + (rows - 1) * gap;

  canvas.width = W * scale;
  canvas.height = H * scale;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

  ctx.fillStyle = MOSAIC_COLORS.bg;
  ctx.fillRect(0, 0, W, H);

  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = MOSAIC_COLORS.text;
  ctx.font = `700 18px ${MOSAIC_FONT}`;
  ctx.fillText(`Holdings chart mosaic — ${n} coin${n === 1 ? "" : "s"}`, pad, pad + 17);

  ctx.fillStyle = MOSAIC_COLORS.muted;
  ctx.font = `12px ${MOSAIC_FONT}`;
  const tfText =
    timeframe === "6h" ? "last 6 hours" : timeframe === "24h" ? "last 24 hours" : "last 7 days";
  const stamp = loading ? "loading..." : loadedAt ? new Date(loadedAt).toLocaleString() : "—";
  ctx.fillText(
    `${tfText} · % is vs your entry · candles from GeckoTerminal · loaded ${stamp}`,
    pad,
    pad + 35
  );

  coins.forEach((coin, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = pad + col * (tileW + gap);
    const y = pad + titleH + row * (tileH + gap);
    drawMosaicTile(
      ctx,
      x,
      y,
      tileW,
      tileH,
      coin,
      series[coin.address],
      prices[coin.address],
      loading
    );
  });
}
