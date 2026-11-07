import { Bell } from "lucide-react";
import { useState } from "react";
import { type MemeToken } from "../../lib/markets";
import { type NewCoinBar, readNewCoinBar, writeNewCoinBar } from "../../lib/memecoinPrefs";

// Configurable quality bar for new-coin pop-ups. A scan that surfaces a coin
// new since the last scan and clearing this bar fires one toast + OS pop-up
// (see notifyNewCoins). Browser-local; no shared-account meaning.
const NEWCOIN_ALL_BANDS: MemeToken["ratingBand"][] = ["A", "B", "C", "D", "F"];

export function NewCoinBarButton() {
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
