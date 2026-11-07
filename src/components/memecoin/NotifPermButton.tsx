import { Bell, BellOff } from "lucide-react";
import { useEffect, useState } from "react";
import { showSystemPositionWatchNotification } from "../../lib/notifications";

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
export function NotifPermButton() {
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
