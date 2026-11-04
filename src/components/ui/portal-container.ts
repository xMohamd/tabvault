/**
 * Where floating content (tooltips, menus, listboxes) is rendered.
 *
 * Radix portals render into <body>, outside every landmark, which makes screen
 * readers treat them as stray content (axe "region"). The app's <main> is a
 * landmark, and these elements are position: fixed, so they can live inside it
 * without any visual change. Falls back to <body> when there is no <main>.
 */
export function portalContainer(): HTMLElement | undefined {
  return typeof document === "undefined" ? undefined : (document.querySelector<HTMLElement>("main") ?? undefined)
}
