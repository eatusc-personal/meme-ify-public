import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BarChart3,
  Bell,
  BellOff,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Coins,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Gauge,
  LayoutGrid,
  ListChecks,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Wallet,
  Workflow,
  XCircle
} from "lucide-react";
import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { aiReview } from "./lib/claude";
import {
  scanMemecoins,
  lookupToken,
  checkSocialChatter,
  fetchPrices,
  fmtUsd,
  fmtAge,
  type MemeToken,
  type ScanResult,
  type ChatterResult
} from "./lib/markets";
import {
  defaultPaperState,
  runSellPass,
  runBuyPass,
  buyManual,
  sellManual,
  evaluatePositionWatch,
  portfolioStats,
  positionValue,
  tradeStats,
  sanityCheck,
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
  type TradeStats,
  type SanityFinding,
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
import {
  fetchHoldingsCharts,
  CHART_TIMEFRAMES,
  type ChartSeries,
  type ChartTimeframe
} from "./lib/charts";
import {
  connectPhantom,
  eagerConnectPhantom,
  disconnectPhantom,
  fetchSolBalance,
  fetchTokenBalance,
  fetchSwapDelta,
  fetchSolDelta,
  signAndSendBase64Tx,
  signAllBase64Txs
} from "./lib/wallet";
import {
  getQuote,
  getSwapTransaction,
  confirmSignature,
  sendRawTx,
  getMintDecimals,
  SOL_MINT,
  USDC_MINT,
  SOL_DECIMALS,
  USDC_DECIMALS,
  type JupiterQuote
} from "./lib/swap";
import { runSafetyGate, type SafetyCheck } from "./lib/safety";
import {
  fetchIntegrations,
  fetchCoinGeckoTrending,
  fetchMemecoinCategory,
  fetchSolanaUsdcFlow,
  type IntegrationEntry,
  type TrendingCoin,
  type MemecoinCategory,
  type StablecoinFlow
} from "./lib/integrations";
import {
  defaultLiveState,
  openLivePosition,
  sellLivePosition,
  decideLiveSellIntents,
  decideLiveBuyIntents,
  liveStats,
  liveValueUsd,
  livePriceUsd,
  baseSymbol,
  type LiveState,
  type LivePosition,
  type LiveBaseMint
} from "./lib/live";

type Tab = "memecoin" | "memecoin_flow";


const VALID_TABS: Tab[] = ["memecoin", "memecoin_flow"];

function readTabFromHash(): Tab {
  const fromHash = window.location.hash.slice(1);
  return (VALID_TABS as string[]).includes(fromHash) ? (fromHash as Tab) : "memecoin";
}

function showSystemPositionWatchNotification(body: string) {
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification("Meme coin position watch", { body });
    }
  } catch {
    /* OS notifications unavailable; the in-app alert still shows */
  }
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

// ---------------------------------------------------------------------------
// Meme Coin research tab. Separate sub-project, same dashboard.
// Full context lives in docs/ARCHITECTURE.md (read that file first when working here).
// ---------------------------------------------------------------------------

type ChatterState = { loading: boolean; data?: ChatterResult; error?: string };
type SortKey =
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
type Holding = { costUsd: number; pnlUsd: number; pnlPct: number };

function shortAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 5)}...${addr.slice(-4)}` : addr;
}

function signedUsd(n: number): string {
  return `${n >= 0 ? "+" : "-"}${fmtUsd(Math.abs(n))}`;
}

// A price for the confirmation-popup rows: $-prefixed, or "unknown" if absent.
function priceLabel(n: number): string {
  return n > 0 ? `$${fmtPrice(n)}` : "unknown";
}

// Hover tooltip for the closed-trades Reason pill. Maps the bare exit_reason
// string to a human-readable explanation, with the realized P&L appended so
// the reader sees the outcome alongside the cause.
function reasonTooltip(reason: string, pnl: number): string {
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

// A pending buy/sell confirmation. Set when the user clicks a manual Buy or
// Sell (paper or live); the action only fires from the modal's Confirm button.
type ConfirmRequest = {
  title: string;
  subtitle?: string;
  rows: { label: string; value: string }[];
  note?: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
};

// Confirmation popup shown before any manual buy or sell. Cancel or Confirm;
// Esc and a click on the backdrop both cancel. For live trades this gates the
// step before the live buy/sell modal even opens.
function ConfirmModal({ req, onClose }: { req: ConfirmRequest; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="mc-modal-overlay" onClick={onClose}>
      <div
        className="mc-modal mc-modal-confirm"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="mc-modal-head">
          <div>
            <strong>{req.title}</strong>
            {req.subtitle && <span>{req.subtitle}</span>}
          </div>
          <div className="mc-spacer" />
          <button className="mc-modal-close" onClick={onClose} aria-label="close">
            <XCircle size={20} />
          </button>
        </div>
        <div className="mc-modal-body">
          <dl className="mc-confirm-rows">
            {req.rows.map((r) => (
              <div key={r.label}>
                <dt>{r.label}</dt>
                <dd>{r.value}</dd>
              </div>
            ))}
          </dl>
          {req.note && <p className="mc-confirm-note">{req.note}</p>}
          <div className="mc-confirm-actions">
            <button className="ghost-button" onClick={onClose}>
              Cancel
            </button>
            <button
              className={req.danger ? "primary-button mc-danger" : "primary-button"}
              onClick={() => {
                req.onConfirm();
                onClose();
              }}
            >
              {req.confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Progress window for "Approve selected" on live intents (R2): one row per
// intent, updated as the batch builds, signs, broadcasts, confirms, records.
function LiveExecuteModal({
  state,
  onClose
}: {
  state: {
    rows: { id: string; label: string; status: string; detail?: string }[];
    running: boolean;
  };
  onClose: () => void;
}) {
  const done = state.rows.filter((r) => r.status === "done").length;
  const failed = state.rows.filter((r) => r.status === "failed").length;
  return (
    <div className="mc-modal-overlay">
      <div className="mc-modal" onClick={(e) => e.stopPropagation()}>
        <div className="mc-modal-head">
          <div>
            <strong>Approving live trades</strong>
            <span>
              {state.running
                ? "Real money. Approve the batch in Phantom when it pops up."
                : `Finished: ${done} executed, ${failed} not executed.`}
            </span>
          </div>
          <div className="mc-spacer" />
          {!state.running && (
            <button className="mc-modal-close" onClick={onClose} aria-label="close">
              <XCircle size={20} />
            </button>
          )}
        </div>
        <div className="mc-modal-body">
          <div className="mc-warn">
            Real Solana mainnet trades. The whole selected batch is signed in one
            Phantom approval, then each trade is broadcast and confirmed on-chain.
            A "failed" row was not executed (or could not be confirmed, check the
            note and Solscan).
          </div>
          <div className="mc-exec-rows">
            {state.rows.map((r) => (
              <div key={r.id} className={`mc-exec-row mc-exec-${r.status}`}>
                <span className="mc-exec-label">{r.label}</span>
                <span className="mc-exec-status">{r.status}</span>
                {r.detail && <span className="mc-exec-detail">{r.detail}</span>}
              </div>
            ))}
          </div>
          {!state.running && (
            <div className="mc-controls">
              <button className="primary-button" onClick={onClose}>
                Close
              </button>
            </div>
          )}
        </div>
      </div>
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

function MemeCoinCard({
  token,
  chatter,
  onChatter,
  onBuy,
  onBuyLive,
  walletConnected,
  liveHeld,
  livePending,
  holding,
  hidden,
  onHide,
  onUnhide,
  anchorId,
  highlight
}: {
  token: MemeToken;
  chatter: ChatterState | undefined;
  onChatter: () => void;
  onBuy: () => void;
  onBuyLive?: () => void;
  walletConnected?: boolean;
  liveHeld?: boolean;
  livePending?: boolean;
  holding?: Holding;
  hidden?: boolean;
  onHide?: () => void;
  onUnhide?: () => void;
  // Scroll anchor: set to the coin address so new-coin alerts can jump here via
  // getElementById. Only the research-list card sets it; the history modal
  // reuses MemeCoinCard without an id to avoid a duplicate element id.
  anchorId?: string;
  // Brief highlight pulse after an alert jump (see jumpToCoin).
  highlight?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const verdictClass =
    token.verdict === "exitable" ? "exitable" : token.verdict === "caution" ? "caution" : "trap";
  const chg = token.priceChange24h;
  // Defensive: a token from a scan cached before the rating fields existed
  // would be missing these. Fall back so the card never crashes.
  const sources = token.sources ?? [token.source];
  const rating = typeof token.rating === "number" ? token.rating : token.exitScore;
  const ratingBand = token.ratingBand ?? "F";

  function copyAddress() {
    navigator.clipboard?.writeText(token.address).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {
        /* clipboard blocked; the address is still visible to select manually */
      }
    );
  }

  return (
    <div
      className={`mc-card${highlight ? " mc-card-flash" : ""}`}
      id={anchorId}
    >
      <div className="mc-card-head">
        {token.imageUrl ? (
          <img className="mc-logo" src={token.imageUrl} alt="" />
        ) : (
          <div className="mc-logo" />
        )}
        <div className="mc-name">
          <strong>{token.symbol}</strong>
          <span>
            {token.name} · {token.dexId} ·{" "}
            {sources.length > 1 ? `${sources.length} sources` : token.source}
          </span>
        </div>
        <div className="mc-spacer" />
        <span className={`mc-verdict ${verdictClass}`}>{token.verdict}</span>
        <div className="mc-score">
          <strong>{rating}</strong>
          <span>
            rating {ratingBand} · exit {token.exitScore}
          </span>
        </div>
      </div>

      {holding && (
        <div className={`mc-holding ${holding.pnlUsd >= 0 ? "pos" : "neg"}`}>
          You hold this. {fmtUsd(holding.costUsd)} in, {signedUsd(holding.pnlUsd)} (
          {holding.pnlPct >= 0 ? "+" : ""}
          {holding.pnlPct.toFixed(0)}%) right now.
        </div>
      )}

      {token.isNewSinceLastScan ? (
        <div className="mc-momentum new">New since last scan</div>
      ) : token.momentumScore !== undefined ? (
        <div className={`mc-momentum ${token.momentumScore >= 0 ? "up" : "down"}`}>
          Since last scan: volume {(token.volMomentumPct ?? 0) >= 0 ? "+" : ""}
          {(token.volMomentumPct ?? 0).toFixed(0)}%, liquidity{" "}
          {(token.liqMomentumPct ?? 0) >= 0 ? "+" : ""}
          {(token.liqMomentumPct ?? 0).toFixed(0)}%
        </div>
      ) : null}

      <div className="mc-metrics">
        <div className="mc-metric">
          <span>Liquidity</span>
          <strong>{fmtUsd(token.liquidityUsd)}</strong>
        </div>
        <div className="mc-metric">
          <span>24h volume</span>
          <strong>{fmtUsd(token.volume24h)}</strong>
        </div>
        <div
          className="mc-metric"
          title="Turnover = 24h volume divided by liquidity. Roughly 0.5x to 10x is healthy two-sided trading. Above ~25x usually means wash trading or churn before a dump."
        >
          <span>Turnover</span>
          <strong>{token.volToLiq.toFixed(1)}x</strong>
        </div>
        <div className="mc-metric">
          <span>24h trades</span>
          <strong>
            {token.txns24h} ({token.buys24h}b / {token.sells24h}s)
          </strong>
        </div>
        <div className="mc-metric">
          <span>Age</span>
          <strong>{fmtAge(token.ageHours)}</strong>
        </div>
        <div className="mc-metric">
          <span>24h price</span>
          <strong className={chg >= 0 ? "mc-pos" : "mc-neg"}>
            {chg >= 0 ? "+" : ""}
            {chg.toFixed(1)}%
          </strong>
        </div>
        <div className="mc-metric">
          <span>Market cap</span>
          <strong>{fmtUsd(token.marketCap || token.fdv)}</strong>
        </div>
        {token.top10HoldersPct !== undefined && (
          <div
            className="mc-metric"
            title="Percent of supply held by the top 10 wallets, from the Jupiter audit. Above 30 to 40% is the consensus 'back away' threshold for memecoins. Edit the Max top-10 holders rule in Trading rules to change the live-buy block threshold."
          >
            <span>Top-10 holders</span>
            <strong
              className={
                token.top10HoldersPct >= 50
                  ? "mc-neg"
                  : token.top10HoldersPct >= 25
                    ? ""
                    : "mc-pos"
              }
            >
              {token.top10HoldersPct.toFixed(1)}%
            </strong>
          </div>
        )}
        {token.botRatio !== undefined && (
          <div
            className="mc-metric"
            title="Unique wallets divided by total 24h transactions, from the Jupiter audit. Below 2% blocks a live buy in the safety gate (sniper-pump signature); below 5% warns. A healthy organic memecoin is usually 10%+ here."
          >
            <span>Unique wallets</span>
            <strong
              className={
                token.botRatio < 0.02 ? "mc-neg" : token.botRatio < 0.05 ? "" : "mc-pos"
              }
            >
              {(token.botRatio * 100).toFixed(1)}%
              {token.jupiterHolderCount !== undefined
                ? ` (${token.jupiterHolderCount.toLocaleString()} holders)`
                : ""}
            </strong>
          </div>
        )}
        {(() => {
          // Holders/day = adoption velocity. A coin with 500 holders after 3 days
          // (~167/day) passes the absolute threshold but is much weaker than the
          // same 500 holders after 1 day (~500/day). Caps at 24h age to avoid
          // divide-by-zero on freshly-launched coins.
          if (token.jupiterHolderCount === undefined || token.ageHours <= 0) return null;
          const days = Math.max(token.ageHours / 24, 1 / 24);
          const hpd = token.jupiterHolderCount / days;
          return (
            <div
              className="mc-metric"
              title="Unique holders per day = jupiterHolderCount / (ageHours / 24). Adoption velocity. The green (>= 200/day) and red (< 50/day) cutoffs are PRELIMINARY: picked from research, not calibrated against your own outcomes. Treat the color as a hint, not a verdict, until a few weeks of algo2 trade data lets us tune the thresholds from actual win-rate."
            >
              <span>Holders/day</span>
              <strong className={hpd >= 200 ? "mc-pos" : hpd < 50 ? "mc-neg" : ""}>
                {hpd >= 1000 ? `${(hpd / 1000).toFixed(1)}k` : Math.round(hpd).toLocaleString()}
              </strong>
            </div>
          );
        })()}
      </div>

      {token.riskFlags.length > 0 && (
        <div className="mc-flags">
          {token.riskFlags.map((f) => (
            <div key={f} className="mc-flag">
              <AlertTriangle size={13} />
              <span>{f}</span>
            </div>
          ))}
        </div>
      )}

      <div className="mc-detail">
        <div className="mc-detail-col">
          <span className="mc-detail-label">Why it showed up</span>
          <p className="mc-detail-text">
            <span className="mc-channel">{token.discoveryChannel}</span>
            {token.discoveryReason}
          </p>
          <p className="mc-detail-meta">
            Discovered {new Date(token.discoveredAt).toLocaleString()}
          </p>
          <p className="mc-detail-meta">First traded {fmtAge(token.ageHours)} ago</p>
        </div>
        <div className="mc-detail-col">
          <span className="mc-detail-label">Where to trade</span>
          <p className="mc-detail-meta">
            Chain: {token.chainId} · liquidity pool on {token.dexId}
          </p>
          <div className="mc-contract">
            <code>{shortAddr(token.address)}</code>
            <button className="mc-copy" onClick={copyAddress}>
              <Copy size={12} />
              {copied ? "copied" : "copy CA"}
            </button>
          </div>
          <p className="mc-detail-meta">
            Wallet: Phantom, Solflare, or Backpack. Swap through Jupiter, which routes to
            Raydium / PumpSwap / Meteora.
          </p>
        </div>
      </div>

      <div className="mc-actions">
        <a className="small-button" href={token.tradeUrl} target="_blank" rel="noreferrer">
          <ExternalLink size={14} />
          Trade on Jupiter
        </a>
        <a className="small-button" href={token.url} target="_blank" rel="noreferrer">
          <ExternalLink size={14} />
          DexScreener chart
        </a>
        <button className="small-button" onClick={onBuy} disabled={!!holding}>
          <Plus size={14} />
          {holding ? "Holding" : "Buy (paper)"}
        </button>
        {onBuyLive && (
          <button
            className="small-button"
            onClick={onBuyLive}
            disabled={!walletConnected || liveHeld || livePending}
            title={
              !walletConnected
                ? "Connect Phantom in the wallet panel to enable live buys."
                : liveHeld
                  ? "You already hold this live. Sell the open position before buying again."
                  : livePending
                    ? "A buy for this coin is signing or confirming. Wait for it to finish."
                    : "Real money. Opens a quote modal; you approve in Phantom."
            }
          >
            <Plus size={14} />
            {liveHeld
              ? "Holding (live)"
              : livePending
                ? "Pending..."
                : "Buy (live)"}
          </button>
        )}
        <button className="small-button" onClick={onChatter} disabled={chatter?.loading}>
          <Search size={14} />
          {chatter?.loading ? "Checking..." : "Check X / Reddit chatter"}
        </button>
        {hidden
          ? onUnhide && (
              <button
                className="small-button"
                onClick={onUnhide}
                title="Bring this coin back to the Visible list."
              >
                <Eye size={14} />
                Unhide
              </button>
            )
          : onHide && (
              <button
                className="small-button"
                onClick={onHide}
                title="Hide this coin from the Visible list. Find it again under the Hidden tab."
              >
                <EyeOff size={14} />
                Hide
              </button>
            )}
      </div>

      {chatter && !chatter.loading && (
        <div className="mc-chatter">
          {chatter.error && <p className="danger-text">{chatter.error}</p>}
          {chatter.data && (
            <>
              <div className="mc-chatter-counts">
                <span className="mc-count">X: {chatter.data.byPlatform.x}</span>
                <span className="mc-count">Reddit: {chatter.data.byPlatform.reddit}</span>
                <span className="mc-count">Other: {chatter.data.byPlatform.other}</span>
              </div>
              {chatter.data.items.length === 0 ? (
                <p className="muted">
                  No recent posts found. Could mean the coin is too new, or that there is no organic
                  interest yet.
                </p>
              ) : (
                chatter.data.items.slice(0, 8).map((it) => (
                  <div key={it.url} className="mc-chatter-item">
                    <span className="plat">{it.platform}</span>
                    <a href={it.url} target="_blank" rel="noreferrer">
                      {it.title}
                    </a>
                  </div>
                ))
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Real-wallet connection: read-only. Connects a Phantom wallet and shows its
// address and SOL balance. No transactions here. See docs/ARCHITECTURE.md.
function WalletStrip({ onAddress }: { onAddress: (a: string | null) => void }) {
  const section = useCollapsibleSection("wallet");
  const [address, setAddress] = useState<string | null>(null);
  const [sol, setSol] = useState<number | null>(null);
  const [usdc, setUsdc] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Fetch SOL and USDC in parallel. SOL goes through the RPC's getBalance;
  // USDC is an SPL token, summed across all the owner's token accounts for
  // the USDC mint. Both reads are independent and one failing should not
  // hide the other.
  async function loadBalance(addr: string) {
    const [s, u] = await Promise.all([
      fetchSolBalance(addr),
      fetchTokenBalance(addr, USDC_MINT)
    ]);
    if (s.ok) setSol(s.sol);
    else setError(`SOL balance read failed: ${s.error}`);
    if (u.ok) setUsdc(u.amount);
    else setError((prev) => prev ?? `USDC balance read failed: ${u.error}`);
  }

  async function connect() {
    setBusy(true);
    setError(null);
    const res = await connectPhantom();
    if (res.ok) {
      connectedRef.current = true;
      setAddress(res.address);
      onAddress(res.address);
      await loadBalance(res.address);
    } else {
      setError(res.error);
    }
    setBusy(false);
  }

  async function disconnect() {
    await disconnectPhantom();
    connectedRef.current = false;
    setAddress(null);
    setSol(null);
    setUsdc(null);
    setError(null);
    onAddress(null);
  }

  // Silent eager-connect on mount. Phantom resolves with the public key if the
  // user has previously approved this site (in Phantom's Connected Apps list);
  // otherwise the promise rejects without showing any popup. Net effect: the
  // dashboard lights up "connected" automatically on page load with no click
  // and no approval prompt, exactly when the user has already authorized us.
  //
  // Phantom injects window.solana before React mounts in normal load order,
  // but we also catch the case where the extension isn't ready yet by deferring
  // one frame and re-trying once. Anything beyond that is a real "not trusted"
  // outcome; the user clicks Connect manually.
  // Ref tracks whether ANY connect path (eager OR manual) has already
  // succeeded, so the 500ms retry doesn't fire a redundant eagerConnect
  // after the user manually clicked Connect during the retry window
  // (or after the first eager pass already succeeded). Used by the
  // useEffect below; also set by `connect()` above.
  const connectedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    async function tryEager() {
      if (connectedRef.current) return;
      const res = await eagerConnectPhantom();
      if (cancelled || connectedRef.current) return;
      if (res.ok) {
        connectedRef.current = true;
        setAddress(res.address);
        onAddress(res.address);
        await loadBalance(res.address);
      }
    }
    void tryEager();
    // Second pass: if Phantom hadn't injected yet on the first call (rare but
    // possible on slow extension load), try once more after a short delay.
    // No-op if connect already succeeded (eager first pass or user clicked).
    const retry = setTimeout(() => {
      if (cancelled || connectedRef.current) return;
      void tryEager();
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(retry);
    };
    // Mount-once; onAddress is stable from the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className={`panel wide ${section.className}`}>
      <PanelTitle
        icon={Wallet}
        title="Wallet (real, non-custodial)"
        collapsed={section.collapsed}
        onToggle={section.toggle}
      />
      <p className="muted">
        Connect a Solana wallet to read its address and balance. Your private key stays inside
        Phantom and the dashboard never sees it. Real swaps are prepared by the app and shown in
        Phantom for explicit approval before they are signed. See docs/ARCHITECTURE.md, "Live
        trading boundary".
      </p>

      {!address ? (
        <div className="mc-controls">
          <button className="primary-button" onClick={connect} disabled={busy}>
            <Wallet size={16} />
            {busy ? "Connecting..." : "Connect Phantom wallet"}
          </button>
        </div>
      ) : (
        <>
          <div className="mc-metrics">
            <div className="mc-metric">
              <span>Connected address</span>
              <strong>{shortAddr(address)}</strong>
            </div>
            <div className="mc-metric">
              <span>SOL balance</span>
              <strong>{sol === null ? "..." : `${sol.toFixed(4)} SOL`}</strong>
            </div>
            <div className="mc-metric">
              <span>USDC balance</span>
              <strong>{usdc === null ? "..." : `${usdc.toFixed(2)} USDC`}</strong>
            </div>
          </div>
          <div className="mc-controls">
            <button className="ghost-button" onClick={() => loadBalance(address)} disabled={busy}>
              <RefreshCw size={15} />
              Refresh balances
            </button>
            <button className="ghost-button" onClick={disconnect}>
              Disconnect
            </button>
          </div>
        </>
      )}

      {error && <p className="danger-text">{error}</p>}
    </section>
  );
}

// Phase B real trading: SOL <-> USDC swap. Quote from Jupiter, sign in Phantom.
// SOL/USDC only on purpose, so the first real tests carry no rug risk.
function SwapPanel({ walletAddress }: { walletAddress: string | null }) {
  const section = useCollapsibleSection("swap");
  const [direction, setDirection] = useState<"sol-usdc" | "usdc-sol">("sol-usdc");
  const [amount, setAmount] = useState("0.03");
  const [quote, setQuote] = useState<JupiterQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [signing, setSigning] = useState(false);
  const [result, setResult] = useState<{ signature: string; status: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const inputIsSol = direction === "sol-usdc";
  const inputSym = inputIsSol ? "SOL" : "USDC";
  const outputSym = inputIsSol ? "USDC" : "SOL";
  const inputDecimals = inputIsSol ? SOL_DECIMALS : USDC_DECIMALS;
  const outputDecimals = inputIsSol ? USDC_DECIMALS : SOL_DECIMALS;
  const inputMint = inputIsSol ? SOL_MINT : USDC_MINT;
  const outputMint = inputIsSol ? USDC_MINT : SOL_MINT;

  function resetQuote() {
    setQuote(null);
    setResult(null);
    setError(null);
  }

  async function getQuoteClick() {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError("Enter an amount greater than zero.");
      return;
    }
    setQuoting(true);
    setError(null);
    setResult(null);
    const base = Math.floor(amt * Math.pow(10, inputDecimals));
    const res = await getQuote(inputMint, outputMint, base);
    if (res.ok) {
      setQuote(res.quote);
    } else {
      setQuote(null);
      setError(`Quote failed: ${res.error}`);
    }
    setQuoting(false);
  }

  async function signClick() {
    if (!walletAddress || !quote) return;
    setSigning(true);
    setError(null);
    const tx = await getSwapTransaction(quote.raw, walletAddress);
    if (!tx.ok) {
      setError(`Could not build the swap: ${tx.error}`);
      setSigning(false);
      return;
    }
    const sent = await signAndSendBase64Tx(tx.base64);
    if (!sent.ok) {
      setError(`Not sent: ${sent.error}`);
      setSigning(false);
      return;
    }
    setResult({ signature: sent.signature, status: "submitted, confirming..." });
    const conf = await confirmSignature(sent.signature);
    if (conf.ok) {
      setResult({ signature: sent.signature, status: conf.status });
    } else {
      setResult({ signature: sent.signature, status: "unconfirmed" });
      setError(conf.error);
    }
    setSigning(false);
  }

  const outHuman = quote ? Number(quote.outAmount) / Math.pow(10, outputDecimals) : 0;

  return (
    <section className={`panel wide ${section.className}`}>
      <PanelTitle
        icon={Coins}
        title="Swap (real money)"
        collapsed={section.collapsed}
        onToggle={section.toggle}
      />
      <div className="mc-warn">
        Real funds on Solana mainnet. Every swap is approved by you in the Phantom popup; the
        dashboard never signs. Phase B v1 is SOL and USDC only, on purpose, so the first tests
        carry no rug risk. Start with a tiny amount.
      </div>

      <div className="mc-controls">
        <button
          className={inputIsSol ? "primary-button" : "ghost-button"}
          onClick={() => {
            setDirection("sol-usdc");
            resetQuote();
          }}
        >
          SOL to USDC
        </button>
        <button
          className={!inputIsSol ? "primary-button" : "ghost-button"}
          onClick={() => {
            setDirection("usdc-sol");
            resetQuote();
          }}
        >
          USDC to SOL
        </button>
      </div>

      <div className="mc-settings">
        <label className="mc-setting">
          <span>Amount ({inputSym})</span>
          <input
            type="number"
            min={0}
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              resetQuote();
            }}
          />
        </label>
      </div>

      <div className="mc-controls">
        <button className="ghost-button" onClick={getQuoteClick} disabled={quoting || signing}>
          <RefreshCw size={15} />
          {quoting ? "Getting quote..." : "Get quote"}
        </button>
      </div>

      {quote && (
        <div className="mc-detail">
          <div className="mc-detail-col">
            <span className="mc-detail-label">Quote</span>
            <p className="mc-detail-text">
              Pay {amount} {inputSym}, receive about {outHuman.toFixed(inputIsSol ? 4 : 6)}{" "}
              {outputSym}.
            </p>
            <p className="mc-detail-meta">
              Price impact {(Number(quote.priceImpactPct) * 100).toFixed(3)}% · slippage limit 0.5%
            </p>
          </div>
          <div className="mc-detail-col">
            <span className="mc-detail-label">Sign</span>
            <p className="mc-detail-meta">
              {walletAddress
                ? "This builds the transaction and opens Phantom. You approve it there."
                : "Connect your wallet in the panel above first."}
            </p>
            <button
              className="primary-button"
              onClick={signClick}
              disabled={!walletAddress || signing}
            >
              {signing ? "Waiting for Phantom..." : "Review and sign in Phantom"}
            </button>
          </div>
        </div>
      )}

      {result && (
        <div className="mc-cyclelog">
          <strong>Swap {result.status}</strong>
          <div className="mc-logline mc-log-buy">Signature: {result.signature}</div>
          <div className="mc-logline">
            <a href={`https://solscan.io/tx/${result.signature}`} target="_blank" rel="noreferrer">
              View on Solscan
            </a>
          </div>
        </div>
      )}

      {error && <p className="danger-text">{error}</p>}
    </section>
  );
}

