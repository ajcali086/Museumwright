/** Fetching a page and its files, as the starter does it: one GET each, no cookies, no scripts run. */
const HEADERS = { "user-agent": "mw/0.1 (Museumwright starter)", accept: "*/*" };

export async function fetchText(url: string): Promise<{ text: string; url: string }> {
  const res = await fetch(url, { headers: { ...HEADERS, accept: "text/html,*/*" }, redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${res.statusText}`);
  return { text: await res.text(), url: res.url || url };
}

export async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { headers: HEADERS, redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
