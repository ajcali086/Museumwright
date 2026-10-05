/**
 * The local admin in Chromium: Collection → archival work → site, on a box
 * with no remote. Take in a file, catalogue a record by hand, make an
 * entity, open a question, link evidence, correct a passage (proposed,
 * accepted, applied), and see it on the site.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { createMuseumServer } from "../src/serve/server.ts";
import { executablePath, noBrowser } from "./admin/browser.ts";
import { tmp } from "./helpers.ts";

describe("the local admin, in Chromium, no remote", { skip: noBrowser }, () => {
  let browser: Browser;
  let page: Page;
  let server: Server;
  let url: string;
  const errors: string[] = [];
  const root = tmp("local-desk");

  before(async () => {
    const box = createMuseumServer({ museum: join(root, "museum"), state: join(root, "state"), quiet: true });
    server = box.server;
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await chromium.launch({ executablePath });
    page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${url}/desk/`);
    await page.getByLabel("Setup code").fill(box.desk.setupCode);
    await page.getByLabel(/Choose a passcode/).fill("lanternfish");
    await page.getByLabel(/Your name/).fill("Andrew");
    await page.getByRole("button", { name: "Set up" }).click();
    await page.getByLabel("Name", { exact: true }).fill("The Mill Museum");
    await page.getByRole("button", { name: "Create the museum" }).click();
    await page.getByRole("heading", { name: "Queue" }).waitFor();
  });
  after(async () => {
    await browser?.close();
    server?.close();
  });

  const go = async (hash: string, heading: string | RegExp) => {
    await page.goto(`${url}/desk/#/${hash}`);
    await page.getByRole("heading", { name: heading }).first().waitFor();
  };
  /** Show the change, then write it, and wait for the desk to say it is committed. */
  const write = async (scope: ReturnType<Page["locator"]>, button: string | RegExp) => {
    await scope.getByRole("button", { name: button }).click();
    await scope.getByRole("button", { name: "Write it" }).click();
    await page.locator("#notice.ok").waitFor();
    assert.match(await page.locator("#notice").innerText(), /committed [0-9a-f]+/);
    await page.locator("#notice.ok").evaluate((n) => ((n as HTMLElement).className = ""));
  };

  it("collection: takes in a file from the box", async () => {
    await go("add", "Add to the archive");
    const file = join(root, "ledger.txt");
    writeFileSync(file, "Received of Ezra Pound, ten dollars, for the mill.\n\nPaid in full, May 1911.\n");
    await page.getByLabel("Files").setInputFiles(file);
    await page.getByRole("button", { name: "Take them in" }).click();
    await page.locator("#notice.ok").waitFor();
  });

  it("archival work: catalogues a record by hand", async () => {
    await go("records", /^Records/);
    await page.getByRole("button", { name: "Catalogue a record" }).click();
    await page.getByRole("heading", { name: "Catalogue a record" }).waitFor();
    const form = page.locator("form.editor");
    await form.getByLabel("Title").fill("The mill's bell");
    await form.getByLabel(/^Caption/).fill("Cast iron, the date ground off.");
    await write(form, "Show the record…");
    await go("records", /^Records/);
    await page.getByRole("link", { name: "r-0002" }).waitFor();
  });

  it("archival work: makes an entity anchored to the record that spells it", async () => {
    await go("entities/new", "A new entity");
    const form = page.locator("form.editor");
    await form.getByLabel("Name as shown").fill("Ezra Pound");
    await form.getByLabel(/Anchored by/).selectOption(["r-0001"]);
    await write(form, "Show the entity…");
    await go("entities", /^Entities/);
    await page.getByRole("link", { name: "Ezra Pound" }).waitFor();
  });

  it("archival work: opens a question, and links evidence", async () => {
    await go("questions/new", "Open a question");
    const q = page.locator("form.editor");
    await q.getByLabel("The question").fill("When was the bell cast?");
    await q.getByLabel("What we know", { exact: true }).fill("The date is ground off.");
    await q.getByLabel("What we don't").fill("The year.");
    await q.getByLabel("What might answer it").fill("The foundry's books.");
    await q.getByLabel("Evidence needed").fill("A record of the casting.");
    await q.getByLabel("Rests on").selectOption(["r-0002"]);
    await write(q, "Show the question…");

    await go("evidence", /^Evidence/);
    const e = page.locator("form.editor");
    await e.getByLabel(/The claim/).selectOption("r-0001#p2");
    await e.getByLabel(/Its words/).fill("May 1911");
    await e.getByLabel(/The record that bears/).selectOption("r-0001");
    await write(e, "Show the link…");
    await page.getByRole("cell", { name: "ev-001" }).waitFor();
  });

  it("archival work: a passage corrected: proposed on the record, accepted and applied in the queue", async () => {
    await go("records/r-0001", "ledger.txt");
    const passage = page.locator(".passage", { hasText: "r-0001#p1" });
    await passage.getByRole("button", { name: "Propose a correction" }).click();
    await passage.getByLabel("As it should read, whole").fill("Received of Ezra Pound, ten dollars, for the mill race.");
    await passage.getByLabel("Why").fill("The ledger's page says race.");
    await write(passage, "Propose the correction…");
    await go("queue", "Queue");
    const row = page.locator("article.row").first();
    assert.match(await row.innerText(), /Reads now[\s\S]*for the mill\.[\s\S]*Should read[\s\S]*for the mill race\./);
    await write(row, "Accept…");
    await write(page.locator("article.row").first(), "Apply it…");
    await page.getByRole("button", { name: /Decided/ }).click();
    assert.match(await page.locator("article.row").first().innerText(), /applied[\s\S]*Read before[\s\S]*for the mill\./);
  });

  it("site: visitors see the museum as it now stands, with no GitHub and nothing from the queue", async () => {
    await go("site", "Site");
    assert.match(await page.locator("main").innerText(), /Visitors see\s+2\s+records\s+1\s+entities\s+1\s+questions\s+1\s+evidence links/);
    assert.match(await page.locator("#check-dot").getAttribute("class") ?? "", /\bok\b/);
    const visitor = await browser.newPage();
    await visitor.goto(`${url}/#/records/r-0001`);
    await visitor.getByText("for the mill race.").waitFor();
    assert.ok(!/\bproposed\b|c-000\d/.test(await visitor.locator("body").innerText()));
    await visitor.close();
    assert.deepEqual(errors, []);
  });
});
