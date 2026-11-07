import { fmtUsd } from "./markets";

export function shortAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 5)}...${addr.slice(-4)}` : addr;
}

export function signedUsd(n: number): string {
  return `${n >= 0 ? "+" : "-"}${fmtUsd(Math.abs(n))}`;
}

// A price for the confirmation-popup rows: $-prefixed, or "unknown" if absent.
export function priceLabel(n: number): string {
  return n > 0 ? `$${fmtPrice(n)}` : "unknown";
}

// Hover tooltip for the closed-trades Reason pill. Maps the bare exit_reason
// string to a human-readable explanation, with the realized P&L appended so
// the reader sees the outcome alongside the cause.
export function reasonTooltip(reason: string, pnl: number): string {
  const pnlText = `${pnl >= 0 ? "+" : "-"}$${Math.abs(pnl).toFixed(2)} realized`;
  const base: Record<string, string> = {
    manual: "You clicked Sell. The price was fetched fresh at confirm time.",
    "take profit": "Auto-closed by the +N% take-profit threshold in your trading rules.",
    "stop loss": "Auto-closed by the -N% stop-loss threshold in your trading rules.",
    "trailing-stop": "Trailing stop fired: price dropped past the trail % from the peak the position had ever printed.",
    "max hold time": "Auto-closed because the position aged past the max-hold-hours threshold.",
    "liquidity death (watch exit)":
      "Force-closed by the position watch: liquidity collapsed below $3k, exiting before the pool went to zero."
  };
  const explained = base[reason] ?? `Exit reason recorded as "${reason}".`;
  return `${explained}\n\n${pnlText}`;
}

// Compact price string that keeps precision on sub-cent memecoin prices.
export function fmtPrice(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "n/a";
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return n.toLocaleString("en-US", { maximumSignificantDigits: 4 });
}
