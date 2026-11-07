import { XCircle } from "lucide-react";
import { useEffect } from "react";

// A pending buy/sell confirmation. Set when the user clicks a manual Buy or
// Sell (paper or live); the action only fires from the modal's Confirm button.
export type ConfirmRequest = {
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
export function ConfirmModal({ req, onClose }: { req: ConfirmRequest; onClose: () => void }) {
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
