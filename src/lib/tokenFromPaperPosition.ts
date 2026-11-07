import { type MemeToken } from "./markets";
import { type PaperPosition } from "./paper";

// Build a minimal MemeToken from a held paper position. Used by the "Buy real"
// action so a coin that has scrolled out of the current scan can still be
// bought for real: only `address` actually drives the live buy (decimals, the
// Jupiter quote, and RugCheck all refetch from chain at buy time), the rest are
// display defaults seeded from the position's entry snapshot. Callers prefer
// the live scan token when the coin is still in it. See requestBuyRealFromPosition.
export function tokenFromPaperPosition(pos: PaperPosition, priceNow: number): MemeToken {
  return {
    address: pos.address,
    name: pos.name,
    symbol: pos.symbol,
    chainId: "solana",
    dexId: "",
    url: "",
    priceUsd: priceNow,
    volume24h: pos.entryVolume24h ?? 0,
    liquidityUsd: pos.lastLiquidityUsd ?? pos.entryLiquidityUsd ?? 0,
    marketCap: pos.entryMarketCap ?? 0,
    fdv: 0,
    txns24h: 0,
    buys24h: pos.entryBuys24h ?? 0,
    sells24h: pos.entrySells24h ?? 0,
    priceChange24h: pos.entryPriceChange24h ?? 0,
    ageHours: pos.entryAgeHours ?? 0,
    volToLiq: 0,
    buyRatio: pos.entryBuyRatio ?? 0,
    exitScore: pos.entryExitScore ?? 0,
    verdict: "caution",
    riskFlags: [],
    socials: [],
    source: "paper-position",
    discoveredAt: pos.entryAt,
    discoveryChannel: "paper-position",
    discoveryReason: "Held paper position",
    tradeUrl: "",
    sources: [],
    rating: pos.entryRating ?? 0,
    ratingBand: (pos.entryRatingBand as MemeToken["ratingBand"]) ?? "C"
  };
}
