/** A museum box in the test process, and a desk client for it: the cookie, and the header the desk's own page sends. */
import type { Server } from "node:http";
import { createMuseumServer } from "../../src/serve/server.ts";

export type Box = { url: string; server: Server; dir: string; setupCode: string; state: string };

export async function box(dir: string, state: string): Promise<Box> {
  const { server, desk } = createMuseumServer({ museum: dir, state, quiet: true });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server, dir, setupCode: desk.setupCode, state };
}

/** A desk client: its cookie, the header the desk's own page sends. */
export function client(base: string) {
  let cookie = "";
  const req = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}/desk/api/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(body === undefined ? {} : { "content-type": "application/json", "x-mw-desk": "1" }), ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const type = res.headers.get("content-type") ?? "";
    return { status: res.status, body: type.includes("json") ? ((await res.json()) as Record<string, any>) : await res.arrayBuffer() } as { status: number; body: any };
  };
  return { req, upload: async (intake: string, name: string, bytes: Uint8Array) => {
    const res = await fetch(`${base}/desk/api/upload?intake=${intake}&name=${encodeURIComponent(name)}`, { method: "POST", headers: { "x-mw-desk": "1", cookie }, body: Buffer.from(bytes) });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  } };
}

