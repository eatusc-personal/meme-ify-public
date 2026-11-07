export function showSystemPositionWatchNotification(body: string) {
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification("Meme coin position watch", { body });
    }
  } catch {
    /* OS notifications unavailable; the in-app alert still shows */
  }
}
