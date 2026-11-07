import { type SanityFinding } from "../../lib/paper";

// Results of the "Sanity check" button: a linted list of the trading rules,
// each finding coloured by severity. Errors are likely mistakes to fix,
// warnings are worth a look.
export function SanityResults({
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
export function AiReviewResult({
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
