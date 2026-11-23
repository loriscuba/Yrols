/**
 * Notifiche: elenco delle novità (campanella) e iscrizione alle notifiche push del dispositivo.
 * Le novità le scrive il database (trigger su movimenti, fondi, Scalable, fondo pensione, offerte); qui si leggono soltanto.
 * Le push passano dal service worker public/sw.js e dalla Edge Function yrols-push.
 */
import { supabase } from "./cloud";

export type NoticeKind = "movimento" | "portafoglio" | "offerta";
export const KINDS: [NoticeKind, string][] = [["movimento", "Movimenti"], ["portafoglio", "Portafogli"], ["offerta", "Offerte"]];

export interface Notice {
  id: number;
  kind: NoticeKind;
  title: string;
  body: string | null;
  url: string | null;
  createdAt: string;
  readAt: string | null;
}

export const notificationsAvailable = () => !!supabase;

export async function loadNotices(limit = 40): Promise<Notice[]> {
  const r = await supabase!.from("notifications").select("id,kind,title,body,url,createdAt:created_at,readAt:read_at")
    .order("created_at", { ascending: false }).limit(limit);
  if (r.error) throw new Error(r.error.message);
  return r.data as Notice[];
}

export async function unreadCount(): Promise<number> {
  const r = await supabase!.from("notifications").select("id", { count: "exact", head: true }).is("read_at", null);
  if (r.error) throw new Error(r.error.message);
  return r.count ?? 0;
}

export async function markAllRead() {
  const r = await supabase!.rpc("yrols_notifications_read");
  if (r.error) throw new Error(r.error.message);
}

// ───────────────────────── Push sul dispositivo ─────────────────────────

export type PushState =
  | { state: "unsupported" }
  | { state: "ios-home" }          // iPhone/iPad: le notifiche funzionano solo dall'icona sulla schermata Home
  | { state: "denied" }            // permesso negato nelle impostazioni del browser
  | { state: "off" }
  | { state: "on"; kinds: NoticeKind[] };

const BASE = import.meta.env.BASE_URL;

export function isIos() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
export function isStandalone() {
  return matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}
const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return "Browser";
}

const register = () => navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE });

async function currentSubscription() {
  const reg = await navigator.serviceWorker.getRegistration(BASE);
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export async function pushStatus(): Promise<PushState> {
  if (!supabase) return { state: "unsupported" };
  if (isIos() && !isStandalone()) return { state: "ios-home" };
  if (!supported()) return { state: "unsupported" };
  if (Notification.permission === "denied") return { state: "denied" };
  const sub = await currentSubscription();
  if (!sub) return { state: "off" };
  // Tiene aggiornato il service worker e controlla che il database conosca ancora questo dispositivo.
  register().catch(() => { /* resta quello attuale */ });
  const r = await supabase.from("push_subscriptions").select("kinds").eq("endpoint", sub.endpoint).maybeSingle();
  if (r.error) throw new Error(r.error.message);
  if (!r.data) return { state: "off" };
  return { state: "on", kinds: r.data.kinds as NoticeKind[] };
}

function keyBytes(b64u: string) {
  const t = b64u.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(t + "=".repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase!.functions.invoke("yrols-push", { body });
  if (error) {
    let msg = error.message;
    try { msg = ((await (error as { context?: Response }).context?.json()) as { error?: string })?.error ?? msg; } catch { /* messaggio generico */ }
    throw new Error(msg);
  }
  return data as T;
}

/** Attiva le notifiche su questo dispositivo. Va chiamata dal tocco di un pulsante (iPhone chiede il permesso solo così). */
export async function enablePush(): Promise<PushState> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? { state: "denied" } : { state: "off" };
  const [{ publicKey }, reg] = await Promise.all([invoke<{ publicKey: string }>({ action: "key" }), register()]);
  await navigator.serviceWorker.ready;
  const key = keyBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  // Un'iscrizione fatta con un'altra chiave non riceverebbe nulla: si rifà.
  const old = sub?.options.applicationServerKey;
  if (sub && old && !sameBytes(new Uint8Array(old), key)) { await sub.unsubscribe(); sub = null; }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const j = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  const prev = await supabase!.from("push_subscriptions").select("kinds").eq("endpoint", j.endpoint).maybeSingle();
  const kinds = (prev.data?.kinds as NoticeKind[] | undefined) ?? KINDS.map(([k]) => k);
  const r = await supabase!.from("push_subscriptions")
    .upsert({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, device: deviceName(), kinds, failures: 0 });
  if (r.error) { await sub.unsubscribe().catch(() => {}); throw new Error(r.error.message); }
  return { state: "on", kinds };
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

export async function disablePush(): Promise<PushState> {
  const sub = await currentSubscription();
  if (sub) {
    await supabase!.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
    await sub.unsubscribe().catch(() => {});
  }
  return { state: "off" };
}

export async function setPushKinds(kinds: NoticeKind[]) {
  const sub = await currentSubscription();
  if (!sub) return;
  const r = await supabase!.from("push_subscriptions").update({ kinds }).eq("endpoint", sub.endpoint);
  if (r.error) throw new Error(r.error.message);
}

export async function testPush(): Promise<number> {
  const r = await invoke<{ sent: number }>({ action: "test" });
  return r.sent;
}
