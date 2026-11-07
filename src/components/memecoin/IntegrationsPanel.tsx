import { Activity, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { fetchIntegrations, type IntegrationEntry } from "../../lib/integrations";
import { useCollapsibleSection } from "../../hooks/useCollapsibleSection";
import { PanelTitle } from "../PanelTitle";

// Integrations status panel. Reads /api/integrations every 30s and renders
// a compact list: one row per external service the Meme Coin tab depends on.
// Green dot = configured + healthy, amber = configured but no health signal
// yet (still starting up or never called), red = configured but failing, grey
// = missing env var. Lets the user verify at a glance that PumpPortal is
// streaming, CoinGecko is reachable, Helius is wired, etc., without digging
// in the dev-server logs.
export function IntegrationsPanel() {
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
