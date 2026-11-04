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
