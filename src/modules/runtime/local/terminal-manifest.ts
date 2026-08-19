/**
 * Android / tablet terminal PWA wiring (PRODUCTIZATION-4, Phases F and G).
 *
 * The public website and the operational terminal are two different installable
 * apps served from one origin. While the operator is inside the OS shell the
 * document points at the terminal manifest, so "Add to home screen" installs
 * NOVA (scope /admin) and not the website. The swap is reverted on unmount.
 *
 * Nothing here assumes a hosted domain: the manifest is same-origin and
 * resolves identically on an on-premise LAN address.
 */
export const TERMINAL_MANIFEST = "/nova-terminal.webmanifest";
export const TERMINAL_THEME_COLOUR = "#141c2b";

export function applyTerminalManifest(doc: Document = document): () => void {
  const link = doc.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  const theme = doc.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  const previousManifest = link?.getAttribute("href") ?? null;
  const previousTheme = theme?.getAttribute("content") ?? null;

  link?.setAttribute("href", TERMINAL_MANIFEST);
  theme?.setAttribute("content", TERMINAL_THEME_COLOUR);

  return () => {
    if (previousManifest !== null) link?.setAttribute("href", previousManifest);
    if (previousTheme !== null) theme?.setAttribute("content", previousTheme);
  };
}
