import type { InboxItemDto } from "@conclave/contract";
import { api } from "./api";

/**
 * Desktop notifications and web push in the browser (NOTE-003). The server
 * decides what to deliver and when (quiet hours, alert rules); this file only
 * shows what it sends.
 */

export const notificationsSupported = () => typeof window !== "undefined" && "Notification" in window;
export const pushSupported = () => notificationsSupported() && "serviceWorker" in navigator && "PushManager" in window && window.isSecureContext;

let pushActive = false;

async function registration(): Promise<ServiceWorkerRegistration> {
  return (await navigator.serviceWorker.getRegistration("/")) ?? navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

/** Whether this browser already gets pushes; then the socket does not show a second copy. */
export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = (await reg?.pushManager.getSubscription()) ?? null;
  pushActive = !!sub;
  return sub;
}

/** Called for each "notification" event from the realtime socket. */
export function showDesktop(item: InboxItemDto, at: string, open: (path: string) => void): void {
  if (!notificationsSupported() || Notification.permission !== "granted" || pushActive) return;
  // The inbox updates live while the app is in view; replays after a reconnect are old news.
  if (document.visibilityState === "visible" && document.hasFocus()) return;
  if (Date.now() - new Date(at).getTime() > 2 * 60_000) return;
  const n = new Notification(item.title, { body: (item.body || item.path).slice(0, 240), tag: item.id, requireInteraction: item.urgent, icon: "/favicon.svg" });
  n.onclick = () => {
    window.focus();
    open("/inbox");
    n.close();
  };
}

export async function askPermission(): Promise<NotificationPermission> {
  if (!notificationsSupported()) return "denied";
  return Notification.permission === "default" ? Notification.requestPermission() : Notification.permission;
}

const keyBytes = (base64url: string) => {
  const b64 = base64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};

/** Subscribe this browser to web push and register it with the server. */
export async function enablePush(publicKey: string): Promise<void> {
  if (!pushSupported()) throw new Error("This browser cannot receive web push.");
  if ((await askPermission()) !== "granted") throw new Error("Notifications are blocked for this site. Allow them in the browser's site settings.");
  const reg = await registration();
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with another server key cannot be reused.
  if (sub && sub.options.applicationServerKey) {
    const existing = new Uint8Array(sub.options.applicationServerKey);
    const wanted = keyBytes(publicKey);
    if (existing.length !== wanted.length || existing.some((b, i) => b !== wanted[i])) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await api.subscribePush({ endpoint: json.endpoint, keys: json.keys });
  pushActive = true;
}

/** Stop pushes to this browser. */
export async function disablePush(): Promise<void> {
  const sub = await currentPushSubscription();
  if (!sub) return;
  await api.removePushEndpoint(sub.endpoint).catch(() => {});
  await sub.unsubscribe();
  pushActive = false;
}
