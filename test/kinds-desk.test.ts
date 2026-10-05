/**
 * Proposal kinds at the desk: a museum made at the desk, a page pulled in
 * with every kind proposed, then each kept or held back, and what each
 * becomes: a Both Stand entry, a question, a link, a merge.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { chromium, type Browser } from "playwright-core";
import { box, client, type Box } from "./admin/box.ts";
import { executablePath, noBrowser } from "./admin/browser.ts";
import { answers } from "./fixtures/angie/answers.ts";
import { angiePage } from "./fixtures/angie/page.ts";
import { serve, stubModel, tmp } from "./helpers.ts";

process.env.MW_NOW = "2026-10-04T12:00:00Z";
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

describe("proposal kinds at the desk", () => {
  let b: Box;
  let c: ReturnType<typeof client>;
  let site: Awaited<ReturnType<typeof serve>>;
  let model: Awaited<ReturnType<typeof stubModel>>;
  const root = tmp("kinds-desk");
  const of = async (kind: string) => (await c.req("state")).body.queue.find((q: { kind: string; status: string }) => q.kind === kind);

  before(async () => {
    const fx = angiePage();
    const routes = new Map<string, { type: string; body: Uint8Array | string }>([["/post/angie", { type: "text/html", body: fx.html }]]);
    for (const [path, body] of fx.files) routes.set(path, { type: "image/jpeg", body });
    site = await serve(routes);
    model = await stubModel([], answers);
    b = await box(join(root, "museum"), join(root, "state"));
    c = client(b.url);
    await c.req("setup", { code: b.setupCode, passcode: "lanternfish", name: "Andrew" });
    await c.req("create", { mode: "new", name: "Kinds Museum" });
    const pulled = await c.req("pull", { url: `${site.url}/post/angie`, propose: true, modelUrl: model.url });
    assert.equal(pulled.body.ok, true, JSON.stringify(pulled.body));
  });
  after(() => {
    b.server.close();
    site.server.close();
    model.server.close();
  });

  it("shows each kind with its citations and their words", async () => {
    const s = (await c.req("state")).body;
    const kinds = [...new Set(s.queue.map((q: { kind: string }) => q.kind))].sort();
    assert.deepEqual(kinds, ["contradiction", "duplicate", "gap", "link", "question"]);
    for (const q of s.queue) {
      assert.equal(q.holds, true, q.id);
      for (const ct of q.citations) assert.ok(ct.text.includes(ct.quote));
    }
  });

  it("keeps a contradiction as a Both Stand entry, both claims cited, neither resolved", async () => {
    const q = await of("contradiction");
    const p = await c.req("keep", { id: q.id, title: "Born in 1917, or 1919?", preview: true });
    assert.deepEqual(p.body.diff.map((d: { path: string }) => d.path), ["src/model/both-stand/born-in-1917-or-1919.json", `src/data/corrections/${q.id}.json`]);
    const k = await c.req("keep", { id: q.id, title: "Born in 1917, or 1919?" });
    assert.equal(k.body.ok, true, JSON.stringify(k.body));
    const entry = json(join(b.dir, "src/model/both-stand/born-in-1917-or-1919.json"));
    assert.deepEqual([entry.status, entry.claim_a.quote, entry.claim_b.quote, entry.from_proposal], ["standing", "born on July 21, 1917", "listing her as age 1", q.id]);
    const slice = await (await fetch(`${b.url}/data/museum.json`)).text();
    assert.match(slice, /"title": "Born in 1917, or 1919\?"/);
    assert.ok(!slice.includes(q.id), "the public entry carries no proposal ID");
  });

  it("settles a Both Stand entry only with a note", async () => {
    assert.equal((await c.req("settle", { id: "born-in-1917-or-1919", note: " " })).status, 400);
    const r = await c.req("settle", { id: "born-in-1917-or-1919", note: "The 1920 census gives ages loosely; the birth record says 1917." });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.equal(json(join(b.dir, "src/model/both-stand/born-in-1917-or-1919.json")).status, "settled");
  });

  it("keeps a question and a gap as open questions, raised by their record; a question is bounded", async () => {
    const q = await of("question");
    assert.equal((await c.req("keep", { id: q.id, question: { title: q.question.text } })).status, 400, "what we know etc. are required");
    const fields = { what_we_know: "She had surgery at thirteen.", what_might_answer_it: "Hospital records.", evidence_needed: "A hospital record." };
    const k = await c.req("keep", { id: q.id, question: { title: q.question.text, what_we_dont: "What the operation was.", ...fields } });
    assert.equal(k.body.ok, true, JSON.stringify(k.body));
    const g = await of("gap");
    const kg = await c.req("keep", { id: g.id, question: { title: "Where was she from 1942 into the 1950s?", ...fields } });
    assert.equal(kg.body.ok, true, JSON.stringify(kg.body));
    const qs = readdirSync(join(b.dir, "src/model/questions")).filter((f) => f.endsWith(".json")).map((f) => json(join(b.dir, "src/model/questions", f)));
    const fromGap = qs.find((x) => x.from_proposal === g.id);
    assert.deepEqual([fromGap.what_we_dont, fromGap.last_known_source, fromGap.status], ["where she was, and under what name", ["r-0001"], "open"]);
    assert.ok(qs.some((x) => x.from_proposal === q.id));
  });

  it("keeps a link as a quiet door on both records", async () => {
    const q = await of("link");
    const k = await c.req("keep", { id: q.id });
    assert.equal(k.body.ok, true, JSON.stringify(k.body));
    const links = json(join(b.dir, "src/model/links.json"));
    assert.deepEqual([links[0].id, links[0].from, links[0].basis], ["ln-001", "r-0001", "shared name"]);
    assert.match(await (await fetch(`${b.url}/data/museum.json`)).text(), /"basis": "shared name"/);
  });

  it("marks a duplicate for merging, then merges it as the curator's act: one retired, a note on the other", async () => {
    const q = await of("duplicate");
    const marked = await c.req("keep", { id: q.id });
    assert.equal(marked.body.ok, true, JSON.stringify(marked.body));
    assert.equal(json(join(b.dir, `src/data/corrections/${q.id}.json`)).status, "accepted");
    assert.ok(existsSync(join(b.dir, `src/model/records/${q.pair.b}.json`)), "marking merges nothing");
    const merged = await c.req("merge", { id: q.id, keep: q.pair.a });
    assert.equal(merged.body.ok, true, JSON.stringify(merged.body));
    assert.ok(!existsSync(join(b.dir, `src/model/records/${q.pair.b}.json`)));
    assert.ok(json(join(b.dir, "meta/tombstones.json")).some((t: { id: string }) => t.id === q.pair.b));
    assert.match(json(join(b.dir, `src/model/records/${q.pair.a}.json`)).notes.at(-1).note, new RegExp(`${q.pair.b} merged into this record`));
    assert.equal(json(join(b.dir, `src/data/corrections/${q.id}.json`)).status, "applied");
    assert.equal((await c.req("state")).body.check.ok, true);
  });

  it("refuses to keep one whose citation isn't in its span, and says which", async () => {
    // A contradiction arriving from elsewhere, its quote not in its span, committed past the check.
    const bad = { id: "c-9999", kind: "contradiction", target: "r-0001#p8", proposed_text: "x", cites: [{ span: "r-0001#p8", quote: "born in 1915" }, { span: "r-0001#p12", quote: "listing her as age 1" }], reason: "r", proposed_by: "elsewhere", date: "2026-10-04", status: "proposed" };
    writeFileSync(join(b.dir, "src/data/corrections/c-9999.json"), JSON.stringify(bad, null, 2) + "\n");
    execFileSync("git", ["add", "-A"], { cwd: b.dir });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "bad"], { cwd: b.dir });
    const r = await c.req("keep", { id: "c-9999", title: "Nope" });
    assert.equal(r.status, 422);
    assert.match(r.body.refusal, /the span r-0001#p8 doesn't contain “born in 1915”/);
    execFileSync("git", ["rm", "-q", "src/data/corrections/c-9999.json"], { cwd: b.dir });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "out"], { cwd: b.dir });
  });

  it("the queue's decisions are all in the museum's history, in the curator's name", () => {
    const log = execFileSync("git", ["log", "--format=%an|%s"], { cwd: b.dir, encoding: "utf8" });
    for (const s of [/Andrew\|Both stand: Born in 1917, or 1919\?/, /Andrew\|Open a question from c-/, /Andrew\|Link r-0001 and r-/, /Andrew\|Merge r-/]) assert.match(log, s);
  });
});

describe("proposal kinds at the desk, in Chromium", { skip: noBrowser }, () => {
  let b: Box;
  let site: Awaited<ReturnType<typeof serve>>;
  let model: Awaited<ReturnType<typeof stubModel>>;
  let browser: Browser;
  const root = tmp("kinds-chromium");

  before(async () => {
    const fx = angiePage();
    const routes = new Map<string, { type: string; body: Uint8Array | string }>([["/post/angie", { type: "text/html", body: fx.html }]]);
    for (const [path, body] of fx.files) routes.set(path, { type: "image/jpeg", body });
    site = await serve(routes);
    model = await stubModel([], answers);
    b = await box(join(root, "museum"), join(root, "state"));
    const c = client(b.url);
    await c.req("setup", { code: b.setupCode, passcode: "lanternfish", name: "Andrew" });
    await c.req("create", { mode: "new", name: "Kinds Museum" });
    await c.req("pull", { url: `${site.url}/post/angie`, propose: true, modelUrl: model.url });
    browser = await chromium.launch({ executablePath });
  });
  after(async () => {
    await browser?.close();
    b?.server.close();
    site?.server.close();
    model?.server.close();
  });

  it("lets a contradiction stand, judges a duplicate distinct, and visitors see the Both Stand entry", async () => {
    const errors: string[] = [];
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${b.url}/desk/`);
    await page.getByLabel("Passcode").fill("lanternfish");
    await page.getByLabel(/Your name/).fill("Andrew");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("heading", { name: "Queue" }).waitFor();
    const row = (k: string) => page.locator("article.row", { has: page.locator(".chip", { hasText: new RegExp(`^${k}$`) }) }).first();

    const contradiction = row("contradiction");
    assert.equal(await contradiction.locator("mark").count(), 2, "both claims marked in their spans");
    await contradiction.getByRole("button", { name: "Let both stand…" }).click();
    await contradiction.getByLabel("The Both Stand entry's title").fill("Born in 1917, or 1919?");
    await contradiction.getByRole("button", { name: "Show the change" }).click();
    await contradiction.locator(".diff .path", { hasText: "new file: src/model/both-stand/born-in-1917-or-1919.json" }).waitFor();
    await contradiction.getByRole("button", { name: "Write it" }).click();
    await page.locator("#notice.ok").waitFor();

    await page.getByRole("heading", { name: "Queue" }).waitFor();
    const duplicate = row("duplicate");
    await duplicate.getByRole("button", { name: "They're distinct" }).click();
    await duplicate.getByRole("button", { name: "Write it" }).click();
    await page.locator("#notice.ok", { hasText: /Hold back/ }).waitFor();

    await page.goto(`${b.url}/desk/#/both-stand`);
    await page.getByRole("heading", { name: "Born in 1917, or 1919?" }).waitFor();
    const visitor = await browser.newPage();
    await visitor.goto(`${b.url}/#/both-stand`);
    await visitor.getByText("Born in 1917, or 1919?").waitFor();
    assert.match(await visitor.locator("main").innerText(), /“born on July 21, 1917”[\s\S]*“listing her as age 1”/);
    assert.deepEqual(errors, []);
  });
});
