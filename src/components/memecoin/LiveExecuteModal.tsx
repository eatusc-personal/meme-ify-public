import { XCircle } from "lucide-react";

// Progress window for "Approve selected" on live intents (R2): one row per
// intent, updated as the batch builds, signs, broadcasts, confirms, records.
export function LiveExecuteModal({
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