// Coin detail popup. Opened by clicking a ticker in the open positions or
// closed trades tables. Shows the live scan card if the coin is in the current
// scan, plus this wallet's full trade history for that coin. Dismissible.
// ---------------------------------------------------------------------------
// Holdings chart mosaic
//
// One small candlestick chart per open position, drawn into a single canvas so
// the whole portfolio can be eyeballed (and saved as a PNG) in one shot instead
// of opening each coin on DexScreener. Candle data comes from src/lib/charts.ts
// (DexScreener for the pool address, GeckoTerminal for the OHLCV).
// ---------------------------------------------------------------------------

type HeldCoin = {
  address: string;
  symbol: string;
  name: string;
  entryPriceUsd: number;
  side: "paper" | "live" | "paper+live";
};

// Collapse open paper + live positions to one row per coin. When a coin is
// held more than once the entry price is the token-amount-weighted average.
function buildHeldCoins(paper: PaperState, live: LiveState): HeldCoin[] {
  type Acc = {
    symbol: string;
    name: string;
    wpSum: number;
    wSum: number;
    paper: boolean;
    live: boolean;
  };
  const map = new Map<string, Acc>();
  for (const p of paper.positions) {
    if (p.status !== "open") continue;
    const e =
      map.get(p.address) ??
      { symbol: p.symbol, name: p.name, wpSum: 0, wSum: 0, paper: false, live: false };
    e.wpSum += p.entryPriceUsd * p.tokenAmount;
    e.wSum += p.tokenAmount;
    e.paper = true;
    map.set(p.address, e);
  }
  for (const p of live.positions) {
    if (p.status !== "open") continue;
    const e =
      map.get(p.mint) ??
      { symbol: p.symbol, name: p.name, wpSum: 0, wSum: 0, paper: false, live: false };
    e.wpSum += p.entryPriceUsd * p.entryTokenAmount;
    e.wSum += p.entryTokenAmount;
    e.live = true;
    map.set(p.mint, e);
  }
  const out: HeldCoin[] = [];
  for (const [address, e] of map) {
    out.push({
      address,
      symbol: e.symbol,
      name: e.name,
      entryPriceUsd: e.wSum > 0 ? e.wpSum / e.wSum : 0,
      side: e.paper && e.live ? "paper+live" : e.live ? "live" : "paper"
    });
  }
  return out;
}

// Compact price string that keeps precision on sub-cent memecoin prices.
function fmtPrice(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "n/a";
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return n.toLocaleString("en-US", { maximumSignificantDigits: 4 });
}

// Loaded candles per timeframe. Held in the MemeCoinPanel (not the modal) and
// mirrored to localStorage so the slow one-by-one load is done once and then
// kept: closing the mosaic, reopening it, or reloading the page all show the
// same cached snapshot until the user explicitly hits Reload.
type MosaicCacheEntry = { series: Record<string, ChartSeries>; loadedAt: string };
type MosaicCache = Partial<Record<ChartTimeframe, MosaicCacheEntry>>;

const MOSAIC_CACHE_KEY = "memeify-memecoin-mosaic-v1";

function readMosaicCache(): MosaicCache {
  try {
    const raw = localStorage.getItem(MOSAIC_CACHE_KEY);
    return raw ? (JSON.parse(raw) as MosaicCache) : {};
  } catch {
    return {};
  }
}

