/** Service worker registration, install prompt and push subscription helpers. */
import { get, post } from './api';

let deferredPrompt: any = null;
const listeners = new Set<() => void>();

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // In development the Vite dev server serves modules directly; only cache in production builds.
  if (!import.meta.env.PROD) return;
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  listeners.forEach((l) => l());
});
window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  listeners.forEach((l) => l());
});

export const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
export const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
export const canPromptInstall = () => !!deferredPrompt;
export function onInstallAvailability(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export async function promptInstall() {
  if (!deferredPrompt) return false;
  deferredPrompt.prompt();
  const choice = await deferredPrompt.userChoice;
  deferredPrompt = null;
  listeners.forEach((l) => l());
  return choice?.outcome === 'accepted';
}

/** Point the manifest at the user's school so an install carries its name and colour. */
export function setManifestSchool(slug: string | null) {
  const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (link) link.href = `/api/public/manifest.webmanifest${slug ? `?school=${encodeURIComponent(slug)}` : ''}`;
}

export function clearUserCache() {
  navigator.serviceWorker?.controller?.postMessage('clear-user-cache');
}

const urlB64ToUint8 = (b64: string) => {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

export type PushState = 'unsupported' | 'unavailable' | 'denied' | 'off' | 'on';

export async function pushState(): Promise<PushState> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return 'unavailable';
  const { enabled } = await get<{ enabled: boolean }>('/push/public-key');
  if (!enabled) return 'unavailable';
  if (Notification.permission === 'denied') return 'denied';
  return (await reg.pushManager.getSubscription()) ? 'on' : 'off';
}

export async function enablePush() {
  const { enabled, publicKey } = await get<{ enabled: boolean; publicKey: string | null }>('/push/public-key');
  if (!enabled || !publicKey) throw new Error('Push notifications are not configured on the server');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications were blocked for this site');
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(publicKey) });
  await post('/push/subscribe', sub.toJSON());
  await post('/push/test');
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await post('/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe();
  }
}
