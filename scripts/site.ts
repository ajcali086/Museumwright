/**
 * The project's own website (what Vercel publishes): a front page, and a
 * read-only demo museum at /demo/ that mw builds during the deploy, from
 * nothing: mw init, then mw pull of the test fixture's page, served from
 * this process (a deploy has no business fetching someone's live site).
 * The desk itself isn't here: it needs a disk, git and a running server,
 * so it runs on the museum's box (mw serve), not on a static host.
 *
 *   npm run site   →  site/
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { init } from "../src/init.ts";
import { museumScript } from "../src/serve/actions.ts";
import { pull } from "../src/pull.ts";
import { RunLog } from "../src/util.ts";
import { angiePage } from "../test/fixtures/angie/page.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = join(root, "site");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, "site-src"), out, { recursive: true });

// The demo museum: generated, then a page pulled into it.
const work = mkdtempSync(join(tmpdir(), "mw-site-"));
const museum = join(work, "demo");
const log = new RunLog();
init("Demo", { title: "A demo museum", repo: "OWNER/demo", dir: museum, install: false, git: false }, log);

const fx = angiePage();
const routes = new Map<string, { type: string; body: Uint8Array | string }>([["/post/angie", { type: "text/html; charset=utf-8", body: fx.html }]]);
for (const [path, body] of fx.files) routes.set(path, { type: "image/jpeg", body });
const server = createServer((req, res) => {
  const r = routes.get(new URL(req.url ?? "/", "http://x").pathname);
  if (r) res.writeHead(200, { "content-type": r.type }).end(r.body);
  else res.writeHead(404).end();
});
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
const port = (server.address() as { port: number }).port;
process.env.MW_NOW ??= "2026-10-04T12:00:00Z";
await pull(museum, `http://127.0.0.1:${port}/post/angie`, {}, log);
server.close();

const check = museumScript(museum, "scripts/check-model.ts");
if (!check.ok) throw new Error(`the demo museum fails its check:\n${check.out}`);
const built = museumScript(museum, "scripts/build-public.ts");
if (!built.ok) throw new Error(built.out);

// The museum's public folder, without the CMS (it would point at no repository).
cpSync(join(museum, "public"), join(out, "demo"), { recursive: true, filter: (src) => !src.includes(`${join(museum, "public", "admin")}`) });
rmSync(work, { recursive: true, force: true });
if (!existsSync(join(out, "demo", "data", "museum.json"))) throw new Error("the demo has no public slice");
console.log(`wrote ${out}: the front page, and the demo museum at /demo/`);
