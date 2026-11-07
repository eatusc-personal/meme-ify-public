import { portfolioStats, type PaperState, type TradeStats } from "./paper";

// Build the plain-text brief sent to Claude for the AI review: the trading
// rules, the account state, and the recent closed trades.
export function buildAiReviewPrompt(
  paper: PaperState,
  stats: ReturnType<typeof portfolioStats>,
  tStats: TradeStats
): string {
  const s = paper.settings;
  const closed = paper.positions
    .filter((p) => p.status === "closed")
    .sort((a, b) => new Date(b.exitAt ?? 0).getTime() - new Date(a.exitAt ?? 0).getTime())
    .slice(0, 15);
  const lines: string[] = [];
  lines.push("TRADING RULES");
  lines.push(`- Auto-execute buys (paper execute mode only, ignored in queue mode): ${s.autoTrade ? "on" : "off"}`);
  lines.push(`- Trade size: $${s.tradeSizeUsd}`);
  lines.push(`- Max open positions: ${s.maxOpenPositions}`);
  lines.push(`- Min exit score: ${s.minExitScore} (0-100 scale)`);
  lines.push(`- Min liquidity: $${s.minLiquidityUsd}`);
  lines.push(`- Min coin age: ${s.minAgeHours}h`);
  lines.push(`- Min unique holders: ${s.minHolderCount}`);
  lines.push(`- Re-entry cooldown: ${s.reentryCooldownHours}h`);
  lines.push(`- Daily loss limit: ${s.dailyLossLimitPct}% of starting cash`);
  lines.push(`- Take profit: +${s.takeProfitPct}%`);
  lines.push(`- Stop loss: -${s.stopLossPct}%`);
  lines.push(`- Max hold: ${s.maxHoldHours}h`);
  lines.push(
    "- Position watch: alert at +50%, sell half at +100%, exit if liquidity < $3k."
  );
  lines.push("");
  lines.push("ACCOUNT");
  lines.push(
    `- Starting cash $${paper.startingCashUsd.toFixed(0)}, cash now $${paper.cashUsd.toFixed(
      0
    )}, equity $${stats.equity.toFixed(0)}.`
  );
  lines.push(
    `- Realized P&L $${stats.realized.toFixed(0)}, unrealized $${stats.unrealized.toFixed(
      0
    )}, total P&L $${stats.totalPnl.toFixed(0)}.`
  );
  lines.push(
    `- Open positions ${stats.openCount}, closed trades ${stats.closedCount}, win rate ${stats.winRate.toFixed(
      0
    )}%.`
  );
  lines.push(
    `- Estimated fees on activity so far $${tStats.estFeesUsd.toFixed(
      0
    )} (realized net of fees $${tStats.realizedNetUsd.toFixed(0)}).`
  );
  if (tStats.byReason.length > 0) {
    lines.push("");
    lines.push("CLOSED TRADES BY EXIT REASON");
    for (const r of tStats.byReason) lines.push(`- ${r.reason}: ${r.count}`);
  }
  if (closed.length > 0) {
    lines.push("");
    lines.push(`RECENT CLOSED TRADES (newest ${closed.length})`);
    for (const p of closed) {
      const pct =
        p.entryPriceUsd > 0 && p.exitPriceUsd !== undefined
          ? ((p.exitPriceUsd - p.entryPriceUsd) / p.entryPriceUsd) * 100
          : 0;
      lines.push(
        `- ${p.symbol}: ${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%, P&L $${(p.pnlUsd ?? 0).toFixed(
          2
        )}, exit "${p.exitReason ?? "?"}"`
      );
    }
  }
  lines.push("");
  lines.push(
    "Review these rules and results. What is unsafe, contradictory, or likely to lose real money, and what should change?"
  );
  return lines.join("\n");
}
