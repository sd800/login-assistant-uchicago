// Cookie cleanup is limited to these domains in the current Chrome cookie store.
// Parent-domain cookies and unrelated sites are deliberately excluded.
export const COOKIE_SITES = ['uchicago.okta.com', 'duosecurity.com', 'ais.uchicago.edu'];
export const COOKIE_ACCESS = ['*://uchicago.okta.com/*', '*://*.duosecurity.com/*', '*://*.ais.uchicago.edu/*'];
const inScope = cookie => {
  const host = cookie.domain.replace(/^\./, '').toLowerCase();
  return host === COOKIE_SITES[0] || COOKIE_SITES.slice(1).some(site => host === site || host.endsWith('.' + site));
};
export async function clearSignInCookies(api) {
  if (!api.cookies || !await api.permissions.contains({ permissions: ['cookies'], origins: COOKIE_ACCESS })) {
    throw new Error("Reload the extension and allow its site access before adding a passkey.");
  }
  try {
    const read = async () => (await Promise.all(COOKIE_SITES.map(domain =>
      api.cookies.getAll({ domain, partitionKey: {} })))).flat().filter(inScope);
    for (let attempt = 0; attempt < 3; attempt++) {
      const cookies = await read();
      if (!cookies.length) return;
      // Longest paths first avoids same-name cookies shadowing later removals.
      cookies.sort((a, b) => b.path.length - a.path.length);
      for (const cookie of cookies) {
        const url = new URL(`${cookie.secure ? 'https' : 'http'}://${cookie.domain.replace(/^\./, '')}`);
        url.pathname = cookie.path;
        const details = { url: url.href, name: cookie.name, storeId: cookie.storeId,
          ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}) };
        const current = await api.cookies.get(details);
        if (!current) continue;
        // The URL-based API can otherwise select a shared parent-domain cookie.
        if (!inScope(current)) throw new Error('Cookie scope changed');
        await api.cookies.remove(details);
      }
      if (!(await read()).length) return;
      // A live school tab may rewrite a session cookie while it is being
      // removed. Re-read from Chrome and retry after a short bounded delay.
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
    }
    throw new Error('Cookie cleanup incomplete');
  } catch {
    // Never include cookie names, values, or authentication URLs in an error.
    throw new Error("Unable to prepare a fresh sign-in. Close other school sign-in tabs and try adding the passkey again.");
  }
}
