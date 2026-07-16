import { describe, expect, it } from "vitest";
import type { MemeToken } from "./markets";
import {
  buyManual,
  defaultPaperState,
  plausibleSellPrice,
  runSellPass,
  sellManual
} from "./paper";

function token(overrides: Partial<MemeToken> = {}): MemeToken {
  return {
    address: "mint-1",
    name: "Test Coin",
    symbol: "TEST",
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
    ratingBand: "A",
    ...overrides
  };
}

describe("paper trading", () => {
  it("rejects impossible prices while allowing the 1000x boundary", () => {
    expect(plausibleSellPrice(0, 1)).toBe(false);
    expect(plausibleSellPrice(1_000, 1)).toBe(true);
    expect(plausibleSellPrice(1_001, 1)).toBe(false);
  });

  it("books a manual buy once and preserves the entry snapshot", () => {
    const first = buyManual(defaultPaperState(), token());
    expect(first.event.kind).toBe("buy");
    expect(first.state.cashUsd).toBe(950);
    expect(first.state.positions).toHaveLength(1);
    expect(first.state.positions[0].tokenAmount).toBe(25);
    expect(first.state.positions[0].entryAgeHours).toBe(96);

    const duplicate = buyManual(first.state, token());
    expect(duplicate.event.kind).toBe("skip");
    expect(duplicate.state).toBe(first.state);
  });

  it("keeps cost basis proportional across a partial paper sell", () => {
    const bought = buyManual(defaultPaperState(), token()).state;
    const position = bought.positions[0];
    const partial = sellManual(bought, position.id, 4, 50).state;
    const remainder = partial.positions.find((p) => p.id === position.id)!;

    expect(partial.cashUsd).toBe(1_000);
    expect(remainder.status).toBe("open");
    expect(remainder.tokenAmount).toBe(12.5);
    expect(remainder.costUsd).toBe(25);
    expect(remainder.partialRealizedUsd).toBe(25);
  });

  it("closes a position at the configured stop loss", () => {
    const bought = buyManual(defaultPaperState(), token()).state;
    const result = runSellPass(bought, {
      "mint-1": { priceUsd: 1.4, liquidityUsd: 100_000 }
    });
    const position = result.state.positions[0];

    expect(position.status).toBe("closed");
    expect(position.exitReason).toBe("stop loss");
    expect(position.pnlUsd).toBeCloseTo(-15);
    expect(result.state.cashUsd).toBeCloseTo(985);
  });

  it("does not interpret a missing market tick as a rug", () => {
    const bought = buyManual(defaultPaperState(), token()).state;
    const result = runSellPass(bought, {});

    expect(result.state.positions[0].status).toBe("open");
    expect(result.events[0].kind).toBe("info");
  });
});
