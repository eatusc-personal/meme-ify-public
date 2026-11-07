import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Coins,
  RefreshCw,
  Search,
  ShieldCheck,
  Workflow,
  XCircle
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  scanMemecoins,
  lookupToken,
  checkSocialChatter,
  fetchPrices,
  fmtUsd,
  type MemeToken,
  type ScanResult
} from "./lib/markets";
import {
  defaultPaperState,
  runSellPass,
  runBuyPass,
  buyManual,
  sellManual,
  evaluatePositionWatch,
  positionValue,
  decideBuyIntents,
  decideSellIntents,
  applyQueuedIntents,
  deriveAlgoVersion,
  circuitBreakerTripped,
  dailyRealizedUsd,
  type PaperState,
  type PaperSettings,
  type PriceMap,
  type TradeEvent,
  type WatchAlert,
  type PanelAlert,
  type PaperPosition,
  type TradeIntent,
  type DismissedBuyIntent,
  plausibleSellPrice
} from "./lib/paper";
import {
  loadMemecoinState,
  saveMemecoinState,
  savePumpEvent,
  saveScan,
  type MemecoinState,
  type UserPrefs,
  type WatchlistEntry
} from "./lib/memecoinStore";
import {
  readPumpEvents,
  writePumpEvents,
  recentlyLogged,
  pickScanPumps,
  buildPumpEvent,
  type PumpEvent
} from "./lib/pumpwatch";
import { fetchHoldingsCharts, type ChartSeries, type ChartTimeframe } from "./lib/charts";
import { fetchSwapDelta, signAllBase64Txs } from "./lib/wallet";
import {
  getQuote,
  getSwapTransaction,
  confirmSignature,
  sendRawTx,
  getMintDecimals,
  SOL_MINT,
  USDC_MINT,
  USDC_DECIMALS
} from "./lib/swap";
import { runSafetyGate, type SafetyCheck } from "./lib/safety";
import {
  defaultLiveState,
  openLivePosition,
  sellLivePosition,
  decideLiveSellIntents,
  decideLiveBuyIntents,
  livePriceUsd,
  baseSymbol,
  type LiveState,
  type LivePosition,
  type LiveBaseMint
} from "./lib/live";
import { ApiUsageBanner } from "./components/ApiUsageBanner";
import { FlowChart } from "./components/flow/FlowChart";
import { type ChatterState, type SortKey, type Holding } from "./components/memecoin/types";
import {
  type MosaicCache,
  readMosaicCache,
  writeMosaicCache,
  readFeePct,
  writeFeePct,
  readTradeQueue,
  writeTradeQueue,
  readQueueMode,
  writeQueueMode,
  NEWCOIN_REALERT_MS,
  readNewCoinBar,
  readNewCoinSeen,
  writeNewCoinSeen,
  readTradingMode,
  writeTradingMode
} from "./lib/memecoinPrefs";
import { useCollapsibleSection } from "./hooks/useCollapsibleSection";
import { type ConfirmRequest, ConfirmModal } from "./components/memecoin/ConfirmModal";
import { buildHeldCoins } from "./lib/heldCoins";
import { showSystemPositionWatchNotification } from "./lib/notifications";
import { shortAddr, signedUsd, priceLabel, fmtPrice } from "./lib/format";
import { tokenFromPaperPosition } from "./lib/tokenFromPaperPosition";
import { PanelTitle } from "./components/PanelTitle";
import { RotationContextPanel } from "./components/memecoin/RotationContextPanel";
import { MemeCoinCard } from "./components/memecoin/MemeCoinCard";
import { WalletStrip } from "./components/memecoin/WalletStrip";
import { SwapPanel } from "./components/memecoin/SwapPanel";
import { LivePanel } from "./components/memecoin/LivePanel";
import { PaperPanel } from "./components/memecoin/PaperPanel";
import { TradeQueuePanel } from "./components/memecoin/TradeQueuePanel";
import { PumpTriggersPanel } from "./components/memecoin/PumpTriggersPanel";
import { WatchlistPanel } from "./components/memecoin/WatchlistPanel";
import { IntegrationsPanel } from "./components/memecoin/IntegrationsPanel";
import { BuyLiveModal } from "./components/memecoin/BuyLiveModal";
import { SellLiveModal } from "./components/memecoin/SellLiveModal";
import { CoinPopup } from "./components/memecoin/CoinPopup";
import { LiveExecuteModal } from "./components/memecoin/LiveExecuteModal";
import { HoldingsMosaicModal } from "./components/memecoin/HoldingsMosaicModal";

type Tab = "memecoin" | "memecoin_flow";


const VALID_TABS: Tab[] = ["memecoin", "memecoin_flow"];

function readTabFromHash(): Tab {
  const fromHash = window.location.hash.slice(1);
  return (VALID_TABS as string[]).includes(fromHash) ? (fromHash as Tab) : "memecoin";
}

function App() {
  const [tab, setTab] = useState<Tab>(readTabFromHash);

  useEffect(() => {
    const onHashChange = () => setTab(readTabFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    const desired = `#${tab}`;
    if (window.location.hash !== desired) {
      window.history.replaceState(null, "", desired);
    }
  }, [tab]);

  const navItems: Array<{ id: Tab; label: string; icon: typeof Coins }> = [
    { id: "memecoin", label: "Meme Coin", icon: Coins },
    { id: "memecoin_flow", label: "Meme Coin Flow", icon: Workflow }
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div>
            <strong>meme-ify</strong>
            <span>Meme coin trading</span>
          </div>
        </div>
        <nav className="nav-list">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <a
                href={`#${item.id}`}
                className={tab === item.id ? "nav-item active" : "nav-item"}
                key={item.id}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </a>
            );
          })}
        </nav>
        <div className="sidebar-note">
          <ShieldCheck size={18} />
          <span>Manual approval first. APIs can be added after workflows are stable.</span>
        </div>
      </aside>

      <main className="main">
        <ApiUsageBanner />
        <header className="topbar">
          <div>
            <p className="eyebrow">Meme coin trading</p>
            <h1>{navItems.find((item) => item.id === tab)?.label}</h1>
          </div>
        </header>


        {tab === "memecoin" && <MemeCoinPanel />}

        {tab === "memecoin_flow" && <FlowChart />}
      </main>
    </div>
  );
}

