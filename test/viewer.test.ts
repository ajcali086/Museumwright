/**
 * The viewer (structure/public/index.html, viewer.js): the generated
 * museum's plain pages over the public slice, opened in Chromium. Empty,
 * unbuilt, and after a pull with a kept name; a pulled page's words stay
 * words; nothing from the corrections queue shows.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { devServer, executablePath, noBrowser } from "./admin/browser.ts";
import { angiePage } from "./fixtures/angie/page.ts";
import { freshMuseum, jsonIn, mw, serve, stubModel } from "./helpers.ts";

describe("the viewer, opened in Chromium", { skip: noBrowser }, () => {
  let browser: Browser;
  const stops: (() => void)[] = [];
  const errors: string[] = [];
  before(async () => {
    browser = await chromium.launch({ executablePath });
  });
  after(async () => {
    await browser?.close();
    for (const stop of stops) stop();
  });

  async function open(url: string, width = 1000): Promise<Page> {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(url);
    await page.locator("main h1").first().waitFor({ timeout: 10_000 });
    return page;
  }
  const go = async (page: Page, hash: string) => {
    await page.evaluate((h) => (location.hash = h), hash);
    await page.waitForTimeout(150);
  };
  const text = (page: Page) => page.locator("main").innerText();

  it("an empty museum says it has no records; an unbuilt one says how to build", async () => {
    const dir = freshMuseum("viewer-empty");
    const built = await devServer(dir);
    stops.push(() => built.proc.kill());
    const page = await open(built.url);
    assert.match(await text(page), /This museum has no records yet\./);
    assert.equal(await page.title(), "Records · viewer-empty");

    const bare = freshMuseum("viewer-unbuilt");
    const unbuilt = await devServer(bare, { slice: false });
    stops.push(() => unbuilt.proc.kill());
    const page2 = await open(unbuilt.url);
    assert.match(await text(page2), /Nothing to show yet[\s\S]*npm run build/);
  });

  describe("after a pull, with one name kept", () => {
    const fx = angiePage();
    let url: string;
    let dir: string;
    let queue: { id: string; proposed_text: string }[];

    before(async () => {
      const routes = new Map<string, { type: string; body: Uint8Array | string }>([["/post/angie", { type: "text/html", body: fx.html }]]);
      for (const [path, body] of fx.files) routes.set(path, { type: "image/jpeg", body });
      const site = await serve(routes);
      const model = await stubModel([["Watts Towers", "place"], ["Virginia Sullivan", "person"]]);
      stops.push(() => site.server.close(), () => model.server.close());
      dir = freshMuseum("viewer-pulled");
      const pulled = await mw(["pull", `${site.url}/post/angie`, "--propose", "--model-url", model.url, "--museum", dir]);
      assert.equal(pulled.code, 0, pulled.out);
      queue = jsonIn(join(dir, "src/data/corrections"));
      assert.ok(queue.length > 0);
      writeFileSync(join(dir, "src/model/entities/watts-towers.json"), JSON.stringify({ id: "0a1b2c3d", slug: "watts-towers", kind: "place", label: "Watts Towers", anchors: ["r-0001"] }, null, 2));
      // A hand-made record whose words look like markup: they must stay words.
      writeFileSync(join(dir, "src/model/records/hostile.json"), JSON.stringify({ id: "hostile", kind: "object", title: '<img src=x onerror="window.pwned=1">', caption: "<script>window.pwned=2</script>", held: false, status: "not-held", media: [] }, null, 2));
      const built = await devServer(dir);
      stops.push(() => built.proc.kill());
      url = built.url;
    });

    it("lists the document with its plates, in order", async () => {
      const page = await open(url);
      const main = await text(page);
      assert.match(main, new RegExp(`${fx.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*Unverified copy`));
      assert.match(main, /23 passages · 9 plates/);
      assert.equal(await page.locator("main .thumbs img").count(), 9);
      assert.match(main, /What the pull skipped/);
    });

    it("shows the document's text with each plate after the passage it follows, captions verbatim", async () => {
      const page = await open(url);
      await go(page, "#/records/r-0001");
      const passages = await page.locator("main p.passage").allInnerTexts();
      assert.deepEqual(passages, fx.paragraphs.slice(1), "every passage but the title, which is the heading");
      const captions = (await page.locator("main figure.plate figcaption").allInnerTexts()).map((c) => c.split("\n")[0]);
      const records = jsonIn(join(dir, "src/model/records")).filter((r) => r.kind === "image").sort((a, b) => a.position - b.position);
      assert.deepEqual(captions, records.map((r) => r.caption || "No caption given."));
      // Each plate sits after the passage it follows, with only plates between.
      const placed = await page.locator("main figure.plate").evaluateAll((figs) =>
        figs.map((f) => {
          let el = f.previousElementSibling;
          while (el && el.tagName === "FIGURE") el = el.previousElementSibling;
          return [f.id, el?.id ?? ""];
        }),
      );
      assert.deepEqual(placed, records.map((r) => [r.id, r.follows ? `r-0001-${r.follows}` : ""]));
    });

    it("opens a plate with its image, caption and source", async () => {
      const page = await open(url);
      await go(page, "#/records/r-0003");
      const img = page.locator("main figure.plate img");
      await img.waitFor();
      assert.ok(await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), "the held file loads");
      const main = await text(page);
      assert.ok(main.includes(fx.captions[1]));
      assert.match(main, /Found in .*plate 2/);
      assert.match(main, /File as fetched/);
    });

    it("shows a kept name as an entity, linked to the record that spells it", async () => {
      const page = await open(url);
      await go(page, "#/entities/watts-towers");
      assert.match(await text(page), /PLACE\s+Watts Towers[\s\S]*Records that name it/i);
      await go(page, "#/records/r-0001");
      assert.match(await text(page), /Names it\s+Watts Towers/);
    });

    it("keeps a record's words as words, however they look", async () => {
      const page = await open(url);
      await go(page, "#/records/hostile");
      assert.equal(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned), undefined);
      assert.equal(await page.locator("main img").count(), 0);
      assert.ok((await text(page)).includes('<img src=x onerror="window.pwned=1">'));
    });

    it("never shows the queue, on any page", async () => {
      const page = await open(url);
      const pages = ["#/", "#/records/r-0001", "#/records/r-0003", "#/records/r-0011", "#/entities", "#/entities/watts-towers", "#/questions", "#/evidence"];
      for (const hash of pages) {
        await go(page, hash);
        const body = await page.locator("body").innerText();
        for (const c of queue) assert.ok(!body.includes(c.id), `${hash} shows ${c.id}`);
        assert.ok(!/\bproposed\b/i.test(body), `${hash} mentions a proposal`);
      }
      const slice = readFileSync(join(dir, "public/data/museum.json"), "utf8");
      for (const c of queue) assert.ok(!slice.includes(c.id));
      assert.ok(readdirSync(join(dir, "public")).every((f) => f !== "corrections"));
    });

    it("fits a phone: no sideways scroll", async () => {
      const page = await open(url, 375);
      for (const hash of ["#/", "#/records/r-0001", "#/records/r-0003"]) {
        await go(page, hash);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, hash);
      }
    });

    it("throws no page errors", () => {
      assert.deepEqual(errors, []);
    });
  });
});
