/**
 * The address of electron-vite's dev server (ELECTRON_RENDERER_URL, `npm run dev`), from which the window loads the
 * interface and keeps two development shortcuts; never in the packaged app (`packaged`), which shows its own page only
 * (plan 9, task 3, M5).
 */
export function devServerUrl(env: Record<string, string | undefined>, packaged: boolean): string | undefined {
  return packaged ? undefined : env.ELECTRON_RENDERER_URL || undefined;
}

/**
 * Whether the window may go to `url` (Review Focus 2): only to the app's own page, `appUrl` (the dev server's address,
 * or the built page's file: URL), its fragment aside. Anything else — a file dropped outside a drop zone (Chromium's
 * default is to show it), another file: or https: page, about:blank, a blob of the store — is refused, so the window
 * keeps showing the app, and the bridge never reaches another page. A string that is no address is refused too.
 */
export function navigationAllowed(url: string, appUrl: string): boolean {
  const bare = (u: string) => {
    const parsed = new URL(u);
    parsed.hash = '';
    return parsed.href;
  };
  try {
    return bare(url) === bare(appUrl);
  } catch {
    return false;
  }
}

/**
 * The schemes a PDF's link may hand to the system (plan 4a, task 6). The app's own, `cirrus://node/<id>` (a compiled
 * \ref or \cite, plan 4b, D7), never comes here: the interface opens that node's pop-up itself (ui/latex/links.ts).
 */
const EXTERNAL = new Set(['http:', 'https:', 'mailto:']);

/**
 * Whether `url`, a link clicked in a PDF (openUrl), may be opened by the system's handler (shell.openExternal): an
 * address in http:, https: or mailto: only. Anything else — file:, javascript:, cirrus: (should it ever reach the main
 * process), the store's cirrus-file:, ftp:, tel:, a string that is no address — is refused, so a document never has
 * Windows run or open a local file.
 */
export function externalUrlAllowed(url: string): boolean {
  try {
    return EXTERNAL.has(new URL(url).protocol);
  } catch {
    return false;
  }
}
