import { useEffect, useState } from "react";
import { type PaperSettings } from "../../lib/paper";

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
export function TradingRules({
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
