/**
 * /admin, opened: the generated museum's Sveltia (the pinned release, served
 * from the npm package in place of unpkg) loads the generated config, signs
 * in with a token, and lists what is committed: an empty museum, then one
 * after mw pull --propose. GitHub is a stand-in answered from the museum's
 * own git repository (admin/github.ts). Needs Chromium: MW_CHROMIUM, or
 * Playwright's (npx playwright-core install chromium).
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { githubStub } from "./admin/github.ts";
import { angiePage } from "./fixtures/angie/page.ts";
import { freshMuseum, mw, run, serve, stubModel } from "./helpers.ts";

const SVELTIA = fileURLToPath(new URL("../node_modules/@sveltia/cms/dist/", import.meta.url));
const pinned = (dir: string) => /@sveltia\/cms@([\d.]+)\//.exec(readFileSync(join(dir, "public/admin/index.html"), "utf8"))![1];
const executablePath = process.env.MW_CHROMIUM ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);

function commit(dir: string) {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=Curator", "-c", "user.email=curator@example.org", "commit", "-qm", "museum"], { cwd: dir });
}

/** The museum's own dev server (scripts/serve.mjs), on a free port. */
async function devServer(dir: string): Promise<{ url: string; proc: ChildProcess }> {
  const built = run(dir, "scripts/cms-build.ts");
  assert.equal(built.code, 0, built.out);
  const proc = spawn(process.execPath, ["scripts/serve.mjs"], { cwd: dir, env: { ...process.env, PORT: "0" } });
  const url = await new Promise<string>((ok) => proc.stdout!.on("data", (d) => ok(String(d).trim())));
  return { url, proc };
}

type Opened = { page: Page; unknown: string[]; errors: string[]; text: () => Promise<string> };

async function openAdmin(browser: Browser, dir: string, url: string, owner: string, repo: string): Promise<Opened> {
  const version = pinned(dir);
  const pkg = JSON.parse(readFileSync(join(SVELTIA, "../package.json"), "utf8")).version;
  assert.equal(pkg, version, `the test serves Sveltia ${pkg}; the museum pins ${version}`);
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(`https://unpkg.com/@sveltia/cms@${version}/dist/**`, (route) => {
    const file = join(SVELTIA, new URL(route.request().url()).pathname.split("/dist/")[1]);
    return existsSync(file) ? route.fulfill({ body: readFileSync(file), contentType: "text/javascript" }) : route.fulfill({ status: 404 });
  });
  const stub = githubStub(dir, owner, repo);
  await page.route("https://api.github.com/**", (r) => stub.handle(r));
  // Fonts, icons and status pings: not needed to read the config or the repository.
  await page.route(/^https:\/\/(cdn\.jsdelivr\.net|www\.githubstatus\.com|unpkg\.com\/@sveltia\/cms\/package\.json)/, (r) => r.fulfill({ status: 404 }));
  await page.goto(url);
  return { page, unknown: stub.unknown, errors, text: () => page.locator("body").innerText() };
}

async function signIn(o: Opened) {
  await o.page.getByText("Sign In Using Access Token").click();
  await o.page.locator("input").last().fill("ghp_stand_in");
  await o.page.keyboard.press("Enter");
  await o.page.getByText("Collections").first().waitFor({ timeout: 15_000 });
}

/** Each collection's label and entry count, from the sidebar. */
async function counts(page: Page): Promise<Record<string, number>> {
  await page.waitForTimeout(500);
  const text = await page.locator("body").innerText();
  const out: Record<string, number> = {};
  for (const label of ["Corrections", "Records", "Entities", "Open questions", "Evidence"]) {
    const m = new RegExp(`(?:^|\\n)${label}\\n(\\d+)`).exec(text);
    if (m) out[label] = Number(m[1]);
  }
  return out;
}

describe("/admin, opened in Chromium", { skip: !executablePath && !process.env.CI ? "no Chromium (set MW_CHROMIUM)" : false }, () => {
  let browser: Browser;
  const stops: (() => void)[] = [];
  before(async () => {
    browser = await chromium.launch({ executablePath });
  });
  after(async () => {
    await browser?.close();
    for (const stop of stops) stop();
  });

  it("an empty museum: the config loads, sign-in works, five collections, none with entries", async () => {
    const dir = freshMuseum("admin-empty");
    commit(dir);
    const { url, proc } = await devServer(dir);
    stops.push(() => proc.kill());
    const o = await openAdmin(browser, dir, url, "someone", "admin-empty");
    await o.page.getByText("Sign In Using Access Token").waitFor({ timeout: 15_000 });
    assert.match(await o.text(), /admin-empty · Curator/);
    await signIn(o);
    assert.deepEqual(await counts(o.page), { Corrections: 0, Records: 0, Entities: 0, "Open questions": 0, Evidence: 0 });
    assert.deepEqual(o.unknown, [], "every GitHub request answered");
    assert.deepEqual(o.errors, []);
    await o.page.close();
  });

  it("after mw pull --propose: records and the queue are listed, a plate opens with its caption", async () => {
    const fx = angiePage();
    const routes = new Map<string, { type: string; body: Uint8Array | string }>([["/post/angie", { type: "text/html", body: fx.html }]]);
    for (const [path, body] of fx.files) routes.set(path, { type: "image/jpeg", body });
    const site = await serve(routes);
    const model = await stubModel([["Watts Towers", "place"], ["Virginia Sullivan", "person"], ["Martinez Daily Standard", "organization"]]);
    stops.push(() => site.server.close(), () => model.server.close());
    const dir = freshMuseum("admin-pulled");
    const pulled = await mw(["pull", `${site.url}/post/angie`, "--propose", "--model-url", model.url, "--museum", dir]);
    assert.equal(pulled.code, 0, pulled.out);
    const queued = execFileSync("ls", [join(dir, "src/data/corrections")], { encoding: "utf8" }).split("\n").filter((f) => f.endsWith(".json")).length;
    commit(dir);
    const { url, proc } = await devServer(dir);
    stops.push(() => proc.kill());

    const o = await openAdmin(browser, dir, url, "someone", "admin-pulled");
    await signIn(o);
    assert.deepEqual(await counts(o.page), { Corrections: queued, Records: 11, Entities: 0, "Open questions": 0, Evidence: 0 });
    assert.match(await o.text(), /name · r-0001#p\d+ — .* · proposed · (Watts Towers|Virginia Sullivan|Martinez Daily Standard)/);

    await o.page.goto(`${url}#/collections/records/entries/r-0003`);
    await o.page.getByText("Caption (verbatim)").first().waitFor({ timeout: 15_000 });
    const captions = await o.page.locator("textarea").evaluateAll((els) => els.map((e) => (e as HTMLTextAreaElement).value));
    assert.ok(captions.includes(fx.captions[1]), `the editor shows the caption verbatim: ${JSON.stringify(captions)}`);
    assert.deepEqual(o.unknown, []);
    assert.deepEqual(o.errors, []);
  });
});
