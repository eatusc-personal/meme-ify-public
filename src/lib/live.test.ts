import { describe, expect, it } from "vitest";
import type { MemeToken } from "./markets";
import { defaultPaperState } from "./paper";
import { defaultLiveState, openLivePosition, sellLivePosition } from "./live";
import { SOL_MINT } from "./swap";

const fixture: MemeToken = {
  address: "mint-live",
  name: "Live Test",
  symbol: "LIVE",
  chainId: "solana",
  dexId: "test-dex",
  url: "https://example.test/pair",
  priceUsd: 2,
  volume24h: 500_000,
  liquidityUsd: 100_000,
  marketCap: 2_000_000,
  fdv: 2_000_000,
  txns24h: 2_000,
  buys24h: 1_200,
  sells24h: 800,
  priceChange24h: 10,
  ageHours: 96,
  volToLiq: 5,
  buyRatio: 0.6,
  exitScore: 80,
  verdict: "exitable",
  riskFlags: [],
  socials: [],
  source: "test",
  discoveredAt: new Date().toISOString(),
  discoveryChannel: "test",
  discoveryReason: "fixture",
  tradeUrl: "https://example.test/trade",
  sources: ["test"],
  rating: 85,
  ratingBand: "A"
};

function opened() {
  return openLivePosition(defaultLiveState(), {
    mint: fixture.address,
    symbol: fixture.symbol,
    name: fixture.name,
    baseMint: SOL_MINT,
    signature: "entry-signature",
    baseAmountSpent: 1,
    tokenAmountReceived: 100,
    priceUsdAtEntry: 2,
    slippageBps: 150,
    token: fixture,
    settings: defaultPaperState().settings
  });
}

describe("live position accounting", () => {
  it("records an immutable entry snapshot", () => {
    const position = opened().positions[0];
    expect(position.status).toBe("open");
    expect(position.entryAgeHours).toBe(96);
    expect(position.entrySettingsSnapshot?.minLiquidityUsd).toBe(25_000);
    expect(position.peakPriceUsd).toBe(2);
  });

  it("splits a partial fill and keeps the remaining basis proportional", () => {
    const state = opened();
    const position = state.positions[0];
    const result = sellLivePosition(state, position.id, {
      signature: "partial-signature",
      tokensSold: 25,
      baseAmountReceived: 0.4,
      exitPriceUsd: 3,
      reason: "take profit"
    });

    const closedSlice = result.positions.find((p) => p.status === "closed")!;
    const remainder = result.positions.find((p) => p.id === position.id)!;
    expect(closedSlice.entryTokenAmount).toBe(25);
    expect(closedSlice.entryBaseAmount).toBe(0.25);
    expect(remainder.entryTokenAmount).toBe(75);
    expect(remainder.entryBaseAmount).toBe(0.75);
    expect(closedSlice.pnlBase).toBeCloseTo(0.15);
  });

  it("clamps an oversized sell to a full close", () => {
    const state = opened();
    const position = state.positions[0];
    const result = sellLivePosition(state, position.id, {
      signature: "exit-signature",
      tokensSold: 1_000,
      baseAmountReceived: 1.2,
      exitPriceUsd: 2.4,
      reason: "manual"
    });

    expect(result.positions).toHaveLength(1);
    expect(result.positions[0].status).toBe("closed");
    expect(result.positions[0].pnlBase).toBeCloseTo(0.2);
    expect(result.positions[0].pnlUsd).toBeCloseTo(40);
  });
});