function writeMosaicCache(cache: MosaicCache): void {
  try {
    localStorage.setItem(MOSAIC_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* storage full or unavailable; the in-memory cache still works */
  }
}

// Estimated fee-per-fill assumption for the trade-stats block. A pure display
// preference (it does not affect the simulation), so it lives in localStorage
// rather than the paper account in Postgres.
const DEFAULT_FEE_PCT = 1;

// fee_pct is Postgres-only as of the 2026-05-24 "no-localStorage-for-settings"
// migration. The DEFAULT_FEE_PCT below is used as the initial-render fallback
// before hydration completes (~50-100ms on Supabase Postgres). The previous
// readFeePct / writeFeePct localStorage helpers were retired; their call
// sites now read DEFAULT_FEE_PCT on first paint and let hydration overwrite.
function readFeePct(): number {
  return DEFAULT_FEE_PCT;
}

// writeFeePct is a no-op kept for call-site compatibility. The persist effect
// covers fee_pct via the standard payload now.
function writeFeePct(_pct: number): void {
  /* no-op; see migration comment above */
}

// Trade queue localStorage cache. The queue and its on/off mode persist to
// Postgres (the paper_account row, via the hydration + persist effects);
// these helpers are only the pre-hydration cache, read on first render
// before the database load lands. No real money either way.
const TRADE_QUEUE_KEY = "memeify-memecoin-queue-v1";
const QUEUE_MODE_KEY = "memeify-memecoin-queuemode-v1";

function readTradeQueue(): TradeIntent[] {
  try {
    const raw = localStorage.getItem(TRADE_QUEUE_KEY);
    return raw ? (JSON.parse(raw) as TradeIntent[]) : [];
  } catch {
    return [];
  }
}

function writeTradeQueue(q: TradeIntent[]): void {
  try {
    localStorage.setItem(TRADE_QUEUE_KEY, JSON.stringify(q.slice(0, 100)));
  } catch {
    /* ignore */
  }
}

function readQueueMode(): boolean {
  try {
    return localStorage.getItem(QUEUE_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeQueueMode(on: boolean): void {
  try {
    localStorage.setItem(QUEUE_MODE_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

// New-coin pop-up bar. When a scan surfaces a coin that is new since the last
// scan AND clears this quality bar, fire one notification (in-app toast + OS
// pop-up, via pushAlert). Purely a notification gate — it never trades. The
// bar is browser-local (localStorage), like the other display settings here;
// there's no shared-account meaning to it. See notifyNewCoins in <App/>.
export type NewCoinBar = {
  enabled: boolean;
  bands: MemeToken["ratingBand"][];
  minLiquidityUsd: number;
  minVolume24h: number;
};

const NEWCOIN_BAR_KEY = "memeify-memecoin-newcoin-bar-v1";
const NEWCOIN_SEEN_KEY = "memeify-memecoin-newcoin-seen-v1";
// Don't re-alert the same coin within this window. A coin that drops off a
// scan and resurfaces later (genuinely re-discovered) can alert again.
const NEWCOIN_REALERT_MS = 6 * 60 * 60 * 1000;

const DEFAULT_NEWCOIN_BAR: NewCoinBar = {
  enabled: true,
  bands: ["A"],
  minLiquidityUsd: 50000,
  minVolume24h: 75000
};

function readNewCoinBar(): NewCoinBar {
  try {
    const raw = localStorage.getItem(NEWCOIN_BAR_KEY);
    if (!raw) return DEFAULT_NEWCOIN_BAR;
    const p = JSON.parse(raw);
    if (!p || typeof p !== "object") return DEFAULT_NEWCOIN_BAR;
    return {
      enabled: p.enabled !== false,
      bands: Array.isArray(p.bands) && p.bands.length > 0 ? p.bands : DEFAULT_NEWCOIN_BAR.bands,
      minLiquidityUsd:
        typeof p.minLiquidityUsd === "number" ? p.minLiquidityUsd : DEFAULT_NEWCOIN_BAR.minLiquidityUsd,
      minVolume24h:
        typeof p.minVolume24h === "number" ? p.minVolume24h : DEFAULT_NEWCOIN_BAR.minVolume24h
    };
  } catch {
    return DEFAULT_NEWCOIN_BAR;
  }
}

function writeNewCoinBar(bar: NewCoinBar): void {
  try {
    localStorage.setItem(NEWCOIN_BAR_KEY, JSON.stringify(bar));
  } catch {
    /* ignore */
  }
}

// Dedup ledger: address -> epoch ms of last alert. Persisted so a reload (or a
// fresh tab on this origin) doesn't re-alert coins already announced. Pruned to
// the re-alert window on every read so it can't grow without bound.
function readNewCoinSeen(): Record<string, number> {
  try {
    const raw = localStorage.getItem(NEWCOIN_SEEN_KEY);
    const p = raw ? JSON.parse(raw) : null;
    if (!p || typeof p !== "object") return {};
    const now = Date.now();
    const out: Record<string, number> = {};
    for (const [addr, ts] of Object.entries(p)) {
      if (typeof ts === "number" && now - ts < NEWCOIN_REALERT_MS) out[addr] = ts;
    }
    return out;
  } catch {
    return {};
  }
}

function writeNewCoinSeen(seen: Record<string, number>): void {
  try {
    localStorage.setItem(NEWCOIN_SEEN_KEY, JSON.stringify(seen));
  } catch {
    /* ignore */
  }
}

// Trading mode (paper / real). Postgres-backed via paper_account.trading_mode;
// this localStorage key is the pre-hydration cache so the top switch does not
// flicker on load.
const TRADING_MODE_KEY = "memeify-memecoin-mode-v1";

function readTradingMode(): "paper" | "real" {
  try {
    return localStorage.getItem(TRADING_MODE_KEY) === "real" ? "real" : "paper";
  } catch {
    return "paper";
  }
}

function writeTradingMode(mode: "paper" | "real"): void {
  try {
    localStorage.setItem(TRADING_MODE_KEY, mode);
  } catch {
    /* ignore */
  }
}

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

function drawHoldingsMosaic(
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

// Presentational only. The candle cache and the in-flight load live in the
// MemeCoinPanel, so this modal just draws whatever is cached for the selected
// timeframe and dispatches timeframe / reload actions upward.
function HoldingsMosaicModal({
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

function CoinPopup({
  address,
  token,
  positions,
  priceNow,
  holding,
  chatter,
  onChatter,
  onBuy,
  onClose
}: {
  // The mint address the popup was opened for. Always set (popupCoin upstream),
  // even when the coin isn't in the current scan and has no positions — needed
  // to build the DexScreener / Jupiter / Birdeye URLs for old closed trades
  // and for watchlist clicks where positions is empty.
  address: string;
  token: MemeToken | undefined;
  positions: PaperState["positions"];
  priceNow: number | undefined;
  holding?: Holding;
  chatter: ChatterState | undefined;
  onChatter: () => void;
  onBuy: () => void;
  onClose: () => void;
}) {
  const symbol = token?.symbol ?? positions[0]?.symbol ?? "Coin";
  const name = token?.name ?? positions[0]?.name ?? "";
  return (
    <div className="mc-modal-overlay" onClick={onClose}>
      <div className="mc-modal" onClick={(e) => e.stopPropagation()}>
        <div className="mc-modal-head">
          <div>
            <strong>{symbol}</strong>
            <span>{name}</span>
          </div>
          <div className="mc-spacer" />
          <button className="mc-modal-close" onClick={onClose} aria-label="close">
            <XCircle size={20} />
          </button>
        </div>
        <div className="mc-modal-body">
          {token ? (
            <MemeCoinCard
              token={token}
              holding={holding}
              chatter={chatter}
              onChatter={onChatter}
              onBuy={onBuy}
            />
          /* Buy (live) button is intentionally omitted from the popup view: the
             popup is a history detail, not a primary entry point, and we want
             live trades initiated from the live scan card with full context. */
          ) : (
            <>
              <p className="muted">
                {symbol} is not in the current scan, so there is no live scan card for it.
                {priceNow ? ` Last known price $${priceNow.toPrecision(4)}.` : ""} Run a scan to
                refresh the list, or use the chart link below to see the coin's current state on
                DexScreener / Jupiter.
              </p>
              {/* When the coin is no longer in the scan (typical for older closed
                  trades and for watchlist entries), the MemeCoinCard above isn't
                  rendered, so the user loses the chart/trade affordances it
                  provides. Reproduce the two most useful links here so any
                  popup can jump to the live DexScreener chart and Jupiter swap
                  page regardless of scan freshness. Mirrors the styling of the
                  MemeCoinCard action row. */}
              <div className="mc-actions" style={{ marginTop: 12 }}>
                <a
                  className="small-button"
                  href={`https://dexscreener.com/solana/${address}`}
                  target="_blank"
                  rel="noreferrer"
                  title="Open the live DexScreener chart for this coin"
                >
                  <ExternalLink size={14} />
                  DexScreener chart
                </a>
                <a
                  className="small-button"
                  href={`https://jup.ag/swap/USDC-${address}`}
                  target="_blank"
                  rel="noreferrer"
                  title="Open Jupiter to swap USDC for this coin"
                >
                  <ExternalLink size={14} />
                  Trade on Jupiter
                </a>
                <a
                  className="small-button"
                  href={`https://solscan.io/token/${address}`}
                  target="_blank"
                  rel="noreferrer"
                  title="Open Solscan token page (holders, transactions, transfers)"
                >
                  <ExternalLink size={14} />
                  Solscan
                </a>
              </div>
            </>
          )}
          {positions.length > 0 && (
            <>
              <h3 className="mc-subhead">
                Your {symbol} trades ({positions.length})
              </h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>Cost</th>
                      <th>Entry</th>
                      <th>Exit</th>
                      <th>P&amp;L</th>
                      <th>Opened</th>
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map((p) => (
                      <tr key={p.id}>
                        <td>{p.status}</td>
                        <td>{fmtUsd(p.costUsd)}</td>
                        <td>${p.entryPriceUsd.toPrecision(4)}</td>
                        <td>{p.exitPriceUsd ? `$${p.exitPriceUsd.toPrecision(4)}` : "open"}</td>
                        <td className={(p.pnlUsd ?? 0) >= 0 ? "mc-pos" : "mc-neg"}>
                          {p.pnlUsd != null ? signedUsd(p.pnlUsd) : "open"}
                        </td>
                        <td>{new Date(p.entryAt).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// One editable numeric rule: a plain-English description plus its input.
function RuleNum({
  label,
  desc,
  value,
  min,
  onChange
}: {
  label: string;
  desc: string;
  value: number;
  min: number;
  onChange: (v: number) => void;
}) {
  // Local draft string so the field can be cleared and freely retyped. The
  // committed numeric value updates only when the draft parses to a valid
  // number at or above `min`; an empty or below-min field is restored from
  // `value` on blur. The old code bound the input straight to `value`, so
  // clearing it (which reads as 0) was rejected and snapped back, making the
  // field impossible to edit by typing.
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  return (
    <div className="mc-rule">
      <div className="mc-rule-text">
        <strong>{label}</strong>
        <span>{desc}</span>
      </div>
      <input
        className="mc-rule-input"
        type="number"
        min={min}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          const v = Number(e.target.value);
          if (e.target.value.trim() !== "" && Number.isFinite(v) && v >= min) {
            onChange(v);
          }
        }}
        onBlur={() => {
          const v = Number(draft);
          if (draft.trim() === "" || !Number.isFinite(v) || v < min) {
            setDraft(String(value));
          }
        }}
      />
    </div>
  );
}

// The full rule book, shown below the closed trades. Editable rules have an
// input; the fixed position-watch rules are marked "automatic".
function TradingRules({
  settings,
  onUpdate,
  saveStatus
}: {
  settings: PaperSettings;
  onUpdate: (patch: Partial<PaperSettings>) => void;
  saveStatus: "saved" | "saving" | "error";
}) {
  const s = settings;
  return (
    <>
      <h3 className="mc-subhead" id="trading-rules">
        Trading rules
        <span className={`mc-save-status mc-save-${saveStatus}`}>
          {saveStatus === "saving"
            ? "Saving changes..."
            : saveStatus === "error"
              ? "Save failed - will retry"
              : "All changes saved"}
        </span>
      </h3>
      <p className="muted">
        Exactly what the bot does, with the current thresholds. Edit a value to change that rule.
        Manual "Buy (paper)" on a coin card always works regardless of the buy rules.
      </p>
      <div className="mc-rules">
        <div className="mc-rules-group">Buy, runs on each trade cycle</div>
        <div className="mc-rule">
          <div className="mc-rule-text">
            <strong>Auto-execute buys (execute mode only)</strong>
            <span>
              Controls the <em>paper execute</em> path: when off, the cycle's
              buy pass books nothing and emits "Auto-execute is off". <b>In queue
              mode (paper or live) this setting is ignored</b> — the cycle still
              proposes buy intents to the Trade queue and you approve each one
              by hand, which is the whole point of queue mode. To stop
              proposals entirely, turn queue mode off and turn this off too, or
              raise the buy gates (min exit score / liquidity / age / holders).
            </span>
          </div>
          <select
            className="mc-rule-input"
            value={s.autoTrade ? "on" : "off"}
            onChange={(e) => onUpdate({ autoTrade: e.target.value === "on" })}
          >
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </div>
        <RuleNum
          label="Minimum exit score"
          desc="Only buy coins scoring at least this (0 to 100)."
          value={s.minExitScore}
          min={0}
          onChange={(v) => onUpdate({ minExitScore: v })}
        />
        <RuleNum
          label="Minimum liquidity, USD"
          desc="Only buy coins whose pool holds at least this much."
          value={s.minLiquidityUsd}
          min={0}
          onChange={(v) => onUpdate({ minLiquidityUsd: v })}
        />
        <RuleNum
          label="Minimum age, hours"
          desc="Only buy coins at least this old. Roughly 95% of launches die in the first 24 to 72h, so an older coin with live volume has already survived that. Coins with an unknown age are not blocked."
          value={s.minAgeHours}
          min={0}
          onChange={(v) => onUpdate({ minAgeHours: v })}
        />
        <RuleNum
          label="Minimum unique holders"
          desc="Only buy coins whose Jupiter audit reports at least this many unique wallets. Bundle-launched coins (the 'MANIFEST pattern' of 10+ insider networks) are mechanically incompatible with hundreds of organic holders; 500 rejects most bundles while admitting day-1 coins that have started distributing. Coins outside the Jupiter enrichment window (unknown holder count) are not blocked. 0 disables."
          value={s.minHolderCount}
          min={0}
          onChange={(v) => onUpdate({ minHolderCount: v })}
        />
        <RuleNum
          label="Trade size, USD"
          desc="Fake cash spent per position."
          value={s.tradeSizeUsd}
          min={1}
          onChange={(v) => onUpdate({ tradeSizeUsd: v })}
        />
        <RuleNum
          label="Max open positions"
          desc="Stop buying once this many positions are open."
          value={s.maxOpenPositions}
          min={1}
          onChange={(v) => onUpdate({ maxOpenPositions: v })}
        />
        <RuleNum
          label="Re-entry cooldown, hours"
          desc="After a coin is sold, the cycle will not rebuy it for this many hours. Stops it from re-buying a coin in the same cycle it just took profit on. 0 disables. A coin that rugged is never rebought, regardless of this."
          value={s.reentryCooldownHours}
          min={0}
          onChange={(v) => onUpdate({ reentryCooldownHours: v })}
        />
        <RuleNum
          label="Daily loss limit, %"
          desc="Paper only. If today's realized P&L drops past this percent of starting cash, the cycle stops opening new paper positions until tomorrow. Selling is never blocked. 0 disables."
          value={s.dailyLossLimitPct}
          min={0}
          onChange={(v) => onUpdate({ dailyLossLimitPct: v })}
        />
        <RuleNum
          label="Live daily loss limit, USD"
          desc="Real money only. If today's realized live P&L is at or below the negative of this dollar amount, no live buys are proposed until tomorrow. 0 disables. For early real-money testing a tight value like 50 is sensible."
          value={s.liveDailyLossLimitUsd}
          min={0}
          onChange={(v) => onUpdate({ liveDailyLossLimitUsd: v })}
        />
        <RuleNum
          label="Max top-10 holders, %"
          desc="Block a live buy if Jupiter's audit reports the top 10 wallets hold more than this percent of supply. A coordinated exit from a handful of wallets can crash the price. Consensus default 35. 0 disables."
          value={s.maxTopHoldersPct}
          min={0}
          onChange={(v) => onUpdate({ maxTopHoldersPct: v })}
        />
        <RuleNum
          label="Dismissed re-propose threshold, rating points"
          desc="When you dismiss a buy from the Trade queue, the same coin is skipped on future cycles until its rating climbs by at least this many absolute points above the dismissed value (and a 1-hour anti-flap cooldown has passed). Default 10. 0 keeps dismissed coins blocked permanently until you manually buy or approve them."
          value={s.buyDismissalImprovementPoints}
          min={0}
          onChange={(v) => onUpdate({ buyDismissalImprovementPoints: v })}
        />

        <div className="mc-rules-group">Sell, runs on each trade cycle</div>
        <RuleNum
          label="Take profit, %"
          desc="Sell a position when it is up this much from entry."
          value={s.takeProfitPct}
          min={1}
          onChange={(v) => onUpdate({ takeProfitPct: v })}
        />
        <RuleNum
          label="Stop loss, %"
          desc="Stop a position out when it is down this much from entry."
          value={s.stopLossPct}
          min={1}
          onChange={(v) => onUpdate({ stopLossPct: v })}
        />
        <RuleNum
          label="Max hold, hours"
          desc="Sell a position once it has been held this long."
          value={s.maxHoldHours}
          min={1}
          onChange={(v) => onUpdate({ maxHoldHours: v })}
        />
        <RuleNum
          label="Trailing stop, %"
          desc="After the position has been up by at least the activation %, propose a sell if price falls this much from the peak ever seen. Locks in gains on a runner that retraces. 0 disables. Note: if take-profit is below 100% the position usually closes before the trail engages; raise take-profit to let runners ride and let the trail manage the exit."
          value={s.trailingStopPct}
          min={0}
          onChange={(v) => onUpdate({ trailingStopPct: v })}
        />
        <RuleNum
          label="Trailing stop activation, %"
          desc="Trailing stop only arms once the position has been up by at least this much from entry at some point. Default 25."
          value={s.trailingActivationPct}
          min={0}
          onChange={(v) => onUpdate({ trailingActivationPct: v })}
        />
        <div className="mc-rule">
          <div className="mc-rule-text">
            <strong>Liquidity death exit</strong>
            <span>Sell at once if the pool falls under $3,000 or stops returning a price.</span>
          </div>
          <span className="mc-rule-fixed">automatic</span>
        </div>

        <div className="mc-rules-group">Position watch, every 5 min on coins you hold</div>
        <div className="mc-rule">
          <div className="mc-rule-text">
            <strong>Run-up alert</strong>
            <span>Pop-up alert when a held position is up 50% from entry.</span>
          </div>
          <span className="mc-rule-fixed">automatic</span>
        </div>
        <div className="mc-rule">
          <div className="mc-rule-text">
            <strong>Scale out at 2x</strong>
            <span>Sell half when a held position is up 100%, let the rest ride.</span>
          </div>
          <span className="mc-rule-fixed">automatic</span>
        </div>
        <div className="mc-rule">
          <div className="mc-rule-text">
            <strong>Danger alert and safety exit</strong>
            <span>
              Warn on thin or fast-falling liquidity, dead volume, or a sudden dump; force-exit if
              liquidity is effectively gone.
            </span>
          </div>
          <span className="mc-rule-fixed">automatic</span>
        </div>
      </div>
    </>
  );
}

// Trade-activity counts and an estimated fee total, shown below the closed
// trades. Paper trading books no fees; the cost figures are a what-if estimate.
const REASON_LABELS: Record<string, string> = {
  "take profit": "Take-profit",
  "stop loss": "Stop-loss",
  "trailing stop": "Trailing stop",
  "max hold time": "Max hold",
  "liquidity dried up": "Liquidity death",
  "liquidity death (watch exit)": "Liquidity death (watch)",
  manual: "Manual"
};

function TradeStatsBlock({
  stats,
  feePct,
  onFeePct
}: {
  stats: TradeStats;
  feePct: number;
  onFeePct: (pct: number) => void;
}) {
  // Local draft so the fee field can be cleared and retyped, same pattern as
  // RuleNum.
  const [feeDraft, setFeeDraft] = useState(String(feePct));
  useEffect(() => {
    setFeeDraft(String(feePct));
  }, [feePct]);

  return (
    <>
      <h3 className="mc-subhead">Trade stats and estimated cost</h3>
      <p className="muted">
        Activity for this paper account (cleared on Reset). Paper trading books no fees, so the
        cost below is a what-if estimate of what the same trading would cost for real, at the fee
        rate you set. The estimate is a percent of each swap's size, which is how a Solana DEX pool
        fee works: it scales with trade size and with how often the bot trades.
      </p>

      <div className="mc-metrics">
        <div className="mc-metric">
          <span>Positions opened</span>
          <strong>{stats.opened}</strong>
        </div>
        <div className="mc-metric">
          <span>Still open</span>
          <strong>{stats.open}</strong>
        </div>
        <div className="mc-metric">
          <span>Closed</span>
          <strong>{stats.closed}</strong>
        </div>
        <div className="mc-metric">
          <span>Scaled out at 2x</span>
          <strong>{stats.scaledOut}</strong>
        </div>
        <div className="mc-metric">
          <span>Buys</span>
          <strong>{stats.buyFills}</strong>
        </div>
        <div className="mc-metric">
          <span>Sells</span>
          <strong>{stats.sellFills}</strong>
        </div>
        <div className="mc-metric">
          <span>Total fills</span>
          <strong>{stats.totalFills}</strong>
        </div>
      </div>

      {stats.byReason.length > 0 && (
        <div className="mc-metrics">
          {stats.byReason.map((r) => (
            <div className="mc-metric" key={r.reason}>
              <span>{REASON_LABELS[r.reason] ?? r.reason}</span>
              <strong>{r.count}</strong>
            </div>
          ))}
        </div>
      )}

      {stats.byAlgo.length > 0 && (
        <div className="mc-algo-block">
          <div className="mc-rules-group">Algorithm performance (closed trades)</div>
          <p className="muted">
            Per-algo win rate and realized P&amp;L over CLOSED paper trades. <code>algo1</code> = pre-2026-05-23
            (no holder gate, min age 24h). <code>algo2</code> = current defaults (min age 72h, min holders 500,
            wider Jupiter enrichment, safety auto-dismiss). <code>custom</code> = algo2 with your settings tweaked
            off-reference. The tag is derived from the settings snapshot at trade-open time, not stamped, so the
            label always matches the rules the trade actually ran under. Realized P&amp;L excludes partial
            (+100% scale-out) profits.
          </p>
          <div className="table-wrap">
            <table className="mc-algo-table">
              <thead>
                <tr>
                  <th>Algo</th>
                  <th>Closed</th>
                  <th>Wins</th>
                  <th>Win rate</th>
                  <th>Realized P&amp;L</th>
                  <th>Avg / trade</th>
                </tr>
              </thead>
              <tbody>
                {stats.byAlgo.map((a) => (
                  <tr key={a.algoVersion}>
                    <td>
                      <span className={`mc-algo-pill mc-algo-pill-${a.algoVersion}`}>
                        {a.algoVersion}
                      </span>
                    </td>
                    <td>{a.closed}</td>
                    <td>{a.wins}</td>
                    <td>{a.winRate.toFixed(0)}%</td>
                    <td className={a.pnlUsd >= 0 ? "mc-pos" : "mc-neg"}>
                      {a.pnlUsd >= 0 ? "+" : ""}
                      {fmtUsd(a.pnlUsd)}
                    </td>
                    <td className={a.avgPnlUsd >= 0 ? "mc-pos" : "mc-neg"}>
                      {a.avgPnlUsd >= 0 ? "+" : ""}
                      {fmtUsd(a.avgPnlUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="mc-rules">
        <div className="mc-rules-group">Estimated trading cost</div>
        <div className="mc-rule">
          <div className="mc-rule-text">
            <strong>Fee per fill, %</strong>
            <span>
              Assumed cost of each buy and each sell, as a percent of its size. Roughly 0.25% to 1%
              is typical for a Solana memecoin DEX pool; default 1%.
            </span>
          </div>
          <input
            className="mc-rule-input"
            type="number"
            min={0}
            step={0.05}
            value={feeDraft}
            onChange={(e) => {
              setFeeDraft(e.target.value);
              const v = Number(e.target.value);
              if (e.target.value.trim() !== "" && Number.isFinite(v) && v >= 0) {
                onFeePct(v);
              }
            }}
            onBlur={() => {
              const v = Number(feeDraft);
              if (feeDraft.trim() === "" || !Number.isFinite(v) || v < 0) {
                setFeeDraft(String(feePct));
              }
            }}
          />
        </div>
      </div>

      <div className="mc-metrics">
        <div className="mc-metric">
          <span>Volume traded</span>
          <strong>{fmtUsd(stats.volumeTradedUsd)}</strong>
        </div>
        <div className="mc-metric">
          <span>Estimated fees</span>
          <strong className="mc-neg">
            {stats.estFeesUsd > 0 ? `-${fmtUsd(stats.estFeesUsd)}` : "$0"}
          </strong>
        </div>
        <div className="mc-metric">
          <span>Realized P&amp;L (gross)</span>
          <strong className={stats.realizedGrossUsd >= 0 ? "mc-pos" : "mc-neg"}>
            {signedUsd(stats.realizedGrossUsd)}
          </strong>
        </div>
        <div className="mc-metric">
          <span>Realized P&amp;L (after est. fees)</span>
          <strong className={stats.realizedNetUsd >= 0 ? "mc-pos" : "mc-neg"}>
            {signedUsd(stats.realizedNetUsd)}
          </strong>
        </div>
      </div>
    </>
  );
}

// Build the plain-text brief sent to Claude for the AI review: the trading
// rules, the account state, and the recent closed trades.
function buildAiReviewPrompt(
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

// Results of the "Sanity check" button: a linted list of the trading rules,
// each finding coloured by severity. Errors are likely mistakes to fix,
// warnings are worth a look.
function SanityResults({
  findings,
  onDismiss
}: {
  findings: SanityFinding[];
  onDismiss: () => void;
}) {
  const errors = findings.filter((x) => x.level === "error").length;
  const warnings = findings.filter((x) => x.level === "warn").length;
  const summary =
    errors + warnings === 0
      ? "All clear, no problems found."
      : `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"} found.`;
  return (
    <div className="mc-sanity">
      <div className="mc-sanity-head">
        <strong>Sanity check</strong>
        <span>{summary}</span>
        <button className="ghost-button" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
      {findings.map((finding, i) => (
        <div key={i} className={`mc-sanity-item mc-sanity-${finding.level}`}>
          <strong>{finding.title}</strong>
          <span>{finding.detail}</span>
        </div>
      ))}
    </div>
  );
}

// Output of the "AI review" button: Claude's plain-language read on the
// trading rules and recent performance, via the /api/claude bridge.
function AiReviewResult({
  state,
  onDismiss
}: {
  state: { loading: boolean; text?: string; error?: string };
  onDismiss: () => void;
}) {
  return (
    <div className="mc-sanity">
      <div className="mc-sanity-head">
        <strong>AI review</strong>
        <span>
          {state.loading
            ? "Claude is reviewing your rules and recent trades, this can take a moment..."
            : state.error
              ? "Review failed."
              : "Claude's read on your setup. Not financial advice."}
        </span>
        {!state.loading && (
          <button className="ghost-button" onClick={onDismiss}>
            Dismiss
          </button>
        )}
      </div>
      {state.error && <p className="danger-text">{state.error}</p>}
      {state.text && <div className="mc-ai-review">{state.text}</div>}
    </div>
  );
}

// Build a minimal MemeToken from a held paper position. Used by the "Buy real"
// action so a coin that has scrolled out of the current scan can still be
// bought for real: only `address` actually drives the live buy (decimals, the
// Jupiter quote, and RugCheck all refetch from chain at buy time), the rest are
// display defaults seeded from the position's entry snapshot. Callers prefer
// the live scan token when the coin is still in it. See requestBuyRealFromPosition.
function tokenFromPaperPosition(pos: PaperPosition, priceNow: number): MemeToken {
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

// OS pop-up alerts (new Notification(...) in pushAlert) only fire when the
// browser notification permission for *this origin* is "granted". Permission
// is per-origin, so granting it on the HTTP :47391 dashboard does nothing for
// the HTTPS :8444 one, and a long-open tab where the watch was already ON
// never re-runs the toggle's request path. The result is silent: pushAlert's
// `if (permission === "granted")` just skips the pop-up and the in-app toast is
// the only sign anything fired. This button surfaces the state explicitly and
// gives the user a one-click way to grant it (requesting from a click is the
// reliable gesture browsers expect). It re-reads on window focus so flipping
// the site setting in browser prefs reflects here without a reload.
function NotifPermButton() {
  const supported = typeof Notification !== "undefined";
  const [perm, setPerm] = useState<NotificationPermission | "unsupported">(
    supported ? Notification.permission : "unsupported"
  );

  useEffect(() => {
    if (!supported) return;
    const sync = () => setPerm(Notification.permission);
    window.addEventListener("focus", sync);
    return () => window.removeEventListener("focus", sync);
  }, [supported]);

  if (!supported) return null;

  if (perm === "granted") {
    return (
      <>
        <button className="ghost-button" disabled title="Pop-up alerts are enabled for this site.">
          <Bell size={16} />
          Pop-up alerts: on
        </button>
        <button
          className="ghost-button"
          title="Send one local browser notification now."
          onClick={() =>
            showSystemPositionWatchNotification(
              `Test pop-up ${new Date().toLocaleTimeString()}`
            )
          }
        >
          Test pop-up
        </button>
      </>
    );
  }

  if (perm === "denied") {
    return (
      <button
        className="ghost-button"
        disabled
        title="Notifications are blocked for this site. Click the lock/site icon in the address bar, set Notifications to Allow, then reload. Also check macOS System Settings > Notifications for your browser."
      >
        <BellOff size={16} />
        Pop-up alerts: blocked
      </button>
    );
  }

  return (
    <button
      className="primary-button"
      title="Position-watch alerts can pop up as OS notifications. Click to allow them for this site."
      onClick={() => {
        Notification.requestPermission()
          .then((p) => setPerm(p))
          .catch(() => {});
      }}
    >
      <Bell size={16} />
      Enable pop-up alerts
    </button>
  );
}

// Configurable quality bar for new-coin pop-ups. A scan that surfaces a coin
// new since the last scan and clearing this bar fires one toast + OS pop-up
// (see notifyNewCoins). Browser-local; no shared-account meaning.
const NEWCOIN_ALL_BANDS: MemeToken["ratingBand"][] = ["A", "B", "C", "D", "F"];

function NewCoinBarButton() {
  const [bar, setBar] = useState<NewCoinBar>(readNewCoinBar);
  const onChange = (next: NewCoinBar) => {
    setBar(next);
    writeNewCoinBar(next);
  };
  const [open, setOpen] = useState(false);
  const label = bar.enabled
    ? `New-coin alerts: ${bar.bands.join("/")} · liq $${Math.round(
        bar.minLiquidityUsd / 1000
      )}k · vol $${Math.round(bar.minVolume24h / 1000)}k`
    : "New-coin alerts: off";
  return (
    <span style={{ position: "relative", display: "inline-block" }}>
      <button
        className={bar.enabled ? "primary-button" : "ghost-button"}
        title="Pop up when a scan surfaces a new coin clearing this quality bar."
        onClick={() => setOpen((o) => !o)}
      >
        <Bell size={16} />
        {label}
      </button>
      {open ? (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            zIndex: 50,
            background: "var(--panel, #1a1a1a)",
            border: "1px solid var(--border, #333)",
            borderRadius: 8,
            padding: 12,
            minWidth: 260,
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)"
          }}
        >
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <input
              type="checkbox"
              checked={bar.enabled}
              onChange={(e) => onChange({ ...bar, enabled: e.target.checked })}
            />
            Enable new-coin pop-ups
          </label>
          <div style={{ marginBottom: 8, fontSize: 12, opacity: 0.8 }}>Rating bands</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
            {NEWCOIN_ALL_BANDS.map((b) => (
              <label key={b} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <input
                  type="checkbox"
                  checked={bar.bands.includes(b)}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? Array.from(new Set([...bar.bands, b]))
                      : bar.bands.filter((x) => x !== b);
                    // Never allow an empty band set (would match nothing and
                    // silently disable alerts); keep at least the current one.
                    onChange({ ...bar, bands: next.length > 0 ? next : bar.bands });
                  }}
                />
                {b}
              </label>
            ))}
          </div>
          <label style={{ display: "block", fontSize: 12, opacity: 0.8, marginBottom: 4 }}>
            Min liquidity (USD)
          </label>
          <input
            type="number"
            value={bar.minLiquidityUsd}
            min={0}
            step={1000}
            onChange={(e) =>
              onChange({ ...bar, minLiquidityUsd: Math.max(0, Number(e.target.value) || 0) })
            }
            style={{ width: "100%", marginBottom: 10 }}
          />
          <label style={{ display: "block", fontSize: 12, opacity: 0.8, marginBottom: 4 }}>
            Min 24h volume (USD)
          </label>
          <input
            type="number"
            value={bar.minVolume24h}
            min={0}
            step={1000}
            onChange={(e) =>
              onChange({ ...bar, minVolume24h: Math.max(0, Number(e.target.value) || 0) })
            }
            style={{ width: "100%", marginBottom: 10 }}
          />
          <button className="ghost-button" onClick={() => setOpen(false)} style={{ width: "100%" }}>
            Done
          </button>
        </div>
      ) : null}
    </span>
  );
}

function PaperPanel({
  paper,
  prices,
  cycleLog,
  cycleRunning,
  autoRun,
  watchOn,
  onRunCycle,
  onToggleAuto,
  onToggleWatch,
  onUpdateSettings,
  onSell,
  sellingId,
  onBuyReal,
  walletConnected,
  onClearRearm,
  onReset,
  onTopUp,
  onShowCoin,
  onShowMosaic,
  feePct,
  onFeePct,
  saveStatus,
  tradingMode,
  closedExpanded,
  onSetClosedExpanded,
  onAddWatch,
  serverSchedulesWatch
}: {
  paper: PaperState;
  prices: PriceMap;
  cycleLog: { at: string; events: TradeEvent[] } | null;
  cycleRunning: boolean;
  autoRun: boolean;
  watchOn: boolean;
  onRunCycle: () => void;
  onToggleAuto: () => void;
  onToggleWatch: () => void;
  onUpdateSettings: (patch: Partial<PaperSettings>) => void;
  onSell: (positionId: string) => void;
  sellingId: string | null;
  // "Buy real" on an open-position row: opens the live USDC buy flow for the
  // held coin, pre-filled with the paper position's dollar size. Disabled when
  // no wallet is connected (the live buy modal needs one to sign).
  onBuyReal: (position: PaperPosition) => void;
  walletConnected: boolean;
  onClearRearm: (positionId: string) => void;
  onReset: () => void;
  onTopUp: () => void;
  onShowCoin: (address: string) => void;
  onShowMosaic: () => void;
  feePct: number;
  closedExpanded: boolean;
  onSetClosedExpanded: (v: boolean) => void;
  // "+ Watch" button on each closed-trades row uses this to pre-fill mint +
  // symbol + name and open a quick-add prompt. See PaperPanel closed-trades
  // table for the wire-up.
  onAddWatch: (args: {
    mint: string;
    symbol?: string | null;
    name?: string | null;
    targetPriceUsd: number;
    direction: "below" | "above";
    note?: string | null;
  }) => void;
  onFeePct: (pct: number) => void;
  saveStatus: "saved" | "saving" | "error";
  tradingMode: "paper" | "real";
  // True when the server-side scheduler is firing the watch tick; the panel
  // copy below adjusts to match so the user knows the cycle runs regardless
  // of whether the browser tab is open.
  serverSchedulesWatch: boolean;
}) {
  const paperSection = useCollapsibleSection("paper-trading");
  const stats = portfolioStats(paper, prices);
  const open = paper.positions.filter((p) => p.status === "open");
  const closed = paper.positions.filter((p) => p.status === "closed");
  const tStats = tradeStats(paper, feePct);
  const [sanity, setSanity] = useState<SanityFinding[] | null>(null);
  const [aiReviewState, setAiReviewState] = useState<{
    loading: boolean;
    text?: string;
    error?: string;
  } | null>(null);
  const [closedSearch, setClosedSearch] = useState("");
  const [closedPage, setClosedPage] = useState(0);
  // Collapsed by default for fresh users; current value comes from userPrefs
  // (Postgres-backed, follows the account across devices). Setter calls the
  // prop which routes through setUserPrefs in MemeCoinPanel. Was previously
  // localStorage-only — see the 2026-05-24 "no-localStorage-for-settings"
  // migration in docs/ARCHITECTURE.md. Wrap so callers can still use the functional
  // updater pattern setClosedExpanded(v => !v).
  const setClosedExpanded = (next: boolean | ((v: boolean) => boolean)) => {
    onSetClosedExpanded(typeof next === "function" ? next(closedExpanded) : next);
  };
  const CLOSED_PAGE_SIZE = 25;
  const closedQuery = closedSearch.trim().toLowerCase();
  const closedFiltered = closedQuery
    ? closed.filter(
        (p) =>
          p.symbol.toLowerCase().includes(closedQuery) ||
          p.name.toLowerCase().includes(closedQuery)
      )
    : closed;
  const closedPageCount = Math.max(1, Math.ceil(closedFiltered.length / CLOSED_PAGE_SIZE));
  const closedPageSafe = Math.min(Math.max(0, closedPage), closedPageCount - 1);
  const closedPageItems = closedFiltered.slice(
    closedPageSafe * CLOSED_PAGE_SIZE,
    closedPageSafe * CLOSED_PAGE_SIZE + CLOSED_PAGE_SIZE
  );

  // Open positions: ticker search + click-to-sort columns.
  const [openSearch, setOpenSearch] = useState("");
  const [openSort, setOpenSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(null);
  // Selling is confirmed in the ConfirmModal popup (onSell opens it), so the
  // Sell button here is a single click.
  const openQuery = openSearch.trim().toLowerCase();
  const openFiltered = openQuery
    ? open.filter(
        (p) =>
          p.symbol.toLowerCase().includes(openQuery) ||
          p.name.toLowerCase().includes(openQuery)
      )
    : open;
  const openSortVal = (p: PaperPosition, key: string): number | string => {
    if (key === "coin") return p.symbol.toLowerCase();
    if (key === "entry") return p.entryPriceUsd;
    if (key === "now") return prices[p.address]?.priceUsd ?? 0;
    if (key === "cost") return p.costUsd;
    if (key === "value") return positionValue(p, prices);
    if (key === "pnl") return positionValue(p, prices) - p.costUsd;
    if (key === "held") return new Date(p.entryAt).getTime();
    return 0;
  };
  const openView = openSort
    ? [...openFiltered].sort((a, b) => {
        const va = openSortVal(a, openSort.key);
        const vb = openSortVal(b, openSort.key);
        const cmp =
          typeof va === "string" && typeof vb === "string"
            ? va.localeCompare(vb)
            : Number(va) - Number(vb);
        return openSort.dir === "asc" ? cmp : -cmp;
      })
    : openFiltered;
  const toggleOpenSort = (key: string) => {
    setOpenSort((cur) =>
      cur && cur.key === key
        ? { key, dir: cur.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "coin" ? "asc" : "desc" }
    );
  };
  const sortTh = (key: string, label: string) => (
    <th>
      <button className="mc-sort-th" onClick={() => toggleOpenSort(key)}>
        {label}
        {openSort?.key === key ? (openSort.dir === "asc" ? " ↑" : " ↓") : ""}
      </button>
    </th>
  );

  return (
    <section className={`panel wide ${paperSection.className}`}>
      <PanelTitle
        icon={BarChart3}
        title="Paper trading (simulation)"
        collapsed={paperSection.collapsed}
        onToggle={paperSection.toggle}
      />
      <p className="muted">
        Fake money, no wallet, no keys, no real transactions. The system buys and sells against
        real live prices so the scoring strategy can be tested at zero risk. Real execution is never
        done here or by the agent. See docs/ARCHITECTURE.md, "Trading and execution boundary".
      </p>
      <p className="muted">
        Position watch (every 5 min while it is on): alerts on a +50% run-up, sells half at +100%,
        and flags positions at risk of going to zero (collapsing liquidity, dead volume, a sudden
        dump). Alerts pop up at the top right.{" "}
        {serverSchedulesWatch
          ? "Running on the server: ticks fire whether or not this browser tab is open. An open tab polls for new alert rows and can show OS pop-ups; if the browser is closed, missed alerts surface when you reopen."
          : "It needs the dev server running and this browser tab open."}
      </p>

      <div className="mc-metrics">
        <div className="mc-metric">
          <span>Equity</span>
          <strong>{fmtUsd(stats.equity)}</strong>
        </div>
        <div className="mc-metric">
          <span>Total P&amp;L</span>
          <strong className={stats.totalPnl >= 0 ? "mc-pos" : "mc-neg"}>
            {signedUsd(stats.totalPnl)}
          </strong>
        </div>
        <div className="mc-metric">
          <span>Realized</span>
          <strong className={stats.realized >= 0 ? "mc-pos" : "mc-neg"}>
            {signedUsd(stats.realized)}
          </strong>
        </div>
        <div className="mc-metric">
          <span>Unrealized</span>
          <strong className={stats.unrealized >= 0 ? "mc-pos" : "mc-neg"}>
            {signedUsd(stats.unrealized)}
          </strong>
        </div>
        <div className="mc-metric">
          <span>Cash</span>
          <strong>{fmtUsd(paper.cashUsd)}</strong>
        </div>
        <div className="mc-metric">
          <span>Open / closed</span>
          <strong>
            {stats.openCount} / {stats.closedCount}
          </strong>
        </div>
        <div className="mc-metric">
          <span>Win rate</span>
          <strong>
            {stats.closedCount ? `${stats.winRate.toFixed(0)}% (${stats.wins}/${stats.closedCount})` : "n/a"}
          </strong>
        </div>
      </div>

      <div className="mc-controls">
        <button className="primary-button" onClick={onRunCycle} disabled={cycleRunning}>
          <RefreshCw size={16} />
          {cycleRunning ? "Running cycle..." : "Run trade cycle now"}
        </button>
        <button
          className={autoRun ? "primary-button" : "ghost-button"}
          onClick={onToggleAuto}
          disabled={tradingMode === "real"}
          title={
            tradingMode === "real"
              ? "Paper automation is off in Real mode"
              : undefined
          }
        >
          {autoRun ? "Auto-run: ON (every 60 min)" : "Auto-run: OFF"}
        </button>
        <button
          className={watchOn ? "primary-button" : "ghost-button"}
          onClick={onToggleWatch}
          disabled={tradingMode === "real"}
          title={
            tradingMode === "real"
              ? "Paper automation is off in Real mode"
              : undefined
          }
        >
          {watchOn ? "Position watch: ON (5 min)" : "Position watch: OFF"}
        </button>
        <NotifPermButton />
        <NewCoinBarButton />
        <button className="ghost-button" onClick={() => setSanity(sanityCheck(paper))}>
          Sanity check
        </button>
        <button
          className="ghost-button"
          disabled={aiReviewState?.loading}
          onClick={async () => {
            setAiReviewState({ loading: true });
            const res = await aiReview(buildAiReviewPrompt(paper, stats, tStats));
            setAiReviewState(
              res.ok
                ? { loading: false, text: res.text }
                : { loading: false, error: res.error }
            );
          }}
        >
          {aiReviewState?.loading ? "AI reviewing..." : "AI review"}
        </button>
        <button className="ghost-button" onClick={onTopUp}>
          Add $1,000 cash
        </button>
        <button className="ghost-button" onClick={onReset}>
          Reset paper account
        </button>
      </div>

      {sanity && <SanityResults findings={sanity} onDismiss={() => setSanity(null)} />}

      {aiReviewState && (
        <AiReviewResult state={aiReviewState} onDismiss={() => setAiReviewState(null)} />
      )}

      {cycleLog && (
        <div className="mc-cyclelog">
          <strong>Last action {new Date(cycleLog.at).toLocaleTimeString()}</strong>
          {cycleLog.events.map((ev, i) => (
            <div key={i} className={`mc-logline mc-log-${ev.kind}`}>
              {ev.text}
            </div>
          ))}
        </div>
      )}

      <div className="mc-subhead-row">
        <h3 className="mc-subhead">
          Open positions (
          {openQuery ? `${openFiltered.length} of ${open.length}` : open.length})
        </h3>
        {open.length > 0 && (
          <input
            className="mc-rule-input mc-closed-search"
            type="text"
            placeholder="Search ticker"
            value={openSearch}
            onChange={(e) => setOpenSearch(e.target.value)}
          />
        )}
        {open.length > 0 && (
          <button className="ghost-button mc-mosaic-btn" onClick={onShowMosaic}>
            <LayoutGrid size={14} />
            Chart mosaic
          </button>
        )}
      </div>
      {open.length === 0 ? (
        <p className="empty">No open paper positions.</p>
      ) : openFiltered.length === 0 ? (
        <p className="empty">No open positions match "{openSearch}".</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {sortTh("coin", "Coin")}
                {sortTh("entry", "Entry")}
                {sortTh("now", "Now")}
                {sortTh("cost", "Cost")}
                {sortTh("value", "Value")}
                {sortTh("pnl", "P&L")}
                {sortTh("held", "Held")}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {openView.map((p) => {
                const now = prices[p.address]?.priceUsd ?? 0;
                const value = positionValue(p, prices);
                const pnl = value - p.costUsd;
                const pnlPct = p.costUsd > 0 ? (pnl / p.costUsd) * 100 : 0;
                return (
                  <tr key={p.id}>
                    <td>
                      <button
                        className="mc-tickerlink"
                        title="Open this coin"
                        onClick={() => onShowCoin(p.address)}
                      >
                        {p.symbol}
                      </button>
                      <small>
                        {p.name}
                        {p.tookHalfProfit ? " · half sold" : ""}
                        {p.dangerAlerted ? " · flagged" : ""}
                      </small>
                      {p.rearmPrice !== undefined && p.rearmDir && (
                        <div className="mc-rearm-tag">
                          <span>
                            re-armed {p.rearmDir === "floor" ? "↓" : "↑"} $
                            {fmtPrice(p.rearmPrice)}
                          </span>
                          <button
                            className="mc-rearm-clear"
                            title="Clear the re-arm: back to the normal sell rules"
                            onClick={() => onClearRearm(p.id)}
                          >
                            ✕
                          </button>
                        </div>
                      )}
                    </td>
                    <td>${p.entryPriceUsd.toPrecision(4)}</td>
                    <td>{now > 0 ? `$${now.toPrecision(4)}` : "no price"}</td>
                    <td>{fmtUsd(p.costUsd)}</td>
                    <td>{fmtUsd(value)}</td>
                    <td className={pnl >= 0 ? "mc-pos" : "mc-neg"}>
                      {signedUsd(pnl)} ({pnl >= 0 ? "+" : ""}
                      {pnlPct.toFixed(0)}%)
                    </td>
                    <td>{fmtAge((Date.now() - new Date(p.entryAt).getTime()) / 3.6e6)}</td>
                    <td>
                      <div className="mc-row-actions">
                        <button
                          className="small-button mc-buyreal-btn"
                          disabled={!walletConnected}
                          title={
                            walletConnected
                              ? `Buy ${p.symbol} for real with USDC from your wallet (defaults to ${fmtUsd(p.costUsd)}, the paper size). Opens the live buy flow; you sign in Phantom.`
                              : "Connect your Phantom wallet first to buy for real."
                          }
                          onClick={() => onBuyReal(p)}
                        >
                          Buy real
                        </button>
                        <button
                          className="small-button"
                          disabled={sellingId !== null}
                          onClick={() => onSell(p.id)}
                        >
                          {sellingId === p.id ? "Selling..." : "Sell"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {closed.length > 0 && (
        <>
          <div className="mc-subhead-row">
            <button
              type="button"
              className="mc-collapse-toggle"
              aria-expanded={closedExpanded}
              onClick={() => setClosedExpanded((v) => !v)}
              title={closedExpanded ? "Collapse closed trades" : "Expand closed trades"}
            >
              {closedExpanded ? (
                <ChevronDown size={16} aria-hidden />
              ) : (
                <ChevronRight size={16} aria-hidden />
              )}
              <h3 className="mc-subhead">
                Closed trades (
                {closedQuery && closedExpanded
                  ? `${closedFiltered.length} of ${closed.length}`
                  : closed.length}
                )
              </h3>
            </button>
            {closedExpanded && (
              <input
                className="mc-rule-input mc-closed-search"
                type="text"
                placeholder="Search ticker"
                value={closedSearch}
                onChange={(e) => {
                  setClosedSearch(e.target.value);
                  setClosedPage(0);
                }}
              />
            )}
          </div>
          {closedExpanded && (closedFiltered.length === 0 ? (
            <p className="empty">No closed trades match "{closedSearch}".</p>
          ) : (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Coin</th>
                      <th>Algo</th>
                      <th>Entry</th>
                      <th>Exit</th>
                      <th>Now</th>
                      <th>Cost</th>
                      <th>P&amp;L</th>
                      <th>Reason</th>
                      <th>Closed</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {closedPageItems.map((p) => {
                      const now = prices[p.address]?.priceUsd ?? 0;
                      const exit = p.exitPriceUsd ?? 0;
                      const algo = p.algoVersion ?? "algo1";
                      return (
                        <tr key={p.id}>
                          <td>
                            <button
                              className="mc-tickerlink"
                              title="Open this coin"
                              onClick={() => onShowCoin(p.address)}
                            >
                              {p.symbol}
                            </button>
                          </td>
                          <td>
                            <span
                              className={`mc-algo-pill mc-algo-pill-${algo}`}
                              title={`Trade opened under ${algo}. See the Algorithm performance block below for the comparison.`}
                            >
                              {algo}
                            </span>
                          </td>
                          <td>${p.entryPriceUsd.toPrecision(4)}</td>
                          <td>${exit.toPrecision(4)}</td>
                          <td className={now > exit ? "mc-pos" : now > 0 ? "mc-neg" : ""}>
                            {now > 0 ? `$${now.toPrecision(4)}` : "-"}
                          </td>
                          <td>{fmtUsd(p.costUsd)}</td>
                          <td className={(p.pnlUsd ?? 0) >= 0 ? "mc-pos" : "mc-neg"}>
                            {signedUsd(p.pnlUsd ?? 0)}
                          </td>
                          <td>
                            {(() => {
                              // Render the exit_reason as a colored pill. "Manual" is the
                              // most common reason but the least informative on its own —
                              // append a ↑/↓ arrow based on realized P&L so the reader sees
                              // profit-take vs loss-cut without reading the P&L column too.
                              // Other reasons render verbatim; the color reflects outcome.
                              const reason = p.exitReason ?? "unknown";
                              const pnl = p.pnlUsd ?? 0;
                              const kind = pnl > 0 ? "pos" : pnl < 0 ? "neg" : "flat";
                              const isManual = reason === "manual";
                              const display = isManual
                                ? `manual ${pnl > 0 ? "↑" : pnl < 0 ? "↓" : "="}`
                                : reason;
                              const tooltip = reasonTooltip(reason, pnl);
                              return (
                                <span
                                  className={`mc-exit-reason mc-exit-reason-${kind}`}
                                  title={tooltip}
                                >
                                  {display}
                                </span>
                              );
                            })()}
                          </td>
                          <td>{p.exitAt ? new Date(p.exitAt).toLocaleString() : ""}</td>
                          <td>
                            <button
                              className="ghost-button small-button"
                              title="Set a price alert on this coin (buy-back, breakout, etc.). Prompts for target price and direction; lands in the Watchlist panel."
                              onClick={() => {
                                const ref = now > 0 ? now : exit;
                                const suggested = ref > 0 ? (ref * 0.6).toPrecision(4) : "";
                                const raw = window.prompt(
                                  `Watch ${p.symbol} at what USD price?\n\n` +
                                    `Current: ${now > 0 ? "$" + now.toPrecision(4) : "no price"}\n` +
                                    `Exit:    $${exit.toPrecision(4)}\n\n` +
                                    `Defaulting to -40% from current ($${suggested}); edit to taste.\n` +
                                    `Prefix with > for "alert when price rises ABOVE" (e.g. >0.00020).`,
                                  suggested
                                );
                                if (!raw) return;
                                const direction = raw.trim().startsWith(">") ? "above" : "below";
                                const target = parseFloat(raw.trim().replace(/^>/, ""));
                                if (!Number.isFinite(target) || target <= 0) {
                                  window.alert("Invalid target price.");
                                  return;
                                }
                                onAddWatch({
                                  mint: p.address,
                                  symbol: p.symbol,
                                  name: p.name,
                                  targetPriceUsd: target,
                                  direction
                                });
                              }}
                            >
                              <Eye size={12} /> Watch
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {closedPageCount > 1 && (
                <div className="mc-pager">
                  <button
                    className="ghost-button"
                    disabled={closedPageSafe === 0}
                    onClick={() => setClosedPage(closedPageSafe - 1)}
                  >
                    Prev
                  </button>
                  <span>
                    Page {closedPageSafe + 1} of {closedPageCount} · {closedFiltered.length} trades
                  </span>
                  <button
                    className="ghost-button"
                    disabled={closedPageSafe >= closedPageCount - 1}
                    onClick={() => setClosedPage(closedPageSafe + 1)}
                  >
                    Next
                  </button>
                </div>
              )}
            </>
          ))}
        </>
      )}

      <TradeStatsBlock stats={tStats} feePct={feePct} onFeePct={onFeePct} />

      <TradingRules settings={paper.settings} onUpdate={onUpdateSettings} saveStatus={saveStatus} />
    </section>
  );
}

// Live trading buy modal. Seeded with a scanned coin; gets a Jupiter quote,
// runs the safety gate, asks Phantom to sign. The dashboard never signs and
// never custodies funds. On confirm, the actual on-chain fill is read back
// from the transaction (not the quoted fill) so the position is recorded
// honestly. See docs/ARCHITECTURE.md "Live trading".
function BuyLiveModal({
  token,
  walletAddress,
  maxTopHoldersPct,
  defaultAmountUsd,
  onConfirm,
  onSignStart,
  onSignEnd,
  onClose
}: {
  token: MemeToken;
  walletAddress: string;
  maxTopHoldersPct: number;
  // Optional pre-fill for the amount field (in USDC). Set when the buy is
  // launched from a held paper position so the real buy defaults to the paper
  // trade's size. The default base is USDC, so this maps straight to the field.
  defaultAmountUsd?: number;
  onConfirm: (args: {
    signature: string;
    baseMint: LiveBaseMint;
    baseAmountSpent: number;
    tokenAmountReceived: number;
    entryPriceUsdAtFill: number;
    buyPriceImpactPct: number;
    slippageBps: number;
  }) => void;
  onSignStart: () => void;
  onSignEnd: () => void;
  onClose: () => void;
}) {
  // Default to USDC: real-money buys and sells are denominated in USDC. SOL is
  // just for onboarding / gas. SOL stays selectable for the rare manual case.
  const [base, setBase] = useState<LiveBaseMint>(USDC_MINT);
  const [amount, setAmount] = useState(
    defaultAmountUsd && defaultAmountUsd > 0 ? String(defaultAmountUsd) : ""
  );
  const [slippagePct, setSlippagePct] = useState("1.5");
  const [decimals, setDecimals] = useState<number | null>(null);
  const [decimalsError, setDecimalsError] = useState<string | null>(null);
  const [quote, setQuote] = useState<JupiterQuote | null>(null);
  const [safety, setSafety] = useState<SafetyCheck | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const [signing, setSigning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDecimals(null);
    setDecimalsError(null);
    getMintDecimals(token.address).then((r) => {
      if (r.ok) setDecimals(r.decimals);
      else setDecimalsError(r.error);
    });
  }, [token.address]);

  function clearQuote() {
    setQuote(null);
    setSafety(null);
    setAcknowledged(false);
    setError(null);
  }

  async function fetchQuote() {
    clearQuote();
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError("Enter an amount greater than zero.");
      return;
    }
    // Clamp slippage to 10% hard maximum. A fat-finger 150% would open a
    // very wide sandwich window where the fill could land far below the
    // shown quote; Jupiter accepts very large slippage values.
    const slipBps = Math.max(1, Math.min(1000, Math.round(Number(slippagePct) * 100)));
    const baseDecimals = base === SOL_MINT ? SOL_DECIMALS : USDC_DECIMALS;
    const baseUnits = Math.floor(amt * Math.pow(10, baseDecimals));
    setQuoting(true);
    const q = await getQuote(base, token.address, baseUnits, slipBps);
    if (!q.ok) {
      setError(`Quote failed: ${q.error}`);
      setQuoting(false);
      return;
    }
    setQuote(q.quote);
    const safe = await runSafetyGate({
      tokenMint: token.address,
      baseMint: base,
      buyQuote: q.quote,
      acknowledgedHighImpact: false,
      maxTopHoldersPct
    });
    setSafety(safe);
    setQuoting(false);
  }

  async function sign() {
    if (!quote || !safety || decimals === null) return;
    setSigning(true);
    setError(null);
    // Mark the mint as in-flight so the scan card's Buy (live) button
    // refuses a second click while we wait for confirm. Cleared in every
    // exit path below via the `endSign` helper.
    onSignStart();
    const endSign = () => {
      setSigning(false);
      setProgress(null);
      onSignEnd();
    };
    setProgress("Building swap transaction...");
    const tx = await getSwapTransaction(quote.raw, walletAddress);
    if (!tx.ok) {
      setError(`Could not build the swap: ${tx.error}`);
      endSign();
      return;
    }
    setProgress("Waiting for Phantom approval...");
    const sent = await signAndSendBase64Tx(tx.base64);
    if (!sent.ok) {
      setError(`Not sent: ${sent.error}`);
      endSign();
      return;
    }
    setProgress(`Submitted, confirming ${sent.signature.slice(0, 10)}...`);
    const conf = await confirmSignature(sent.signature);
    if (!conf.ok) {
      setError(
        `Could not confirm: ${conf.error}. Check Solscan with the signature. If the swap landed, the position will not show in this ledger (there is no manual-entry screen); your on-chain wallet balance is the record.`
      );
      endSign();
      return;
    }
    setProgress("Reading on-chain fill...");
    const tokenDelta = await fetchSwapDelta(sent.signature, walletAddress, token.address);
    if (!tokenDelta.ok || tokenDelta.delta <= 0) {
      setError(
        `Swap confirmed (${sent.signature}) but the on-chain token fill could not be read (${
          tokenDelta.ok ? "delta=0" : tokenDelta.error
        }). Position not recorded; verify on Solscan.`
      );
      endSign();
      return;
    }
    // Base-side delta: NOT a silent fallback. If the read fails, the user
    // sees an error and the position is not recorded, the same standard
    // applied to the token-side read above. Falling back to the typed
    // amount was a Rule 4 violation (record must reflect actual fill).
    let baseSpent: number;
    if (base === SOL_MINT) {
      const s = await fetchSolDelta(sent.signature, walletAddress);
      if (!s.ok) {
        setError(
          `Swap confirmed (${sent.signature}) but the on-chain SOL debit could not be read: ${s.error}. Position not recorded; verify on Solscan.`
        );
        endSign();
        return;
      }
      baseSpent = Math.abs(s.delta);
    } else {
      const u = await fetchSwapDelta(sent.signature, walletAddress, USDC_MINT);
      if (!u.ok) {
        setError(
          `Swap confirmed (${sent.signature}) but the on-chain USDC debit could not be read: ${u.error}. Position not recorded; verify on Solscan.`
        );
        endSign();
        return;
      }
      baseSpent = Math.abs(u.delta);
    }
    // Entry price from the ACTUAL fill, not the modal-open scanned price.
    // USDC base: baseSpent itself is the USD value (ignoring the trivial
    // USDC depeg). SOL base: ask Jupiter for a spot SOL->USDC quote at the
    // actual SOL spent to get a snapshot rate at confirm time.
    setProgress("Pricing fill in USD...");
    let baseSpentUsd: number;
    if (base === USDC_MINT) {
      baseSpentUsd = baseSpent;
    } else {
      const solLamports = Math.max(1, Math.floor(baseSpent * 1e9));
      const usdQuote = await getQuote(SOL_MINT, USDC_MINT, solLamports);
      if (usdQuote.ok) {
        baseSpentUsd = Number(usdQuote.quote.outAmount) / Math.pow(10, USDC_DECIMALS);
      } else {
        // Last-resort: fall back to the scanned token price. This branch
        // is rare (Jupiter has to be down) and is the only path that uses
        // the stale scanned price; the recorded entry will be approximate.
        baseSpentUsd = token.priceUsd * tokenDelta.delta;
      }
    }
    const entryPriceUsdAtFill =
      tokenDelta.delta > 0 && baseSpentUsd > 0
        ? baseSpentUsd / tokenDelta.delta
        : token.priceUsd;
    const buyImpactPct = Math.abs(Number(quote.priceImpactPct ?? "0")) * 100;
    onConfirm({
      signature: sent.signature,
      baseMint: base,
      baseAmountSpent: baseSpent,
      tokenAmountReceived: tokenDelta.delta,
      entryPriceUsdAtFill,
      buyPriceImpactPct: buyImpactPct,
      slippageBps: Math.max(1, Math.min(1000, Math.round(Number(slippagePct) * 100)))
    });
    endSign();
  }

  const baseSym = base === SOL_MINT ? "SOL" : "USDC";
  const outHuman =
    quote && decimals !== null ? Number(quote.outAmount) / Math.pow(10, decimals) : 0;
  const effectiveLevel: "ok" | "warn" | "block" | null = safety
    ? safety.level === "warn" && acknowledged
      ? "ok"
      : safety.level
    : null;
  const canSign = quote && safety && effectiveLevel === "ok" && decimals !== null && !signing;

  return (
    <div className="mc-modal-overlay" onClick={onClose}>
      <div className="mc-modal" onClick={(e) => e.stopPropagation()}>
        <div className="mc-modal-head">
          <div>
            <strong>Buy {token.symbol} (live)</strong>
            <span>Real money. You sign every trade in Phantom.</span>
          </div>
          <div className="mc-spacer" />
          <button className="mc-modal-close" onClick={onClose} aria-label="close">
            <XCircle size={20} />
          </button>
        </div>
        <div className="mc-modal-body">
          <div className="mc-warn">
            Real Solana mainnet trade. The agent never signs and never holds keys. Every click here
            triggers a Phantom popup that you approve. Start with a small amount. Memecoins commonly
            lose 99%+ within hours.
          </div>

          {decimalsError && (
            <p className="danger-text">Could not read token decimals: {decimalsError}</p>
          )}

          <div className="mc-controls">
            <button
              className={base === SOL_MINT ? "primary-button" : "ghost-button"}
              onClick={() => {
                setBase(SOL_MINT);
                clearQuote();
              }}
            >
              Pay with SOL
            </button>
            <button
              className={base === USDC_MINT ? "primary-button" : "ghost-button"}
              onClick={() => {
                setBase(USDC_MINT);
                clearQuote();
              }}
            >
              Pay with USDC
            </button>
          </div>

          <div className="mc-settings">
            <label className="mc-setting">
              <span>Amount ({baseSym})</span>
              <input
                type="number"
                min={0}
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  clearQuote();
                }}
                placeholder="e.g. 0.05"
              />
            </label>
            <label className="mc-setting">
              <span>Slippage (%)</span>
              <input
                type="number"
                min={0.1}
                max={10}
                step={0.1}
                value={slippagePct}
                onChange={(e) => {
                  setSlippagePct(e.target.value);
                  clearQuote();
                }}
              />
            </label>
          </div>
          {Number(slippagePct) > 10 && (
            <p className="danger-text">
              Slippage above 10% will be clamped to 10%. Memecoin pools move fast but a wider window
              just hands more to MEV bots.
            </p>
          )}
          {Number(slippagePct) > 3 && Number(slippagePct) <= 10 && (
            <p className="danger-text">
              Slippage above 3% opens a wide sandwich window. Lower it if the pool is thin.
            </p>
          )}

          <div className="mc-controls">
            <button
              className="ghost-button"
              onClick={fetchQuote}
              disabled={quoting || signing || decimals === null}
            >
              <RefreshCw size={15} />
              {quoting ? "Quoting + safety..." : "Get quote and safety check"}
            </button>
          </div>

          {quote && (
            <div className="mc-detail">
              <div className="mc-detail-col">
                <span className="mc-detail-label">Quote</span>
                <p className="mc-detail-text">
                  Pay {amount} {baseSym}, expect about {outHuman.toPrecision(6)} {token.symbol}.
                </p>
                <p className="mc-detail-meta">
                  Buy price impact{" "}
                  {(Math.abs(Number(quote.priceImpactPct ?? "0")) * 100).toFixed(2)}% · slippage{" "}
                  {slippagePct}%
                </p>
              </div>
              {safety && (
                <div className="mc-detail-col">
                  <span className="mc-detail-label">Safety</span>
                  <p
                    className={
                      safety.level === "block"
                        ? "danger-text"
                        : safety.level === "warn"
                          ? "mc-detail-text"
                          : "mc-detail-meta"
                    }
                  >
                    <strong>
                      {safety.level === "ok"
                        ? "Passed"
                        : safety.level === "warn"
                          ? "Warning"
                          : "Blocked"}
                    </strong>
                  </p>
                  <ul className="mc-safety-reasons">
                    {safety.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                  <p className="mc-detail-meta">
                    Sellability sim:{" "}
                    {safety.sellSim.ok
                      ? `${safety.sellSim.priceImpactPct.toFixed(2)}% exit impact`
                      : `failed (${safety.sellSim.error})`}
                  </p>
                  <p className="mc-detail-meta">
                    RugCheck:{" "}
                    {safety.rugcheck.ok
                      ? `${safety.rugcheck.risks.length} risk${safety.rugcheck.risks.length === 1 ? "" : "s"}${safety.rugcheck.level ? `, level ${safety.rugcheck.level}` : ""}`
                      : `failed (${safety.rugcheck.error})`}
                  </p>
                  <p className="mc-detail-meta">
                    Jupiter:{" "}
                    {safety.jupiter.ok
                      ? safety.jupiter.found
                        ? `organic score ${safety.jupiter.organicScoreLabel ?? "n/a"}${
                            safety.jupiter.holderCount != null
                              ? `, ${safety.jupiter.holderCount} holders`
                              : ""
                          }${safety.jupiter.isVerified ? ", verified" : ""}`
                        : "no listing yet"
                      : `unavailable (${safety.jupiter.error})`}
                  </p>
                  {safety.level === "warn" && (
                    <label className="mc-ack">
                      <input
                        type="checkbox"
                        checked={acknowledged}
                        onChange={(e) => setAcknowledged(e.target.checked)}
                      />
                      <span>
                        I have read the warnings above and accept the risk. Proceed.
                      </span>
                    </label>
                  )}
                </div>
              )}
            </div>
          )}

          {canSign && (
            <div className="mc-controls">
              <button className="primary-button" onClick={sign} disabled={signing}>
                {signing ? "Waiting for Phantom..." : "Review and sign in Phantom"}
              </button>
            </div>
          )}

          {progress && <p className="mc-detail-meta">{progress}</p>}
          {error && <p className="danger-text">{error}</p>}
        </div>
      </div>
    </div>
  );
}

// Live trading sell modal. Seeded with an open live position; gets a Jupiter
// quote for token -> base, asks Phantom to sign. Defaults to selling the full
// position back to whichever base was used to buy, switchable.
function SellLiveModal({
  position,
  walletAddress,
  currentPriceUsd,
  onConfirm,
  onClose
}: {
  position: LivePosition;
  walletAddress: string;
  currentPriceUsd: number | undefined;
  onConfirm: (args: {
    signature: string;
    tokensSold: number;
    baseAmountReceived: number;
    exitPriceUsd: number;
    reason: string;
  }) => void;
  onClose: () => void;
}) {
  const [base, setBase] = useState<LiveBaseMint>(position.baseMint);
  const [tokenAmount, setTokenAmount] = useState(String(position.entryTokenAmount));
  const [slippagePct, setSlippagePct] = useState("1.5");
  const [decimals, setDecimals] = useState<number | null>(null);
  const [decimalsError, setDecimalsError] = useState<string | null>(null);
  const [quote, setQuote] = useState<JupiterQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [signing, setSigning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getMintDecimals(position.mint).then((r) => {
      if (r.ok) setDecimals(r.decimals);
      else setDecimalsError(r.error);
    });
  }, [position.mint]);

  function clearQuote() {
    setQuote(null);
    setError(null);
  }

  async function fetchQuote() {
    clearQuote();
    const amt = Number(tokenAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError("Enter a token amount greater than zero.");
      return;
    }
    if (decimals === null) {
      setError("Token decimals not loaded yet.");
      return;
    }
    // Clamp slippage to 10% hard maximum. Same reasoning as BuyLiveModal.
    const slipBps = Math.max(1, Math.min(1000, Math.round(Number(slippagePct) * 100)));
    const baseUnits = Math.floor(amt * Math.pow(10, decimals));
    setQuoting(true);
    const q = await getQuote(position.mint, base, baseUnits, slipBps);
    setQuoting(false);
    if (!q.ok) {
      setError(`Quote failed: ${q.error}. The pool may be too thin to exit; try a smaller size.`);
      return;
    }
    setQuote(q.quote);
  }

  async function sign() {
    if (!quote) return;
    setSigning(true);
    setError(null);
    setProgress("Building swap transaction...");
    const tx = await getSwapTransaction(quote.raw, walletAddress);
    if (!tx.ok) {
      setError(`Could not build the swap: ${tx.error}`);
      setSigning(false);
      setProgress(null);
      return;
    }
    setProgress("Waiting for Phantom approval...");
    const sent = await signAndSendBase64Tx(tx.base64);
    if (!sent.ok) {
      setError(`Not sent: ${sent.error}`);
      setSigning(false);
      setProgress(null);
      return;
    }
    setProgress(`Submitted, confirming ${sent.signature.slice(0, 10)}...`);
    const conf = await confirmSignature(sent.signature);
    if (!conf.ok) {
      setError(`Could not confirm: ${conf.error}. Verify with Solscan.`);
      setSigning(false);
      setProgress(null);
      return;
    }
    setProgress("Reading on-chain fill...");
    // Base-side delta: read it honestly or abort. Recording a sell with a
    // user-typed amount would falsify P&L; the live trade log must reflect
    // the actual on-chain credit.
    let baseReceived: number;
    if (base === SOL_MINT) {
      const s = await fetchSolDelta(sent.signature, walletAddress);
      if (!s.ok) {
        setError(
          `Swap confirmed (${sent.signature}) but the on-chain SOL credit could not be read: ${s.error}. Position not closed in the ledger; verify on Solscan.`
        );
        setSigning(false);
        setProgress(null);
        return;
      }
      baseReceived = Math.max(0, s.delta);
    } else {
      const u = await fetchSwapDelta(sent.signature, walletAddress, USDC_MINT);
      if (!u.ok) {
        setError(
          `Swap confirmed (${sent.signature}) but the on-chain USDC credit could not be read: ${u.error}. Position not closed in the ledger; verify on Solscan.`
        );
        setSigning(false);
        setProgress(null);
        return;
      }
      baseReceived = Math.max(0, u.delta);
    }
    // Exit price in USD: derive from the actual fill the same way the buy
    // does. For USDC base, the received USDC is the USD value. For SOL,
    // snapshot a SOL->USDC quote at confirm time and divide.
    let exitPriceUsd = currentPriceUsd ?? 0;
    const tokensSold = Number(tokenAmount);
    if (tokensSold > 0 && baseReceived > 0) {
      if (base === USDC_MINT) {
        exitPriceUsd = baseReceived / tokensSold;
      } else {
        const solLamports = Math.max(1, Math.floor(baseReceived * 1e9));
        const usdQuote = await getQuote(SOL_MINT, USDC_MINT, solLamports);
        if (usdQuote.ok) {
          const usdReceived = Number(usdQuote.quote.outAmount) / Math.pow(10, USDC_DECIMALS);
          exitPriceUsd = usdReceived / tokensSold;
        }
        // If the SOL/USD quote fails, exitPriceUsd stays at currentPriceUsd
        // (the last-known DexScreener reading), which is approximate but
        // honest about its source. The on-chain base amount is correct.
      }
    }
    onConfirm({
      signature: sent.signature,
      tokensSold,
      baseAmountReceived: baseReceived,
      exitPriceUsd,
      reason: "manual"
    });
  }

  const baseSym = base === SOL_MINT ? "SOL" : "USDC";
  const baseDecimals = base === SOL_MINT ? SOL_DECIMALS : USDC_DECIMALS;
  const outHuman = quote ? Number(quote.outAmount) / Math.pow(10, baseDecimals) : 0;
  const tokensHeld = position.entryTokenAmount;
  const tokensRequested = Number(tokenAmount);
  const tokensExceeded = tokensRequested > tokensHeld * 1.0001;

  return (
    <div className="mc-modal-overlay" onClick={onClose}>
      <div className="mc-modal" onClick={(e) => e.stopPropagation()}>
        <div className="mc-modal-head">
          <div>
            <strong>Sell {position.symbol} (live)</strong>
            <span>
              {tokensHeld.toPrecision(6)} {position.symbol} held; entry{" "}
              {position.entryBaseAmount.toFixed(position.baseMint === SOL_MINT ? 4 : 2)}{" "}
              {baseSymbol(position.baseMint)}
            </span>
          </div>
          <div className="mc-spacer" />
          <button className="mc-modal-close" onClick={onClose} aria-label="close">
            <XCircle size={20} />
          </button>
        </div>
        <div className="mc-modal-body">
          <div className="mc-warn">
            Real Solana mainnet trade. You approve in Phantom. Position closes only after the swap
            confirms.
          </div>
          {decimalsError && (
            <p className="danger-text">Could not read token decimals: {decimalsError}</p>
          )}

          <div className="mc-controls">
            <button
              className={base === SOL_MINT ? "primary-button" : "ghost-button"}
              onClick={() => {
                setBase(SOL_MINT);
                clearQuote();
              }}
            >
              Receive SOL
            </button>
            <button
              className={base === USDC_MINT ? "primary-button" : "ghost-button"}
              onClick={() => {
                setBase(USDC_MINT);
                clearQuote();
              }}
            >
              Receive USDC
            </button>
          </div>

          <div className="mc-settings">
            <label className="mc-setting">
              <span>Token amount</span>
              <input
                type="number"
                min={0}
                value={tokenAmount}
                onChange={(e) => {
                  setTokenAmount(e.target.value);
                  clearQuote();
                }}
              />
            </label>
            <label className="mc-setting">
              <span>Slippage (%)</span>
              <input
                type="number"
                min={0.1}
                max={10}
                step={0.1}
                value={slippagePct}
                onChange={(e) => {
                  setSlippagePct(e.target.value);
                  clearQuote();
                }}
              />
            </label>
          </div>
          {Number(slippagePct) > 10 && (
            <p className="danger-text">
              Slippage above 10% will be clamped to 10%.
            </p>
          )}
          {Number(slippagePct) > 3 && Number(slippagePct) <= 10 && (
            <p className="danger-text">
              Slippage above 3% opens a wide sandwich window. Lower it if the pool is thin.
            </p>
          )}
          {tokensExceeded && (
            <p className="danger-text">
              You only hold {tokensHeld.toPrecision(6)} {position.symbol}. The swap will likely
              fail.
            </p>
          )}
          {!tokensExceeded && tokensRequested > 0 && tokensRequested < tokensHeld * 0.9999 && (
            <p className="mc-detail-meta">
              Partial sell: {tokensRequested.toPrecision(6)} of {tokensHeld.toPrecision(6)}{" "}
              {position.symbol}. The remaining {(tokensHeld - tokensRequested).toPrecision(6)} stays
              open as a live position with its cost basis reduced proportionally.
            </p>
          )}

          <div className="mc-controls">
            <button
              className="ghost-button"
              onClick={fetchQuote}
              disabled={quoting || signing || decimals === null}
            >
              <RefreshCw size={15} />
              {quoting ? "Quoting..." : "Get quote"}
            </button>
            <button
              className="ghost-button"
              onClick={() => {
                setTokenAmount(String(tokensHeld));
                clearQuote();
              }}
              disabled={signing}
            >
              Use full balance
            </button>
          </div>

          {quote && (
            <div className="mc-detail">
              <div className="mc-detail-col">
                <span className="mc-detail-label">Quote</span>
                <p className="mc-detail-text">
                  Sell {tokenAmount} {position.symbol}, expect about {outHuman.toFixed(
                    base === SOL_MINT ? 6 : 4
                  )}{" "}
                  {baseSym}.
                </p>
                <p className="mc-detail-meta">
                  Price impact {(Math.abs(Number(quote.priceImpactPct ?? "0")) * 100).toFixed(2)}% ·
                  slippage {slippagePct}%
                </p>
              </div>
              <div className="mc-detail-col">
                <span className="mc-detail-label">Sign</span>
                <p className="mc-detail-meta">
                  This builds the transaction and opens Phantom. You approve there.
                </p>
                <button className="primary-button" onClick={sign} disabled={signing}>
                  {signing ? "Waiting for Phantom..." : "Review and sign in Phantom"}
                </button>
              </div>
            </div>
          )}

          {progress && <p className="mc-detail-meta">{progress}</p>}
          {error && <p className="danger-text">{error}</p>}
        </div>
      </div>
    </div>
  );
}

// Live trading panel. Real positions; wallet balance read from Phantom on
// connect and after every confirmed swap. The agent never executes; every
// row's Sell button opens a quote modal that requires a Phantom signature.
function LivePanel({
  live,
  prices,
  walletAddress,
  onSell,
  onShowCoin,
  onShowMosaic
}: {
  live: LiveState;
  prices: PriceMap;
  walletAddress: string | null;
  onSell: (pos: LivePosition) => void;
  onShowCoin: (mint: string) => void;
  onShowMosaic: () => void;
}) {
  const liveSection = useCollapsibleSection("live-trading");
  const stats = liveStats(live, prices);
  const open = live.positions.filter((p) => p.status === "open");
  const closed = live.positions.filter((p) => p.status === "closed");
  const [sol, setSol] = useState<number | null>(null);
  const [usdc, setUsdc] = useState<number | null>(null);
  const [balancesError, setBalancesError] = useState<string | null>(null);

  async function refreshBalances() {
    if (!walletAddress) return;
    const [s, u] = await Promise.all([
      fetchSolBalance(walletAddress),
      fetchTokenBalance(walletAddress, USDC_MINT)
    ]);
    if (s.ok) setSol(s.sol);
    else setBalancesError(`SOL balance read failed: ${s.error}`);
    if (u.ok) setUsdc(u.amount);
    else setBalancesError(`USDC balance read failed: ${u.error}`);
  }

  // Re-read balances when the wallet connects and whenever an open position
  // count changes (proxy for "a swap just confirmed"). Debounced 1s so a
  // burst of state changes from one batch-confirm (each confirm sets `live`
  // separately when going through the modal path) coalesces into one
  // SOL+USDC fetch instead of N.
  useEffect(() => {
    const id = setTimeout(() => {
      void refreshBalances();
    }, 1000);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress, open.length, closed.length]);

  return (
    <section id="live-positions" className={`panel wide ${liveSection.className}`}>
      <PanelTitle
        icon={Coins}
        title="Live trading (real money)"
        collapsed={liveSection.collapsed}
        onToggle={liveSection.toggle}
      />
      <div className="mc-warn">
        Real positions on Solana mainnet. You sign every buy and sell in Phantom. The agent never
        executes and never holds keys. Under 0.5% of pump.fun launches graduate; fewer than 5% of
        memecoins keep volume past 72 hours. Even a passed safety check does not make a coin safe.
        See docs/ARCHITECTURE.md, "Live trading".
      </div>

      {!walletAddress ? (
        <p className="empty">Connect a Phantom wallet in the panel above to enable live trading.</p>
      ) : (
        <>
          <div className="mc-metrics">
            <div className="mc-metric">
              <span>SOL balance</span>
              <strong>{sol === null ? "..." : sol.toFixed(4)}</strong>
            </div>
            <div className="mc-metric">
              <span>USDC balance</span>
              <strong>{usdc === null ? "..." : usdc.toFixed(2)}</strong>
            </div>
            <div className="mc-metric">
              <span>Open value (USD)</span>
              <strong>{fmtUsd(stats.openValueUsd)}</strong>
            </div>
            <div className="mc-metric">
              <span>Unrealized (USD)</span>
              <strong className={stats.unrealizedUsd >= 0 ? "mc-pos" : "mc-neg"}>
                {signedUsd(stats.unrealizedUsd)}
              </strong>
            </div>
            <div className="mc-metric">
              <span>Realized (USD)</span>
              <strong className={stats.realizedUsd >= 0 ? "mc-pos" : "mc-neg"}>
                {signedUsd(stats.realizedUsd)}
              </strong>
            </div>
            <div className="mc-metric">
              <span>Realized (base)</span>
              <strong className={stats.realizedBase >= 0 ? "mc-pos" : "mc-neg"}>
                {stats.realizedBase >= 0 ? "+" : ""}
                {stats.realizedBase.toFixed(4)}
              </strong>
            </div>
            <div className="mc-metric">
              <span>Open / closed</span>
              <strong>
                {stats.openCount} / {stats.closedCount}
              </strong>
            </div>
            <div className="mc-metric">
              <span>Win rate</span>
              <strong>
                {stats.closedCount
                  ? `${stats.winRate.toFixed(0)}% (${stats.wins}/${stats.closedCount})`
                  : "n/a"}
              </strong>
            </div>
          </div>

          <div className="mc-controls">
            <button className="ghost-button" onClick={refreshBalances}>
              <RefreshCw size={15} />
              Refresh balances
            </button>
          </div>

          {balancesError && <p className="danger-text">{balancesError}</p>}

          <div className="mc-subhead-row">
            <h3 className="mc-subhead">Open live positions ({open.length})</h3>
            {open.length > 0 && (
              <button className="ghost-button mc-mosaic-btn" onClick={onShowMosaic}>
                <LayoutGrid size={14} />
                Chart mosaic
              </button>
            )}
          </div>
          {open.length === 0 ? (
            <p className="empty">No open live positions.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Coin</th>
                    <th>Entry</th>
                    <th>Now</th>
                    <th>Paid</th>
                    <th>Value</th>
                    <th>P&amp;L</th>
                    <th>Opened</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {open.map((p) => {
                    const now = livePriceUsd(p, prices);
                    const valueUsd = liveValueUsd(p, prices);
                    const costUsd = p.entryTokenAmount * p.entryPriceUsd;
                    const pnl = valueUsd - costUsd;
                    const pnlPct = costUsd > 0 ? (pnl / costUsd) * 100 : 0;
                    return (
                      <tr key={p.id}>
                        <td>
                          <button
                            className="mc-tickerlink"
                            title="Open this coin"
                            onClick={() => onShowCoin(p.mint)}
                          >
                            {p.symbol}
                          </button>
                          <small>{p.name}</small>
                        </td>
                        <td>${p.entryPriceUsd.toPrecision(4)}</td>
                        <td>{now > 0 ? `$${now.toPrecision(4)}` : "no price"}</td>
                        <td>
                          {p.entryBaseAmount.toFixed(p.baseMint === SOL_MINT ? 4 : 2)}{" "}
                          {baseSymbol(p.baseMint)}
                        </td>
                        <td>{fmtUsd(valueUsd)}</td>
                        <td className={pnl >= 0 ? "mc-pos" : "mc-neg"}>
                          {signedUsd(pnl)} ({pnl >= 0 ? "+" : ""}
                          {pnlPct.toFixed(0)}%)
                        </td>
                        <td>{fmtAge((Date.now() - new Date(p.entryAt).getTime()) / 3.6e6)}</td>
                        <td>
                          <button className="small-button" onClick={() => onSell(p)}>
                            Sell (live)
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {closed.length > 0 && (
            <>
              <h3 className="mc-subhead">Closed live trades ({closed.length})</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Coin</th>
                      <th>Algo</th>
                      <th>Entry</th>
                      <th>Exit</th>
                      <th>Paid</th>
                      <th>Got back</th>
                      <th>P&amp;L (USD)</th>
                      <th>P&amp;L (base)</th>
                      <th>Reason</th>
                      <th>Closed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {closed.slice(0, 30).map((p) => {
                      const algo = p.algoVersion ?? "algo1";
                      return (
                      <tr key={p.id}>
                        <td>
                          <button
                            className="mc-tickerlink"
                            onClick={() => onShowCoin(p.mint)}
                          >
                            {p.symbol}
                          </button>
                        </td>
                        <td>
                          <span
                            className={`mc-algo-pill mc-algo-pill-${algo}`}
                            title={`Trade opened under ${algo}.`}
                          >
                            {algo}
                          </span>
                        </td>
                        <td>${p.entryPriceUsd.toPrecision(4)}</td>
                        <td>
                          {p.exitPriceUsd ? `$${p.exitPriceUsd.toPrecision(4)}` : "-"}
                        </td>
                        <td>
                          {p.entryBaseAmount.toFixed(p.baseMint === SOL_MINT ? 4 : 2)}{" "}
                          {baseSymbol(p.baseMint)}
                        </td>
                        <td>
                          {(p.exitBaseAmount ?? 0).toFixed(p.baseMint === SOL_MINT ? 4 : 2)}{" "}
                          {baseSymbol(p.baseMint)}
                        </td>
                        <td className={(p.pnlUsd ?? 0) >= 0 ? "mc-pos" : "mc-neg"}>
                          {signedUsd(p.pnlUsd ?? 0)}
                        </td>
                        <td className={(p.pnlBase ?? 0) >= 0 ? "mc-pos" : "mc-neg"}>
                          {(p.pnlBase ?? 0) >= 0 ? "+" : ""}
                          {(p.pnlBase ?? 0).toFixed(4)}
                        </td>
                        <td>{p.exitReason ?? ""}</td>
                        <td>{p.exitAt ? new Date(p.exitAt).toLocaleString() : ""}</td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}


// The trade queue: in queue mode the cycle proposes trades here for review.
// Tick the ones to approve, dismiss the rest, approve the selected batch in
// one action. This is the exact flow real-money trading will use.
// One editable row in the Trade queue. Buy rows expose an editable size and an
// optional limit price; sell rows expose a sell %. A sell row can also be
// re-armed: instead of approving or dismissing, hold the position and set a
// price level at which the queue re-proposes it.
function QueueRow({
  intent,
  selected,
  priceNow,
  safety,
  onToggle,
  onEdit,
  onDismiss,
  onRearm,
  onClearRearm,
  onShowCoin
}: {
  intent: TradeIntent;
  selected: boolean;
  priceNow: number | undefined;
  safety?: { loading: boolean; result?: SafetyCheck; error?: string };
  onToggle: () => void;
  onEdit: (patch: Partial<TradeIntent>) => void;
  onDismiss: () => void;
  onRearm: (magnitudePct: number, dir: "floor" | "ceil") => void;
  onClearRearm: () => void;
  onShowCoin: () => void;
}) {
  const isBuy = intent.kind === "buy";
  const [sizeDraft, setSizeDraft] = useState(String(intent.sizeUsd ?? ""));
  const [limitDraft, setLimitDraft] = useState(
    intent.limitPrice != null ? String(intent.limitPrice) : ""
  );
  const [pctDraft, setPctDraft] = useState(String(intent.sellPct ?? 100));
  // A sell that fired on a downside trigger defaults the re-arm to "price
  // falls"; an upside trigger (take-profit, scale-out) defaults to "price rises".
  const downTrigger =
    intent.trigger === "stop-loss" ||
    intent.trigger === "liquidity" ||
    intent.trigger === "max-hold";
  const [rearmOpen, setRearmOpen] = useState(false);
  const [rearmMag, setRearmMag] = useState("50");
  const [rearmDir, setRearmDir] = useState<"floor" | "ceil">(downTrigger ? "floor" : "ceil");
  const rearmMagNum = Number(rearmMag);
  const rearmLevel =
    priceNow && priceNow > 0 && Number.isFinite(rearmMagNum) && rearmMagNum >= 0
      ? rearmDir === "floor"
        ? priceNow * (1 - rearmMagNum / 100)
        : priceNow * (1 + rearmMagNum / 100)
      : 0;

  return (
    <>
      <tr>
        <td>
          <input type="checkbox" checked={selected} onChange={onToggle} />
        </td>
        <td className={isBuy ? "mc-pos" : "mc-neg"}>
          <strong>{isBuy ? "Buy" : "Sell"}</strong>
          {intent.account === "live" && <span className="mc-queue-live">LIVE</span>}
          {!isBuy && intent.trigger && (
            <div className="mc-queue-trigger">{intent.trigger}</div>
          )}
          {isBuy ? (
            <div className="mc-queue-edit">
              <label>
                Size $
                <input
                  type="number"
                  min={1}
                  value={sizeDraft}
                  onChange={(e) => {
                    setSizeDraft(e.target.value);
                    const v = Number(e.target.value);
                    if (e.target.value.trim() !== "" && Number.isFinite(v) && v >= 1) {
                      onEdit({ sizeUsd: v });
                    }
                  }}
                  onBlur={() => {
                    const v = Number(sizeDraft);
                    if (sizeDraft.trim() === "" || !Number.isFinite(v) || v < 1) {
                      setSizeDraft(String(intent.sizeUsd ?? ""));
                    }
                  }}
                />
              </label>
              <label>
                Limit $
                <input
                  type="number"
                  min={0}
                  placeholder="none"
                  value={limitDraft}
                  onChange={(e) => {
                    setLimitDraft(e.target.value);
                    if (e.target.value.trim() === "") {
                      onEdit({ limitPrice: undefined });
                      return;
                    }
                    const v = Number(e.target.value);
                    if (Number.isFinite(v) && v > 0) onEdit({ limitPrice: v });
                  }}
                />
              </label>
            </div>
          ) : (
            <div className="mc-queue-edit">
              <label>
                Sell %
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={pctDraft}
                  onChange={(e) => {
                    setPctDraft(e.target.value);
                    const v = Number(e.target.value);
                    if (
                      e.target.value.trim() !== "" &&
                      Number.isFinite(v) &&
                      v >= 1 &&
                      v <= 100
                    ) {
                      onEdit({ sellPct: v });
                    }
                  }}
                  onBlur={() => {
                    const v = Number(pctDraft);
                    if (pctDraft.trim() === "" || !Number.isFinite(v) || v < 1 || v > 100) {
                      setPctDraft(String(intent.sellPct ?? 100));
                    }
                  }}
                />
              </label>
            </div>
          )}
        </td>
        <td>
          <button
            className="mc-tickerlink"
            title="Open this coin's details"
            onClick={onShowCoin}
          >
            {intent.symbol}
          </button>
          <a
            className="mc-queue-chart"
            href={`https://dexscreener.com/solana/${intent.address}`}
            target="_blank"
            rel="noreferrer"
            title="Open the DexScreener chart for this coin"
          >
            Chart &#8599;
          </a>
        </td>
        <td>
          {intent.reason}
          {isBuy && safety && (
            <div
              className={`mc-queue-safety mc-queue-safety-${
                safety.loading || (!safety.result && !safety.error)
                  ? "pending"
                  : safety.error
                    ? "warn"
                    : safety.result
                      ? safety.result.level
                      : "pending"
              }`}
            >
              {safety.loading
                ? "Safety: checking RugCheck + sellability..."
                : safety.error
                  ? `Safety check unavailable: ${safety.error}`
                  : safety.result
                    ? `Safety: ${
                        safety.result.level === "ok"
                          ? "passed"
                          : safety.result.level === "warn"
                            ? "warning"
                            : "BLOCKED"
                      } — ${safety.result.reasons.slice(0, 2).join(" ")}`
                    : ""}
            </div>
          )}
        </td>
        <td>{new Date(intent.decidedAt).toLocaleTimeString()}</td>
        <td>
          <div className="mc-queue-actions">
            {!isBuy && intent.account !== "live" && (
              <button className="small-button" onClick={() => setRearmOpen((v) => !v)}>
                {rearmOpen ? "Cancel re-arm" : "Re-arm"}
              </button>
            )}
            {!isBuy && intent.account !== "live" && intent.trigger === "rearm" && (
              <button
                className="small-button"
                title="Drop the re-arm level, back to normal sell rules"
                onClick={onClearRearm}
              >
                Clear re-arm
              </button>
            )}
            <button className="small-button" onClick={onDismiss}>
              Dismiss
            </button>
          </div>
        </td>
      </tr>
      {!isBuy && rearmOpen && (
        <tr className="mc-queue-rearm">
          <td></td>
          <td colSpan={5}>
            <div className="mc-queue-rearm-box">
              <span>Don't sell. Re-arm: alert me again when price moves</span>
              <input
                type="number"
                min={0}
                value={rearmMag}
                onChange={(e) => setRearmMag(e.target.value)}
              />
              <span>%</span>
              <select
                value={rearmDir}
                onChange={(e) => setRearmDir(e.target.value as "floor" | "ceil")}
              >
                <option value="floor">down (price falls)</option>
                <option value="ceil">up (price rises)</option>
              </select>
              <span className="mc-queue-rearm-level">
                {rearmLevel > 0 ? `target $${fmtPrice(rearmLevel)}` : "no current price"}
              </span>
              <button
                className="small-button"
                disabled={!(rearmLevel > 0)}
                onClick={() => {
                  onRearm(rearmMagNum, rearmDir);
                  setRearmOpen(false);
                }}
              >
                Re-arm at this level
              </button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function TradeQueuePanel({
  queue,
  queueMode,
  settings,
  prices,
  safety,
  dismissedBuyIntents,
  onToggleMode,
  onApprove,
  onDismiss,
  onEditIntent,
  onRearm,
  onClearRearm,
  onShowCoin
}: {
  queue: TradeIntent[];
  queueMode: boolean;
  settings: PaperSettings;
  prices: PriceMap;
  safety: Record<string, { loading: boolean; result?: SafetyCheck; error?: string }>;
  // Used to explain an empty queue. When a buy intent is auto-dismissed by
  // the safety gate, the user can land on this panel via the "N trade
  // proposed" toast and see nothing. The empty state surfaces the recent
  // safety dismissals inline so the disappearance has a visible cause.
  dismissedBuyIntents: DismissedBuyIntent[];
  onToggleMode: () => void;
  onApprove: (ids: string[]) => void;
  onDismiss: (id: string) => void;
  onEditIntent: (id: string, patch: Partial<TradeIntent>) => void;
  onRearm: (id: string, magnitudePct: number, dir: "floor" | "ceil") => void;
  onClearRearm: (positionId: string) => void;
  onShowCoin: (address: string) => void;
}) {
  const section = useCollapsibleSection("trade-queue");
  const s = settings;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectedCount = queue.filter((q) => selected.has(q.id)).length;
  return (
    <section className={`panel wide ${section.className}`} id="trade-queue">
      <PanelTitle
        icon={ListChecks}
        title={queue.length > 0 ? `Trade queue (${queue.length} waiting)` : "Trade queue"}
        collapsed={section.collapsed}
        onToggle={section.toggle}
      />
      <p className="muted">
        Queue mode routes the bot's buy and sell decisions here for review
        instead of executing them. Tick the ones you want, dismiss the rest,
        and approve the selected batch in one action. This is the exact flow
        real-money trading will use; for now it books paper trades, the
        real-money version swaps the approve step for one Phantom signature.
      </p>
      <div className="mc-queue-explain">
        <strong>What gets queued each cycle</strong>
        <p>
          <b>Buys</b> — a scanned coin that clears the buy rules: exit score at
          least {s.minExitScore}, liquidity at least {fmtUsd(s.minLiquidityUsd)},
          age at least {s.minAgeHours}h, at least {s.minHolderCount} unique
          holders when Jupiter has the data, a coin you do not already hold,
          not in the re-entry cooldown, and an open slot.
        </p>
        <p>
          <b>Sells</b> — an open position that hits an exit: liquidity collapse
          under $3k, the +100% scale-out (sell half), take profit at +
          {s.takeProfitPct}%, stop loss at -{s.stopLossPct}%, or max hold at{" "}
          {s.maxHoldHours}h.
        </p>
        <p>
          Edit any row before approving: a buy's size or a limit price, a sell's
          %. On a sell you can also <b>Re-arm</b> instead of approving or
          dismissing, which holds the position and re-proposes it only when
          price reaches a level you set. In queue mode the position watch
          proposes sells here too and never auto-sells.
        </p>
      </div>
      <div className="mc-controls">
        <button
          className={queueMode ? "primary-button" : "ghost-button"}
          onClick={onToggleMode}
        >
          {queueMode ? "Queue mode: ON" : "Queue mode: OFF"}
        </button>
        <button
          className="primary-button"
          disabled={selectedCount === 0}
          onClick={() => {
            onApprove([...selected]);
            setSelected(new Set());
          }}
        >
          Approve selected ({selectedCount})
        </button>
      </div>
      {!queueMode && (
        <p className="muted">
          Queue mode is off, so the trade cycle executes paper trades directly.
          Turn it on to route them here for review first.
        </p>
      )}
      {queue.length === 0 ? (
        (() => {
          // When the queue is empty, surface any recent safety-gate auto-dismissals
          // inline. Without this, a user clicking the "N trade proposed" toast lands
          // on an empty queue with no context for what happened to their trades.
          // Window: 5 minutes, matches the position-watch cadence so a recently
          // ticked cycle's dismissals are always visible.
          const RECENT_WINDOW_MS = 5 * 60 * 1000;
          const cutoff = Date.now() - RECENT_WINDOW_MS;
          const recentAuto = dismissedBuyIntents.filter(
            (d) =>
              d.source === "auto-safety-block" &&
              new Date(d.dismissedAt).getTime() >= cutoff
          );
          if (recentAuto.length === 0) {
            return (
              <p className="empty">
                Queue is empty. With queue mode on, run a trade cycle and the bot's
                proposed trades appear here for review.
              </p>
            );
          }
          return (
            <div className="empty mc-queue-recent-dismiss">
              <p>
                <strong>Queue is empty.</strong> The safety gate auto-dismissed{" "}
                {recentAuto.length} proposed trade{recentAuto.length === 1 ? "" : "s"}{" "}
                in the last 5 minutes. If you arrived here from the "N trade
                proposed" toast, this is why nothing's here to review.
              </p>
              <ul className="mc-queue-recent-dismiss-list">
                {recentAuto.slice(0, 10).map((d) => (
                  <li key={`${d.address}-${d.dismissedAt}`}>
                    <strong>{d.symbol}</strong>
                    {d.reason ? <span> &mdash; {d.reason}</span> : null}
                    <span className="muted">
                      {" "}({new Date(d.dismissedAt).toLocaleTimeString()})
                    </span>
                  </li>
                ))}
                {recentAuto.length > 10 && (
                  <li className="muted">
                    + {recentAuto.length - 10} more, see the Alerts log for the
                    full record.
                  </li>
                )}
              </ul>
            </div>
          );
        })()
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Trade</th>
                <th>Coin</th>
                <th>Why the bot proposed it</th>
                <th>Proposed</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {queue.map((q) => (
                <QueueRow
                  key={q.id}
                  intent={q}
                  selected={selected.has(q.id)}
                  priceNow={prices[q.address]?.priceUsd}
                  safety={safety[q.address]}
                  onToggle={() => toggle(q.id)}
                  onEdit={(patch) => onEditIntent(q.id, patch)}
                  onDismiss={() => onDismiss(q.id)}
                  onRearm={(mag, dir) => onRearm(q.id, mag, dir)}
                  onClearRearm={() => q.positionId && onClearRearm(q.positionId)}
                  onShowCoin={() => onShowCoin(q.address)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// The pump-trigger log: coins that ran up 50%+, each with a social-media scan
// of what may have caused it. Built by logPumps() in MemeCoinPanel.
function PumpTriggersPanel({
  events,
  onShowCoin
}: {
  events: PumpEvent[];
  onShowCoin: (address: string) => void;
}) {
  const section = useCollapsibleSection("pump-triggers");
  // Paged so the section stays compact; matches the closed-positions pager.
  const PAGE_SIZE = 10;
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(events.length / PAGE_SIZE));
  const pageSafe = Math.min(Math.max(0, page), pageCount - 1);
  const paged = events.slice(pageSafe * PAGE_SIZE, pageSafe * PAGE_SIZE + PAGE_SIZE);

  return (
    <section className={`panel wide ${section.className}`}>
      <PanelTitle
        icon={Sparkles}
        title="Pump triggers"
        collapsed={section.collapsed}
        onToggle={section.toggle}
      />
      <p className="muted">
        When a coin you hold crosses +50% from entry, or a scanned coin is up
        50%+ over 24h, the tool runs one social-media scan to capture what may
        have triggered it. A research log of what moves coins. Each coin is
        logged once per day; stored locally in this browser.
      </p>
      {events.length === 0 ? (
        <p className="empty">
          No pump triggers logged yet. They appear after a held position spikes
          or a scan turns up a big mover.
        </p>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Coin</th>
                  <th>Detected</th>
                  <th>Trigger</th>
                  <th>Social chatter</th>
                </tr>
              </thead>
              <tbody>
                {paged.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <button
                        className="mc-tickerlink"
                        title="Open this coin"
                        onClick={() => onShowCoin(e.address)}
                      >
                        {e.symbol}
                      </button>
                    </td>
                    <td>{new Date(e.detectedAt).toLocaleString()}</td>
                    <td>{e.trigger}</td>
                    <td>
                      {e.chatter
                        ? e.chatter.total === 0
                          ? "no posts found"
                          : `${e.chatter.total} posts (${e.chatter.byPlatform.x} X, ${e.chatter.byPlatform.reddit} Reddit)`
                        : `social scan failed${e.chatterError ? `: ${e.chatterError}` : ""}`}
                      {e.chatter && e.chatter.items[0] && (
                        <>
                          {" · "}
                          <a href={e.chatter.items[0].url} target="_blank" rel="noreferrer">
                            top post
                          </a>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pageCount > 1 && (
            <div className="mc-pager">
              <button
                className="ghost-button"
                disabled={pageSafe === 0}
                onClick={() => setPage(pageSafe - 1)}
              >
                Prev
              </button>
              <span>
                Page {pageSafe + 1} of {pageCount} · {events.length} events
              </span>
              <button
                className="ghost-button"
                disabled={pageSafe >= pageCount - 1}
                onClick={() => setPage(pageSafe + 1)}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// Integrations status panel. Reads /api/integrations every 30s and renders
// a compact list: one row per external service the Meme Coin tab depends on.
// Green dot = configured + healthy, amber = configured but no health signal
// yet (still starting up or never called), red = configured but failing, grey
// = missing env var. Lets the user verify at a glance that PumpPortal is
// streaming, CoinGecko is reachable, Helius is wired, etc., without digging
// in the dev-server logs.
// Watchlist panel: user-set price alerts. The position-watch tick fires
// when any active row's target hits. Triggered rows stay in the list as
// history; user can "Re-arm" (clears triggered_at) or "Remove" to clean up.
//
// Add flow: inline form at the top takes mint + target $ + direction.
// Also wired from the closed-trades row in PaperPanel (a "+ Watch" button
// that pre-fills mint+symbol) for the common "re-enter at a dip" workflow.
function WatchlistPanel({
  watchlist,
  prices,
  onAdd,
  onDelete,
  onResetTrigger,
  onShowCoin
}: {
  watchlist: WatchlistEntry[];
  prices: PriceMap;
  onAdd: (args: {
    mint: string;
    symbol?: string | null;
    name?: string | null;
    targetPriceUsd: number;
    direction: "below" | "above";
    note?: string | null;
  }) => void;
  onDelete: (id: string) => void;
  onResetTrigger: (id: string) => void;
  onShowCoin: (address: string) => void;
}) {
  const section = useCollapsibleSection("watchlist");
  const [addMint, setAddMint] = useState("");
  const [addTarget, setAddTarget] = useState("");
  const [addDir, setAddDir] = useState<"below" | "above">("below");
  const active = watchlist.filter((w) => w.triggeredAt == null);
  const triggered = watchlist.filter((w) => w.triggeredAt != null);

  function handleAdd() {
    const mint = addMint.trim();
    const target = parseFloat(addTarget);
    if (!mint) return;
    if (!Number.isFinite(target) || target <= 0) return;
    onAdd({ mint, targetPriceUsd: target, direction: addDir });
    setAddMint("");
    setAddTarget("");
    setAddDir("below");
  }

  return (
    <section id="watchlist" className={`panel wide ${section.className}`}>
      <PanelTitle
        icon={Eye}
        title={
          watchlist.length === 0
            ? "Watchlist"
            : `Watchlist (${active.length} active${triggered.length > 0 ? `, ${triggered.length} triggered` : ""})`
        }
        collapsed={section.collapsed}
        onToggle={section.toggle}
      />
      <p className="muted">
        Price alerts for any coin, whether you currently hold it or not. The position-watch tick
        (every 5 min when Watch is ON) fetches prices for every active row; when a target is hit
        a toast fires and the row moves to "Triggered." Use this to set buy-back levels on coins
        you've already closed, or to flag coins you're interested in before they appear in your
        scan.
      </p>
      <div className="mc-watch-addrow">
        <input
          type="text"
          placeholder="Mint address (paste from the Look up box or DexScreener URL)"
          value={addMint}
          onChange={(e) => setAddMint(e.target.value)}
          className="mc-rule-input"
          style={{ flex: 2 }}
        />
        <input
          type="number"
          placeholder="Target USD price"
          value={addTarget}
          onChange={(e) => setAddTarget(e.target.value)}
          step="any"
          min="0"
          className="mc-rule-input"
          style={{ flex: 1 }}
        />
        <select
          value={addDir}
          onChange={(e) => setAddDir(e.target.value === "above" ? "above" : "below")}
          className="mc-rule-input"
        >
          <option value="below">Below (dip alert)</option>
          <option value="above">Above (breakout alert)</option>
        </select>
        <button className="primary-button" onClick={handleAdd}>
          <Plus size={14} /> Add watch
        </button>
      </div>

      {watchlist.length === 0 ? (
        <p className="empty">
          No watches yet. Add one above, or use the "+ Watch" button on any closed-trades row to
          set a buy-back alert.
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Coin</th>
                <th>Target</th>
                <th>Direction</th>
                <th>Current</th>
                <th>Status</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {watchlist.map((w) => {
                const current = prices[w.mint]?.priceUsd ?? 0;
                const triggered = w.triggeredAt != null;
                return (
                  <tr key={w.id} className={triggered ? "mc-watchrow-triggered" : ""}>
                    <td>
                      <button
                        className="mc-tickerlink"
                        onClick={() => onShowCoin(w.mint)}
                        title="Open coin details + buy"
                      >
                        {w.symbol ?? w.mint.slice(0, 8) + "…"}
                      </button>
                    </td>
                    <td>${w.targetPriceUsd.toPrecision(4)}</td>
                    <td>{w.direction === "below" ? "↓ below" : "↑ above"}</td>
                    <td>{current > 0 ? `$${current.toPrecision(4)}` : <span className="muted">no data</span>}</td>
                    <td>
                      {triggered ? (
                        <span className="mc-watch-status-triggered">
                          triggered at ${(w.triggeredPrice ?? 0).toPrecision(4)}
                        </span>
                      ) : (
                        <span className="mc-watch-status-active">active</span>
                      )}
                    </td>
                    <td className="muted">{new Date(w.createdAt).toLocaleString()}</td>
                    <td style={{ display: "flex", gap: 6 }}>
                      {triggered && (
                        <button
                          className="ghost-button small-button"
                          onClick={() => onResetTrigger(w.id)}
                          title="Re-arm: clear the trigger so this watch fires again next time the price hits."
                        >
                          Re-arm
                        </button>
                      )}
                      <button
                        className="ghost-button small-button"
                        onClick={() => onDelete(w.id)}
                        aria-label="remove watch"
                      >
                        <XCircle size={13} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function IntegrationsPanel() {
  const section = useCollapsibleSection("integrations");
  const [items, setItems] = useState<IntegrationEntry[]>([]);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  async function reload() {
    setRefreshing(true);
    try {
      const list = await fetchIntegrations();
      setItems(list);
      setLoadedAt(new Date().toISOString());
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void reload();
    const id = setInterval(() => void reload(), 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <section id="integrations" className={`panel wide ${section.className}`}>
      <PanelTitle
        icon={Activity}
        title="Integrations"
        collapsed={section.collapsed}
        onToggle={section.toggle}
      />
      <p className="muted">
        Live health of every external service the Meme Coin tab depends on. Refreshes every 30s; clicking
        Reload forces a check now. A row in red means the service is configured but the last call failed,
        which usually means a transient upstream blip or an expired key. A row in grey is not configured
        (paste the env var in <code>.env.local</code> and restart the dev server).
      </p>
      <div className="mc-controls">
        <button className="ghost-button" onClick={() => void reload()} disabled={refreshing}>
          <RefreshCw size={14} />
          {refreshing ? "Checking..." : "Reload"}
        </button>
        {loadedAt && (
          <span className="muted" style={{ fontSize: 12 }}>
            Last check {new Date(loadedAt).toLocaleTimeString()}
          </span>
        )}
      </div>
      <div className="mc-integrations-list">
        {items.length === 0 ? (
          <p className="empty">No integrations reported yet. The dev server may still be starting up.</p>
        ) : (
          items.map((it) => {
            const s = it.status;
            const dotKind = !s.configured
              ? "off"
              : s.healthy === true
                ? "ok"
                : s.healthy === false
                  ? "err"
                  : "warn";
            const dotLabel =
              dotKind === "off"
                ? "not configured"
                : dotKind === "ok"
                  ? "healthy"
                  : dotKind === "err"
                    ? "failing"
                    : "no signal yet";
            const messages = pumpPortalExtras(it);
            return (
              <div key={it.key} className={`mc-integration mc-integration-${dotKind}`}>
                <div className="mc-integration-head">
                  <span className={`mc-integration-dot mc-integration-dot-${dotKind}`} title={dotLabel} />
                  <strong>{it.label}</strong>
                  <span className="mc-integration-env">
                    <code>{it.envVar}</code>
                  </span>
                  {it.docs && (
                    <a href={it.docs} target="_blank" rel="noopener noreferrer" className="mc-integration-docs">
                      docs ↗
                    </a>
                  )}
                </div>
                <div className="mc-integration-powers">{it.powers}</div>
                {messages && <div className="mc-integration-extras">{messages}</div>}
                {s.lastError && dotKind === "err" && (
                  <div className="mc-integration-error">Last error: {s.lastError}</div>
                )}
                {s.lastOkAt && dotKind === "ok" && (
                  <div className="mc-integration-meta">
                    Last OK at {new Date(s.lastOkAt).toLocaleTimeString()}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

// Render PumpPortal's bespoke extras (message count + last mint) inline. Other
// services don't carry extras today; if a future plugin does, add a case here.
function pumpPortalExtras(it: IntegrationEntry): string | null {
  if (it.key !== "pumpportal") return null;
  const e = it.status.extras ?? {};
  const state = typeof e.state === "string" ? e.state : "unknown";
  const messages = typeof e.messages === "number" ? e.messages : 0;
  const lastMint = typeof e.lastMint === "string" ? e.lastMint : null;
  const lastMintShort = lastMint ? `${lastMint.slice(0, 4)}…${lastMint.slice(-4)}` : "none yet";
  return `state: ${state} · ${messages.toLocaleString()} messages received · last mint: ${lastMintShort}`;
}

// Rotation context panel. Macro overlay: search-trending memecoins from
// CoinGecko + memecoin sector P&L + DefiLlama USDC inflow on Solana. None of
// this is a per-coin signal; it's the "is the broader memecoin tide rising or
// receding" framing that informs how to read individual pumps.
function RotationContextPanel() {
  const section = useCollapsibleSection("rotation-context");
  const [trending, setTrending] = useState<TrendingCoin[]>([]);
  const [category, setCategory] = useState<MemecoinCategory | null>(null);
  const [flow, setFlow] = useState<StablecoinFlow | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  async function reload() {
    setRefreshing(true);
    try {
      const [t, c, f] = await Promise.all([
        fetchCoinGeckoTrending(),
        fetchMemecoinCategory(),
        fetchSolanaUsdcFlow()
      ]);
      setTrending(t);
      setCategory(c);
      setFlow(f);
      setLoadedAt(new Date().toISOString());
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void reload();
    // 3-minute refresh matches the cycle cadence; CoinGecko Demo tier limits
    // are well above this, and the server-side cache absorbs HMR clicks.
    const id = setInterval(() => void reload(), 180_000);
    return () => clearInterval(id);
  }, []);

  // Read the sector direction once for a one-glance "rising / falling / flat"
  // headline. Thresholds chosen to mark moves worth acting on, not noise.
  const sectorDir =
    category == null
      ? "unknown"
      : category.marketCapChange24hPct > 5
        ? "rising"
        : category.marketCapChange24hPct < -5
          ? "falling"
          : "flat";
  const flowDir =
    flow == null
      ? "unknown"
      : flow.delta24hPct > 1
        ? "inflow"
        : flow.delta24hPct < -1
          ? "outflow"
          : "flat";

  return (
    <section id="rotation-context" className={`panel wide ${section.className}`}>
      <PanelTitle
        icon={TrendingUp}
        title="Rotation context"
        collapsed={section.collapsed}
        onToggle={section.toggle}
      />
      <p className="muted">
        Macro context for reading scans. <strong>Sector</strong> = memecoin category 24h
        mcap change from CoinGecko. <strong>USDC on Solana</strong> = DefiLlama's
        per-day USDC supply on Solana; inflow often precedes a memecoin rotation
        by 6-24h. <strong>Trending searches</strong> = top coins by coingecko.com
        search volume in the last 24h. None of this is a per-coin signal; it's
        "is the broader tide rising or receding" framing that tells you whether
        the pumps you see in the scanner are likely to be sticky or fade.
      </p>
      <div className="mc-controls">
        <button className="ghost-button" onClick={() => void reload()} disabled={refreshing}>
          <RefreshCw size={14} />
          {refreshing ? "Refreshing..." : "Refresh"}
        </button>
        {loadedAt && (
          <span className="muted" style={{ fontSize: 12 }}>
            Last refresh {new Date(loadedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      <div className="mc-rotation-grid">
        <div className={`mc-rotation-card mc-rotation-card-${sectorDir}`}>
          <div className="mc-rotation-label">Memecoin sector 24h</div>
          <div className="mc-rotation-headline">
            {category ? `${category.marketCapChange24hPct >= 0 ? "+" : ""}${category.marketCapChange24hPct.toFixed(2)}%` : "—"}
          </div>
          <div className="mc-rotation-sub">
            {category
              ? `${fmtUsd(category.marketCapUsd)} mcap · ${fmtUsd(category.volume24hUsd)} 24h vol`
              : "CoinGecko unreachable"}
          </div>
        </div>
        <div className={`mc-rotation-card mc-rotation-card-${flowDir}`}>
          <div className="mc-rotation-label">USDC on Solana 24h</div>
          <div className="mc-rotation-headline">
            {flow ? `${flow.delta24hPct >= 0 ? "+" : ""}${flow.delta24hPct.toFixed(2)}%` : "—"}
          </div>
          <div className="mc-rotation-sub">
            {flow
              ? `${flow.delta24hUsd >= 0 ? "+" : ""}${fmtUsd(Math.abs(flow.delta24hUsd))} delta · ${fmtUsd(flow.totalUsdcOnSolana)} supply`
              : "DefiLlama unreachable"}
          </div>
        </div>
        <div className="mc-rotation-card">
          <div className="mc-rotation-label">Trending searches</div>
          <div className="mc-rotation-trending">
            {trending.length === 0 ? (
              <span className="muted">CoinGecko unreachable</span>
            ) : (
              trending.slice(0, 8).map((c) => (
                <a
                  key={c.id}
                  href={`https://www.coingecko.com/en/coins/${c.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mc-rotation-trending-chip"
                  title={`Rank #${c.marketCapRank ?? "?"} · click to view on CoinGecko`}
                >
                  {c.thumb && (
                    <img src={c.thumb} alt="" width={14} height={14} className="mc-rotation-trending-thumb" />
                  )}
                  {c.symbol.toUpperCase()}
                </a>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

// System-flow diagram. A dedicated page (tab id `memecoin_flow`) that
// documents every pipeline in the Meme Coin sub-project: what triggers it,
// what runs automatically, what gates exist, and what the user sees. The
// diagram is plain HTML so a PR diff shows exactly what changed; update
// this whenever the pipelines change. Layperson-readable but each step
// carries the file the code lives in for engineers digging deeper. See
// docs/ARCHITECTURE.md "System flow" for the project-doc reflection of this page.
function FlowChart() {
  return (
    <section className="stack">
    <section id="memecoin-flow" className="panel wide">
      <PanelTitle icon={Workflow} title="System flow" />
      <p className="flow-intro">
        Eight independent pipelines drive everything in the Meme Coin sub-project.
        Browser-tab-driven: the trade cycles (hourly), position watch (5 min), the event-driven
        safety/queue paths, and the user actions. Server-side, running with no tab open (opt-in via the
        <code>SERVER_SCHEDULER_*</code> env flags): the new-coin
        scan scheduler (15 min, chart 8) and a position-watch twin that mirrors chart 4 (5 min). Each
        chart below shows the trigger, the steps, and the gates. The walkthrough under each chart cites
        the file the code lives in. Keep this page in sync with code changes; a stale chart is worse
        than no chart.
      </p>

      {/* ---------- 1. SCAN PIPELINE ---------- */}
      <div className="flow-subflow">
        <h3 className="flow-subtitle">1. Scan pipeline</h3>
        <p className="flow-cadence">
          On demand: <strong>Scan latest meme coins</strong> button. Also runs as the first step of
          every Auto-cycle, Live cycle, and lookup-by-address.
        </p>
        <div className="flow-chart">
          <FlowNode kind="trigger" title="Scan request" sub='Button click, "Look up" box, or a cycle tick' />
          <FlowArrow />
          <FlowNode
            kind="step"
            title="Gather candidates (parallel)"
            sub="Promise.allSettled across 4 feeds, latency = slowest provider"
          />
          <FlowBranch
            cols={[
              <FlowMini key="d" label="DexScreener" detail="boosted + newly profiled" />,
              <FlowMini key="g" label="GeckoTerminal" detail="new + trending Solana pools" />,
              <FlowMini key="j" label="Jupiter v2" detail="recent + toptrending/24h" />,
              <FlowMini key="p" label="pump.fun" detail="newest launches (often gated)" />
            ]}
          />
          <FlowArrow label="merge round-robin · dedupe · cap 60" />
          <FlowNode kind="step" title="Enrich market data" sub="DexScreener tokens/{addrs} in batches of 30 · price, liquidity, age, txns" />
          <FlowArrow label="top 40 only · concurrency pool of 8" />
          <FlowNode
            kind="step"
            title="Jupiter enrichment"
            sub="holder count · top-10 % · organic score · audit fields. In-flight dedup per mint."
          />
          <FlowArrow />
          <FlowNode kind="step" title="Score" sub="exitScore = liq·0.42 + vol·0.28 + turn·0.20 + trades·0.10" />
          <FlowArrow />
          <FlowNode kind="step" title="Momentum vs prior scan" sub="volume + liquidity delta · momentumScore · 'new' tag if absent before" />
          <FlowArrow />
          <FlowNode kind="step" title="Composite rating" sub="exit + corroboration + momentum − risk flags · 0-100, A-F" />
          <FlowArrow />
          <FlowNode kind="outcome" title="Render scan list" sub="default sort: Rating · Hidden coins filtered to Hidden tab" />
        </div>
        <ol className="flow-walkthrough">
          <li><strong>Trigger</strong>: <code>runScan</code> in <code>App.tsx</code>, or step 1 of <code>runCycle</code> / <code>runLiveCycle</code>.</li>
          <li><strong>Gather</strong>: <code>scanMemecoins</code> in <code>src/lib/markets.ts</code> fans out to four candidate sources in parallel via <code>Promise.allSettled</code>; a slow or failing feed cannot stall the others. Source chips on the scan panel show which answered.</li>
          <li><strong>Enrich</strong>: <code>fetchPrices</code> hits DexScreener <code>latest/dex/tokens/{`{addrs}`}</code> 30 at a time. No key.</li>
          <li><strong>Jupiter audit</strong>: top 40 by exit score get a Jupiter Tokens v2 lookup for holder count, top-10 %, and the organic score. <code>runWithConcurrency(8)</code> caps in-flight requests; <code>jupiterInFlight</code> in <code>src/lib/safety.ts</code> dedups concurrent same-mint requests.</li>
          <li><strong>Score</strong>: <code>scoreExit</code> in <code>src/lib/markets.ts</code>, four weighted components. Verdict thresholds: <em>exitable</em> ≥62 score + ≥$25k liq + ≤1 risk flag.</li>
          <li><strong>Rating</strong>: <code>computeRating</code> in <code>src/lib/markets.ts</code> folds in cross-source corroboration (+5 per extra feed, cap +15), momentum, and risk-flag penalty.</li>
          <li><strong>Render</strong>: sorted client-side per the active dropdown. Hide list (<code>memeify-memecoin-hidden-v1</code>) filters the default tab.</li>
        </ol>
      </div>

      {/* ---------- 2. AUTO-CYCLE ---------- */}
      <div className="flow-subflow">
        <h3 className="flow-subtitle">2. Auto-cycle (paper)</h3>
        <p className="flow-cadence">
          <strong>Every 60 minutes</strong> while <em>Auto-run</em> is ON and trading mode is Paper.
          Browser-tab-open required. Skipped when mode is Real (the Live cycle takes over).
        </p>
        <div className="flow-chart">
          <FlowNode kind="trigger" title="60-min interval fires" sub="setInterval · App.tsx · paper auto-run effect" />
          <FlowArrow />
          <FlowNode kind="gate" title="Busy lock?" sub="Shared lock with position watch. If held, skip this tick." />
          <FlowArrow />
          <FlowNode kind="step" title="Scan pipeline" sub="(see chart 1)" />
          <FlowArrow />
          <FlowNode kind="step" title="Re-price held coins not in scan" sub="fetchPrices · merge into priceMap · prune to addresses still referenced" />
          <FlowArrow />
          <FlowNode kind="decision" title="Queue mode ON?" sub="Branch on paper_account.queue_mode" />
          <FlowBranch
            cols={[
              <div key="q" className="flow-branchcol">
                <FlowMini label="YES — propose only" detail="decideSellIntents + decideBuyIntents" />
                <FlowArrow />
                <FlowMini label="Pre-filter against safety cache" detail="drop intents where verdict was 'block' inside the 6h TTL" />
                <FlowArrow />
                <FlowMini label="enqueueIntents" detail="trade_queue jsonb on paper_account" />
                <FlowArrow />
                <FlowMini label='Toast "N proposed"' detail='kind=spike · clicks scroll to "trade-queue"' />
              </div>,
              <div key="e" className="flow-branchcol">
                <FlowMini label="NO — execute now" detail="runSellPass then runBuyPass" />
                <FlowArrow />
                <FlowMini label="Sell pass" detail="take-profit · stop-loss · max hold · liquidity death" />
                <FlowArrow />
                <FlowMini label="Buy pass" detail="execute-mode gates (in firing order): autoTrade on · circuit-breaker · maxOpen · cash ≥ $1 · minExitScore · minLiq · minAge · minHolderCount · price > 0 · not-already-held · not-blacklisted · cooldown. Queue mode skips the autoTrade gate (it's execute-only). Rating is the SORT key, not a gate." />
                <FlowArrow />
                <FlowMini label='Toast "Auto-cycle traded: ..."' detail="kind chosen by sell-vs-buy mix" />
              </div>
            ]}
          />
          <FlowArrow />
          <FlowNode kind="gate" title="Daily loss limit check" sub="circuitBreakerTripped · toast once on transition into tripped" />
        </div>
        <ol className="flow-walkthrough">
          <li><strong>Trigger</strong>: <code>setInterval</code> in the auto-run <code>useEffect</code> in <code>App.tsx</code>, 3600000ms (60 min, slowed from 180000ms on 2026-05-26 to keep Brave inside its $5 free credit). Bails when <code>tradingMode === "real"</code>.</li>
          <li><strong>Busy lock</strong>: <code>paperBusyRef</code> guards <code>runCycle</code>, <code>runPositionWatch</code>, and every manual paper handler so concurrent writes never clobber.</li>
          <li><strong>Scan</strong>: <code>scanMemecoins</code> reused; result also written to <code>scan_cache</code> via the persist debounce.</li>
          <li><strong>Re-price</strong>: held coins not in scan get a separate <code>fetchPrices</code>; the merged price map is then pruned to addresses still referenced (this scan, paper positions, live mints) to keep <code>price_snapshots</code> from growing unbounded.</li>
          <li><strong>Queue mode</strong>: <code>decideSellIntents</code> then <code>decideBuyIntents</code> in <code>src/lib/paper.ts</code> produce intents (sells first, matching the chart and the code in <code>runCycle</code>); the safety cache pre-filters known-blocked coins so the queue isn't churned with auto-dismiss noise.</li>
          <li><strong>Execute mode</strong>: <code>runSellPass</code> then <code>runBuyPass</code> in <code>src/lib/paper.ts</code>. The buy pass runs every gate in firing order: <code>autoTrade</code> on, circuit-breaker, max open, cash ≥ $1, <code>minExitScore</code>, <code>minLiquidityUsd</code>, <code>minAgeHours</code>, <code>minHolderCount</code>, price &gt; 0, not already holding the address, not in the rugged blacklist, not in the re-entry cooldown. <strong>Queue-mode asymmetry</strong>: <code>decideBuyIntents</code> intentionally skips the <code>autoTrade</code> gate because queue mode is "review every trade" by definition; only execute mode honors it. To stop queue-mode proposals entirely, raise the buy gates. Note: the candidate list is pre-sorted best-first by <em>rating</em>, but rating is not itself a gate; <code>minExitScore</code> is.</li>
          <li><strong>Circuit-breaker</strong>: <code>circuitBreakerTripped</code> at the end of the cycle. <code>circuitTrippedRef</code> ensures the toast fires once on transition, not every tick.</li>
        </ol>
      </div>

      {/* ---------- 3. LIVE CYCLE ---------- */}
      <div className="flow-subflow">
        <h3 className="flow-subtitle">3. Live cycle (real money)</h3>
        <p className="flow-cadence">
          <strong>Every 60 minutes</strong> while trading mode is Real. Fires once immediately on
          entering Real mode. The paper Auto-run and Position watch are force-disabled in Real mode.
        </p>
        <div className="flow-chart">
          <FlowNode kind="trigger" title="Real mode entered, OR 60-min tick" sub="setInterval · App.tsx · live cycle effect" />
          <FlowArrow />
          <FlowNode kind="gate" title="Live busy lock?" sub="liveCycleBusyRef · skip if a prior tick is still in flight" />
          <FlowArrow />
          <FlowNode kind="step" title="Scan pipeline" sub="(see chart 1)" />
          <FlowArrow />
          <FlowNode kind="step" title="Decide live BUY intents" sub="decideLiveBuyIntents · against open live positions + dismissed-buy records" />
          <FlowArrow />
          <FlowNode kind="step" title="Re-price live open positions" sub="fetchPrices · lift peakPriceUsd (bad-data ticks blocked from peak)" />
          <FlowArrow />
          <FlowNode kind="step" title="Decide live SELL intents" sub="decideLiveSellIntents · trailing stop · max hold · liquidity death" />
          <FlowArrow />
          <FlowNode kind="gate" title="Pre-filter against safety cache" sub="drop block-cached intents (6h TTL) so the queue stays clean" />
          <FlowArrow />
          <FlowNode kind="step" title="enqueueIntents" sub="proposals only · NEVER auto-executes a real trade" />
          <FlowArrow />
          <FlowNode kind="outcome" title='Toast "Live cycle proposed N trades"' sub='kind=spike · clicks scroll to "trade-queue"' />
        </div>
        <ol className="flow-walkthrough">
          <li><strong>Trigger</strong>: separate <code>useEffect</code> in <code>App.tsx</code>, partner to the paper auto-run. Mutual exclusion guarantees exactly one cycle owns the 60-min cadence per mode.</li>
          <li><strong>Decide buys</strong>: <code>decideLiveBuyIntents</code> in <code>src/lib/live.ts</code> applies the same gates as the paper buy pass plus the live-positions cap.</li>
          <li><strong>Re-price + peaks</strong>: <code>plausibleSellPrice</code> guards the peak so one thin-pool glitch upward doesn't bake a fake peak that later fires trailing as a -99% drawdown.</li>
          <li><strong>Decide sells</strong>: <code>decideLiveSellIntents</code> in <code>src/lib/live.ts</code> reads the lifted peaks for trailing-stop math.</li>
          <li><strong>Safety pre-filter</strong>: same <code>safetyCacheRef</code> + TTL as the paper cycle. Live-mode silently dropping a coin you were watching for is the worse failure mode, so blocked symbols are also written to the cycle log.</li>
          <li><strong>Enqueue, never execute</strong>: by design, the live cycle <em>only</em> proposes. Every real swap requires a Phantom signature in the Queue approval or Manual trade flows.</li>
        </ol>
      </div>

      {/* ---------- 4. POSITION WATCH ---------- */}
      <div className="flow-subflow">
        <h3 className="flow-subtitle">4. Position watch</h3>
        <p className="flow-cadence">
          <strong>Every 5 minutes</strong> while <em>Position watch</em> is ON. Fires once immediately
          on toggle-on. Paper positions only get auto-evaluated; live positions are re-priced for the
          panel display. A server-side twin (<code>positionWatchSchedulerPlugin</code> in
          <code>vite.config.ts</code>, opt-in <code>SERVER_SCHEDULER_WATCH=true</code>) runs this same
          evaluation every 5 min with no tab open. It loads state from
          Postgres, refreshes <code>m_price_snapshots</code>, runs the queue/execute/watchlist branches
          below, and writes alerts straight to <code>m_paper_alerts</code> (no <code>pushAlert</code>;
          the open tab surfaces them on its next state poll).
        </p>
        <div className="flow-chart">
          <FlowNode kind="trigger" title="5-min interval fires" sub="setInterval · App.tsx · watch effect" />
          <FlowArrow />
          <FlowNode kind="gate" title="Busy lock?" sub="Shared with auto-cycle. Empty open lists also short-circuit." />
          <FlowArrow />
          <FlowNode kind="step" title="Fetch prices" sub="paper open addresses + live open mints, deduped" />
          <FlowArrow />
          <FlowNode kind="decision" title="Any prices back?" sub="Empty result = upstream blip; bail to avoid false rugs" />
          <FlowArrow />
          <FlowNode kind="decision" title="Trading mode?" />
          <FlowBranch
            cols={[
              <div key="r" className="flow-branchcol">
                <FlowMini label="REAL mode" detail="re-price live for panel only · stop here" />
              </div>,
              <div key="q" className="flow-branchcol">
                <FlowMini label="PAPER + queue mode" detail="decideSellIntents on paper positions" />
                <FlowArrow />
                <FlowMini label="enqueueIntents" detail="watch keeps the queue fed even with auto-run off" />
                <FlowArrow />
                <FlowMini label='Toast "Watch proposed N sells"' detail='kind=spike · clicks scroll to "trade-queue"' />
              </div>,
              <div key="e" className="flow-branchcol">
                <FlowMini label="PAPER + execute mode" detail="evaluatePositionWatch in src/lib/paper.ts" />
                <FlowArrow />
                <FlowMini label="Per-position rules (one-shot flags)" detail="+50% spike · +100% sell half · danger reasons · liq < $3k force-exit" />
                <FlowArrow />
                <FlowMini label="Toast per alert · log pump triggers for spikes" detail="pushAlert + Notification API + logPumps" />
              </div>
            ]}
          />
        </div>
        <ol className="flow-walkthrough">
          <li><strong>Trigger</strong>: <code>useEffect</code> in <code>App.tsx</code>, 300000ms, plus an immediate first run on toggle-on.</li>
          <li><strong>Prices</strong>: <code>fetchPrices</code> over the deduped paper-open + live-open address set; an empty response sets a soft error and bails the evaluation step.</li>
          <li><strong>Real mode</strong>: live positions are re-priced into <code>prices</code> so the live panel stays current, but no rules run against them. Live sells are exclusively user-clicked.</li>
          <li><strong>Queue mode</strong>: <code>decideSellIntents</code> in <code>src/lib/paper.ts</code> proposes only; the watch never auto-sells in queue mode.</li>
          <li><strong>Execute mode</strong>: <code>evaluatePositionWatch</code> in <code>src/lib/paper.ts</code>. Spike (+50%) and danger alerts are flag-throttled (<code>alertedSpike</code>, <code>dangerAlerted</code>); danger re-arms on a clean tick so a recovery → re-deterioration alerts again. Liquidity 0&lt;x&lt;$3k force-exits.</li>
          <li><strong>Pump log</strong>: every <em>spike</em> alert writes a pump-trigger row with a one-shot social chatter scan (deduped per coin per day).</li>
        </ol>
      </div>

      {/* ---------- 5. SAFETY GATE ---------- */}
      <div className="flow-subflow">
        <h3 className="flow-subtitle">5. Safety gate (event-driven)</h3>
        <p className="flow-cadence">
          Fires <strong>whenever the trade queue changes</strong>, not on a timer. Decides which
          queued buy intents are safe enough to keep, auto-dismisses the rest.
        </p>
        <div className="flow-chart">
          <FlowNode kind="trigger" title="tradeQueue state changed" sub="useEffect dependency · App.tsx · safety effect" />
          <FlowArrow label="for each pending buy intent" />
          <FlowNode kind="gate" title="Cache hit within 6h?" sub="safetyCacheRef · persisted to localStorage" />
          <FlowBranch
            cols={[
              <div key="h" className="flow-branchcol">
                <FlowMini label="YES (cached)" detail="reuse verdict · skip all upstream calls" />
              </div>,
              <div key="m" className="flow-branchcol">
                <FlowMini label="In-flight dedup" detail="safetyInFlightRef Map by mint" />
                <FlowArrow />
                <FlowMini label="runForIntent" detail="runs sequentially per intent" />
                <FlowArrow />
                <FlowMini label="RugCheck report (5min TTL)" detail="mint/freeze auth · insider · LP · transfer fee" />
                <FlowArrow />
                <FlowMini label="Jupiter audit (30min TTL)" detail="organic score · top holders · wash signal" />
                <FlowArrow />
                <FlowMini label="Jupiter quote + sellability sim" detail="buy + sell price-impact check" />
                <FlowArrow />
                <FlowMini label="Cache verdict" detail="ref + localStorage write" />
              </div>
            ]}
          />
          <FlowArrow label="after loop" />
          <FlowNode kind="decision" title="Any verdict = block?" />
          <FlowArrow />
          <FlowNode
            kind="outcome"
            title="Batched auto-dismiss"
            sub="append DismissedBuyIntent (source=auto-safety-block) · remove from queue · one toast per blocked coin"
          />
        </div>
        <ol className="flow-walkthrough">
          <li><strong>Trigger</strong>: the safety <code>useEffect</code> in <code>App.tsx</code> depends on <code>tradeQueue</code>. Adding, removing, or replacing intents re-runs it.</li>
          <li><strong>Cache</strong>: <code>safetyCacheRef</code> + <code>SAFETY_CACHE_TTL_MS</code> (6h). Persisted to <code>memeify-memecoin-safety-cache-v1</code>. Manual user buys deliberately do NOT evict the cache (one-time override, not safety endorsement).</li>
          <li><strong>In-flight dedup</strong>: <code>safetyInFlightRef</code> Map. Concurrent re-renders re-attach to the same Promise instead of issuing redundant RugCheck/Jupiter calls.</li>
          <li><strong>RugCheck + Jupiter</strong>: <code>runSafetyGate</code> in <code>src/lib/safety.ts</code>. Internal TTL split: RugCheck 5min, Jupiter 30min (audit data is slow-moving).</li>
          <li><strong>Auto-dismiss</strong>: batched at end of loop so state mutations don't re-trigger the effect mid-run. Each dismissed coin gets a permanent record with <code>source: "auto-safety-block"</code>, <code>reason</code>, and <code>algoVersion</code>.</li>
        </ol>
      </div>

      {/* ---------- 6. QUEUE APPROVAL ---------- */}
      <div className="flow-subflow">
        <h3 className="flow-subtitle">6. Queue approval (user action)</h3>
        <p className="flow-cadence">
          Triggered by the user ticking intents and clicking <strong>Approve selected</strong> in the
          Trade queue panel. The only place automated proposals become real trades.
        </p>
        <div className="flow-chart">
          <FlowNode kind="trigger" title='User clicks "Approve selected"' sub="TradeQueuePanel · onApprove handler" />
          <FlowArrow label="for each ticked intent" />
          <FlowNode kind="decision" title="Paper or Live intent?" />
          <FlowBranch
            cols={[
              <div key="p" className="flow-branchcol">
                <FlowMini label="PAPER" detail="book directly · no signature needed" />
                <FlowArrow />
                <FlowMini label="applyQueuedIntents in src/lib/paper.ts" detail="updates positions + cash · pushes events to log" />
                <FlowArrow />
                <FlowMini label="setPaper · cycle log · save" detail="debounced persist to Postgres" />
              </div>,
              <div key="l" className="flow-branchcol">
                <FlowMini label="LIVE" detail="real money · requires signature" />
                <FlowArrow />
                <FlowMini label="Build Jupiter swap txns" detail="quote + buildSwapTransaction per intent" />
                <FlowArrow />
                <FlowMini label="signAllTransactions (Phantom)" detail="ONE signature for the whole batch" />
                <FlowArrow />
                <FlowMini label="On-chain confirm + delta read" detail="fetchSwapDelta + fetchSolDelta (5-attempt retry)" />
                <FlowArrow />
                <FlowMini label="openLivePosition / sellLivePosition" detail="record in live_positions · stamps entry_settings_snapshot + algo_version" />
              </div>
            ]}
          />
          <FlowArrow />
          <FlowNode kind="outcome" title="Remove intents from queue · toasts" sub="any failed intent stays in the queue with an error" />
        </div>
        <ol className="flow-walkthrough">
          <li><strong>Trigger</strong>: <code>approveQueued</code> in <code>App.tsx</code>. Bails with a toast if the paper busy lock is held.</li>
          <li><strong>Paper</strong>: <code>applyQueuedIntents</code> in <code>src/lib/paper.ts</code> books all ticked paper trades atomically.</li>
          <li><strong>Live build</strong>: per intent, a Jupiter quote + <code>buildSwapTransaction</code> assembles an unsigned transaction. Pre-buy safety is re-checked against the cache.</li>
          <li><strong>Sign</strong>: <code>signAllTransactions</code> in Phantom signs the whole batch in one popup; the dashboard never touches a key.</li>
          <li><strong>Confirm + record</strong>: <code>fetchSwapDelta</code> + <code>fetchSolDelta</code> in <code>src/lib/wallet.ts</code> read the on-chain delta with a 5-attempt retry (the indexer can lag). <code>openLivePosition</code> / <code>sellLivePosition</code> in <code>src/lib/live.ts</code> write the durable record. The <code>entry_settings_snapshot</code> captures the rule set at trade time so backtests can reason about it later.</li>
          <li><strong>Failure</strong>: a failed intent stays in the queue with an error; the rest of the batch is unaffected.</li>
        </ol>
      </div>

      {/* ---------- 7. MANUAL TRADE ---------- */}
      <div className="flow-subflow">
        <h3 className="flow-subtitle">7. Manual trade (user action)</h3>
        <p className="flow-cadence">
          Triggered by <strong>Buy (paper)</strong>, <strong>Buy (live)</strong>, or <strong>Sell</strong> on a
          scan card, the coin popup, or an open-positions row. Bypasses the queue but still goes
          through the confirmation popup.
        </p>
        <div className="flow-chart">
          <FlowNode kind="trigger" title="Buy / Sell click" sub="Card · popup · open-positions row" />
          <FlowArrow />
          <FlowNode kind="step" title="ConfirmModal" sub="Cancel · Confirm · ESC or backdrop cancels" />
          <FlowArrow />
          <FlowNode kind="decision" title="Paper or Live?" />
          <FlowBranch
            cols={[
              <div key="p" className="flow-branchcol">
                <FlowMini label="PAPER" detail="buyOne / sellOne in App.tsx" />
                <FlowArrow />
                <FlowMini label="Apply to state" detail="positions + cash updated · ignores buy-side gates (manual override)" />
                <FlowArrow />
                <FlowMini label="Save + toast" detail="debounced Postgres write · pushAlert result" />
              </div>,
              <div key="l" className="flow-branchcol">
                <FlowMini label="LIVE" detail="opens BuyLiveModal / SellLiveModal" />
                <FlowArrow />
                <FlowMini label="Pre-buy safety check (buy only)" detail="src/lib/safety.ts · user can override with checkbox" />
                <FlowArrow />
                <FlowMini label="Phantom signs the swap" detail="one popup · slippage capped at 10%" />
                <FlowArrow />
                <FlowMini label="On-chain confirm + delta read" detail="fetchSwapDelta retried 5×" />
                <FlowArrow />
                <FlowMini label="confirmLiveBuy / confirmLiveSell" detail="reads from latest committed siblings · force-saves to Postgres" />
                <FlowArrow />
                <FlowMini label="Toast result" detail="profit kind · partial-sell text if applicable" />
              </div>
            ]}
          />
        </div>
        <ol className="flow-walkthrough">
          <li><strong>Trigger</strong>: every Buy / Sell button on cards, popups, or position rows opens <code>ConfirmModal</code> via a <code>request*</code> helper. Auto-cycle and Queue approval are NOT gated by this modal.</li>
          <li><strong>Paper</strong>: <code>buyOne</code> / <code>sellOne</code> in <code>App.tsx</code>. The shared busy lock holds across the price fetch on sell so a mid-cycle write can't overwrite it.</li>
          <li><strong>Live safety</strong>: <code>runSafetyGate</code> in <code>src/lib/safety.ts</code> (4 checks). Blocking verdicts can be acknowledged with a checkbox; warns show as text only.</li>
          <li><strong>Sign</strong>: <code>signAndSendBase64Tx</code> in <code>src/lib/wallet.ts</code>. Slippage hard-capped at 10% client-side.</li>
          <li><strong>Confirm</strong>: <code>fetchSwapDelta</code> reads the on-chain delta; failure surfaces an error and refuses to record the position (no falsified ledger).</li>
          <li><strong>Force-save</strong>: <code>confirmLiveBuy</code> / <code>confirmLiveSell</code> in <code>App.tsx</code> build the persist payload from <code>persistRef.current</code> (latest committed siblings) so a cycle that ran during the Phantom sign isn't stale-overwritten. The save is non-debounced.</li>
        </ol>
      </div>

      {/* ---------- 8. SERVER NEW-COIN SCAN SCHEDULER ---------- */}
      <div className="flow-subflow">
        <h3 className="flow-subtitle">8. Server new-coin scan scheduler</h3>
        <p className="flow-cadence">
          <strong>Every 15 minutes</strong> server-side, with <em>no browser tab open</em>. Opt-in via
          <code>SERVER_SCHEDULER_SCAN=true</code>; first tick 45s after server start. Free by
          construction — reuses the scan pipeline (chart 1), which hits only keyless feeds and never the
          paid social-chatter providers. This surfaces new-coin alerts while the local server runs.
        </p>
        <div className="flow-chart">
          <FlowNode kind="trigger" title="15-min timer fires" sub="setInterval · scanSchedulerPlugin · vite.config.ts · no tab needed" />
          <FlowArrow />
          <FlowNode kind="gate" title="Busy lock?" sub="Local per-tick lock; skip if the prior tick is still running." />
          <FlowArrow />
          <FlowNode kind="step" title="Scan pipeline" sub="load prior from m_scan_cache → scanMemecoins → write result back (see chart 1)" />
          <FlowArrow />
          <FlowNode kind="gate" title="First-tick seed guard" sub="If first tick after restart AND prior scan stale (>2× interval): seed only, emit nothing this tick." />
          <FlowArrow />
          <FlowNode
            kind="gate"
            title="Quality bar prefilter"
            sub="new-since-last-scan · band ∈ {A} · liq ≥ $50k · vol24h ≥ $75k · verdict exitable (requireExitable)"
          />
          <FlowArrow label="cross-tick dedup: drop addresses alerted <6h ago · cap 5/scan" />
          <FlowNode
            kind="gate"
            title="RugCheck rug-screen (per candidate)"
            sub="skip unverifiable (ok:false) and shady (rugged / honeypot / mint+freeze auth open / insider-bundled / top-holder concentration). Capture the RugCheck score."
          />
          <FlowArrow />
          <FlowNode
            kind="outcome"
            title="Insert enriched alert → m_paper_alerts"
            sub="formatNewCoinAlert: rating/100 · verdict+exit · liq/vol/mcap · 24h price + vol-momentum · buy% · vol/liq · top10% · uniq% · age · #sources · RugCheck score. kind='newcoin', dismissed=false, scroll_to_id=address."
          />
          <FlowArrow label="open tab polls /api/memecoin/state" />
          <FlowNode kind="outcome" title="Toast + OS notification" sub="applyServerState surfaces unseen, undismissed alerts. No tab open → it waits in the Alerts log." />
        </div>
        <ol className="flow-walkthrough">
          <li><strong>Trigger</strong>: <code>scanSchedulerPlugin</code> in <code>vite.config.ts</code> — <code>setTimeout(45s)</code> then <code>setInterval</code> at <code>SCAN_INTERVAL_MIN</code> (default 15 min). Gated on <code>SERVER_SCHEDULER_SCAN==="true"</code> read from <code>loadEnv</code> (not <code>process.env</code>).</li>
          <li><strong>Scan</strong>: <code>scanMemecoins(prior)</code> from <code>src/lib/markets.ts</code>, the same pipeline as chart 1, pointed at the server's own loopback proxy. Result is upserted into <code>m_scan_cache</code> so an opening tab sees fresh data.</li>
          <li><strong>Seed guard</strong>: on the first tick after a restart, if the prior cached scan is stale (<code>priorAgeMs &gt; 2×</code> interval) every coin reads as "new" vs the stale cache, so it seeds silently and emits no alerts that tick.</li>
          <li><strong>Quality bar</strong>: env-tunable — <code>NEWCOIN_BANDS</code> (default A), <code>NEWCOIN_MIN_LIQUIDITY_USD</code> (50k), <code>NEWCOIN_MIN_VOLUME_24H</code> (75k), <code>NEWCOIN_REQUIRE_EXITABLE</code> (default on → <em>exitable</em> only; off → anything not <em>trap risk</em>).</li>
          <li><strong>Dedup + cap</strong>: queries <code>m_paper_alerts</code> for <code>kind='newcoin'</code> rows in the last 6h and skips those addresses; then slices to <code>NEWCOIN_MAX_ALERTS_PER_SCAN</code> (default 5).</li>
          <li><strong>Rug screen</strong>: <code>screenRugCheck</code> in <code>src/lib/safety.ts</code> (free RugCheck), default on via <code>NEWCOIN_RUGCHECK</code>. Unverifiable mints (often too new to be indexed) are skipped, not alerted.</li>
          <li><strong>Alert</strong>: <code>formatNewCoinAlert</code> in <code>vite.config.ts</code> packs every decision criterion the scan already computed (no extra API calls) into one line and inserts it into <code>m_paper_alerts</code> with <code>dismissed=false</code>.</li>
          <li><strong>Delivery</strong>: <code>applyServerState</code> in <code>App.tsx</code> diffs server alerts against what it has seen and fires a toast + OS <code>Notification</code> for each fresh, undismissed one. With no tab open the alert simply waits in the Alerts log until one opens.</li>
        </ol>
      </div>

      <p className="flow-footnote">
        Out of scope above: alert lifecycle (no auto-dismiss timer, alerts persist until clicked; see
        the Alerts log panel on the Meme Coin tab), persistence debouncing (700ms for real changes,
        2500ms for prices-only), and the eager-Phantom auto-connect on mount. These are infrastructure
        that every flow above relies on but doesn't independently trigger.
      </p>
    </section>
    </section>
  );
}

// Visual primitives for the FlowChart. Kept tiny on purpose — every node is
// just a styled box with a title and a subtitle, every arrow is a labeled
// chevron, every branch is a horizontal row of mini-nodes. No layout library.
function FlowNode({
  kind,
  title,
  sub
}: {
  kind: "trigger" | "step" | "decision" | "gate" | "outcome";
  title: string;
  sub?: string;
}) {
  return (
    <div className={`flow-node flow-node-${kind}`}>
      <div className="flow-node-title">{title}</div>
      {sub && <div className="flow-node-sub">{sub}</div>}
    </div>
  );
}

function FlowArrow({ label }: { label?: string }) {
  return (
    <div className="flow-arrow">
      <span className="flow-arrow-line">↓</span>
      {label && <span className="flow-arrow-label">{label}</span>}
    </div>
  );
}

function FlowBranch({ cols }: { cols: ReactNode[] }) {
  return (
    <div className="flow-branch" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(0, 1fr))` }}>
      {cols.map((c, i) => (
        <div key={i} className="flow-branchwrap">
          {c}
        </div>
      ))}
    </div>
  );
}

function FlowMini({ label, detail }: { label: string; detail?: string }) {
  return (
    <div className="flow-mini">
      <div className="flow-mini-label">{label}</div>
      {detail && <div className="flow-mini-detail">{detail}</div>}
    </div>
  );
}

// Collapsible-section state. Module-level so any component can call
// useCollapsibleSection(id) and stay in sync with every other consumer
// without prop drilling. Persisted to localStorage so the user's collapse
// preferences survive reloads.
//
// Each call site picks a stable id (e.g. "meme-coin-research", "live-panel").
// CSS hides everything except .panel-title when the section is collapsed;
// React keeps the body mounted so background work (intervals, useEffects)
// continues running for collapsed panels. That's the right trade-off here
// since LivePanel's balance refresh and PaperPanel's cycle timers should
// keep ticking even when the user has collapsed those sections to scroll past.
const COLLAPSED_SECTIONS_KEY = "memeify-memecoin-collapsed-sections-v1";
let collapsedSectionsCache: Set<string> | null = null;
const collapsedSectionsListeners = new Set<() => void>();
function readCollapsedSections(): Set<string> {
  if (collapsedSectionsCache) return collapsedSectionsCache;
  try {
    const raw = localStorage.getItem(COLLAPSED_SECTIONS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    // Drop orphaned ids whose panels no longer exist. The set is
    // user-controlled so it accumulates over time; deleting a panel without
    // pruning here leaves dead entries that other tooling could mistake for
    // signal. ORPHANED_SECTION_IDS is the explicit removal list.
    //   - "memecoin-flow": briefly existed as a collapsible panel inside the
    //     Meme Coin tab; was promoted to its own tab (`memecoin_flow`) in the
    //     same session. Anyone who collapsed it during that interval has a
    //     dead entry. (2026-05-23)
    const ORPHANED_SECTION_IDS = new Set(["memecoin-flow"]);
    const cleaned: string[] = Array.isArray(arr)
      ? arr.filter((x) => typeof x === "string" && !ORPHANED_SECTION_IDS.has(x))
      : [];
    collapsedSectionsCache = new Set(cleaned);
    // Persist the cleanup if anything was actually removed, so future reads
    // (and any other tooling that reads the raw key) see the trimmed list.
    if (Array.isArray(arr) && cleaned.length !== arr.length) {
      try {
        localStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify(cleaned));
      } catch {
        /* storage unavailable; in-memory cache still works for this session */
      }
    }
  } catch {
    collapsedSectionsCache = new Set();
  }
  return collapsedSectionsCache;
}
function writeCollapsedSections(s: Set<string>) {
  collapsedSectionsCache = s;
  try {
    localStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify(Array.from(s)));
  } catch {
    /* storage unavailable; in-memory cache still works for this session */
  }
  collapsedSectionsListeners.forEach((fn) => fn());
}
function useCollapsibleSection(id: string): {
  collapsed: boolean;
  toggle: () => void;
  className: string;
} {
  // Force a re-render via reducer increment whenever the shared set changes.
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    collapsedSectionsListeners.add(force);
    return () => {
      collapsedSectionsListeners.delete(force);
    };
  }, []);
  const collapsed = readCollapsedSections().has(id);
  return {
    collapsed,
    toggle: () => {
      const cur = readCollapsedSections();
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeCollapsedSections(next);
    },
    className: collapsed ? "panel-collapsed" : ""
  };
}

function PanelTitle({
  icon: Icon,
  title,
  collapsed,
  onToggle
}: {
  icon: typeof Gauge;
  title: string;
  // When onToggle is provided, the title becomes a button: clicking anywhere
  // in the bar toggles collapse, and a chevron indicates the current state.
  // When omitted, PanelTitle renders as a static heading (existing behavior).
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  if (onToggle) {
    return (
      <button
        type="button"
        className="panel-title panel-title-toggle"
        onClick={onToggle}
        aria-expanded={!collapsed}
        title={collapsed ? "Click to expand" : "Click to collapse"}
      >
        <Icon size={18} />
        <h2>{title}</h2>
        <span className="panel-title-chevron" aria-hidden="true">
          {collapsed ? "▸" : "▾"}
        </span>
      </button>
    );
  }
  return (
    <div className="panel-title">
      <Icon size={18} />
      <h2>{title}</h2>
    </div>
  );
}


// Rate-limit banner for metered upstreams (Tavily, Serper). Polls
// /api/usage/summary every 60s and surfaces a warning when any provider
// crosses 80% of its monthly free-tier cap, an error at 100%. Rendered as
// the first child of <main> so it appears on every tab; the user was on
// /#plan when they first hit Tavily's 432, so the banner has to be global,
// not Meme-Coin-tab-local. Hidden when nothing is over threshold.
type UsageSummary = { provider: string; used: number; cap: number; pct: number };
function ApiUsageBanner() {
  const [summary, setSummary] = useState<UsageSummary[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/usage/summary");
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && data.ok) setSummary(data.summary as UsageSummary[]);
      } catch {
        /* network blip — leave the prior value, try again next tick */
      }
    };
    void load();
    const id = setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  if (!summary) return null;
  // Threshold logic: anything >= 80% surfaces; >= 100% paints red. A provider
  // under 80% is invisible (no nag for healthy state).
  const surfaced = summary.filter((s) => s.pct >= 80);
  if (surfaced.length === 0) return null;
  const exceeded = surfaced.filter((s) => s.pct >= 100);
  const tone = exceeded.length > 0 ? "danger" : "warn";
  const label = (s: UsageSummary) =>
    `${s.provider} ${s.used}/${s.cap} (${s.pct.toFixed(1)}%)`;
  return (
    <div className={`api-usage-banner api-usage-banner-${tone}`} role="status">
      <strong>
        {exceeded.length > 0
          ? "API quota exceeded:"
          : "API quota approaching:"}
      </strong>{" "}
      {surfaced.map(label).join(" · ")}
      {exceeded.length > 0 && (
        <span className="api-usage-banner-hint">
          Calls from this provider will fail until the monthly window resets (UTC).
        </span>
      )}
    </div>
  );
}

export default App;
