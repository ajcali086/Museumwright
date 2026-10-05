/** Fetching a page and its files, as the starter does it: one GET each, no cookies, no scripts run. */
const HEADERS = { "user-agent": "mw/0.1 (Museumwright starter)", accept: "*/*" };

/** fetch, with a failure to connect said as what it is. */
async function get(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    type Cause = { code?: string; errors?: Cause[]; cause?: Cause };
    const cause = (e as { cause?: Cause }).cause;
    const code = cause?.code ?? cause?.errors?.[0]?.code ?? cause?.cause?.code;
    throw new Error(`Couldn't reach ${new URL(url).host}. Is the web there?${code ? ` (${code})` : ""}`, { cause: e });
  }
}

export async function fetchText(url: string): Promise<{ text: string; url: string }> {
  const res = await get(url, { headers: { ...HEADERS, accept: "text/html,*/*" }, redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${res.statusText}`);
  return { text: await res.text(), url: res.url || url };
}

export async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await get(url, { headers: HEADERS, redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
