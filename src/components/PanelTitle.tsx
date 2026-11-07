import { Gauge } from "lucide-react";

export function PanelTitle({
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
