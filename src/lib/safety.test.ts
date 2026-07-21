// Tests for the pre-buy safety gate. Network boundaries are mocked: getQuote
// (the Jupiter sell-simulation quote) via a module mock, and the RugCheck /
// Jupiter Tokens v2 HTTP reads via a global fetch stub. The decision logic
// itself runs unmodified.
//
// safety.ts keeps per-mint module-level caches (RugCheck 5 min, Jupiter 30
// min), so every test uses a unique mint to stay cache-independent.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSafetyGate, screenRugCheck } from "./safety";
import { getQuote, type JupiterQuote } from "./swap";

vi.mock("./swap", () => ({
  getQuote: vi.fn(),
  SOL_MINT: "So11111111111111111111111111111111111111112",
  USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
}));

const getQuoteMock = vi.mocked(getQuote);

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// priceImpactPct in a Jupiter quote is a fraction ("0.15" = 15%), matching
// what the real /swap/v1/quote endpoint returns.
function buyQuote(priceImpactPct: string): JupiterQuote {
  return {
    inAmount: "25000000", // 25 USDC in base units
    outAmount: "1000000000",
    priceImpactPct,
    raw: {}
  };
}

function sellQuoteOk(priceImpactPct = "0.01") {
  return {
    ok: true as const,
    quote: {
      inAmount: "1000000000",
      outAmount: "24500000",
      priceImpactPct,
      raw: {}
    }
  };
}

// Realistic RugCheck report shell for a clean token; tests override fields.
function rugReport(overrides: Record<string, unknown> = {}) {
  return {
    score: 250,
    score_normalised: 5,
    rugged: false,
    risks: [],
    mintAuthority: null,
    freezeAuthority: null,
    topHolders: [
      { address: "wallet1", pct: 6.2 },
      { address: "wallet2", pct: 4.8 },
      { address: "wallet3", pct: 3.1 },
      { address: "wallet4", pct: 2.4 },
      { address: "wallet5", pct: 1.9 }
    ],
    creator: "creatorWallet",
    creatorTokens: [],
    graphInsidersDetected: 0,
    insiderNetworks: null,
    totalLPProviders: 42,
    transferFee: null,
    ...overrides
  };
}

// Realistic Jupiter Tokens v2 entry for a healthy token; tests override.
function jupToken(mint: string, overrides: Record<string, unknown> = {}) {
  return {
    id: mint,
    organicScore: 82,
    organicScoreLabel: "high",
    holderCount: 4200,
    isVerified: false,
    audit: {
      mintAuthorityDisabled: true,
      freezeAuthorityDisabled: true,
      topHoldersPercentage: 18.4,
      devMigrations: 0
    },
    stats24h: {
      buyVolume: 260000,
      sellVolume: 210000,
      numTraders: 900,
      numBuys: 2600,
      numSells: 2100
    },
    ...overrides
  };
}

type FetchFixture = {
  rugcheck?: unknown;
  rugcheckStatus?: number;
  jupiter?: unknown;
  jupiterStatus?: number;
};

// Route the two upstream HTTP reads the gate performs. Anything else is a
// test bug, so it throws.
function stubFetch(fixture: FetchFixture) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/rugcheck/")) {
        const status = fixture.rugcheckStatus ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          text: async () => JSON.stringify(fixture.rugcheck ?? {})
        } as Response;
      }
      if (url.includes("/api/jupiter/tokens/v2/search")) {
        const status = fixture.jupiterStatus ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          text: async () => JSON.stringify(fixture.jupiter ?? [])
        } as Response;
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    })
  );
}

function gateOpts(mint: string, overrides: Partial<Parameters<typeof runSafetyGate>[0]> = {}) {
  return {
    tokenMint: mint,
    baseMint: USDC,
    buyQuote: buyQuote("0.004"),
    acknowledgedHighImpact: false,
    ...overrides
  };
}

