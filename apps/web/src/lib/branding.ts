/** Applies a school's brand at runtime: CSS colour variables, favicon and title. */
export interface BrandInput {
  name?: string;
  branding?: { primaryColor?: string; secondaryColor?: string; accentColor?: string; faviconUrl?: string | null; logoUrl?: string | null } | null;
}

export function applyBranding(b: BrandInput | null) {
  const root = document.documentElement;
  const br = b?.branding;
  root.style.setProperty('--brand', br?.primaryColor || '#4f46e5');
  root.style.setProperty('--brand-2', br?.secondaryColor || '#0f172a');
  root.style.setProperty('--brand-accent', br?.accentColor || '#f59e0b');
  const link = document.getElementById('favicon') as HTMLLinkElement | null;
  if (link) link.href = br?.faviconUrl || br?.logoUrl || '/favicon.svg';
  document.title = b?.name ? `${b.name} · Edumin` : 'Edumin — School Management';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', br?.primaryColor || '#4f46e5');
}