// Persistent safety-verdict cache TTL. RugCheck flags (insider bundles, single
// LP wallet, unsellability) don't reverse on a useful timescale, so caching a
// verdict for 6 hours prevents the same coin from re-hitting RugCheck on
// every queue cycle. Past the TTL the next safety pass re-fetches fresh.
const SAFETY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function MemeCoinPanel() {
  const [scan, setScan] = useState<ScanResult | null>(() => {
    try {
      const raw = localStorage.getItem("memeify-memecoin-scan-v2");
      return raw ? (JSON.parse(raw) as ScanResult) : null;
    } catch {
      return null;
    }
  });
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [chatter, setChatter] = useState<Record<string, ChatterState>>({});

  // User preferences (scan sort, hidden coins, hide-view tab, closed-trades
  // collapse). Postgres-backed bundle, persisted via the same payload as
  // the rest of MemecoinState. Previously each lived in its own per-browser
  // localStorage key; that was retired in the 2026-05-24
  // "no-localStorage-for-settings" migration so prefs follow the account
  // across browsers / machines / a future Supabase migration.
  //
  // On first render userPrefs starts at the in-memory defaults; hydration
  // overwrites it with the server value within ~50-100ms (Supabase Postgres).
  // The initial flash to defaults is the trade-off for single-source-of-truth.
  const DEFAULT_USER_PREFS: UserPrefs = {
    sortBy: "rating",
    sortDir: "desc",
    hideView: "visible",
    hiddenMints: [],
    closedExpanded: false,
    collapsedSections: []
  };
  const [userPrefs, setUserPrefs] = useState<UserPrefs>(DEFAULT_USER_PREFS);
  // Sort + view derive directly from userPrefs. Setters route through
  // setUserPrefs so a single bundle persists to Postgres (no parallel state).
  const sortBy = userPrefs.sortBy as SortKey;
  const sortDir = userPrefs.sortDir;
  const hideView = userPrefs.hideView;
  // hiddenMints kept as a Set in component state for O(1) lookups in render.
  // The persisted form is a string[] (jsonb-friendly); the Set is built once
  // per userPrefs update via useMemo.
  const hiddenMints = useMemo(() => new Set(userPrefs.hiddenMints), [userPrefs.hiddenMints]);
  function setSortBy(v: SortKey) {
    setUserPrefs((p) => ({ ...p, sortBy: v }));
  }
  function setSortDir(v: "asc" | "desc") {
    setUserPrefs((p) => ({ ...p, sortDir: v }));
  }
  function setHideView(v: "visible" | "hidden") {
    setUserPrefs((p) => ({ ...p, hideView: v }));
  }

  const [shown, setShown] = useState(5);
  // Address of the coin the user just jumped to from a new-coin alert. Drives a
  // brief highlight pulse on its research card so the eye lands on it after the
  // scroll. Cleared on a timer in jumpToCoin.
  const [highlightedCoin, setHighlightedCoin] = useState<string | null>(null);
  function hideMint(addr: string) {
    setUserPrefs((p) => ({
      ...p,
      hiddenMints: p.hiddenMints.includes(addr) ? p.hiddenMints : [addr, ...p.hiddenMints]
    }));
  }
  function unhideMint(addr: string) {
    setUserPrefs((p) => ({
      ...p,
      hiddenMints: p.hiddenMints.filter((m) => m !== addr)
    }));
  }
  const [popupCoin, setPopupCoin] = useState<string | null>(null);
  // Holdings chart mosaic. The candle cache and the in-flight load live here,
  // not in the modal, so the load is not restarted every time the modal is
  // reopened and keeps running even while the modal is closed.
  const [showMosaic, setShowMosaic] = useState(false);
  const [mosaicTf, setMosaicTf] = useState<ChartTimeframe>("7d");
  const [mosaicCache, setMosaicCache] = useState<MosaicCache>(() => readMosaicCache());
  const [mosaicLoadingTf, setMosaicLoadingTf] = useState<ChartTimeframe | null>(null);
  const [mosaicProgress, setMosaicProgress] = useState({ done: 0, total: 0 });
  const mosaicRunRef = useRef(0);

  // Pump-trigger log: coins that ran up 50%+, with a social-media scan of what
  // may have caused it. Postgres-backed; localStorage is the pre-hydration
  // cache. See src/lib/pumpwatch.ts.
  const [pumpEvents, setPumpEvents] = useState<PumpEvent[]>(readPumpEvents);
  // Dismissed buy intents. When the user clicks Dismiss on a buy in the
  // Trade queue, a record lands here with the metric snapshot at dismissal.
  // The next decideBuyIntents / decideLiveBuyIntents pass skips that address
  // until the rating climbs by buyDismissalImprovementPoints above the
  // dismissed value and a 1-hour anti-flap cooldown has passed. Postgres-
  // backed; hydrated from the load below.
  const [dismissedBuyIntents, setDismissedBuyIntents] = useState<DismissedBuyIntent[]>([]);
  // Watchlist: user-set price alerts. Active rows (triggeredAt == null) get
  // their prices fetched on every position-watch tick; when target is hit,
  // a toast fires and triggeredAt + triggeredPrice are recorded. Triggered
  // rows stay in the list as history. See evaluateWatchlist below.
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>([]);
  // Estimated fee-per-fill % for the trade-stats block. A display setting,
  // Postgres-backed; localStorage is the pre-hydration cache.
  const [feePct, setFeePct] = useState<number>(readFeePct);

  // New-coin pop-up dedup state. The quality bar itself lives in localStorage
  // and is owned by the self-contained <NewCoinBarButton/>; notifyNewCoins reads
  // it fresh each scan via readNewCoinBar(). newCoinSeenRef is the dedup ledger
  // (address -> last alert ms), seeded from localStorage so a reload doesn't
  // re-announce coins.
  const newCoinSeenRef = useRef<Record<string, number>>(readNewCoinSeen());
  const hadPriorScanRef = useRef(false);

  // Trade queue: in queue mode the cycle proposes trades here for review and
  // approval instead of executing them. See TradeQueuePanel. The queue and its
  // mode are Postgres-backed (the paper_account row, like autoRun / watchOn),
  // so they survive a cleared cache or a different origin; the localStorage
  // read here is only the pre-hydration cache.
  const [tradeQueue, setTradeQueue] = useState<TradeIntent[]>(readTradeQueue);
  const [queueMode, setQueueMode] = useState<boolean>(readQueueMode);
  // Top-level Paper / Real trading switch. Postgres-backed; localStorage is the
  // pre-hydration cache. `modeSaveStatus` surfaces whether a mode change has
  // actually been verified saved in the database (round-trip checked).
  const [tradingMode, setTradingMode] = useState<"paper" | "real">(readTradingMode);
  const [modeSaveStatus, setModeSaveStatus] = useState<
    "idle" | "saving" | "verified" | "error"
  >("idle");
  // Pre-buy safety check per queued buy intent, keyed by token address. Runs
  // the same RugCheck / sellability / Jupiter gate the live buy modal uses, so
  // a queued buy can be reviewed for rug risk before it is approved.
  const [queueSafety, setQueueSafety] = useState<
    Record<string, { loading: boolean; result?: SafetyCheck; error?: string }>
  >({});
  // Persistent cache of safety verdicts keyed by token mint. The pre-buy
  // safety gate is expensive (RugCheck + Jupiter + sellability sim per coin);
  // when a dismissed coin's rating climbs +10 and it re-queues, we want to
  // reuse the prior verdict for a window instead of calling RugCheck again.
  // A "block" verdict cached here also auto-dismisses on re-queue without a
  // network round trip. Entries older than SAFETY_CACHE_TTL_MS are ignored
  // and re-checked from upstream the next time the coin queues.
  const [safetyCache, setSafetyCache] = useState<
    Record<string, { result: SafetyCheck; at: string }>
  >(() => {
    try {
      const raw = localStorage.getItem("memeify-memecoin-safety-cache-v1");
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("memeify-memecoin-safety-cache-v1", JSON.stringify(safetyCache));
    } catch {
      /* quota exceeded or storage disabled; in-memory cache still works for the session */
    }
  }, [safetyCache]);
  // Read-through ref so the in-effect loop sees the freshest cache without
  // re-triggering the effect on every cache write.
  const safetyCacheRef = useRef(safetyCache);
  safetyCacheRef.current = safetyCache;
  // The paper position currently being sold (a sell does an async price
  // fetch). Disables the Sell buttons while one is in flight.
  const [sellingId, setSellingId] = useState<string | null>(null);

  // Paper trading: fake money, no keys, no real trades. See docs/ARCHITECTURE.md.
  const [paper, setPaper] = useState<PaperState>(() => {
    try {
      const raw = localStorage.getItem("memeify-memecoin-paper-v1");
      if (!raw) return defaultPaperState();
      const saved = JSON.parse(raw) as PaperState;
      // Merge over defaults so a cache written before a settings field was
      // added (e.g. minAgeHours) still has every field defined.
      const def = defaultPaperState();
      let merged: PaperState = {
        ...def,
        ...saved,
        settings: { ...def.settings, ...saved.settings }
      };
      // One-shot settings migrations are tracked via a versioned localStorage
      // flag (memeify-memecoin-settings-migrations-vN). Each version applies
      // its specific surgical change once. Always check the latest version,
      // plus any legacy keys, so an already-migrated user isn't re-migrated.
      //
      // v1 (May 2026): force minAgeHours=72 and minHolderCount=500 once, so
      // the saved 24h default does not stick after the holder-concentration
      // research landed.
      const MIGRATION_KEY_V1 = "memeify-memecoin-settings-migrations-v1";
      const LEGACY_KEY_V1 = "memeify-memecoin-settings-migrated-may2026";
      const v1Done =
        localStorage.getItem(MIGRATION_KEY_V1) || localStorage.getItem(LEGACY_KEY_V1);
      if (!v1Done) {
        merged = {
          ...merged,
          settings: {
            ...merged.settings,
            minAgeHours: 72,
            minHolderCount: 500
          }
        };
      }
      // Always (re-)assert the v1 marker. Harmless if already set; protects
      // legacy users whose only marker is the old dated key from getting
      // re-migrated if we ever drop the legacy-key check.
      try {
        localStorage.setItem(MIGRATION_KEY_V1, "1");
      } catch {
        /* if storage write fails, the migration will retry next load, which is fine */
      }
      return merged;
    } catch {
      return defaultPaperState();
    }
  });
  // Live trading: real positions on Solana, opened by the user clicking Sign
  // in Phantom. The agent never executes; this is just a ledger. See
  // docs/ARCHITECTURE.md "Live trading".
  const [live, setLive] = useState<LiveState>(() => {
    try {
      const raw = localStorage.getItem("memeify-memecoin-live-v1");
      return raw ? (JSON.parse(raw) as LiveState) : defaultLiveState();
    } catch {
      return defaultLiveState();
    }
  });
  const [prices, setPrices] = useState<PriceMap>(() => {
    try {
      const raw = localStorage.getItem("memeify-memecoin-prices-v1");
      return raw ? (JSON.parse(raw) as PriceMap) : {};
    } catch {
      return {};
    }
  });
  const [cycleLog, setCycleLog] = useState<{ at: string; events: TradeEvent[] } | null>(null);
  const [cycleRunning, setCycleRunning] = useState(false);
  // autoRun and watchOn persist to localStorage so they survive switching
  // dashboard tabs and page reloads. They re-arm automatically on return.
  // autoRun starts OFF; hydration from Postgres overrides within ~50ms. The
  // previous localStorage cache was retired in the 2026-05-24 "no-localStorage
  // -for-settings" migration. Brief OFF flash on initial paint is the
  // single-source-of-truth trade-off; toggles save immediately to Postgres.
  const [autoRun, setAutoRun] = useState(false);
  // Shared busy lock for runCycle and runPositionWatch. Both read `paper` and
  // write the whole object back, so they must not overlap: the cycle's auto
  // interval (180s) and the watch's (300s) realign periodically, and whichever
  // finished last would clobber the other's buys / sells / scale-outs. One
  // lock makes the later one skip its tick; the next tick catches up.
  const paperBusyRef = useRef(false);
  // Re-entrancy guard for the Real-mode cycle (runLiveCycle).
  const liveCycleBusyRef = useRef(false);
  // Live batch execution (R2). One batch at a time; `liveExec` drives the
  // progress modal (one row per intent being approved).
  const liveExecBusyRef = useRef(false);
  const [liveExec, setLiveExec] = useState<{
    rows: {
      id: string;
      label: string;
      status:
        | "queued"
        | "building"
        | "signing"
        | "broadcasting"
        | "confirming"
        | "recording"
        | "done"
        | "failed";
      detail?: string;
    }[];
    running: boolean;
  } | null>(null);
  // Tracks the daily-loss circuit breaker so the toast fires once on the
  // transition into tripped, not every cycle while it stays tripped.
  const circuitTrippedRef = useRef(false);
  // watchOn starts OFF; same architecture as autoRun above.
  const [watchOn, setWatchOn] = useState(false);
  // Collapsible sections. Stable IDs so the user's preferences persist
  // across reloads via the shared localStorage map. Only inline sections
  // (alerts log, meme coin research) read these here; child components like
  // WalletStrip / SwapPanel / PaperPanel / LivePanel / TradeQueuePanel /
  // PumpTriggersPanel each call useCollapsibleSection themselves.
  const alertsLogSection = useCollapsibleSection("alerts-log");
  const researchSection = useCollapsibleSection("meme-coin-research");

  // Alerts persist to localStorage so they survive switching dashboard tabs
  // and browser reloads. They are removed only when the user dismisses them.
  const [alerts, setAlerts] = useState<PanelAlert[]>(() => {
    try {
      const raw = localStorage.getItem("memeify-memecoin-alerts-v1");
      return raw ? (JSON.parse(raw) as PanelAlert[]) : [];
    } catch {
      return [];
    }
  });
  // Per-session UI state: which collapsed alert groups the user has expanded
  // in the top-right toast stack. Resets on reload (alerts persist, but the
  // expand/collapse intent is ephemeral; a fresh session shows the default
  // collapsed view so the stack stays small).
  const [expandedAlertGroups, setExpandedAlertGroups] = useState<Set<string>>(new Set());
  // Connected wallet address, lifted so the Swap panel can use it too.
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  // Live trading modal state. The buy modal seeds with a MemeToken (the
  // scanned coin to swap into); the sell modal seeds with a LivePosition
  // (the one to swap out of). Only one is open at a time.
  const [liveBuyToken, setLiveBuyToken] = useState<MemeToken | null>(null);
  // Optional pre-fill (in USDC) for the live buy modal's amount field. Set when
  // a live buy is launched from a held paper position so the real buy defaults
  // to the same size the paper trade used; null for buys launched off the scan.
  const [liveBuySeedUsd, setLiveBuySeedUsd] = useState<number | null>(null);
  const [liveSellPosition, setLiveSellPosition] = useState<LivePosition | null>(null);
  // Pending buy/sell confirmation popup. Every manual buy and sell, paper or
  // live, opens this first; null when no confirmation is open. See the
  // request* helpers and ConfirmModal.
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null);
  // Mints with a Phantom signature in flight. Set when sign() starts,
  // cleared on confirm finish, modal close, or sign failure. Used by the
  // scan card to refuse a second click while the first transaction is
  // confirming: otherwise the user could open two simultaneous buys for
  // the same coin and end up with two real positions per card.
  const [pendingLiveMints, setPendingLiveMints] = useState<Set<string>>(new Set());
  const markLivePending = (mint: string, on: boolean) =>
    setPendingLiveMints((cur) => {
      const next = new Set(cur);
      if (on) next.add(mint);
      else next.delete(mint);
      return next;
    });

  // Coins currently held (open paper + open live, deduped), for the mosaic.
  const heldCoins = useMemo(() => buildHeldCoins(paper, live), [paper, live]);

  // Load candle data for one timeframe and cache it. Runs to completion even
  // if the mosaic modal is closed mid-load; `force` re-fetches a timeframe
  // that is already cached (the Reload button). A run token guards against a
  // stale load writing over a newer one.
  async function loadMosaic(tf: ChartTimeframe, force = false) {
    if (heldCoins.length === 0) return;
    if (mosaicLoadingTf) return; // one load at a time
    if (!force && mosaicCache[tf]) return; // already cached
    const run = ++mosaicRunRef.current;
    setMosaicLoadingTf(tf);
    setMosaicProgress({ done: 0, total: heldCoins.length });
    const apply = (seriesMap: Record<string, ChartSeries>) => {
      setMosaicCache((prev) => {
        const next: MosaicCache = {
          ...prev,
          [tf]: { series: { ...seriesMap }, loadedAt: new Date().toISOString() }
        };
        writeMosaicCache(next);
        return next;
      });
    };
    try {
      const res = await fetchHoldingsCharts(
        heldCoins.map((c) => c.address),
        tf,
        (done, total, partial) => {
          if (mosaicRunRef.current !== run) return;
          setMosaicProgress({ done, total });
          apply(partial);
        }
      );
      if (mosaicRunRef.current === run) apply(res);
    } catch {
      /* keep whatever partial data already landed in the cache */
    } finally {
      if (mosaicRunRef.current === run) setMosaicLoadingTf(null);
    }
  }

  // Background-load the mosaic: as soon as there are held coins and the
  // current timeframe is not cached, start fetching, whether or not the modal
  // is open. The load paces itself and runs to completion on its own, so
  // opening the modal later just shows the ready snapshot. A cached timeframe
  // never refetches; the Reload button is the only refresh.
  useEffect(() => {
    if (!mosaicLoadingTf && !mosaicCache[mosaicTf] && heldCoins.length > 0) {
      void loadMosaic(mosaicTf);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mosaicTf, mosaicCache, mosaicLoadingTf, heldCoins]);

  const hydratedRef = useRef(false);
  // serverScheduler.watch: true when the server is running the 5-min position
  // watch tick. In that case the React-side watch useEffect skips installing
  // its own setInterval so we don't double-fire. Hydrated from
  // /api/memecoin/state, read-only on this side (the server owns the flag via
  // the SERVER_SCHEDULER_WATCH env var).
  const [serverSchedulesWatch, setServerSchedulesWatch] = useState(false);
  // serverScheduler.scan: true when the server runs the new-coin scan tick. In
  // that case the server owns new-coin alerting and the browser's notifyNewCoins
  // becomes a no-op (avoids double-firing). Hydrated from /api/memecoin/state,
  // server-owned via SERVER_SCHEDULER_SCAN.
  const [serverSchedulesScan, setServerSchedulesScan] = useState(false);
  const lastSavedRef = useRef("");
  const serverAlertIdsRef = useRef<Set<string>>(new Set());
  // Save-state indicator for the trading rules: every settings change is
  // auto-saved (debounced) to Postgres; this surfaces that it happened so a
  // change is never silently in limbo.
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "error">("saved");

  // On mount, pull the canonical state from Postgres. If the database is
  // empty (fresh), seed it from whatever is in the localStorage cache.
  //
  // CRITICAL: hydratedRef is armed ONLY after a *successful* load. If the load
  // fails we must NOT arm it, because the debounced persist effect and the
  // beforeunload beacon both gate on hydratedRef — arming on failure lets this
  // tab write its in-memory DEFAULTS (autoRun=false, watchOn=false, since those
  // are not cached in localStorage) back over the real Postgres row, silently
  // flipping Auto-run / Position watch OFF for every other tab. A transient DB
  // or network blip on any one open tab was enough to reset them. We retry a
  // few times with backoff; if it still fails we leave the writer disarmed so
  // the canonical state is preserved and a reload can recover it.
  useEffect(() => {
    let cancelled = false;
    let attempt = 0;
    const MAX_ATTEMPTS = 5;
    const hydrate = () => {
      void loadMemecoinState().then((res) => {
      if (cancelled) return;
      if (res.ok) {
        const s = res.state;
        if (s.paper) {
          const a = s.alerts ?? [];
          serverAlertIdsRef.current = new Set(a.map((x) => x.id));
          const pr = s.prices ?? {};
          const sc = s.scan ?? null;
          const ar = s.autoRun ?? false;
          const wo = s.watchOn ?? false;
          const qm = s.queueMode ?? false;
          const tq = s.tradeQueue ?? [];
          const lv = s.live ?? defaultLiveState();
          const fp = typeof s.feePct === "number" ? s.feePct : readFeePct();
          const pe = s.pumpEvents ?? [];
          const tm: "paper" | "real" = s.tradingMode === "real" ? "real" : "paper";
          const db = Array.isArray(s.dismissedBuyIntents) ? s.dismissedBuyIntents : [];
          // userPrefs: defensive fallbacks per field. If the row is freshly
          // hydrated from an old DB without the columns, every value falls
          // back to the in-memory default and the next save round-trips
          // the new columns into Postgres.
          const up: UserPrefs = {
            sortBy: typeof s.userPrefs?.sortBy === "string" ? s.userPrefs.sortBy : "rating",
            sortDir: s.userPrefs?.sortDir === "asc" ? "asc" : "desc",
            hideView: s.userPrefs?.hideView === "hidden" ? "hidden" : "visible",
            hiddenMints: Array.isArray(s.userPrefs?.hiddenMints) ? s.userPrefs.hiddenMints : [],
            closedExpanded: !!s.userPrefs?.closedExpanded,
            collapsedSections: Array.isArray(s.userPrefs?.collapsedSections)
              ? s.userPrefs.collapsedSections
              : []
          };
          setPaper(s.paper);
          // If the loaded account is already in a daily-loss pause, mark the
          // breaker as already-notified so a page reload does not re-toast it.
          circuitTrippedRef.current = circuitBreakerTripped(s.paper);
          setLive(lv);
          setAlerts(a);
          setPrices(pr);
          setScan(sc);
          setAutoRun(ar);
          setWatchOn(wo);
          setQueueMode(qm);
          setTradeQueue(tq);
          setFeePct(fp);
          setPumpEvents(pe);
          setTradingMode(tm);
          setDismissedBuyIntents(db);
          setUserPrefs(up);
          setWatchlist(Array.isArray(s.watchlist) ? s.watchlist : []);
          setServerSchedulesWatch(!!s.serverScheduler?.watch);
          setServerSchedulesScan(!!s.serverScheduler?.scan);
          // Refresh the localStorage cache so it matches what Postgres holds.
          writeQueueMode(qm);
          writeTradeQueue(tq);
          writeFeePct(fp);
          writePumpEvents(pe);
          writeTradingMode(tm);
          lastSavedRef.current = JSON.stringify({
            paper: s.paper,
            live: lv,
            alerts: a,
            prices: pr,
            scan: sc,
            autoRun: ar,
            watchOn: wo,
            queueMode: qm,
            tradeQueue: tq,
            feePct: fp,
            pumpEvents: pe,
            tradingMode: tm,
            dismissedBuyIntents: db,
            userPrefs: up,
            watchlist: Array.isArray(s.watchlist) ? s.watchlist : []
          });
        } else {
          // Fresh database: seed it from the current local cache.
          void saveMemecoinState({
            paper,
            live,
            alerts,
            prices,
            scan,
            autoRun,
            watchOn,
            queueMode,
            tradeQueue,
            feePct,
            pumpEvents,
            tradingMode,
            dismissedBuyIntents,
            userPrefs,
            watchlist
          });
        }
        // Loaded cleanly — now (and only now) arm the persist writer.
        hydratedRef.current = true;
      } else {
        attempt += 1;
        if (attempt < MAX_ATTEMPTS) {
          setError(
            `Database load failed: ${res.error}. Retrying (${attempt}/${MAX_ATTEMPTS})…`
          );
          setTimeout(hydrate, 1500 * attempt);
        } else {
          // Give up retrying but DO NOT arm the writer: this tab keeps showing
          // the localStorage cache (positions/alerts) but will not save, so it
          // cannot clobber the canonical autoRun / watchOn / settings in
          // Postgres. A manual reload re-runs this load from scratch.
          setError(
            `Database load failed: ${res.error}. This tab won't save until it loads — reload to retry.`
          );
        }
      }
      });
    };
    hydrate();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When SERVER_SCHEDULER_WATCH=true, the Vite server owns the 5-minute
  // position-watch tick, so the browser-side runPositionWatch path (and its
  // pushAlert -> new Notification call) is intentionally disabled. Poll the
  // canonical DB state while a tab is open so server-created alert rows still
  // hydrate into the UI and can become OS pop-ups for this origin.
  useEffect(() => {
    if (!serverSchedulesWatch || !watchOn) return;
    let cancelled = false;

    const applyServerState = (s: MemecoinState) => {
      if (!s.paper) return;
      const a = s.alerts ?? [];
      const pr = s.prices ?? {};
      const sc = s.scan ?? null;
      const ar = s.autoRun ?? false;
      const wo = s.watchOn ?? false;
      const qm = s.queueMode ?? false;
      const tq = s.tradeQueue ?? [];
      const lv = s.live ?? defaultLiveState();
      const fp = typeof s.feePct === "number" ? s.feePct : readFeePct();
      const pe = s.pumpEvents ?? [];
      const tm: "paper" | "real" = s.tradingMode === "real" ? "real" : "paper";
      const db = Array.isArray(s.dismissedBuyIntents) ? s.dismissedBuyIntents : [];
      const up: UserPrefs = {
        sortBy: typeof s.userPrefs?.sortBy === "string" ? s.userPrefs.sortBy : "rating",
        sortDir: s.userPrefs?.sortDir === "asc" ? "asc" : "desc",
        hideView: s.userPrefs?.hideView === "hidden" ? "hidden" : "visible",
        hiddenMints: Array.isArray(s.userPrefs?.hiddenMints) ? s.userPrefs.hiddenMints : [],
        closedExpanded: !!s.userPrefs?.closedExpanded,
        collapsedSections: Array.isArray(s.userPrefs?.collapsedSections)
          ? s.userPrefs.collapsedSections
          : []
      };

      const seen = serverAlertIdsRef.current;
      const freshAlerts = a
        .filter((x) => !x.dismissed && !seen.has(x.id))
        .sort((x, y) => new Date(x.at).getTime() - new Date(y.at).getTime());
      serverAlertIdsRef.current = new Set(a.map((x) => x.id));
      for (const alert of freshAlerts) showSystemPositionWatchNotification(alert.text);

      setPaper(s.paper);
      circuitTrippedRef.current = circuitBreakerTripped(s.paper);
      setLive(lv);
      setAlerts(a);
      setPrices(pr);
      setScan(sc);
      setAutoRun(ar);
      setWatchOn(wo);
      setQueueMode(qm);
      setTradeQueue(tq);
      setFeePct(fp);
      setPumpEvents(pe);
      setTradingMode(tm);
      setDismissedBuyIntents(db);
      setUserPrefs(up);
      setWatchlist(Array.isArray(s.watchlist) ? s.watchlist : []);
      setServerSchedulesWatch(!!s.serverScheduler?.watch);
      setServerSchedulesScan(!!s.serverScheduler?.scan);
      lastSavedRef.current = JSON.stringify({
        paper: s.paper,
        live: lv,
        alerts: a,
        prices: pr,
        scan: sc,
        autoRun: ar,
        watchOn: wo,
        queueMode: qm,
        tradeQueue: tq,
        feePct: fp,
        pumpEvents: pe,
        tradingMode: tm,
        dismissedBuyIntents: db,
        userPrefs: up,
        watchlist: Array.isArray(s.watchlist) ? s.watchlist : []
      });
    };

    const poll = () => {
      if (!hydratedRef.current || saveStatus !== "saved") return;
      void loadMemecoinState().then((res) => {
        if (cancelled || !res.ok) return;
        applyServerState(res.state);
      });
    };

    const id = window.setInterval(poll, 60_000);
    poll();
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [serverSchedulesWatch, watchOn, saveStatus]);

  // Persist on change: localStorage right away as a fast cache, Postgres
  // debounced as the source of truth. The DB write waits for hydration so
  // stale local state cannot overwrite what the database already holds.
  // Persist effect. Two efficiency tweaks compared to the previous version:
  //
  // P11: localStorage writes were unconditional on every dep change, so a
  // burst of state churn (e.g. a cycle's price refresh + an alert push
  // + a position-watch tick all in one tick) JSON.stringify'd everything
  // multiple times per second. The writes now happen INSIDE the debounced
  // callback, so a burst collapses into one localStorage write per debounce
  // window — same as Postgres.
  //
  // P3: prices-only changes get a longer debounce (2500ms) than real changes
  // (700ms). Each cycle's setPrices rebuilds the whole price map even when no
  // per-coin price moved, so the full-state Postgres POST was paying for
  // noisy churn. User-facing edits (slider, buy, sell) still persist in
  // 700ms. Detection: compare every non-prices state ref to the previous
  // render via a ref. If nothing else changed, only prices did.
  const persistPrevRef = useRef<{
    paper: typeof paper;
    live: typeof live;
    alerts: typeof alerts;
    scan: typeof scan;
    autoRun: typeof autoRun;
    watchOn: typeof watchOn;
    queueMode: typeof queueMode;
    tradeQueue: typeof tradeQueue;
    feePct: typeof feePct;
    pumpEvents: typeof pumpEvents;
    tradingMode: typeof tradingMode;
    dismissedBuyIntents: typeof dismissedBuyIntents;
    userPrefs: typeof userPrefs;
    watchlist: typeof watchlist;
  } | null>(null);
  useEffect(() => {
    if (!hydratedRef.current) {
      persistPrevRef.current = {
        paper, live, alerts, scan, autoRun, watchOn, queueMode,
        tradeQueue, feePct, pumpEvents, tradingMode, dismissedBuyIntents, userPrefs, watchlist
      };
      return;
    }
    const payload = JSON.stringify({
      paper, live, alerts, prices, scan, autoRun, watchOn, queueMode,
      tradeQueue, feePct, pumpEvents, tradingMode, dismissedBuyIntents, userPrefs, watchlist
    });
    if (payload === lastSavedRef.current) return;
    // Did any non-prices field change reference? Reference equality is fine
    // because all setters use ({ ...cur }) or similar to produce new objects.
    const prev = persistPrevRef.current;
    const nonPriceChanged =
      !prev ||
      prev.paper !== paper ||
      prev.live !== live ||
      prev.alerts !== alerts ||
      prev.scan !== scan ||
      prev.autoRun !== autoRun ||
      prev.watchOn !== watchOn ||
      prev.queueMode !== queueMode ||
      prev.tradeQueue !== tradeQueue ||
      prev.feePct !== feePct ||
      prev.pumpEvents !== pumpEvents ||
      prev.tradingMode !== tradingMode ||
      prev.dismissedBuyIntents !== dismissedBuyIntents ||
      prev.userPrefs !== userPrefs ||
      prev.watchlist !== watchlist;
    // User-toggle and "user said-no" changes bypass the 700ms debounce so
    // a refresh-within-window can't lose them. Toggles (autoRun, watchOn,
    // queueMode, tradingMode) are obvious. dismissedBuyIntents matters
    // because a dismiss-then-refresh would silently let the coin back into
    // the queue on the next cycle — exactly the failure shape that bit us
    // with KM. tradeQueue matters because an approval that finishes
    // immediately before refresh would otherwise leave the original intent
    // still in the queue after reload. userPrefs matters because a sort /
    // hide-tab change followed by a refresh would otherwise reset. All
    // infrequent explicit user actions; the immediate-save cost is negligible.
    const userToggleChanged =
      !!prev &&
      (prev.autoRun !== autoRun ||
        prev.watchOn !== watchOn ||
        prev.queueMode !== queueMode ||
        prev.tradingMode !== tradingMode ||
        prev.dismissedBuyIntents !== dismissedBuyIntents ||
        prev.tradeQueue !== tradeQueue ||
        prev.userPrefs !== userPrefs ||
        prev.watchlist !== watchlist ||
        // alerts changes reference identity when the user clicks Hide / Hide
        // all / per-row dismiss; persisting immediately closes the
        // hide-then-refresh-within-700ms race that brought hidden toasts back.
        // Toast pushes from cycles also flow through here; that's fine,
        // adding ~1 extra save per minute is negligible.
        prev.alerts !== alerts);
    persistPrevRef.current = {
      paper, live, alerts, scan, autoRun, watchOn, queueMode,
      tradeQueue, feePct, pumpEvents, tradingMode, dismissedBuyIntents, userPrefs, watchlist
    };
    const debounceMs = userToggleChanged ? 0 : nonPriceChanged ? 700 : 2500;
    setSaveStatus("saving");
    const handle = setTimeout(() => {
      // P11: localStorage writes happen here, once per debounce window,
      // not on every dep change. These caches are pre-hydration perf only;
      // see docs/ARCHITECTURE.md "Persistence audit" for why settings/prefs do NOT
      // also go to localStorage (they live exclusively in Postgres).
      try {
        localStorage.setItem("memeify-memecoin-paper-v1", JSON.stringify(paper));
        localStorage.setItem("memeify-memecoin-live-v1", JSON.stringify(live));
        localStorage.setItem("memeify-memecoin-alerts-v1", JSON.stringify(alerts));
        localStorage.setItem("memeify-memecoin-prices-v1", JSON.stringify(prices));
        if (scan) localStorage.setItem("memeify-memecoin-scan-v2", JSON.stringify(scan));
      } catch {
        /* storage unavailable; state still lives in memory and in Postgres */
      }
      void saveMemecoinState({
        paper, live, alerts, prices, scan, autoRun, watchOn, queueMode,
        tradeQueue, feePct, pumpEvents, tradingMode, dismissedBuyIntents, userPrefs, watchlist
      }).then((res) => {
        if (res.ok) {
          lastSavedRef.current = payload;
          setSaveStatus("saved");
        } else {
          setSaveStatus("error");
          setError(`Database save failed: ${res.error}`);
        }
      });
    }, debounceMs);
    return () => clearTimeout(handle);
  }, [
    paper,
    live,
    alerts,
    prices,
    scan,
    autoRun,
    watchOn,
    queueMode,
    tradeQueue,
    feePct,
    pumpEvents,
    tradingMode,
    dismissedBuyIntents,
    userPrefs,
    watchlist
  ]);

  // P11 follow-up: synchronously flush both halves of the persist pair on tab
  // close. The debounced effect above can leave a 0-2500ms window where the
  // freshest in-memory state isn't durable anywhere.
  //
  // localStorage.setItem is synchronous and always lands.
  //
  // For the canonical DB save we use navigator.sendBeacon, which is designed
  // exactly for this case: the browser queues the POST and delivers it on a
  // best-effort basis after unload, ignoring page navigation. Without it, a
  // user toggle followed by a quick refresh races the in-flight fetch and the
  // toggle silently reverts on reload (visible against Supabase's ~50-100ms
  // round-trip; near-invisible against the old local 1ms socket). We only
  // beacon when the current state differs from lastSavedRef so we don't
  // double-write on every unload.
  useEffect(() => {
    const flush = () => {
      try {
        localStorage.setItem("memeify-memecoin-paper-v1", JSON.stringify(paper));
        localStorage.setItem("memeify-memecoin-live-v1", JSON.stringify(live));
        localStorage.setItem("memeify-memecoin-alerts-v1", JSON.stringify(alerts));
        localStorage.setItem("memeify-memecoin-prices-v1", JSON.stringify(prices));
        if (scan) localStorage.setItem("memeify-memecoin-scan-v2", JSON.stringify(scan));
      } catch {
        /* storage unavailable or quota exceeded; nothing we can do at unload */
      }
      // Beacon the canonical DB save. Skip if hydration hasn't finished (we
      // don't want to overwrite the DB with the in-memory defaults).
      //
      // pumpEvents (~1 MB on this app) and scan (~47 KB) are stripped from
      // the body. With them included the body was over sendBeacon's 64 KB
      // ceiling and the browser was silently rejecting every beacon — every
      // refresh-during-debounce was losing the change. Stripped body is
      // ~49 KB, safely inside the limit.
      //
      // The trade-off: pumpEvents and scan changes that happened *between*
      // the last debounced fetch and the refresh aren't covered by this
      // beacon. pumpEvents have their own write path (POST
      // /api/memecoin/pump-events fires per event from logPumps), so they're
      // protected. scan re-fills on the next scan cycle.
      //
      // We intentionally don't compare against lastSavedRef here: that ref
      // holds the full-state JSON which always differs from our stripped
      // body, and gating on it would skip every beacon. An extra POST per
      // unload is negligible.
      try {
        if (!hydratedRef.current) return;
        const body = JSON.stringify({
          paper, live, alerts, prices, autoRun, watchOn, queueMode,
          tradeQueue, feePct, tradingMode, dismissedBuyIntents, userPrefs, watchlist
        });
        const blob = new Blob([body], { type: "application/json" });
        navigator.sendBeacon("/api/memecoin/state", blob);
      } catch {
        /* beacon API unavailable or blocked; localStorage above is the fallback */
      }
    };
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, [
    paper, live, alerts, prices, scan, autoRun, watchOn, queueMode,
    tradeQueue, feePct, pumpEvents, tradingMode, dismissedBuyIntents, userPrefs, watchlist
  ]);

  // (Removed 2026-05-24: memeify-memecoin-autorun-v1 / -watch-v1 localStorage
  // cache. Toggles are Postgres-only now; immediate-save bypass on toggle
  // change closes the refresh-within-debounce race the cache used to paper
  // over. See docs/ARCHITECTURE.md "Persistence audit".)

  // On mount, refresh prices for held positions so a page reload shows real
  // values right away instead of falling back to cost basis.
  useEffect(() => {
    void refreshHeldPrices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // P2: in-flight Promise dedup. When the user edits a queue row mid-check,
  // the tradeQueue reference changes and the safety useEffect re-fires. The
  // pending filter (which checks `queueSafety[addr].loading`) used to treat
  // in-flight calls as "still pending" and re-issue them, paying RugCheck +
  // Jupiter twice for the same intent. This ref tracks the in-flight Promise
  // per address so a re-render re-attaches to the same upstream work instead
  // of starting a new round. Cleared per address when its Promise settles.
  const safetyInFlightRef = useRef<
    Map<string, Promise<{ safe?: SafetyCheck; error?: string }>>
  >(new Map());

  // Run the pre-buy safety gate for every queued buy intent. Each one gets a
  // USDC-denominated Jupiter quote and the same RugCheck / sellability /
  // Jupiter check the live buy modal uses, so a queued buy carries a rug-risk
  // verdict before it is approved. Sequential, so the upstreams are not
  // hammered; an entry stuck loading (a cancelled run) is retried next time.
  useEffect(() => {
    // Prune safety results for coins no longer queued, so the map does not
    // grow all session and a dismissed-then-re-queued coin gets a fresh check
    // instead of a stale verdict.
    const buyAddrs = new Set(
      tradeQueue.filter((q) => q.kind === "buy").map((q) => q.address)
    );
    setQueueSafety((cur) => {
      let changed = false;
      const next: typeof cur = {};
      for (const k of Object.keys(cur)) {
        if (buyAddrs.has(k)) next[k] = cur[k];
        else changed = true;
      }
      return changed ? next : cur;
    });
    // P2 cleanup: drop in-flight refs for addresses no longer queued. The
    // Promise itself can still resolve (we just won't keep tracking it).
    for (const k of safetyInFlightRef.current.keys()) {
      if (!buyAddrs.has(k)) safetyInFlightRef.current.delete(k);
    }
    // Pending = queued buys with no completed verdict AND no in-flight call.
    // Without the in-flight check, a queue edit during a safety round would
    // re-add the same intent to `pending` and double-issue RugCheck/Jupiter.
    const pending = tradeQueue.filter(
      (q) =>
        q.kind === "buy" &&
        (!queueSafety[q.address] || queueSafety[q.address].loading) &&
        !safetyInFlightRef.current.has(q.address)
    );
    if (pending.length === 0) return;
    let active = true;
    // Collected during the loop, applied as a single batch at the end so the
    // tradeQueue and dismissedBuyIntents mutations don't re-trigger the
    // effect mid-loop or cause partial state. Block verdicts go here whether
    // they came from the cache or a fresh upstream call.
    const toAutoDismiss: { intent: TradeIntent; safe: SafetyCheck }[] = [];

    // Per-intent worker, wrapped so its Promise can be deduped via the
    // in-flight map. Returns {safe} on success or {error} on failure;
    // queueSafety state is updated as a side effect so the UI tracks loading.
    async function runForIntent(
      intent: TradeIntent
    ): Promise<{ safe?: SafetyCheck; error?: string }> {
      // Cache lookup first — skip upstream calls entirely if fresh.
      const cached = safetyCacheRef.current[intent.address];
      const cacheFresh =
        cached && Date.now() - new Date(cached.at).getTime() < SAFETY_CACHE_TTL_MS;
      if (cached && cacheFresh) {
        setQueueSafety((cur) => ({
          ...cur,
          [intent.address]: { loading: false, result: cached.result }
        }));
        return { safe: cached.result };
      }
      setQueueSafety((cur) => ({ ...cur, [intent.address]: { loading: true } }));
      try {
        const size =
          intent.sizeUsd && intent.sizeUsd > 0 ? intent.sizeUsd : paper.settings.tradeSizeUsd;
        const q = await getQuote(USDC_MINT, intent.address, Math.floor(size * 1e6), 50);
        if (!q.ok) {
          setQueueSafety((cur) => ({
            ...cur,
            [intent.address]: { loading: false, error: q.error }
          }));
          return { error: q.error };
        }
        const safe = await runSafetyGate({
          tokenMint: intent.address,
          baseMint: USDC_MINT,
          buyQuote: q.quote,
          acknowledgedHighImpact: false,
          maxTopHoldersPct: paper.settings.maxTopHoldersPct
        });
        setQueueSafety((cur) => ({
          ...cur,
          [intent.address]: { loading: false, result: safe }
        }));
        // Cache write. Update ref so concurrent in-loop callers see it and
        // state so localStorage persists across reload.
        const entry = { result: safe, at: new Date().toISOString() };
        safetyCacheRef.current = { ...safetyCacheRef.current, [intent.address]: entry };
        setSafetyCache((cur) => ({ ...cur, [intent.address]: entry }));
        return { safe };
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        setQueueSafety((cur) => ({
          ...cur,
          [intent.address]: { loading: false, error: err }
        }));
        return { error: err };
      }
    }

    void (async () => {
      for (const intent of pending) {
        if (!active) return;
        // Register the in-flight Promise BEFORE awaiting so a concurrent
        // re-render of the effect sees the address as already-in-progress
        // and skips it. Settle handler clears the entry.
        let p = safetyInFlightRef.current.get(intent.address);
        if (!p) {
          p = runForIntent(intent).finally(() => {
            safetyInFlightRef.current.delete(intent.address);
          });
          safetyInFlightRef.current.set(intent.address, p);
        }
        const res = await p;
        if (!active) return;
        if (res.safe && res.safe.level === "block") {
          toAutoDismiss.push({ intent, safe: res.safe });
        }
      }
      if (!active) return;
      // (A) Apply the batched auto-dismissals: append dismissal records (so
      // future cycles skip these coins per the existing rating-improvement
      // gate), remove the intents from the queue, and toast the user once
      // per blocked coin so they know why it disappeared.
      if (toAutoDismiss.length > 0) {
        setDismissedBuyIntents((cur) => {
          let next = cur;
          for (const { intent, safe } of toAutoDismiss) {
            const rec: DismissedBuyIntent = {
              address: intent.address,
              symbol: intent.symbol,
              name: intent.name,
              account: intent.account === "live" ? "live" : "paper",
              dismissedAt: new Date().toISOString(),
              dismissedRating: intent.ratingAtProposal,
              dismissedExitScore: intent.exitScoreAtProposal,
              dismissedLiquidityUsd: intent.liquidityAtProposal,
              source: "auto-safety-block",
              reason: safe.reasons[0] ?? "Safety gate blocked",
              algoVersion: deriveAlgoVersion(paper.settings)
            };
            next = [rec, ...next.filter((d) => d.address !== rec.address)];
          }
          return next;
        });
        const blockedIds = new Set(toAutoDismiss.map((b) => b.intent.id));
        setTradeQueue((cur) => {
          const filtered = cur.filter((q) => !blockedIds.has(q.id));
          writeTradeQueue(filtered);
          return filtered;
        });
        // Build the new alerts list synchronously so we can persist it in one
        // shot below, instead of pushing one at a time and racing the 700ms
        // debounced persist with a refresh / HMR that re-hydrates from the
        // older saved state. Same trick the live-confirm handlers use.
        const newAlerts: PanelAlert[] = toAutoDismiss.map(({ intent, safe }) => ({
          id: `al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}_${intent.address.slice(0, 4)}`,
          at: new Date().toISOString(),
          text: `Auto-dismissed ${intent.symbol}: ${safe.reasons[0] ?? "safety gate block"}`,
          kind: "danger" as const
        }));
        // Mirror each through the OS Notification path that pushAlert uses, so
        // the user still gets a system ping even though we're bypassing
        // pushAlert itself (which would only batch the React state, not the
        // immediate persist).
        for (const a of newAlerts) showSystemPositionWatchNotification(a.text);
        setAlerts((cur) => {
          const merged = [...newAlerts, ...cur];
          // Force-save: build the payload from the latest committed siblings
          // (persistRef.current) with the just-merged alerts layered on top.
          // The standard 700ms debounce would let an HMR re-mount race the
          // save and silently wipe these alerts. See the matching pattern in
          // confirmLiveBuy / confirmLiveSell.
          const payload = { ...persistRef.current, alerts: merged };
          void saveMemecoinState(payload).then((res) => {
            if (res.ok) {
              lastSavedRef.current = JSON.stringify(payload);
            }
          });
          return merged;
        });
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tradeQueue]);

  // Live trading confirm handlers. Called only AFTER the user has signed in
  // Phantom and the swap has confirmed on-chain. State mutation here does
  // not move funds; the funds already moved on-chain. The role of these is
  // to record what just happened so the live panel can show it.
  //
  // Both handlers force a synchronous, non-debounced save to Postgres
  // immediately after updating React state. The standard persist effect
  // uses a 700ms debounce; closing the tab inside that window after a
  // Phantom confirm would otherwise drop the position from the ledger.
  // The on-chain trade is real either way; this just keeps the dashboard
  // honest about it.
  async function confirmLiveBuy(args: {
    token: MemeToken;
    signature: string;
    baseMint: LiveBaseMint;
    baseAmountSpent: number;
    tokenAmountReceived: number;
    entryPriceUsdAtFill: number;
    buyPriceImpactPct: number;
    slippageBps: number;
  }) {
    const newLive = openLivePosition(persistRef.current.live, {
      mint: args.token.address,
      symbol: args.token.symbol,
      name: args.token.name,
      baseMint: args.baseMint,
      signature: args.signature,
      baseAmountSpent: args.baseAmountSpent,
      tokenAmountReceived: args.tokenAmountReceived,
      priceUsdAtEntry: args.entryPriceUsdAtFill,
      slippageBps: args.slippageBps,
      buyPriceImpactPct: args.buyPriceImpactPct,
      // Capture the entry-time feature snapshot (top-10 holders %, bot ratio,
      // rating, liquidity, etc.) for retrospective analysis in trade_log.
      token: args.token,
      // Capture the PaperSettings regime in effect at this fill, so
      // post-hoc queries can answer "did the algo2 holder floor improve
      // live win rate vs the algo1 regime?".
      settings: persistRef.current.paper.settings
    });
    setLive(newLive);
    // A confirmed live buy clears any active dismissal on the address.
    clearBuyDismissal(args.token.address);
    setLiveBuyToken(null);
    setLiveBuySeedUsd(null);
    pushAlert(
      `Live buy filled: ${args.tokenAmountReceived.toPrecision(6)} ${args.token.symbol} for ${args.baseAmountSpent.toFixed(args.baseMint === SOL_MINT ? 4 : 2)} ${baseSymbol(args.baseMint)}.`,
      "profit"
    );
    // Force-save from the latest committed siblings (a cycle/watch may have
    // run during the Phantom sign), with the fresh live state layered on top.
    const payload = { ...persistRef.current, live: newLive };
    const res = await saveMemecoinState(payload);
    if (res.ok) {
      lastSavedRef.current = JSON.stringify(payload);
    } else {
      pushAlert(
        `Live buy recorded in the browser only: database save failed (${res.error}). It will retry on the next state change.`,
        "danger"
      );
    }
  }

  async function confirmLiveSell(args: {
    positionId: string;
    signature: string;
    tokensSold: number;
    baseAmountReceived: number;
    exitPriceUsd: number;
    reason: string;
  }) {
    const liveBefore = persistRef.current.live;
    const before = liveBefore.positions.find((p) => p.id === args.positionId);
    const newLive = sellLivePosition(liveBefore, args.positionId, {
      signature: args.signature,
      tokensSold: args.tokensSold,
      baseAmountReceived: args.baseAmountReceived,
      exitPriceUsd: args.exitPriceUsd,
      reason: args.reason
    });
    setLive(newLive);
    setLiveSellPosition(null);
    const partial =
      !!before && args.tokensSold < before.entryTokenAmount * 0.9999;
    pushAlert(
      partial
        ? `Live partial sell filled: ${args.tokensSold.toPrecision(6)} ${before?.symbol ?? ""} sold, the rest stays open. Signature ${args.signature.slice(0, 12)}...`
        : `Live sell filled: signature ${args.signature.slice(0, 12)}...`,
      "profit"
    );
    // Force-save from the latest committed siblings (a cycle/watch may have
    // run during the Phantom sign), with the fresh live state layered on top.
    const payload = { ...persistRef.current, live: newLive };
    const res = await saveMemecoinState(payload);
    if (res.ok) {
      lastSavedRef.current = JSON.stringify(payload);
    } else {
      pushAlert(
        `Live sell recorded in the browser only: database save failed (${res.error}). It will retry on the next state change.`,
        "danger"
      );
    }
  }

  // --- Trade queue (paper money; the shape the real-money flow will use) ---
  function enqueueIntents(newIntents: TradeIntent[]): number {
    const has = (it: TradeIntent) =>
      tradeQueue.some(
        (q) =>
          q.kind === it.kind &&
          (it.kind === "buy" ? q.address === it.address : q.positionId === it.positionId)
      );
    const fresh = newIntents.filter((it) => !has(it));
    if (fresh.length > 0) {
      const next = [...fresh, ...tradeQueue].slice(0, 100);
      setTradeQueue(next);
      writeTradeQueue(next);
    }
    return fresh.length;
  }

  async function approveQueued(ids: string[]) {
    if (cycleBusy("approve the queue")) return;
    const chosen = tradeQueue.filter((q) => ids.includes(q.id));
    if (chosen.length === 0) return;
    // Approving a buy is the user changing their mind; clear any active
    // dismissal for the same address so the block does not outlast the
    // intent it referred to. Sells leave dismissals alone.
    for (const q of chosen) {
      if (q.kind === "buy") clearBuyDismissal(q.address);
    }
    // Live intents go through the real-money pipeline: build the swaps, sign
    // the batch in one Phantom approval, broadcast, confirm, record. Paper
    // intents are booked against the paper sim below.
    const liveChosen = chosen.filter((q) => q.account === "live");
    const paperChosen = chosen.filter((q) => q.account !== "live");
    if (liveChosen.length > 0) {
      void executeLiveBatch(liveChosen);
    }
    if (paperChosen.length === 0) return;
    // Hold the cycle lock across the price fetch so a cycle or watch cannot
    // mutate the account mid-approve.
    paperBusyRef.current = true;
    try {
      // Fresh prices for the sell intents: book the fill at current market,
      // not the snapshot from when the intent was proposed. Buys still price
      // off the latest scan (the limit-price field is the guard there).
      let priceMap = prices;
      const sellAddrs = Array.from(
        new Set(paperChosen.filter((q) => q.kind === "sell").map((q) => q.address))
      );
      if (sellAddrs.length > 0) {
        try {
          const snaps = await fetchPrices(sellAddrs);
          if (Object.keys(snaps).length > 0) {
            const fresh: PriceMap = { ...prices };
            for (const [addr, sn] of Object.entries(snaps)) {
              fresh[addr] = {
                priceUsd: sn.priceUsd,
                liquidityUsd: sn.liquidityUsd,
                volume24h: sn.volume24h
              };
            }
            priceMap = fresh;
            setPrices(fresh);
          }
        } catch {
          /* price fetch failed: fall back to the cached prices */
        }
      }
      const res = applyQueuedIntents(paper, paperChosen, scan?.tokens ?? [], priceMap);
      setPaper(res.state);
      setCycleLog({ at: new Date().toISOString(), events: res.events });
      for (const ev of res.events) {
        pushAlert(ev.text, ev.kind === "skip" ? "danger" : "profit");
      }
      const paperIds = new Set(paperChosen.map((q) => q.id));
      const next = tradeQueue.filter((q) => !paperIds.has(q.id));
      setTradeQueue(next);
      writeTradeQueue(next);
    } finally {
      paperBusyRef.current = false;
    }
  }

  function dismissQueued(id: string) {
    // Record a dismissal record on buy intents so the next cycle does not
    // re-propose the same coin until its rating climbs above the threshold
    // (buyDismissalImprovementPoints) AND the anti-flap cooldown has passed.
    // Sells aren't recorded; they re-fire on rule hit and use the re-arm
    // mechanism for "tell me again only at a different level."
    const intent = tradeQueue.find((q) => q.id === id);
    if (intent && intent.kind === "buy") {
      const rec: DismissedBuyIntent = {
        address: intent.address,
        symbol: intent.symbol,
        name: intent.name,
        account: intent.account === "live" ? "live" : "paper",
        dismissedAt: new Date().toISOString(),
        dismissedRating: intent.ratingAtProposal,
        dismissedExitScore: intent.exitScoreAtProposal,
        dismissedLiquidityUsd: intent.liquidityAtProposal,
        source: "manual",
        // Derived from the snapshot so the dismissal carries the actual gate
        // regime active at dismiss time, not a blind stamp.
        algoVersion: deriveAlgoVersion(paper.settings)
      };
      setDismissedBuyIntents((cur) => {
        const others = cur.filter((d) => d.address !== rec.address);
        return [rec, ...others];
      });
    }
    const next = tradeQueue.filter((q) => q.id !== id);
    setTradeQueue(next);
    writeTradeQueue(next);
  }

  // A buy on `address` clears any active dismissal: the user changed their
  // mind, so the block should not persist. Called from approveQueued, from
  // the live execute pipeline on a successful buy record, and from any
  // manual "Buy (paper)" / "Buy (live)" entry path.
  //
  // Intentionally does NOT evict safetyCache[address]. A manual buy is a
  // one-time override, not an endorsement of the coin's structural safety.
  // If the coin re-queues later (via the cycle) the cached block verdict
  // should still auto-dismiss it; the user's override here only applies to
  // the trade they just initiated, not to every future proposal for the
  // same mint. Clearing the safety cache here would re-trigger an upstream
  // RugCheck call and likely re-block on the same evidence.
  function clearBuyDismissal(address: string): void {
    setDismissedBuyIntents((cur) => cur.filter((d) => d.address !== address));
  }

  // Watchlist helpers. addWatch creates a new alert; deleteWatch removes one
  // by id; resetWatchTrigger un-triggers an entry (so the user can re-arm
  // a watch that already fired without deleting and recreating it). The
  // watch tick (evaluateWatchlist below, called from runPositionWatch) reads
  // the active set, fetches prices, and marks triggered.
  function addWatch(args: {
    mint: string;
    symbol?: string | null;
    name?: string | null;
    targetPriceUsd: number;
    direction: "below" | "above";
    note?: string | null;
  }): void {
    const id = `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const entry: WatchlistEntry = {
      id,
      mint: args.mint,
      symbol: args.symbol ?? null,
      name: args.name ?? null,
      targetPriceUsd: args.targetPriceUsd,
      direction: args.direction,
      note: args.note ?? null,
      createdAt: new Date().toISOString(),
      triggeredAt: null,
      triggeredPrice: null
    };
    setWatchlist((cur) => [entry, ...cur]);
    pushAlert(
      `Watch added: ${entry.symbol ?? entry.mint.slice(0, 6)} at ${entry.direction} $${entry.targetPriceUsd.toPrecision(4)}`,
      "spike"
    );
  }
  function deleteWatch(id: string): void {
    setWatchlist((cur) => cur.filter((w) => w.id !== id));
  }
  function resetWatchTrigger(id: string): void {
    setWatchlist((cur) =>
      cur.map((w) => (w.id === id ? { ...w, triggeredAt: null, triggeredPrice: null } : w))
    );
  }

  // R2: execute a batch of approved LIVE intents. Build a Jupiter swap for
  // each (buys: USDC -> token + the pre-buy safety gate; sells: token ->
  // USDC), sign the whole batch in one Phantom approval (signAllTransactions),
  // then broadcast, confirm, read the on-chain fill, and record each. The
  // agent never signs; the user approves the batch in Phantom. Real money.
  async function executeLiveBatch(intents: TradeIntent[]) {
    if (liveExecBusyRef.current) return;
    if (!walletAddress) {
      pushAlert("Connect a Phantom wallet before approving live trades.", "danger");
      return;
    }
    if (intents.length === 0) return;
    liveExecBusyRef.current = true;
    const SLIPPAGE_BPS = 150;
    // Look up the latest enriched MemeToken for each address in the batch.
    // The scan's tokens carry the entry-time feature snapshot (top-10
    // holders, bot ratio, rating, etc.); we attach that to the live position
    // record for retrospective analysis in live_trade_log. Missing lookup
    // means the coin was traded after the scan rolled out of cache; the
    // snapshot fields stay null and analysis filters them out.
    const tokenByAddr = new Map<string, MemeToken>();
    for (const t of scan?.tokens ?? []) tokenByAddr.set(t.address, t);
    setLiveExec({
      running: true,
      rows: intents.map((it) => ({
        id: it.id,
        label: `${it.kind === "buy" ? "Buy" : `Sell ${it.sellPct ?? 100}%`} ${it.symbol}`,
        status: "queued" as const
      }))
    });
    const patch = (
      id: string,
      status:
        | "queued"
        | "building"
        | "signing"
        | "broadcasting"
        | "confirming"
        | "recording"
        | "done"
        | "failed",
      detail?: string
    ) =>
      setLiveExec((cur) =>
        cur
          ? { ...cur, rows: cur.rows.map((r) => (r.id === id ? { ...r, status, detail } : r)) }
          : cur
      );
    const built: { intent: TradeIntent; base64: string }[] = [];
    try {
      // Phase 1: build a swap transaction for each intent.
      for (const it of intents) {
        patch(it.id, "building");
        try {
          if (it.kind === "buy") {
            const sizeUsd = it.sizeUsd && it.sizeUsd > 0 ? it.sizeUsd : paper.settings.tradeSizeUsd;
            const q = await getQuote(
              USDC_MINT,
              it.address,
              Math.floor(sizeUsd * Math.pow(10, USDC_DECIMALS)),
              SLIPPAGE_BPS
            );
            if (!q.ok) {
              patch(it.id, "failed", `Quote failed: ${q.error}`);
              continue;
            }
            const safe = await runSafetyGate({
              tokenMint: it.address,
              baseMint: USDC_MINT,
              buyQuote: q.quote,
              acknowledgedHighImpact: true,
              maxTopHoldersPct: paper.settings.maxTopHoldersPct
            });
            if (safe.level === "block") {
              patch(it.id, "failed", `Blocked by the safety gate: ${safe.reasons[0] ?? "see queue"}`);
              continue;
            }
            const tx = await getSwapTransaction(q.quote.raw, walletAddress);
            if (!tx.ok) {
              patch(it.id, "failed", `Could not build the swap: ${tx.error}`);
              continue;
            }
            built.push({ intent: it, base64: tx.base64 });
          } else {
            const pos = live.positions.find(
              (p) => p.id === it.positionId && p.status === "open"
            );
            if (!pos) {
              patch(it.id, "failed", "Position is no longer open.");
              continue;
            }
            const dec = await getMintDecimals(pos.mint);
            if (!dec.ok) {
              patch(it.id, "failed", `Could not read token decimals: ${dec.error}`);
              continue;
            }
            const sellPct = it.sellPct && it.sellPct > 0 ? Math.min(100, it.sellPct) : 100;
            const tokens = pos.entryTokenAmount * (sellPct / 100);
            const baseUnits = Math.floor(tokens * Math.pow(10, dec.decimals));
            if (baseUnits <= 0) {
              patch(it.id, "failed", "Nothing to sell on this position.");
              continue;
            }
            const q = await getQuote(pos.mint, USDC_MINT, baseUnits, SLIPPAGE_BPS);
            if (!q.ok) {
              patch(it.id, "failed", `Quote failed: ${q.error}`);
              continue;
            }
            const tx = await getSwapTransaction(q.quote.raw, walletAddress);
            if (!tx.ok) {
              patch(it.id, "failed", `Could not build the swap: ${tx.error}`);
              continue;
            }
            built.push({ intent: it, base64: tx.base64 });
          }
        } catch (e) {
          patch(it.id, "failed", e instanceof Error ? e.message : String(e));
        }
      }
      if (built.length === 0) {
        setLiveExec((cur) => (cur ? { ...cur, running: false } : cur));
        pushAlert("No live trades could be built. See the approval window for why.", "danger");
        return;
      }
      // Phase 2: one Phantom approval for the whole batch.
      for (const b of built) patch(b.intent.id, "signing");
      const signed = await signAllBase64Txs(built.map((b) => b.base64));
      if (!signed.ok) {
        for (const b of built) patch(b.intent.id, "failed", `Signing: ${signed.error}`);
        setLiveExec((cur) => (cur ? { ...cur, running: false } : cur));
        pushAlert(`Batch signing did not complete: ${signed.error}`, "danger");
        return;
      }
      // Phase 3: broadcast, confirm, read the fill, record each.
      let workingLive = persistRef.current.live;
      const broadcastIds: string[] = [];
      for (let i = 0; i < built.length; i++) {
        const b = built[i];
        const it = b.intent;
        patch(it.id, "broadcasting");
        const sent = await sendRawTx(signed.signed[i]);
        if (!sent.ok) {
          patch(it.id, "failed", `Broadcast failed: ${sent.error}`);
          continue;
        }
        // The transaction is on the network now: do not leave it re-approvable.
        broadcastIds.push(it.id);
        patch(it.id, "confirming", `sig ${sent.signature.slice(0, 12)}...`);
        const conf = await confirmSignature(sent.signature);
        if (!conf.ok) {
          patch(it.id, "failed", `${conf.error} Verify ${sent.signature.slice(0, 12)}... on Solscan.`);
          continue;
        }
        patch(it.id, "recording");
        try {
          if (it.kind === "buy") {
            const tokenDelta = await fetchSwapDelta(sent.signature, walletAddress, it.address);
            const usdcDelta = await fetchSwapDelta(sent.signature, walletAddress, USDC_MINT);
            if (!tokenDelta.ok || tokenDelta.delta <= 0 || !usdcDelta.ok) {
              patch(
                it.id,
                "failed",
                `Confirmed but the on-chain fill could not be read. Verify ${sent.signature.slice(0, 12)}... on Solscan.`
              );
              continue;
            }
            const usdcSpent = Math.abs(usdcDelta.delta);
            // openLivePosition requires a MemeToken (so the entry-time feature
            // snapshot is always captured). If the latest scan didn't include
            // this address, fail the trade record rather than book a position
            // with NULL entry features. The on-chain swap already happened;
            // this just means our ledger won't carry the snapshot for it.
            const tokenForLive = tokenByAddr.get(it.address);
            if (!tokenForLive) {
              patch(
                it.id,
                "failed",
                `Confirmed on-chain but no scan data for ${it.address.slice(0, 6)}... to snapshot. Rescan to pick up the position.`
              );
              continue;
            }
            workingLive = openLivePosition(workingLive, {
              mint: it.address,
              symbol: it.symbol,
              name: it.name,
              baseMint: USDC_MINT,
              signature: sent.signature,
              baseAmountSpent: usdcSpent,
              tokenAmountReceived: tokenDelta.delta,
              priceUsdAtEntry: usdcSpent / tokenDelta.delta,
              slippageBps: SLIPPAGE_BPS,
              token: tokenForLive,
              settings: paper.settings
            });
          } else {
            const usdcDelta = await fetchSwapDelta(sent.signature, walletAddress, USDC_MINT);
            if (!usdcDelta.ok) {
              patch(
                it.id,
                "failed",
                `Confirmed but the on-chain credit could not be read. Verify ${sent.signature.slice(0, 12)}... on Solscan.`
              );
              continue;
            }
            const usdcReceived = Math.max(0, usdcDelta.delta);
            const pos = workingLive.positions.find((p) => p.id === it.positionId);
            const sellPct = it.sellPct && it.sellPct > 0 ? Math.min(100, it.sellPct) : 100;
            const tokensSold = pos ? pos.entryTokenAmount * (sellPct / 100) : 0;
            workingLive = sellLivePosition(workingLive, it.positionId ?? "", {
              signature: sent.signature,
              tokensSold,
              baseAmountReceived: usdcReceived,
              exitPriceUsd: tokensSold > 0 ? usdcReceived / tokensSold : 0,
              reason: it.trigger ?? "queue"
            });
          }
          patch(it.id, "done", `sig ${sent.signature.slice(0, 12)}...`);
        } catch (e) {
          patch(
            it.id,
            "failed",
            `Recorded with an error: ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }
      // Phase 4: persist the live ledger, drop the broadcast intents.
      setLive(workingLive);
      const payload = { ...persistRef.current, live: workingLive };
      const saveRes = await saveMemecoinState(payload);
      if (saveRes.ok) {
        lastSavedRef.current = JSON.stringify(payload);
      } else {
        pushAlert(
          `Live trades executed but the database save failed (${saveRes.error}). It will retry on the next change.`,
          "danger"
        );
      }
      if (broadcastIds.length > 0) {
        const done = new Set(broadcastIds);
        const nextQ = persistRef.current.tradeQueue.filter((q) => !done.has(q.id));
        setTradeQueue(nextQ);
        writeTradeQueue(nextQ);
      }
      setLiveExec((cur) => (cur ? { ...cur, running: false } : cur));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLiveExec((cur) => (cur ? { ...cur, running: false } : cur));
    } finally {
      liveExecBusyRef.current = false;
    }
  }

  // Edit a queued intent in place: the buy size / limit price, or the sell %.
  // The edited values are what "Approve selected" then books.
  function editIntent(id: string, patch: Partial<TradeIntent>) {
    const next = tradeQueue.map((q) => (q.id === id ? { ...q, ...patch } : q));
    setTradeQueue(next);
    writeTradeQueue(next);
  }

  // Re-arm a queued sell intent: do not sell. Set a new price level on the
  // position and drop the intent; decideSellIntents then stays quiet for that
  // position until price crosses the level, when a fresh intent fires.
  // `dir` floor = re-alert on a fall, ceil = re-alert on a rise; `magnitudePct`
  // is the move from the current price.
  function rearmIntent(id: string, magnitudePct: number, dir: "floor" | "ceil") {
    const intent = tradeQueue.find((q) => q.id === id);
    if (!intent || intent.kind !== "sell" || !intent.positionId) return;
    if (paperBusyRef.current) {
      pushAlert("A trade cycle or position watch is running. Re-arm again in a moment.", "danger");
      return;
    }
    const price = prices[intent.address]?.priceUsd ?? 0;
    if (price <= 0) {
      pushAlert(`Cannot re-arm ${intent.symbol}: no current price available.`, "danger");
      return;
    }
    const mag = Math.max(0, magnitudePct) / 100;
    const level = dir === "floor" ? price * (1 - mag) : price * (1 + mag);
    setPaper((cur) => ({
      ...cur,
      positions: cur.positions.map((p) =>
        p.id === intent.positionId ? { ...p, rearmPrice: level, rearmDir: dir } : p
      ),
      updatedAt: new Date().toISOString()
    }));
    const next = tradeQueue.filter((q) => q.id !== id);
    setTradeQueue(next);
    writeTradeQueue(next);
    pushAlert(
      `${intent.symbol} re-armed: held, no sale. It will be re-proposed when price ${
        dir === "floor" ? "falls to" : "rises to"
      } $${fmtPrice(level)}.`,
      "spike",
      "trade-queue"
    );
  }

  // Clear a position's re-arm level so it returns to the normal sell rules.
  // Reachable both from a fired re-arm intent in the queue and from the
  // open-positions table (where a still-waiting re-armed position lives).
  function clearRearmForPosition(positionId: string) {
    if (cycleBusy("clear the re-arm")) return;
    const pos = paper.positions.find((p) => p.id === positionId);
    if (!pos) return;
    setPaper((cur) => ({
      ...cur,
      positions: cur.positions.map((p) =>
        p.id === positionId ? { ...p, rearmPrice: undefined, rearmDir: undefined } : p
      ),
      updatedAt: new Date().toISOString()
    }));
    // Drop any queued sell intent for this position: it is stale now that the
    // position is back on the normal rules.
    const next = tradeQueue.filter((q) => q.positionId !== positionId);
    if (next.length !== tradeQueue.length) {
      setTradeQueue(next);
      writeTradeQueue(next);
    }
    pushAlert(`${pos.symbol}: re-arm cleared, back to the normal sell rules.`, "spike");
  }

  function toggleQueueMode() {
    setQueueMode((v) => {
      const next = !v;
      writeQueueMode(next);
      return next;
    });
  }

  // Switch trading mode with an explicit round-trip verification: force-save
  // the new mode, then re-load from the database and confirm it actually
  // landed. `modeSaveStatus` surfaces the result so there is no ambiguity
  // about whether the switch persisted.
  async function applyTradingMode(next: "paper" | "real") {
    setTradingMode(next);
    writeTradingMode(next);
    // Switching to real pauses the paper bot's automation so it cannot keep
    // booking paper trades while you are in real mode.
    if (next === "real") {
      setAutoRun(false);
      setWatchOn(false);
    }
    setModeSaveStatus("saving");
    const payload = {
      ...persistRef.current,
      tradingMode: next,
      autoRun: next === "real" ? false : persistRef.current.autoRun,
      watchOn: next === "real" ? false : persistRef.current.watchOn
    };
    const saved = await saveMemecoinState(payload);
    if (!saved.ok) {
      setModeSaveStatus("error");
      setError(`Trading mode NOT saved: ${saved.error}. Do not trade until this is resolved.`);
      return;
    }
    lastSavedRef.current = JSON.stringify(payload);
    // Verify: read the row straight back and confirm the database agrees.
    const check = await loadMemecoinState();
    if (check.ok && check.state.tradingMode === next) {
      setModeSaveStatus("verified");
    } else {
      setModeSaveStatus("error");
      setError(
        `Trading mode change could not be verified in the database${
          check.ok ? ` (database still reports "${check.state.tradingMode}")` : `: ${check.error}`
        }. Do not trade until this is resolved.`
      );
    }
  }

  // Paper -> Real is confirmed (the dangerous direction); Real -> Paper is the
  // safe direction and applies immediately.
  function requestTradingMode(next: "paper" | "real") {
    if (next === tradingMode) return;
    if (next === "paper") {
      void applyTradingMode("paper");
      return;
    }
    setConfirmReq({
      title: "Switch to Real trading mode?",
      subtitle: "Real mode trades actual funds through your connected wallet.",
      rows: [
        { label: "Mode", value: "Paper  ->  Real money" },
        { label: "Wallet", value: walletAddress ? shortAddr(walletAddress) : "not connected" }
      ],
      note: "Paper auto-run and the paper position watch will be turned off. You still review and sign every real trade in Phantom; the agent never signs. Automated live proposals through the Trade queue are rolling out next.",
      confirmLabel: "Switch to Real money",
      danger: true,
      onConfirm: () => void applyTradingMode("real")
    });
  }

  // Run one social-media scan per pumping coin and store it. Each coin is
  // deduped (one entry per day) so a repeat mover does not re-burn a search.
  async function logPumps(
    candidates: {
      address: string;
      symbol: string;
      name: string;
      trigger: string;
      runUpPct: number;
    }[]
  ) {
    let list = pumpEvents;
    for (const c of candidates) {
      if (recentlyLogged(list, c.address)) continue;
      try {
        const ev = await buildPumpEvent(c, c.trigger, c.runUpPct);
        list = [ev, ...list].slice(0, 200);
        setPumpEvents(list);
        writePumpEvents(list);
        // Persist the single event via the dedicated endpoint. The full-
        // state save no longer touches m_pump_events (pumpEvents is
        // stripped from that payload to keep the body under sendBeacon's
        // 64 KB ceiling), so each row needs its own POST. Fire-and-forget:
        // a write failure here gets the row into localStorage and
        // in-memory state, and the next page load reads from DB without
        // it — acceptable loss for a research-log feature.
        void savePumpEvent(ev);
      } catch {
        /* a failed social scan is skipped, not fatal */
      }
    }
  }

  // Scanned coins up 50%+ over 24h (top few, deduped), as pump candidates.
  function scanPumpCandidates(tokens: MemeToken[]) {
    return pickScanPumps(tokens, pumpEvents).map((t) => ({
      address: t.address,
      symbol: t.symbol,
      name: t.name,
      trigger: `Scan, +${Math.round(t.priceChange24h)}% over 24h`,
      runUpPct: t.priceChange24h
    }));
  }

  // Fire a pop-up for promising coins that are new since the last scan and
  // clear the user's quality bar (newCoinBar). Routes through pushAlert so each
  // becomes an in-app toast AND an OS notification, deduped per address for a
  // 6h window via newCoinSeenRef (persisted to localStorage). Called after
  // setScan in every browser scan path; the server scheduler does not scan, so
  // new-coin detection only runs while a tab is open (as do all OS pop-ups).
  function notifyNewCoins(result: ScanResult) {
    // When the server scan scheduler is on, it owns new-coin alerting (it scans
    // with no tab open and writes alert rows the polling effect surfaces). The
    // browser must not also alert or it double-fires. This path is the fallback
    // for when the server scan scheduler is off.
    if (serverSchedulesScan) {
      hadPriorScanRef.current = true;
      return;
    }
    const bar = readNewCoinBar();
    // The first scan of a session compares against a stale cached scan (or no
    // prior at all), so markets.ts flags many coins isNewSinceLastScan. Seed the
    // dedup ledger from that pass WITHOUT alerting, then announce only coins
    // that newly surface on later scans.
    const isFirstScan = !hadPriorScanRef.current;
    hadPriorScanRef.current = true;

    const now = Date.now();
    const seen = newCoinSeenRef.current;
    const candidates = result.tokens.filter(
      (t) =>
        t.isNewSinceLastScan === true &&
        bar.bands.includes(t.ratingBand) &&
        t.liquidityUsd >= bar.minLiquidityUsd &&
        t.volume24h >= bar.minVolume24h
    );

    if (!bar.enabled || isFirstScan) {
      // Seed-only: remember these so re-enabling (or the next scan) doesn't
      // retroactively flood. No alerts emitted.
      for (const t of candidates) seen[t.address] = now;
      writeNewCoinSeen(seen);
      return;
    }

    let fired = 0;
    for (const t of candidates) {
      const last = seen[t.address];
      if (last && now - last < NEWCOIN_REALERT_MS) continue;
      seen[t.address] = now;
      fired++;
      pushAlert(
        `🆕 New coin ${t.symbol} (band ${t.ratingBand}) — liq $${Math.round(
          t.liquidityUsd
        ).toLocaleString()}, 24h vol $${Math.round(
          t.volume24h
        ).toLocaleString()}. Surfaced this scan.`,
        "newcoin",
        t.address
      );
    }
    if (fired > 0) writeNewCoinSeen(seen);
  }

  async function runScan() {
    setLoading(true);
    setError(null);
    try {
      const result = await scanMemecoins(scan ?? undefined);
      setScan(result);
      notifyNewCoins(result);
      void saveScan(result);
      try {
        localStorage.setItem("memeify-memecoin-scan-v2", JSON.stringify(result));
      } catch {
        /* storage full or unavailable; the scan still shows from memory */
      }
      void logPumps(scanPumpCandidates(result.tokens));
      if (result.tokens.length === 0) {
        setError("No tokens came back. Upstream sources were empty or rate-limited. Wait a minute and scan again.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function runLookup() {
    const q = query.trim();
    if (!q) return;
    setBusy(true);
    setError(null);
    try {
      const tokens = await lookupToken(q);
      const lookupResult = {
        tokens,
        sources: [{ name: `DexScreener search: "${q}"`, ok: tokens.length > 0, count: tokens.length }],
        scannedAt: new Date().toISOString()
      };
      setScan(lookupResult);
      void saveScan(lookupResult);
      if (tokens.length === 0) setError(`No pairs matched "${q}".`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function runChatter(token: MemeToken) {
    setChatter((c) => ({ ...c, [token.address]: { loading: true } }));
    try {
      const res = await checkSocialChatter(token.symbol, token.name);
      setChatter((c) => ({
        ...c,
        [token.address]: res.ok
          ? { loading: false, data: res.data }
          : { loading: false, error: res.error }
      }));
    } catch (e) {
      setChatter((c) => ({
        ...c,
        [token.address]: { loading: false, error: e instanceof Error ? e.message : String(e) }
      }));
    }
  }

  // One paper-trading cycle: fresh scan, value held positions, run the sell
  // rules, then the buy rules. Simulation only, never a real transaction.
  async function runCycle() {
    // In Real mode the cycle is the live cycle: it proposes live intents to
    // the queue and never books paper trades.
    if (tradingMode === "real") {
      await runLiveCycle();
      return;
    }
    if (paperBusyRef.current) return;
    paperBusyRef.current = true;
    setCycleRunning(true);
    setError(null);
    const events: TradeEvent[] = [];
    try {
      const result = await scanMemecoins(scan ?? undefined);
      setScan(result);
      notifyNewCoins(result);
      void saveScan(result);
      void logPumps(scanPumpCandidates(result.tokens));
      try {
        localStorage.setItem("memeify-memecoin-scan-v2", JSON.stringify(result));
      } catch {
        /* ignore storage failure */
      }
      const priceMap: PriceMap = {};
      for (const t of result.tokens) {
        priceMap[t.address] = {
          priceUsd: t.priceUsd,
          liquidityUsd: t.liquidityUsd,
          volume24h: t.volume24h
        };
      }
      // Held coins that did not appear in the scan still need a current price.
      const heldMissing = paper.positions
        .filter((p) => p.status === "open" && !priceMap[p.address])
        .map((p) => p.address);
      if (heldMissing.length) {
        const snaps = await fetchPrices(heldMissing);
        for (const [addr, s] of Object.entries(snaps)) {
          priceMap[addr] = {
            priceUsd: s.priceUsd,
            liquidityUsd: s.liquidityUsd,
            volume24h: s.volume24h
          };
        }
      }
      // Merge, then prune. A bare assignment would drop prices for closed
      // paper positions and live positions absent from this scan; an unpruned
      // merge would instead grow `prices` without bound across a long auto-run
      // (each saveMemecoinState rewrites the whole price_snapshots table). So
      // merge, then keep only addresses still referenced: this scan, any paper
      // position, any live position. The watch and sellOne also merge.
      setPrices((cur) => {
        const merged: PriceMap = { ...cur, ...priceMap };
        const keep = new Set<string>([
          ...result.tokens.map((t) => t.address),
          ...paper.positions.map((p) => p.address),
          ...live.positions.map((p) => p.mint)
        ]);
        const pruned: PriceMap = {};
        for (const addr of Object.keys(merged)) {
          if (keep.has(addr)) pruned[addr] = merged[addr];
        }
        return pruned;
      });
      // Skip the sell pass if no prices came back at all, so a transient
      // outage cannot force-close every position as a false rug.
      let cycleEndState = paper;
      if (queueMode) {
        // Queue mode: the cycle proposes trades to the review queue, nothing
        // executes until you approve. The exact shape of the real-money flow.
        const sellIntents =
          Object.keys(priceMap).length === 0 ? [] : decideSellIntents(paper, priceMap);
        const buyResult = decideBuyIntents(paper, result.tokens, dismissedBuyIntents);
        // Pre-filter against the safety cache: drop intents for coins whose
        // most recent safety verdict (within TTL) is "block". Saves the
        // queue-then-auto-dismiss churn that produced misleading "1 trade
        // proposed" alerts immediately followed by "Auto-dismissed X".
        // Structural safety verdicts (insider networks, LP unlocked, etc.)
        // don't reverse on a useful timescale, so re-proposing during the
        // 6h cache window adds no information.
        const safetyPreFiltered: TradeIntent[] = [];
        // Collect symbols (not just a count) so the cycle log is auditable:
        // a coin you were watching for that gets silently pre-filtered for up
        // to 6h needs to be greppable here, not just inside the cache.
        const safetyBlockedSymbols: string[] = [];
        for (const it of buyResult.intents) {
          const c = safetyCacheRef.current[it.address];
          const fresh =
            c && Date.now() - new Date(c.at).getTime() < SAFETY_CACHE_TTL_MS;
          if (fresh && c.result.level === "block") {
            safetyBlockedSymbols.push(it.symbol);
            continue;
          }
          safetyPreFiltered.push(it);
        }
        if (safetyBlockedSymbols.length > 0) {
          const n = safetyBlockedSymbols.length;
          events.push({
            kind: "skip",
            text: `Skipped ${n} coin${n === 1 ? "" : "s"} still in the safety-block cache: ${safetyBlockedSymbols.join(", ")}`
          });
        }
        const added = enqueueIntents([...sellIntents, ...safetyPreFiltered]);
        events.push({
          kind: "info",
          text:
            added > 0
              ? `Queue mode: ${added} trade${added === 1 ? "" : "s"} proposed. Review them in the Trade queue.`
              : "Queue mode: nothing new to propose this cycle."
        });
        // Surface the coins the buy pass skipped, so queue mode is not silent
        // about them (it would otherwise only ever report what it added).
        if (buyResult.skipped.rugged > 0) {
          events.push({
            kind: "info",
            text: `Skipped ${buyResult.skipped.rugged} coin${
              buyResult.skipped.rugged === 1 ? "" : "s"
            } blacklisted as rugged`
          });
        }
        if (buyResult.skipped.cooldown > 0) {
          events.push({
            kind: "info",
            text: `Skipped ${buyResult.skipped.cooldown} coin${
              buyResult.skipped.cooldown === 1 ? "" : "s"
            } inside the re-entry cooldown`
          });
        }
        if (buyResult.skipped.dismissed > 0) {
          events.push({
            kind: "info",
            text: `Skipped ${buyResult.skipped.dismissed} coin${
              buyResult.skipped.dismissed === 1 ? "" : "s"
            } you dismissed, waiting on the rating to climb +${paper.settings.buyDismissalImprovementPoints} points`
          });
        }
        setCycleLog({ at: new Date().toISOString(), events });
        // Pop a persistent toast so a queued trade is not missed. Like the
        // watch alerts, it stays at the top right until dismissed.
        if (added > 0) {
          pushAlert(
            `${added} trade${added === 1 ? "" : "s"} proposed (pending safety review). Buy intents that fail the safety gate auto-dismiss before you see them; click to jump to the queue, or open the Alerts log if it's empty.`,
            "spike",
            "trade-queue"
          );
        }
      } else {
        const hasOpen = paper.positions.some((p) => p.status === "open");
        let working = paper;
        if (hasOpen && Object.keys(priceMap).length === 0) {
          events.push({
            kind: "info",
            text: "No prices available this cycle, skipped sell pass to avoid false rug exits"
          });
        } else {
          const sell = runSellPass(paper, priceMap);
          events.push(...sell.events);
          working = sell.state;
        }
        const buy = runBuyPass(working, result.tokens);
        events.push(...buy.events);
        cycleEndState = buy.state;
        setPaper(buy.state);
        setCycleLog({ at: new Date().toISOString(), events });
        // Auto-run executes trades on its own. Surface every buy and sell as a
        // toast so a cycle never trades silently: the cycle log is far down
        // the page, and a silent same-cycle re-buy of a coin just sold is
        // exactly the behavior that should not pass unnoticed.
        const autoTrades = events.filter((e) => e.kind === "buy" || e.kind === "sell");
        if (autoTrades.length > 0) {
          const sells = autoTrades.filter((e) => e.kind === "sell").length;
          const buys = autoTrades.filter((e) => e.kind === "buy").length;
          pushAlert(
            `Auto-cycle traded: ${sells} sell${sells === 1 ? "" : "s"}, ${buys} buy${
              buys === 1 ? "" : "s"
            }. ${autoTrades.map((e) => e.text).join(" | ")}`,
            sells > 0 && buys > 0 ? "spike" : buys > 0 ? "profit" : "danger"
          );
        }
      }
      // Daily-loss circuit breaker: toast on the transition into tripped, so a
      // paused account is not just a quiet line in the cycle log.
      const tripped = circuitBreakerTripped(cycleEndState);
      if (tripped && !circuitTrippedRef.current) {
        pushAlert(
          `Daily loss limit hit: down $${Math.abs(dailyRealizedUsd(cycleEndState)).toFixed(
            0
          )} realized today. New buys are paused until tomorrow; selling still runs.`,
          "danger"
        );
      }
      circuitTrippedRef.current = tripped;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      paperBusyRef.current = false;
      setCycleRunning(false);
    }
  }

  // A trade cycle / position-watch holds paperBusyRef across its async work,
  // then writes the whole paper object back from a pre-cycle snapshot. A manual
  // paper mutation landing mid-cycle would be silently overwritten (worst case:
  // approveQueued empties the queue but the booked trades are then discarded),
  // so each manual handler bails with a toast while the lock is held. The lock
  // is set synchronously before the cycle's first await, so this check is
  // reliable; the click works once the cycle finishes.
  function cycleBusy(action: string): boolean {
    if (paperBusyRef.current) {
      pushAlert(`A trade cycle is running, ${action} again in a moment.`, "danger");
      return true;
    }
    return false;
  }

  function buyOne(token: MemeToken) {
    if (cycleBusy("try the buy")) return;
    const res = buyManual(paper, token);
    setPaper(res.state);
    // A manual buy clears any dismissal: the user just bought this coin, so
    // they want to see it in the queue again next time the rules clear it.
    if (res.event.kind === "buy") clearBuyDismissal(token.address);
    setCycleLog({ at: new Date().toISOString(), events: [res.event] });
    // Surface the result as a toast. A buy from a coin card or the popup
    // otherwise gives no visible feedback, the cycle log is far down the page.
    pushAlert(res.event.text, res.event.kind === "skip" ? "danger" : "profit");
  }

  async function sellOne(positionId: string) {
    if (sellingId) return; // a sell is already in flight; ignore extra clicks
    if (cycleBusy("try the sell")) return;
    const pos = paper.positions.find((p) => p.id === positionId);
    if (!pos) return;
    setSellingId(positionId);
    // Hold the shared lock across the price fetch so a cycle cannot start
    // mid-sell and overwrite the booked sale from its pre-cycle snapshot.
    paperBusyRef.current = true;
    try {
      // Always fetch a fresh price first so a click sells at current market,
      // not at the cached snapshot or (worse) the entry price. If the address
      // returns nothing (pool likely gone), book the sell at $0 so the loss
      // is realised; the user clicked Sell explicitly.
      let price = 0;
      try {
        const snaps = await fetchPrices([pos.address]);
        price = snaps[pos.address]?.priceUsd ?? 0;
        if (snaps[pos.address]) {
          setPrices((cur) => ({
            ...cur,
            [pos.address]: {
              priceUsd: snaps[pos.address].priceUsd,
              liquidityUsd: snaps[pos.address].liquidityUsd,
              volume24h: snaps[pos.address].volume24h
            }
          }));
        }
      } catch {
        // Network blip. Fall back to the last cached price, or zero.
        price = prices[pos.address]?.priceUsd ?? 0;
      }
      const res = sellManual(paper, positionId, price);
      setPaper(res.state);
      setCycleLog({ at: new Date().toISOString(), events: [res.event] });
      // Surface the result as a toast either way: a skipped sell (bad-data
      // guard) and a booked sell both need visible feedback.
      pushAlert(res.event.text, res.event.kind === "skip" ? "danger" : "profit");
    } finally {
      paperBusyRef.current = false;
      setSellingId(null);
    }
  }

  // Manual buy/sell confirmation. Each request* helper opens the confirmation
  // popup; the trade only runs (or, for live, the live modal only opens) when
  // the user clicks Confirm. Auto-run cycles and queue approval are unaffected.
  function requestBuyPaper(token: MemeToken) {
    setConfirmReq({
      title: "Confirm paper buy",
      subtitle: `${token.symbol} - ${token.name}`,
      rows: [
        { label: "Spend", value: `${fmtUsd(paper.settings.tradeSizeUsd)} (paper money)` },
        { label: "Price now", value: priceLabel(token.priceUsd) },
        { label: "Rating / exit score", value: `${token.rating} - ${token.exitScore}` },
        { label: "Liquidity", value: fmtUsd(token.liquidityUsd) }
      ],
      confirmLabel: "Buy (paper)",
      onConfirm: () => buyOne(token)
    });
  }

  function requestSellPaper(positionId: string) {
    const pos = paper.positions.find((p) => p.id === positionId);
    if (!pos) return;
    const priceNow = prices[pos.address]?.priceUsd ?? 0;
    const valueNow = priceNow > 0 ? pos.tokenAmount * priceNow : 0;
    setConfirmReq({
      title: "Confirm paper sell",
      subtitle: `${pos.symbol} - ${pos.name}`,
      rows: [
        { label: "Cost basis", value: fmtUsd(pos.costUsd) },
        { label: "Price now", value: priceLabel(priceNow) },
        {
          label: "Value now",
          value: priceNow > 0 ? fmtUsd(valueNow) : "unknown"
        },
        {
          label: "Est. P&L",
          value: priceNow > 0 ? signedUsd(valueNow - pos.costUsd) : "unknown"
        }
      ],
      note: "The sell books at a fresh price fetched on confirm, so the final fill may differ from the estimate above.",
      confirmLabel: "Sell",
      danger: true,
      onConfirm: () => void sellOne(positionId)
    });
  }

  function requestBuyLive(token: MemeToken, seedAmountUsd?: number) {
    // Same guard as before: no second modal while a sign is in flight for this
    // mint, or while a buy modal is already open for it.
    if (pendingLiveMints.has(token.address) || liveBuyToken?.address === token.address) {
      return;
    }
    setConfirmReq({
      title: "Start a live buy?",
      subtitle: `${token.symbol} - ${token.name}`,
      rows: [
        { label: "Coin", value: `${token.symbol} (${shortAddr(token.address)})` },
        { label: "Price now", value: priceLabel(token.priceUsd) }
      ],
      note: "Real money. This opens the live buy modal, where you review the Jupiter quote and the pre-buy safety check, then sign in Phantom. Nothing is spent until you sign.",
      confirmLabel: "Continue to live buy",
      danger: true,
      onConfirm: () => {
        setLiveBuySeedUsd(seedAmountUsd ?? null);
        setLiveBuyToken(token);
      }
    });
  }

  // "Buy real" on an open paper-position row: take the held paper position and
  // open the real (live) USDC buy flow for the same coin, pre-filled with the
  // paper trade's dollar size. Prefers the coin's current scan token (fresh
  // price/liquidity) and falls back to a minimal token built from the position
  // when the coin has scrolled out of the latest scan. requestBuyLive runs the
  // confirm -> Jupiter quote -> safety gate -> Phantom sign pipeline; nothing
  // is spent until the user signs. The BuyLiveModal only renders when a wallet
  // is connected, so the row button is disabled without one.
  function requestBuyRealFromPosition(pos: PaperPosition) {
    const scanned = sortedTokens.find((t) => t.address === pos.address);
    const priceNow =
      prices[pos.address]?.priceUsd ?? pos.lastPriceUsd ?? pos.entryPriceUsd;
    const token = scanned ?? tokenFromPaperPosition(pos, priceNow);
    requestBuyLive(token, Math.max(1, Math.round(pos.costUsd)));
  }

  function requestSellLive(position: LivePosition) {
    const priceNow = livePriceUsd(position, prices);
    setConfirmReq({
      title: "Sell this live position?",
      subtitle: `${position.symbol} - ${position.name}`,
      rows: [
        { label: "Entry price", value: priceLabel(position.entryPriceUsd) },
        { label: "Price now", value: priceLabel(priceNow) }
      ],
      note: "Real money. This opens the live sell modal, where you review the quote then sign in Phantom. Nothing is sold until you sign.",
      confirmLabel: "Continue to live sell",
      danger: true,
      onConfirm: () => setLiveSellPosition(position)
    });
  }

  function updateSettings(patch: Partial<PaperSettings>) {
    setPaper((cur) => ({
      ...cur,
      settings: { ...cur.settings, ...patch },
      updatedAt: new Date().toISOString()
    }));
  }

  // Confirm popup for the destructive Reset paper account button. Same modal
  // pattern as paper / live buy / sell, so the user can't trip the reset on a
  // misclick. The modal lays out exactly what's about to be wiped — open
  // positions, cash, alerts, queued intents — so it's obvious if reset wasn't
  // what the user actually wanted. trade_log (closed-trade history) is NOT
  // touched by a reset and that's called out explicitly, since the alarm is
  // usually "did I just lose my history?" — no, history survives.
  function requestResetPaper() {
    if (cycleBusy("reset")) return;
    const openCount = paper.positions.filter((p) => p.status === "open").length;
    const queuedCount = tradeQueue.length;
    const closedSurvives = paper.positions.filter((p) => p.status === "closed").length;
    setConfirmReq({
      title: "Reset paper account?",
      subtitle: "This wipes the paper sim back to a fresh $1,000 starting balance.",
      rows: [
        { label: "Open positions to close (no fill)", value: String(openCount) },
        { label: "Cash on hand to discard", value: fmtUsd(paper.cashUsd) },
        { label: "Queued intents to clear", value: String(queuedCount) },
        { label: "Active alerts to clear", value: String(alerts.length) },
        { label: "Auto-run + position watch", value: "will be turned OFF" },
        { label: "Closed-trade history (trade_log)", value: `${closedSurvives} rows — SURVIVES the reset` }
      ],
      note:
        "Reset returns the paper account to defaults: $1,000 cash, no positions, empty queue, " +
        "alerts cleared. Permanent trade_log history is NOT touched (it's append-only by design, " +
        "so the algo breakdown and SQL reports stay queryable). Cannot be undone.",
      confirmLabel: "Reset paper account",
      danger: true,
      onConfirm: () => resetPaper()
    });
  }

  function resetPaper() {
    if (cycleBusy("reset")) return;
    setPaper(defaultPaperState());
    setCycleLog(null);
    setPrices({});
    setAlerts([]);
    // Clear the trade queue: its intents reference positions and scan coins
    // that no longer exist after a reset. (Queue mode itself is left as-is, a
    // workflow preference like the scan sort.)
    setTradeQueue([]);
    writeTradeQueue([]);
    // Stop the timers so a fresh paper account doesn't immediately trade on
    // the next auto-run tick before the user has reviewed the rules.
    setAutoRun(false);
    setWatchOn(false);
  }

  // Top up the paper account by $1,000. Adds to both cash and the
  // starting-cash baseline so Total P&L stays honest (it is equity minus
  // starting cash; topping up only cash would book a fake +$1,000 gain).
  function topUpCash() {
    if (cycleBusy("add cash")) return;
    setPaper((cur) => ({
      ...cur,
      cashUsd: cur.cashUsd + 1000,
      startingCashUsd: cur.startingCashUsd + 1000,
      updatedAt: new Date().toISOString()
    }));
  }

  function pushAlert(text: string, kind: WatchAlert["kind"], scrollToId?: string) {
    const id = `al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    // No cap: alerts stay until the user dismisses them, so none are missed.
    setAlerts((cur) => [{ id, at: new Date().toISOString(), text, kind, scrollToId }, ...cur]);
    showSystemPositionWatchNotification(text);
  }

  // Toast-stack dismiss: mark the alert hidden so it disappears from the
  // floating top-right stack, but keep it in the alerts log panel. The
  // alerts log shows every alert ever pushed (dismissed ones visually muted)
  // so the user can clear the toast to see what's under it without losing
  // the entry. Permanent removal lives on purgeAlert / purgeAllAlerts below.
  //
  // All alert-mutating user actions (hide and purge) route through
  // flushAlertsImmediately so the new state is queued for the server
  // *before* the click handler returns. Users frequently click Hide or
  // Clear and immediately reach for refresh, which races the normal
  // debounced save (setTimeout(0) + async fetch is aborted by page
  // unload) and the beforeunload sendBeacon (which silently rejects
  // the full-state payload — it's ~1 MB on this app, dominated by
  // pumpEvents, well over the 64 KB sendBeacon ceiling).
  //
  // We POST just the alerts array to the dedicated /api/memecoin/alerts
  // endpoint. Body size is a few KB, comfortably inside beacon limits,
  // and the server only writes m_paper_alerts so the rest of the state
  // is untouched. The trailing debounced full-state save still fires
  // (we intentionally don't update lastSavedRef here) — that's a
  // belt-and-braces fallback. Idempotent against the same alerts array.
  function flushAlertsImmediately(nextAlerts: PanelAlert[]) {
    setAlerts(nextAlerts);
    if (!hydratedRef.current) return;
    try {
      const blob = new Blob([JSON.stringify({ alerts: nextAlerts })], {
        type: "application/json"
      });
      navigator.sendBeacon("/api/memecoin/alerts", blob);
    } catch {
      /* beacon unavailable; the debounced full-state save is the fallback */
    }
  }

  function hideAlert(id: string) {
    flushAlertsImmediately(alerts.map((a) => (a.id === id ? { ...a, dismissed: true } : a)));
  }

  function hideAlertGroup(ids: Set<string>) {
    flushAlertsImmediately(alerts.map((a) => (ids.has(a.id) ? { ...a, dismissed: true } : a)));
  }

  function hideAllAlerts() {
    flushAlertsImmediately(alerts.map((a) => ({ ...a, dismissed: true })));
  }

  // Alerts-log permanent removal. Wipes the row entirely; intentionally
  // distinct from the toast-stack "hide" so the user can curate the log
  // when it gets long without losing in-flight toasts.
  function purgeAlert(id: string) {
    flushAlertsImmediately(alerts.filter((a) => a.id !== id));
  }

  function purgeAllAlerts() {
    flushAlertsImmediately([]);
  }

  // Fetch current prices for held positions without running the watch rules.
  // Used on mount so a reload shows live values immediately.
  async function refreshHeldPrices() {
    // Price open positions plus the most recent closed ones, so the closed
    // trades table can show a current price next to each. Live positions
    // share the same prices map so the live panel renders unrealized P&L
    // without a second fetch.
    const openA = paper.positions.filter((p) => p.status === "open").map((p) => p.address);
    const closedA = paper.positions
      .filter((p) => p.status === "closed")
      .slice(0, 30)
      .map((p) => p.address);
    const liveOpen = live.positions.filter((p) => p.status === "open").map((p) => p.mint);
    const liveClosed = live.positions
      .filter((p) => p.status === "closed")
      .slice(0, 30)
      .map((p) => p.mint);
    const addrs = Array.from(new Set([...openA, ...closedA, ...liveOpen, ...liveClosed]));
    if (addrs.length === 0) return;
    try {
      const snaps = await fetchPrices(addrs);
      const update: PriceMap = {};
      for (const [addr, s] of Object.entries(snaps)) {
        update[addr] = {
          priceUsd: s.priceUsd,
          liquidityUsd: s.liquidityUsd,
          volume24h: s.volume24h
        };
      }
      if (Object.keys(update).length > 0) {
        setPrices((cur) => ({ ...cur, ...update }));
      }
    } catch {
      /* keep last-known prices */
    }
  }

  // Position watch: re-price open positions, run the run-up and danger rules
  // against paper positions. Live positions are also re-priced (so the live
  // panel stays fresh), but no auto-execution happens against them: live sell
  // rules are L5 (one-click prompts), not implicit closes.
  async function runPositionWatch() {
    if (paperBusyRef.current) return;
    const open = paper.positions.filter((p) => p.status === "open");
    const liveOpen = live.positions.filter((p) => p.status === "open");
    // Watchlist: pull prices for active alerts too. Folded into the same
    // fetchPrices batch so a 20-watch list adds at most one DexScreener
    // /tokens call (DexScreener accepts up to 30 addrs per call). The
    // evaluator runs after position rules so a coin both held AND watched
    // sees the position rules first; the watch alert is informational.
    const activeWatches = watchlist.filter((w) => w.triggeredAt == null);
    if (open.length === 0 && liveOpen.length === 0 && activeWatches.length === 0) return;
    paperBusyRef.current = true;
    try {
      const addrs = Array.from(
        new Set([
          ...open.map((p) => p.address),
          ...liveOpen.map((p) => p.mint),
          ...activeWatches.map((w) => w.mint)
        ])
      );
      const snaps = await fetchPrices(addrs);
      const priceMap: PriceMap = {};
      for (const [addr, s] of Object.entries(snaps)) {
        priceMap[addr] = {
          priceUsd: s.priceUsd,
          liquidityUsd: s.liquidityUsd,
          volume24h: s.volume24h
        };
      }
      if (Object.keys(priceMap).length === 0) {
        // The whole price request failed. Do not evaluate, or every position
        // would be force-closed as rugged on a transient network blip.
        setError("Position watch could not fetch prices (server or network). Retrying next cycle.");
        return;
      }
      setPrices((cur) => ({ ...cur, ...priceMap }));
      // Re-pricing above runs in every mode (it keeps the live panel fresh).
      // The paper-position evaluation below does not run in Real mode: Real
      // mode pauses the paper bot. This is belt-and-suspenders, the Auto-run /
      // Position-watch toggles are also disabled in Real mode.
      if (open.length > 0 && tradingMode !== "real" && queueMode) {
        // Queue mode: the watch never auto-sells. It proposes sell intents
        // (stop-loss, take-profit, scale-out, liquidity, re-arm) to the queue,
        // so the watch keeps the queue fed even when auto-run is off.
        const sellIntents = decideSellIntents(paper, priceMap);
        const added = enqueueIntents(sellIntents);
        if (added > 0) {
          setCycleLog({
            at: new Date().toISOString(),
            events: [
              {
                kind: "info",
                text: `Position watch proposed ${added} sell${added === 1 ? "" : "s"} to the Trade queue.`
              }
            ]
          });
          pushAlert(
            `Position watch proposed ${added} sell${added === 1 ? "" : "s"}. Review in the Trade queue.`,
            "spike",
            "trade-queue"
          );
        }
      } else if (open.length > 0 && tradingMode !== "real") {
        const res = evaluatePositionWatch(paper, priceMap);
        setPaper(res.state);
        for (const a of res.alerts) pushAlert(a.text, a.kind);
        // Pump-trigger log: held positions that just crossed +50%.
        const spikes = res.alerts.filter((a) => a.kind === "spike");
        if (spikes.length > 0) {
          void logPumps(
            spikes
              .map((a) => {
                const pos = paper.positions.find(
                  (p) => p.status === "open" && p.address === a.address
                );
                if (!pos) return null;
                const px = priceMap[pos.address]?.priceUsd ?? 0;
                const pct =
                  px > 0 ? ((px - pos.entryPriceUsd) / pos.entryPriceUsd) * 100 : 50;
                return {
                  address: pos.address,
                  symbol: pos.symbol,
                  name: pos.name,
                  trigger: `Held position, +${Math.round(pct)}% from entry`,
                  runUpPct: pct
                };
              })
              .filter((c): c is NonNullable<typeof c> => c !== null)
          );
        }
        if (res.events.length > 0) {
          setCycleLog({ at: new Date().toISOString(), events: res.events });
        }
      }
      // Evaluate watchlist alerts. Runs in EVERY mode (paper / real / queue)
      // because watches are user-side intent, not part of any cycle. Fires
      // one toast per triggered watch and marks triggered_at + triggered_price
      // so it doesn't re-fire. priceMap was already populated above; we just
      // read the watched mints' entries.
      if (activeWatches.length > 0) {
        const newlyTriggered: { entry: WatchlistEntry; price: number }[] = [];
        for (const w of activeWatches) {
          const info = priceMap[w.mint];
          if (!info || !(info.priceUsd > 0)) continue;
          const hit =
            w.direction === "below"
              ? info.priceUsd <= w.targetPriceUsd
              : info.priceUsd >= w.targetPriceUsd;
          if (hit) newlyTriggered.push({ entry: w, price: info.priceUsd });
        }
        if (newlyTriggered.length > 0) {
          const triggeredIds = new Set(newlyTriggered.map((x) => x.entry.id));
          const now = new Date().toISOString();
          setWatchlist((cur) =>
            cur.map((w) => {
              if (!triggeredIds.has(w.id)) return w;
              const t = newlyTriggered.find((x) => x.entry.id === w.id)!;
              return { ...w, triggeredAt: now, triggeredPrice: t.price };
            })
          );
          for (const { entry, price } of newlyTriggered) {
            const label = entry.symbol ?? entry.mint.slice(0, 6);
            const dir = entry.direction === "below" ? "dropped to" : "rose to";
            pushAlert(
              `Watchlist: ${label} ${dir} $${price.toPrecision(4)} (target $${entry.targetPriceUsd.toPrecision(4)}). Click to look it up.`,
              "spike",
              "watchlist"
            );
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      paperBusyRef.current = false;
    }
  }

  function toggleWatch() {
    setWatchOn((v) => {
      const next = !v;
      if (next && typeof Notification !== "undefined" && Notification.permission === "default") {
        Notification.requestPermission().catch(() => {});
      }
      return next;
    });
  }

  // Real-mode cycle. The paper Auto-run / Position watch are off in Real mode;
  // this runs in their place: it scans for live buy candidates and re-prices
  // open live positions for live sell decisions, proposing both to the Trade
  // queue. It never executes a trade and never touches the paper account;
  // approving a live intent (build tx -> Phantom -> confirm -> record) is R2.
  async function runLiveCycle() {
    if (liveCycleBusyRef.current) return;
    liveCycleBusyRef.current = true;
    setCycleRunning(true);
    setError(null);
    const events: TradeEvent[] = [];
    try {
      // Scan -> live buy proposals.
      const result = await scanMemecoins(scan ?? undefined);
      setScan(result);
      notifyNewCoins(result);
      void saveScan(result);
      try {
        localStorage.setItem("memeify-memecoin-scan-v2", JSON.stringify(result));
      } catch {
        /* ignore storage failure */
      }
      void logPumps(scanPumpCandidates(result.tokens));
      const buyResult = decideLiveBuyIntents(
        result.tokens,
        live.positions,
        paper.settings,
        dismissedBuyIntents
      );
      // Re-price open live positions -> live sell proposals.
      const liveOpen = live.positions.filter((p) => p.status === "open");
      let sellIntents: TradeIntent[] = [];
      if (liveOpen.length > 0) {
        const snaps = await fetchPrices(liveOpen.map((p) => p.mint));
        const priceMap: PriceMap = {};
        for (const [addr, s] of Object.entries(snaps)) {
          priceMap[addr] = {
            priceUsd: s.priceUsd,
            liquidityUsd: s.liquidityUsd,
            volume24h: s.volume24h
          };
        }
        if (Object.keys(priceMap).length > 0) {
          setPrices((cur) => ({ ...cur, ...priceMap }));
          // Lift peakPriceUsd on every live position whose price we just
          // observed, so the trailing-stop rule has fresh peak data. Always
          // refresh lastPrice / lastLiquidity (the live equivalent of the
          // paper position-watch), and persist via the next state commit.
          // Bad-data ticks (>1000x entry) are NOT allowed to lift the peak;
          // see plausibleSellPrice. One thin-pool glitch otherwise stays
          // baked into peak forever and fires trailing as a fake -99% later.
          const liftedPositions = live.positions.map((p) => {
            if (p.status !== "open") return p;
            const info = priceMap[p.mint];
            if (!info || info.priceUsd <= 0) return p;
            const priceOk = plausibleSellPrice(info.priceUsd, p.entryPriceUsd);
            const peak =
              !priceOk
                ? p.peakPriceUsd
                : p.peakPriceUsd === undefined || info.priceUsd > p.peakPriceUsd
                  ? info.priceUsd
                  : p.peakPriceUsd;
            return {
              ...p,
              peakPriceUsd: peak,
              lastPriceUsd: info.priceUsd,
              lastLiquidityUsd: info.liquidityUsd
            };
          });
          setLive((cur) => ({ ...cur, positions: liftedPositions, updatedAt: new Date().toISOString() }));
          const liftedOpen = liftedPositions.filter((p) => p.status === "open");
          sellIntents = decideLiveSellIntents(liftedOpen, priceMap, paper.settings);
        }
      }
      // Same safety-cache pre-filter as the paper cycle: drop intents for
      // coins whose recent safety verdict says block. Real-money cycle has
      // even less tolerance for queue churn than paper.
      const liveSafetyPreFiltered: TradeIntent[] = [];
      // Symbols, not just a count: see the paper-cycle pre-filter above for
      // the rationale. Live-mode silently dropping a coin you were watching
      // for is the worse failure mode of the two.
      const liveSafetyBlockedSymbols: string[] = [];
      for (const it of buyResult.intents) {
        const c = safetyCacheRef.current[it.address];
        const fresh =
          c && Date.now() - new Date(c.at).getTime() < SAFETY_CACHE_TTL_MS;
        if (fresh && c.result.level === "block") {
          liveSafetyBlockedSymbols.push(it.symbol);
          continue;
        }
        liveSafetyPreFiltered.push(it);
      }
      if (liveSafetyBlockedSymbols.length > 0) {
        const n = liveSafetyBlockedSymbols.length;
        events.push({
          kind: "skip",
          text: `Skipped ${n} live buy intent${n === 1 ? "" : "s"} still in the safety-block cache: ${liveSafetyBlockedSymbols.join(", ")}`
        });
      }
      const added = enqueueIntents([...sellIntents, ...liveSafetyPreFiltered]);
      events.push({
        kind: "info",
        text:
          added > 0
            ? `Live cycle: ${added} intent${added === 1 ? "" : "s"} proposed for your real account. Review in the Trade queue.`
            : "Live cycle: scan refreshed, nothing new to propose."
      });
      if (buyResult.skipped.rugged > 0) {
        events.push({
          kind: "info",
          text: `Skipped ${buyResult.skipped.rugged} coin${
            buyResult.skipped.rugged === 1 ? "" : "s"
          } blacklisted as rugged`
        });
      }
      if (buyResult.skipped.cooldown > 0) {
        events.push({
          kind: "info",
          text: `Skipped ${buyResult.skipped.cooldown} coin${
            buyResult.skipped.cooldown === 1 ? "" : "s"
          } inside the re-entry cooldown`
        });
      }
      if (buyResult.skipped.dismissed > 0) {
        events.push({
          kind: "info",
          text: `Skipped ${buyResult.skipped.dismissed} coin${
            buyResult.skipped.dismissed === 1 ? "" : "s"
          } you dismissed, waiting on the rating to climb +${paper.settings.buyDismissalImprovementPoints} points`
        });
      }
      setCycleLog({ at: new Date().toISOString(), events });
      if (added > 0) {
        pushAlert(
          `Live cycle proposed ${added} trade${added === 1 ? "" : "s"} (pending safety review). Buy intents that fail the safety gate auto-dismiss before you see them; click to jump to the queue, or open the Alerts log if it's empty.`,
          "spike",
          "trade-queue"
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      liveCycleBusyRef.current = false;
      setCycleRunning(false);
    }
  }

  // Keep the intervals pointed at the latest callbacks to avoid stale closures.
  const runCycleRef = useRef(runCycle);
  const runWatchRef = useRef(runPositionWatch);
  const runLiveCycleRef = useRef(runLiveCycle);
  // Latest committed state, for the live-confirm force-saves. confirmLiveBuy /
  // confirmLiveSell run after a multi-second Phantom sign; a cycle or watch may
  // have updated paper/alerts/prices/scan in the meantime. Reading this ref
  // instead of the closure keeps the force-save from writing stale siblings
  // back over those changes.
  const persistRef = useRef({
    paper,
    live,
    alerts,
    prices,
    scan,
    autoRun,
    watchOn,
    queueMode,
    tradeQueue,
    feePct,
    pumpEvents,
    tradingMode,
    dismissedBuyIntents,
    userPrefs,
    watchlist
  });
  useEffect(() => {
    runCycleRef.current = runCycle;
    runWatchRef.current = runPositionWatch;
    runLiveCycleRef.current = runLiveCycle;
    persistRef.current = {
      paper,
      live,
      alerts,
      prices,
      scan,
      autoRun,
      watchOn,
      queueMode,
      tradeQueue,
      feePct,
      pumpEvents,
      tradingMode,
      dismissedBuyIntents,
      userPrefs,
      watchlist
    };
  });
  useEffect(() => {
    if (!autoRun) return;
    // Mutual exclusion with the real-mode cycle below. In Real mode the live
    // cycle is the single source of truth and runs its own 60-min interval;
    // letting the paper auto-run also install would double-scan on any
    // hydration race where both flags briefly land true. Mode-switch already
    // forces autoRun=false, but this guard makes the architecture itself
    // single-source-of-truth instead of relying on the switch path.
    //
    // Cadence: 60 min (slowed from 3 min on 2026-05-26 to keep monthly Brave
    // chatter checks inside the $5 free credit, ~1000 calls/mo). Memecoin
    // windows are minutes, so hourly is mostly a budget compromise; toggle
    // auto_run off when not actively at the desk for the real fix.
    if (tradingMode === "real") return;
    const id = setInterval(() => {
      void runCycleRef.current();
    }, 3600000);
    return () => clearInterval(id);
  }, [autoRun, tradingMode]);
  useEffect(() => {
    if (!watchOn) return;
    // Server scheduler ownership: when the vite plugin
    // positionWatchSchedulerPlugin is enabled (SERVER_SCHEDULER_WATCH=true),
    // the server owns the 5-min tick. The React app still hydrates positions
    // / alerts / prices via /api/memecoin/state polling, so the user sees
    // everything the server did; we just don't install our own interval here
    // to avoid 2× burn (and to keep one canonical source of evaluation).
    if (serverSchedulesWatch) return;
    void runWatchRef.current();
    const id = setInterval(() => {
      void runWatchRef.current();
    }, 300000);
    return () => clearInterval(id);
  }, [watchOn, serverSchedulesWatch]);
  // Real mode: the live cycle runs on its own 60-minute interval and once on
  // entering Real mode. The paper Auto-run / Position watch stay off.
  // Mutual-exclusion partner to the paper auto-run effect above: that one
  // bails on tradingMode === "real", this one bails on != "real". Together
  // they guarantee exactly one cycle owns the 60-min cadence for the active
  // mode, even across a hydration race where both flags briefly land true.
  // Cadence: see the 2026-05-26 note in the paper effect above.
  useEffect(() => {
    if (tradingMode !== "real") return;
    void runLiveCycleRef.current();
    const id = setInterval(() => {
      void runLiveCycleRef.current();
    }, 3600000);
    return () => clearInterval(id);
  }, [tradingMode]);

  const tokens = scan?.tokens ?? [];
  const sortedTokens = useMemo(() => {
    // Numeric key per token for the active sort. Missing values get sentinels
    // that always sink to the bottom regardless of direction.
    const MISSING = Symbol("missing");
    function keyOf(t: (typeof tokens)[number]): number | typeof MISSING {
      switch (sortBy) {
        case "rating":
          return t.rating;
        case "score":
          return t.exitScore;
        case "rising":
          return t.momentumScore ?? 0;
        case "liquidity":
          return t.liquidityUsd;
        case "volume":
          return t.volume24h;
        case "change":
          return t.priceChange24h;
        case "newest":
          // Lower ageHours = newer. Desc sort newest-first; asc sorts oldest-first.
          return -t.ageHours;
        case "wallets":
          return t.jupiterHolderCount ?? MISSING;
        case "top10":
          // Negate so larger key = better (lower concentration). Desc = safest first.
          return t.top10HoldersPct == null ? MISSING : -t.top10HoldersPct;
        case "holdersPerDay":
          // Adoption velocity. Desc = fastest-growing first. Floor age at 1h
          // to avoid divide-by-zero on freshly-launched coins.
          if (t.jupiterHolderCount === undefined || t.ageHours <= 0) return MISSING;
          return t.jupiterHolderCount / Math.max(t.ageHours / 24, 1 / 24);
      }
    }
    const arr = [...tokens];
    const mul = sortDir === "desc" ? 1 : -1;
    arr.sort((a, b) => {
      const ka = keyOf(a);
      const kb = keyOf(b);
      if (ka === MISSING && kb === MISSING) return 0;
      if (ka === MISSING) return 1;
      if (kb === MISSING) return -1;
      return (kb - ka) * mul;
    });
    return arr;
  }, [tokens, sortBy, sortDir]);

  // Partition into visible vs hidden so we can show counts in both tabs and
  // render the right list based on the user's view choice.
  const visibleTokens = useMemo(
    () => sortedTokens.filter((t) => !hiddenMints.has(t.address)),
    [sortedTokens, hiddenMints]
  );
  const hiddenTokens = useMemo(
    () => sortedTokens.filter((t) => hiddenMints.has(t.address)),
    [sortedTokens, hiddenMints]
  );
  const displayedTokens = hideView === "hidden" ? hiddenTokens : visibleTokens;

  // Jump from a new-coin alert straight to that coin's card in the research
  // list. The alert's scrollToId is the coin address (set by notifyNewCoins and
  // the server scan scheduler). A card only renders when the research panel is
  // expanded, the coin is in the active visible/hidden view, and it falls inside
  // the "show N" slice — so we satisfy all three, then scroll once the DOM has
  // caught up.
  function jumpToCoin(address: string) {
    if (researchSection.collapsed) researchSection.toggle();
    const inHidden = hiddenMints.has(address);
    // The coin lives in whichever view its hidden-state puts it in; switch to
    // that view so the card is in displayedTokens.
    setHideView(inHidden ? "hidden" : "visible");
    const list = inHidden ? hiddenTokens : visibleTokens;
    const idx = list.findIndex((t) => t.address === address);
    // Page the list far enough to render the target (slice(0, shown)).
    if (idx >= 0) setShown((n) => Math.max(n, idx + 1));
    setHighlightedCoin(address);
    window.setTimeout(() => setHighlightedCoin((c) => (c === address ? null : c)), 2400);
    // Defer the scroll one paint so the expand / show-more state above has
    // mounted the target card before getElementById runs.
    window.setTimeout(() => {
      document
        .getElementById(address)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
  }

  // Alert-click router. A scrollToId matching a coin in the current scan routes
  // through jumpToCoin (which pages the research list to it); any other id is a
  // static section anchor (trade-queue, watchlist, ...) we simply scroll to.
  function handleAlertJump(scrollToId: string) {
    // 1. Coin still in the current scan → page the research list to its card.
    if (tokens.some((t) => t.address === scrollToId)) {
      jumpToCoin(scrollToId);
      return;
    }
    // 2. A static section anchor that exists in the DOM → scroll to it.
    const el = document.getElementById(scrollToId);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    // 3. A coin mint that has rotated out of the current scan — there's no card
    // to scroll to (this is why these clicks used to do nothing). Open it on
    // DexScreener in a new tab so the alert is never a dead end.
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(scrollToId)) {
      window.open(`https://dexscreener.com/solana/${scrollToId}`, "_blank", "noopener");
    }
  }

  // Open paper position summary for a coin, or undefined if it is not held.
  function holdingFor(address: string): Holding | undefined {
    const held = paper.positions.filter((p) => p.status === "open" && p.address === address);
    if (held.length === 0) return undefined;
    const costUsd = held.reduce((sum, p) => sum + p.costUsd, 0);
    const value = held.reduce((sum, p) => sum + positionValue(p, prices), 0);
    return {
      costUsd,
      pnlUsd: value - costUsd,
      pnlPct: costUsd > 0 ? ((value - costUsd) / costUsd) * 100 : 0
    };
  }

  // Close the coin detail popup on Escape.
  useEffect(() => {
    if (!popupCoin) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPopupCoin(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [popupCoin]);

  return (
    <>
      {alerts.some((a) => !a.dismissed) &&
        (() => {
          // Toast stack: only renders UNDISMISSED alerts. Hiding a toast marks
          // alerts as dismissed but keeps them in the alerts log panel below,
          // so the user can clear the toast to see what's underneath without
          // losing the log entry. Permanent removal lives on the alerts log
          // (purgeAlert / purgeAllAlerts).
          //
          // Group similar alerts so the stack doesn't dominate the viewport when
          // the cycle fires the same kind of alert (auto-dismissals especially)
          // many times in a row. Each group shows the latest alert as the head,
          // with the rest available via an expander. Hide removes one or a
          // group from the toast; the log keeps every row.
          //
          // Group signature heuristic:
          //   - "Auto-dismissed SYMBOL: ..." → group "auto-dismissed" (all coins together)
          //   - "Live buy filled: ..." / "Live sell filled: ..." → grouped by action
          //   - Otherwise: first 3 lowercased words of the text
          // Combined with `kind` (profit/spike/danger) so different severities
          // don't merge under the same group.
          function alertGroupKey(a: PanelAlert): string {
            const text = a.text.trim();
            if (/^Auto-dismissed\s+\S+:/i.test(text)) return `${a.kind}|auto-dismissed`;
            if (/^Live buy filled:/i.test(text)) return `${a.kind}|live-buy-filled`;
            if (/^Live sell filled:/i.test(text)) return `${a.kind}|live-sell-filled`;
            const words = text.split(/\s+/).slice(0, 3).join(" ").toLowerCase();
            return `${a.kind}|${words}`;
          }
          function groupLabel(key: string): string {
            const tail = key.split("|")[1] ?? "";
            if (tail === "auto-dismissed") return "auto-dismissals";
            if (tail === "live-buy-filled") return "live buys";
            if (tail === "live-sell-filled") return "live sells";
            return tail;
          }
          // Preserve insertion order of FIRST occurrence so the newest group
          // appears at the position of its newest member (alerts is prepend-newest).
          // Filter out dismissed alerts from the toast view; the alerts log
          // below still shows everything.
          const visibleAlerts = alerts.filter((a) => !a.dismissed);
          const groups: { key: string; items: PanelAlert[] }[] = [];
          const byKey = new Map<string, PanelAlert[]>();
          for (const a of visibleAlerts) {
            const k = alertGroupKey(a);
            if (!byKey.has(k)) {
              const arr: PanelAlert[] = [];
              byKey.set(k, arr);
              groups.push({ key: k, items: arr });
            }
            byKey.get(k)!.push(a);
          }
          return (
            <div className="mc-alerts">
              {visibleAlerts.length > 1 && (
                <div className="mc-alerts-head">
                  <span>
                    {visibleAlerts.length} alert{visibleAlerts.length === 1 ? "" : "s"}
                    {groups.length < visibleAlerts.length ? ` in ${groups.length} groups` : ""}
                  </span>
                  <button onClick={hideAllAlerts} title="Hide every toast. The alerts log below keeps the full history.">
                    Hide all
                  </button>
                </div>
              )}
              {groups.map(({ key, items }) => {
                const head = items[0]; // newest in this group (alerts is newest-first)
                const rest = items.slice(1);
                const expanded = expandedAlertGroups.has(key);
                // For auto-dismiss groups, the head text only shows ONE symbol
                // ("Auto-dismissed POKE: ...") and the others hide behind the
                // expander, which is confusing when a single safety-block batch
                // catches multiple coins. Build a consolidated head that lists
                // every symbol up front, while keeping the per-coin alerts in
                // the expander for full reasons.
                const isAutoDismissGroup = key.endsWith("|auto-dismissed");
                let headText = head.text;
                if (isAutoDismissGroup && items.length > 1) {
                  const symbols: string[] = [];
                  for (const a of items) {
                    const m = a.text.match(/^Auto-dismissed\s+(\S+?):/i);
                    if (m && !symbols.includes(m[1])) symbols.push(m[1]);
                  }
                  // Pull the reason from the newest alert; reasons in a batch
                  // are usually identical (one cycle hitting the same gate),
                  // and even when they differ, the per-coin reasons are still
                  // visible in the expander. The "(reasons vary, expand for
                  // details)" hint trails when we detect mixed reasons.
                  const reasonMatch = head.text.match(/^Auto-dismissed\s+\S+?:\s*(.*)$/i);
                  const headReason = reasonMatch ? reasonMatch[1] : "";
                  const reasons = new Set<string>();
                  for (const a of items) {
                    const rm = a.text.match(/^Auto-dismissed\s+\S+?:\s*(.*)$/i);
                    if (rm) reasons.add(rm[1]);
                  }
                  const reasonSuffix =
                    reasons.size > 1
                      ? `${headReason} (reasons vary; expand for per-coin details)`
                      : headReason;
                  headText = `Auto-dismissed ${symbols.length}: ${symbols.join(", ")} — ${reasonSuffix}`;
                }
                return (
                  <div key={key} className={`mc-alert mc-alert-${head.kind}`}>
                    <div
                      className={`mc-alert-body${head.scrollToId ? " mc-alert-link" : ""}`}
                      onClick={
                        head.scrollToId
                          ? () => {
                              handleAlertJump(head.scrollToId!);
                              // Hide the whole group from the toast (the user
                              // just acknowledged it by jumping). The alerts
                              // log keeps every row.
                              hideAlertGroup(new Set(items.map((it) => it.id)));
                            }
                          : undefined
                      }
                    >
                      <span>{headText}</span>
                      <small>
                        {head.scrollToId
                          ? head.kind === "newcoin"
                            ? "Click to view in meme coin research"
                            : "Click to jump to the relevant panel"
                          : new Date(head.at).toLocaleString()}
                      </small>
                      {rest.length > 0 && (
                        <button
                          type="button"
                          className="mc-alert-expand"
                          onClick={(e) => {
                            // Stop the link-style parent onClick from also firing
                            // when the head alert has a scrollToId.
                            e.stopPropagation();
                            setExpandedAlertGroups((cur) => {
                              const next = new Set(cur);
                              if (next.has(key)) next.delete(key);
                              else next.add(key);
                              return next;
                            });
                          }}
                        >
                          {expanded
                            ? `Hide ${rest.length} more`
                            : `+${rest.length} more ${groupLabel(key)}`}
                        </button>
                      )}
                      {expanded &&
                        rest.map((a) => (
                          <div key={a.id} className="mc-alert-sub">
                            <span>{a.text}</span>
                            <small>{new Date(a.at).toLocaleString()}</small>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                hideAlert(a.id);
                              }}
                              aria-label="hide alert"
                            >
                              <XCircle size={13} />
                            </button>
                          </div>
                        ))}
                    </div>
                    <div className="mc-alert-actions">
                      {rest.length > 0 && (
                        <button
                          type="button"
                          className="mc-alert-dismiss-group"
                          title={`Hide all ${items.length} toasts in this group. Alerts log keeps them.`}
                          onClick={(e) => {
                            e.stopPropagation();
                            hideAlertGroup(new Set(items.map((it) => it.id)));
                            setExpandedAlertGroups((cur) => {
                              const next = new Set(cur);
                              next.delete(key);
                              return next;
                            });
                          }}
                        >
                          Hide {items.length}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          // X-on-head with a multi-item group hides the whole
                          // group to match the "Hide N" sibling; with a single
                          // item it just hides that one. Either way the alerts
                          // log keeps the rows.
                          if (items.length > 1) {
                            hideAlertGroup(new Set(items.map((it) => it.id)));
                          } else {
                            hideAlert(head.id);
                          }
                        }}
                        aria-label="hide alert"
                      >
                        <XCircle size={15} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })()}
      <div className={`mc-mode-bar mc-mode-${tradingMode}`}>
        <div className="mc-mode-headline">
          <strong>Trading mode</strong>
          <div className="mc-mode-toggle">
            <button
              className={tradingMode === "paper" ? "mc-mode-on" : ""}
              onClick={() => requestTradingMode("paper")}
            >
              Paper
            </button>
            <button
              className={tradingMode === "real" ? "mc-mode-on mc-mode-on-real" : ""}
              onClick={() => requestTradingMode("real")}
            >
              Real money
            </button>
          </div>
        </div>
        <div className="mc-mode-status">
          {modeSaveStatus === "saving"
            ? "Saving the mode change and verifying it in the database..."
            : modeSaveStatus === "verified"
              ? `${tradingMode === "real" ? "Real money" : "Paper"} mode saved and verified in the database.`
              : modeSaveStatus === "error"
                ? "Mode change NOT confirmed saved. See the error above. Do not trade until it is resolved."
                : tradingMode === "real"
                  ? "Real money mode. You review and sign every trade in Phantom."
                  : "Paper mode. Simulated money, no real transactions."}
        </div>
        {tradingMode === "real" && (
          <div className="mc-mode-note">
            Real mode: trade manually with the Buy (live) / Sell buttons, each
            signed in Phantom. Automated live proposals through the Trade queue
            are rolling out next.
          </div>
        )}
      </div>
      <div className="mc-jump">
        <span>Jump to</span>
        {/* Real positions first, because that's where actual money lives.
            Promoted to primary-button styling when there are open live
            positions so it stands out from paper-trading affordances. */}
        <button
          className={
            live.positions.some((p) => p.status === "open") ? "primary-button" : "ghost-button"
          }
          onClick={() =>
            document
              .getElementById("live-positions")
              ?.scrollIntoView({ behavior: "smooth", block: "start" })
          }
          title="Your actual on-chain positions (real money). The live ledger reads on-chain fills, not the paper simulator."
        >
          Real positions ({live.positions.filter((p) => p.status === "open").length})
        </button>
        <button
          className="ghost-button"
          onClick={() =>
            document
              .getElementById("trade-queue")
              ?.scrollIntoView({ behavior: "smooth", block: "start" })
          }
        >
          Trade queue
        </button>
        <button
          className="ghost-button"
          onClick={() =>
            document
              .getElementById("trading-rules")
              ?.scrollIntoView({ behavior: "smooth", block: "start" })
          }
        >
          Trading rules
        </button>
        <button
          className="ghost-button"
          onClick={() => {
            // Sidebar nav uses hash routing; pushing the hash navigates to
            // the dedicated Flow page (a sibling tab, not a section here).
            window.location.hash = "memecoin_flow";
          }}
          title="System flow diagram: what fires when (scan, auto-cycle, watch, live cycle, safety gate, queue, manual trades). Opens the dedicated Flow page."
        >
          Flow
        </button>
        <button
          className="ghost-button"
          onClick={() =>
            document
              .getElementById("rotation-context")
              ?.scrollIntoView({ behavior: "smooth", block: "start" })
          }
          title="Macro context: CoinGecko search-trending memecoins + DefiLlama USDC flow on Solana. Tells you whether to trust pumps you see."
        >
          Rotation
        </button>
        <button
          className="ghost-button"
          onClick={() =>
            document
              .getElementById("watchlist")
              ?.scrollIntoView({ behavior: "smooth", block: "start" })
          }
          title="Price alerts for any coin (closed positions, scan candidates, anything you paste a mint for). Fires when target is hit."
        >
          Watchlist ({watchlist.filter((w) => w.triggeredAt == null).length})
        </button>
        <button
          className="ghost-button"
          onClick={() =>
            document
              .getElementById("integrations")
              ?.scrollIntoView({ behavior: "smooth", block: "start" })
          }
          title="Live health of every external service this tab depends on (PumpPortal, CoinGecko, Helius, Postgres, etc.)."
        >
          Integrations
        </button>
        <button
          className="ghost-button"
          onClick={() =>
            document
              .getElementById("alerts-log")
              ?.scrollIntoView({ behavior: "smooth", block: "start" })
          }
          title="Full alert log, one row per alert (no grouping). Mirrors the toast stack but always visible."
        >
          Alerts ({alerts.length})
        </button>
      </div>
      <section className="page-grid">
      {/* Full alert log: every alert, newest first, no grouping. Persists
          across toast dismissals — hiding a toast does NOT remove the entry
          here. The user clears the log explicitly via Clear ALL or per-row X.
          Dismissed entries render visually muted so the active vs already-seen
          split is obvious at a glance. */}
      <section id="alerts-log" className={`panel wide ${alertsLogSection.className}`}>
        <PanelTitle
          icon={AlertTriangle}
          title={
            (() => {
              const undismissed = alerts.filter((a) => !a.dismissed).length;
              const total = alerts.length;
              if (total === 0) return "Alerts log";
              if (undismissed === total) return `Alerts log (${total})`;
              return `Alerts log (${undismissed} active, ${total - undismissed} hidden)`;
            })()
          }
          collapsed={alertsLogSection.collapsed}
          onToggle={alertsLogSection.toggle}
        />
        {alerts.length === 0 ? (
          <p className="empty">No alerts. Sell triggers, auto-dismissals, and live fills all log here.</p>
        ) : (
          <>
            <div className="mc-alertlog-controls">
              <span className="muted" style={{ fontSize: 12 }}>
                Hiding a toast above keeps the entry here. Use the buttons below to
                permanently remove from this log.
              </span>
              {alerts.some((a) => a.dismissed) && (
                <button
                  className="ghost-button"
                  onClick={() => flushAlertsImmediately(alerts.filter((a) => !a.dismissed))}
                  title="Permanently delete every alert that's already been hidden from the toast stack"
                >
                  Clear hidden ({alerts.filter((a) => a.dismissed).length})
                </button>
              )}
              <button className="ghost-button" onClick={purgeAllAlerts}>
                Clear ALL ({alerts.length})
              </button>
            </div>
            <div className="mc-alertlog">
              {alerts.map((a) => (
                <div
                  key={a.id}
                  className={`mc-alertlog-row mc-alertlog-${a.kind}${a.dismissed ? " mc-alertlog-dismissed" : ""}`}
                >
                  <span className="mc-alertlog-time" title={new Date(a.at).toLocaleString()}>
                    {new Date(a.at).toLocaleTimeString()}
                  </span>
                  <span className="mc-alertlog-kind">{a.kind}</span>
                  <span
                    className={`mc-alertlog-text${a.scrollToId ? " mc-alert-link" : ""}`}
                    onClick={
                      a.scrollToId
                        ? () => {
                            handleAlertJump(a.scrollToId!);
                            // Clicking a clickable row jumps + hides the toast,
                            // but never permanently deletes the log entry.
                            hideAlert(a.id);
                          }
                        : undefined
                    }
                  >
                    {a.text}
                  </span>
                  <button
                    type="button"
                    onClick={() => purgeAlert(a.id)}
                    aria-label="permanently delete this alert from the log"
                    title="Permanently delete this alert from the log"
                    className="mc-alertlog-x"
                  >
                    <XCircle size={14} />
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
      <RotationContextPanel />

      <section className={`panel wide ${researchSection.className}`}>
        <PanelTitle
          icon={Coins}
          title="Meme coin research"
          collapsed={researchSection.collapsed}
          onToggle={researchSection.toggle}
        />
        <div className="mc-intro">
          <p className="muted">
            Pulls fresh and boosted Solana tokens from DexScreener and pump.fun, then ranks them by
            whether a position could realistically be exited: pool liquidity, two-sided 24h volume,
            turnover, and trade count. Reads public market data only. Not financial advice, does not
            predict price. See docs/ARCHITECTURE.md for the full project context and rules.
          </p>
          <div className="mc-warn">
            Base rate, from the research: under 0.5% of pump.fun launches ever complete the bonding
            curve, only ~1.4% of pump.fun tokens hold even $1k of liquidity, and fewer than 5% of
            memecoins keep real volume past 72 hours. Roughly 43% of meme tokens have zero volume.
            This tool ranks the survivors. It does not change those odds.
          </div>
        </div>

        <div className="mc-controls">
          <button className="primary-button" onClick={runScan} disabled={loading || busy}>
            <RefreshCw size={16} />
            {loading ? "Scanning..." : "Scan latest meme coins"}
          </button>
          <div className="mc-search">
            <input
              placeholder="Or validate one ticker / contract address"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") runLookup();
              }}
            />
            <button className="ghost-button" onClick={runLookup} disabled={loading || busy}>
              <Search size={16} />
              {busy ? "..." : "Look up"}
            </button>
          </div>
        </div>

        {error && <p className="danger-text">{error}</p>}

        {scan && (
          <>
            <div className="mc-sources">
              <span>Scanned {new Date(scan.scannedAt).toLocaleString()}</span>
              {scan.sources.map((s) => (
                <span key={s.name} className={`mc-source-chip ${s.ok ? "good" : "bad"}`}>
                  {s.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                  {s.name}: {s.count}
                  {s.note ? ` (${s.note})` : ""}
                </span>
              ))}
            </div>

            {tokens.length === 0 ? (
              <p className="empty">No tokens to show from this scan.</p>
            ) : (
              <>
                <div className="mc-sortbar" style={{ gap: 8 }}>
                  <button
                    className={hideView === "visible" ? "primary-button" : "ghost-button"}
                    onClick={() => setHideView("visible")}
                    style={{ padding: "4px 10px" }}
                  >
                    Visible ({visibleTokens.length})
                  </button>
                  <button
                    className={hideView === "hidden" ? "primary-button" : "ghost-button"}
                    onClick={() => setHideView("hidden")}
                    disabled={hiddenTokens.length === 0}
                    style={{ padding: "4px 10px" }}
                    title={
                      hiddenTokens.length === 0
                        ? "Nothing hidden yet. Use the Hide button on a card to remove it from the Visible list."
                        : "Show coins you have hidden. Click Unhide on a card to bring it back."
                    }
                  >
                    Hidden ({hiddenTokens.length})
                  </button>
                  {hideView === "hidden" && hiddenMints.size > 0 && (
                    <button
                      className="ghost-button"
                      onClick={() => {
                        if (
                          window.confirm(
                            `Unhide all ${hiddenMints.size} coins? They will reappear in the Visible list immediately.`
                          )
                        ) {
                          setUserPrefs((p) => ({ ...p, hiddenMints: [] }));
                        }
                      }}
                      style={{ padding: "4px 10px" }}
                      title="Unhide every coin in the Hidden list at once. Useful after many sessions when the list has grown unwieldy."
                    >
                      Clear all hidden
                    </button>
                  )}
                  <span style={{ marginLeft: 4 }}>sort by</span>
                  <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortKey)}>
                    <option value="rating">Rating</option>
                    <option value="score">Exit score</option>
                    <option value="rising">Rising (momentum)</option>
                    <option value="liquidity">Liquidity</option>
                    <option value="volume">24h volume</option>
                    <option value="change">24h price change</option>
                    <option value="newest">Newest</option>
                    <option value="wallets">Unique wallets</option>
                    <option value="top10">Top-10 holders</option>
                    <option value="holdersPerDay">Holders / day</option>
                  </select>
                  <button
                    className="ghost-button"
                    onClick={() => setSortDir(sortDir === "desc" ? "asc" : "desc")}
                    title={sortDir === "desc" ? "Descending (high to low)" : "Ascending (low to high)"}
                    style={{ padding: "4px 8px" }}
                  >
                    {sortDir === "desc" ? <ArrowDown size={14} /> : <ArrowUp size={14} />}
                    {sortDir === "desc" ? "Desc" : "Asc"}
                  </button>
                  <span>
                    showing {Math.min(shown, displayedTokens.length)} of {displayedTokens.length}
                  </span>
                </div>
                {displayedTokens.length === 0 ? (
                  <p className="empty">
                    {hideView === "hidden"
                      ? "No hidden coins. Click Hide on a card to remove it from the Visible list."
                      : "All coins in this scan are hidden. Switch to the Hidden tab to manage them."}
                  </p>
                ) : (
                  <div className="mc-list">
                    {displayedTokens.slice(0, shown).map((t) => (
                      <MemeCoinCard
                        key={t.address}
                        anchorId={t.address}
                        highlight={highlightedCoin === t.address}
                        token={t}
                        holding={holdingFor(t.address)}
                        chatter={chatter[t.address]}
                        onChatter={() => runChatter(t)}
                        onBuy={() => requestBuyPaper(t)}
                        onBuyLive={() => requestBuyLive(t)}
                        walletConnected={!!walletAddress}
                        liveHeld={live.positions.some(
                          (p) => p.status === "open" && p.mint === t.address
                        )}
                        livePending={pendingLiveMints.has(t.address)}
                        hidden={hiddenMints.has(t.address)}
                        onHide={() => hideMint(t.address)}
                        onUnhide={() => unhideMint(t.address)}
                      />
                    ))}
                  </div>
                )}
                <div className="mc-controls">
                  {shown < displayedTokens.length && (
                    <button className="ghost-button" onClick={() => setShown((n) => n + 5)}>
                      Show 5 more ({displayedTokens.length - shown} left)
                    </button>
                  )}
                  {shown > 5 && (
                    <button className="ghost-button" onClick={() => setShown(5)}>
                      Collapse to 5
                    </button>
                  )}
                </div>
              </>
            )}
          </>
        )}

        {!scan && !loading && (
          <p className="empty">No scan yet. Hit "Scan latest meme coins" to pull live data.</p>
        )}
      </section>

      <WalletStrip onAddress={setWalletAddress} />

      <SwapPanel walletAddress={walletAddress} />

      <LivePanel
        live={live}
        prices={prices}
        walletAddress={walletAddress}
        onSell={requestSellLive}
        onShowCoin={(addr) => setPopupCoin(addr)}
        onShowMosaic={() => setShowMosaic(true)}
      />

      <PaperPanel
        paper={paper}
        prices={prices}
        cycleLog={cycleLog}
        cycleRunning={cycleRunning}
        autoRun={autoRun}
        watchOn={watchOn}
        onRunCycle={runCycle}
        onToggleAuto={() => setAutoRun((v) => !v)}
        onToggleWatch={toggleWatch}
        onUpdateSettings={updateSettings}
        onSell={requestSellPaper}
        sellingId={sellingId}
        onBuyReal={requestBuyRealFromPosition}
        walletConnected={!!walletAddress}
        onClearRearm={clearRearmForPosition}
        onReset={requestResetPaper}
        onTopUp={topUpCash}
        onShowCoin={(addr) => setPopupCoin(addr)}
        onShowMosaic={() => setShowMosaic(true)}
        feePct={feePct}
        onFeePct={(p) => {
          setFeePct(p);
          writeFeePct(p);
        }}
        saveStatus={saveStatus}
        tradingMode={tradingMode}
        closedExpanded={userPrefs.closedExpanded}
        onSetClosedExpanded={(v) =>
          setUserPrefs((p) => ({ ...p, closedExpanded: v }))
        }
        onAddWatch={addWatch}
        serverSchedulesWatch={serverSchedulesWatch}
      />

      <TradeQueuePanel
        queue={tradeQueue}
        queueMode={queueMode}
        settings={paper.settings}
        prices={prices}
        safety={queueSafety}
        dismissedBuyIntents={dismissedBuyIntents}
        onToggleMode={toggleQueueMode}
        onApprove={approveQueued}
        onDismiss={dismissQueued}
        onEditIntent={editIntent}
        onRearm={rearmIntent}
        onClearRearm={clearRearmForPosition}
        onShowCoin={(addr) => setPopupCoin(addr)}
      />

      <PumpTriggersPanel events={pumpEvents} onShowCoin={(addr) => setPopupCoin(addr)} />

      <WatchlistPanel
        watchlist={watchlist}
        prices={prices}
        onAdd={addWatch}
        onDelete={deleteWatch}
        onResetTrigger={resetWatchTrigger}
        onShowCoin={(addr) => setPopupCoin(addr)}
      />

      <IntegrationsPanel />
      </section>

      {liveBuyToken && walletAddress && (
        <BuyLiveModal
          token={liveBuyToken}
          walletAddress={walletAddress}
          maxTopHoldersPct={paper.settings.maxTopHoldersPct}
          defaultAmountUsd={liveBuySeedUsd ?? undefined}
          onSignStart={() => markLivePending(liveBuyToken.address, true)}
          onSignEnd={() => markLivePending(liveBuyToken.address, false)}
          onConfirm={(args) => {
            void confirmLiveBuy({ token: liveBuyToken, ...args });
          }}
          onClose={() => {
            // Closing the modal while a sign is in flight only dismisses the
            // UI; the sign promise continues and the pending guard stays set
            // until onSignEnd fires. That keeps the Buy (live) button locked
            // for this mint until the in-flight transaction resolves.
            setLiveBuyToken(null);
            setLiveBuySeedUsd(null);
          }}
        />
      )}

      {liveSellPosition && walletAddress && (
        <SellLiveModal
          position={liveSellPosition}
          walletAddress={walletAddress}
          currentPriceUsd={livePriceUsd(liveSellPosition, prices) || undefined}
          onConfirm={(args) => {
            void confirmLiveSell({ positionId: liveSellPosition.id, ...args });
          }}
          onClose={() => setLiveSellPosition(null)}
        />
      )}

      {popupCoin && (
        <CoinPopup
          address={popupCoin}
          token={sortedTokens.find((t) => t.address === popupCoin)}
          positions={paper.positions.filter((p) => p.address === popupCoin)}
          priceNow={prices[popupCoin]?.priceUsd}
          holding={holdingFor(popupCoin)}
          chatter={chatter[popupCoin]}
          onChatter={() => {
            const t = sortedTokens.find((x) => x.address === popupCoin);
            if (t) runChatter(t);
          }}
          onBuy={() => {
            const t = sortedTokens.find((x) => x.address === popupCoin);
            if (t) requestBuyPaper(t);
          }}
          onClose={() => setPopupCoin(null)}
        />
      )}

      {confirmReq && <ConfirmModal req={confirmReq} onClose={() => setConfirmReq(null)} />}

      {liveExec && (
        <LiveExecuteModal state={liveExec} onClose={() => setLiveExec(null)} />
      )}

      {showMosaic && (
        <HoldingsMosaicModal
          coins={heldCoins}
          prices={prices}
          timeframe={mosaicTf}
          entry={mosaicCache[mosaicTf]}
          loading={mosaicLoadingTf === mosaicTf}
          anyLoading={mosaicLoadingTf !== null}
          progress={mosaicProgress}
          onTimeframe={setMosaicTf}
          onReload={() => void loadMosaic(mosaicTf, true)}
          onClose={() => setShowMosaic(false)}
        />
      )}
    </>
  );
}

export default App;
