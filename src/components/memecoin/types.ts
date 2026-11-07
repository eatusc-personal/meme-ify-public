import { type ChatterResult } from "../../lib/markets";

// ---------------------------------------------------------------------------
// Meme Coin research tab. Separate sub-project, same dashboard.
// Full context lives in docs/ARCHITECTURE.md (read that file first when working here).
// ---------------------------------------------------------------------------

export type ChatterState = { loading: boolean; data?: ChatterResult; error?: string };
export type SortKey =
  | "rating"
  | "score"
  | "rising"
  | "liquidity"
  | "volume"
  | "change"
  | "newest"
  | "wallets"
  | "top10"
  | "holdersPerDay";
export type Holding = { costUsd: number; pnlUsd: number; pnlPct: number };
