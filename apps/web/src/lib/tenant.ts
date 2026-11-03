/**
 * Which school are we signing in to?
 *   1. Subdomain: greenwood.edumin.localhost → "greenwood"
 *   2. ?school=greenwood in the URL
 *   3. The last school used on this device
 */
const ROOT = (import.meta.env.VITE_ROOT_DOMAIN as string | undefined) ?? 'edumin.localhost';
const KEY = 'edumin.school';

export function subdomainSlug(): string | null {
  const host = window.location.hostname.toLowerCase();
  if (!host.endsWith('.' + ROOT)) return null;
  const slug = host.slice(0, -(ROOT.length + 1));
  return slug && !['www', 'app'].includes(slug) ? slug : null;
}

export function currentSlug(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get('school');
  if (fromUrl) return fromUrl.toLowerCase();
  const sub = subdomainSlug();
  if (sub) return sub;
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function rememberSlug(slug: string | null) {
  try {
    if (slug) localStorage.setItem(KEY, slug);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
}

export const schoolUrl = (slug: string) => `${window.location.protocol}//${slug}.${ROOT}${window.location.port ? ':' + window.location.port : ''}`;
