import { useEffect, useState } from "react";

// Rate-limit banner for metered upstreams (Tavily, Serper). Polls
// /api/usage/summary every 60s and surfaces a warning when any provider
// crosses 80% of its monthly free-tier cap, an error at 100%. Rendered as
// the first child of <main> so it appears on every tab; the user was on
// /#plan when they first hit Tavily's 432, so the banner has to be global,
// not Meme-Coin-tab-local. Hidden when nothing is over threshold.
type UsageSummary = { provider: string; used: number; cap: number; pct: number };
export function ApiUsageBanner() {
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
