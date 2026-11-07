import { useEffect, useReducer } from "react";

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
export function useCollapsibleSection(id: string): {
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