beforeEach(() => {
  getQuoteMock.mockReset();
  getQuoteMock.mockResolvedValue(sellQuoteOk());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runSafetyGate", () => {
  it("passes a clean token with ok and no blockers", async () => {
    const mint = "CleanMint1111111111111111111111111111111111";
    stubFetch({ rugcheck: rugReport(), jupiter: [jupToken(mint)] });

    const result = await runSafetyGate(gateOpts(mint));

    expect(result.level).toBe("ok");
    expect(result.reasons).toEqual(["All safety checks passed."]);
    expect(result.sellSim.ok).toBe(true);
    expect(result.rugcheck.ok).toBe(true);
    expect(result.jupiter.ok && result.jupiter.found).toBe(true);
  });

  it("blocks on a RugCheck danger-level risk", async () => {
    const mint = "DangerMint111111111111111111111111111111111";
    stubFetch({
      rugcheck: rugReport({
        score_normalised: 71,
        risks: [
          { name: "Freeze Authority still enabled", level: "danger" },
          { name: "Low amount of LP Providers", level: "warn" }
        ]
      }),
      jupiter: [jupToken(mint)]
    });

    const result = await runSafetyGate(gateOpts(mint));

    expect(result.level).toBe("block");
    expect(result.reasons.join(" ")).toContain(
      "RugCheck danger: Freeze Authority still enabled."
    );
  });

  it("blocks a critical risk pattern even when RugCheck labels it warn", async () => {
    const mint = "RelabelMint11111111111111111111111111111111";
    stubFetch({
      rugcheck: rugReport({
        risks: [{ name: "Mint Authority still enabled", level: "warn" }]
      }),
      jupiter: [jupToken(mint)]
    });

    const result = await runSafetyGate(gateOpts(mint));

    expect(result.level).toBe("block");
    expect(result.reasons.join(" ")).toContain(
      "RugCheck critical risk: Mint Authority still enabled."
    );
  });

  it("blocks a honeypot where the sellability simulation fails", async () => {
    const mint = "HoneypotMint1111111111111111111111111111111";
    stubFetch({ rugcheck: rugReport(), jupiter: [jupToken(mint)] });
    getQuoteMock.mockResolvedValue({
      ok: false,
      error: "Could not find any route"
    });

    const result = await runSafetyGate(gateOpts(mint));

    expect(result.level).toBe("block");
    expect(result.sellSim).toEqual({ ok: false, error: "Could not find any route" });
    expect(result.reasons.join(" ")).toContain("Sellability sim failed");
    // The sim must quote the exit of what the buy would deliver.
    expect(getQuoteMock).toHaveBeenCalledWith(mint, USDC, 1000000000);
  });

  it("blocks when the exit quote succeeds but exit impact exceeds 25%", async () => {
    const mint = "ThinExitMint1111111111111111111111111111111";
    stubFetch({ rugcheck: rugReport(), jupiter: [jupToken(mint)] });
    getQuoteMock.mockResolvedValue(sellQuoteOk("0.31"));

    const result = await runSafetyGate(gateOpts(mint));

    expect(result.level).toBe("block");
    expect(result.reasons.join(" ")).toContain("31.0% exit impact");
  });

  it("blocks buy price impact at the 15% threshold", async () => {
    const mint = "ImpactMint111111111111111111111111111111111";
    stubFetch({ rugcheck: rugReport(), jupiter: [jupToken(mint)] });

    const result = await runSafetyGate(
      gateOpts(mint, { buyQuote: buyQuote("0.15"), acknowledgedHighImpact: true })
    );

    // 15% is the hard limit: blocked even with the acknowledgment ticked.
    expect(result.level).toBe("block");
    expect(result.buy.priceImpactPct).toBeCloseTo(15);
    expect(result.reasons.join(" ")).toContain("above the 15% hard limit");
  });

  it("warns between 5% and 15% impact until acknowledged", async () => {
    const warnMint = "WarnImpactMint11111111111111111111111111111";
    const ackMint = "AckImpactMint111111111111111111111111111111";
    stubFetch({ rugcheck: rugReport(), jupiter: [jupToken(warnMint), jupToken(ackMint)] });

    const unacknowledged = await runSafetyGate(
      gateOpts(warnMint, { buyQuote: buyQuote("0.08") })
    );
    expect(unacknowledged.level).toBe("warn");
    expect(unacknowledged.reasons.join(" ")).toContain("Tick the acknowledgment box");

    const acknowledged = await runSafetyGate(
      gateOpts(ackMint, { buyQuote: buyQuote("0.08"), acknowledgedHighImpact: true })
    );
    expect(acknowledged.level).toBe("ok");
  });

  it("warns on wash trading: high volume from few unique traders", async () => {
    const mint = "WashMint1111111111111111111111111111111111W";
    stubFetch({
      rugcheck: rugReport(),
      jupiter: [
        jupToken(mint, {
          stats24h: {
            buyVolume: 40000,
            sellVolume: 35000, // 75k total, above the 50k wash floor
            numTraders: 12, // below the 30-trader wash ceiling
            numBuys: 20,
            numSells: 18 // 38 tx total, under the 50-tx bot-ratio minimum
          }
        })
      ]
    });

    const result = await runSafetyGate(gateOpts(mint));

    expect(result.level).toBe("warn");
    expect(result.reasons.join(" ")).toContain("only 12 unique traders");
    expect(result.reasons.join(" ")).toContain("wash trading");
  });

  it("warns on a bot ratio below 5% and blocks below 2%", async () => {
    const warnMint = "BotWarnMint11111111111111111111111111111111";
    const blockMint = "BotBlockMint1111111111111111111111111111111";
    stubFetch({
      rugcheck: rugReport(),
      jupiter: [
        // 40 traders / 1000 tx = 4%: warn. Volume kept under the wash floor
        // so only the ratio gate fires.
        jupToken(warnMint, {
          stats24h: { buyVolume: 20000, sellVolume: 15000, numTraders: 40, numBuys: 600, numSells: 400 }
        }),
        // 15 traders / 1000 tx = 1.5%: block.
        jupToken(blockMint, {
          stats24h: { buyVolume: 20000, sellVolume: 15000, numTraders: 15, numBuys: 600, numSells: 400 }
        })
      ]
    });

    const warned = await runSafetyGate(gateOpts(warnMint));
    expect(warned.level).toBe("warn");
    expect(warned.reasons.join(" ")).toContain("Bot ratio 4.0%");

    const blocked = await runSafetyGate(gateOpts(blockMint));
    expect(blocked.level).toBe("block");
    expect(blocked.reasons.join(" ")).toContain("Bot ratio 1.5%");
    expect(blocked.reasons.join(" ")).toContain("sniper-pump signature");
  });

  it("blocks when the RugCheck call itself fails", async () => {
    const mint = "RugDownMint11111111111111111111111111111111";
    stubFetch({
      rugcheck: { error: "upstream timeout" },
      rugcheckStatus: 502,
      jupiter: [jupToken(mint)]
    });

    const result = await runSafetyGate(gateOpts(mint));

    expect(result.level).toBe("block");
    expect(result.rugcheck.ok).toBe(false);
    expect(result.reasons.join(" ")).toContain("RugCheck call failed");
  });

  it("does not block when Jupiter has no listing for a brand-new mint", async () => {
    const mint = "UnlistedMint1111111111111111111111111111111";
    stubFetch({ rugcheck: rugReport(), jupiter: [] });

    const result = await runSafetyGate(gateOpts(mint));

    expect(result.level).toBe("ok");
    expect(result.jupiter).toMatchObject({ ok: true, found: false });
    expect(result.reasons.join(" ")).toContain("no listing for this mint yet");
  });

  it("blocks on the Jupiter top-10 holder concentration cap when set", async () => {
    const mint = "TopHoldMint11111111111111111111111111111111";
    stubFetch({
      rugcheck: rugReport(),
      jupiter: [jupToken(mint, { audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 52.3 } })]
    });

    const result = await runSafetyGate(gateOpts(mint, { maxTopHoldersPct: 40 }));

    expect(result.level).toBe("block");
    expect(result.reasons.join(" ")).toContain("Top 10 holders own 52.3%");
  });
});

describe("screenRugCheck", () => {
  it("marks a danger-level report as blocked", async () => {
    const mint = "ScreenBadMint111111111111111111111111111111";
    stubFetch({
      rugcheck: rugReport({
        rugged: true,
        risks: [{ name: "Creator history of rugged tokens", level: "danger" }]
      })
    });

    const screen = await screenRugCheck(mint);

    expect(screen.ok && screen.blocked).toBe(true);
    if (screen.ok) {
      expect(screen.blockers.join(" ")).toContain("already flagged this mint as rugged");
    }
  });

  it("passes a clean report", async () => {
    const mint = "ScreenOkMint1111111111111111111111111111111";
    stubFetch({ rugcheck: rugReport() });

    const screen = await screenRugCheck(mint);

    expect(screen).toMatchObject({ ok: true, blocked: false, blockers: [] });
  });
});
