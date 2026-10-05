/**
 * The desk, in Chromium: a museum built from nothing through the browser
 * alone. Set up the desk with the console's code, create the museum, pull a
 * page with names proposed, keep one (seeing the change first), hold one
 * back, take in a photo with a note, and see it all in the museum's viewer.
 */
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { createMuseumServer } from "../src/serve/server.ts";
import { executablePath, noBrowser } from "./admin/browser.ts";
import { angiePage } from "./fixtures/angie/page.ts";
import { serve, stubModel, tmp } from "./helpers.ts";

describe("the desk, in Chromium, from nothing", { skip: noBrowser }, () => {
  let browser: Browser;
  let page: Page;
  let server: Server;
  let url: string;
  let setupCode: string;
  let site: Awaited<ReturnType<typeof serve>>;
  let model: Awaited<ReturnType<typeof stubModel>>;
  const errors: string[] = [];
  const root = tmp("desk");

  before(async () => {
    const fx = angiePage();
    const routes = new Map<string, { type: string; body: Uint8Array | string }>([["/post/angie", { type: "text/html", body: fx.html }]]);
    for (const [path, body] of fx.files) routes.set(path, { type: "image/jpeg", body });
    site = await serve(routes);
    model = await stubModel([["Watts Towers", "place"], ["Virginia Sullivan", "person"]]);
    const box = createMuseumServer({ museum: join(root, "museum"), state: join(root, "state"), quiet: true });
    server = box.server;
    setupCode = box.desk.setupCode;
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await chromium.launch({ executablePath });
    page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    page.on("pageerror", (e) => errors.push(e.message));
  });
  after(async () => {
    await browser?.close();
    server?.close();
    site?.server.close();
    model?.server.close();
  });

  const notice = () => page.locator("#notice");
  const nav = (name: RegExp) => page.locator("#nav").getByRole("link", { name });

  it("sets up the desk with the setup code, and creates the museum", async () => {
    await page.goto(`${url}/desk/`);
    await page.getByRole("heading", { name: "Set up the desk" }).waitFor();
    await page.getByLabel("Setup code").fill(setupCode);
    await page.getByLabel(/Choose a passcode/).fill("lanternfish");
    await page.getByLabel(/Your name/).fill("Andrew");
    await page.getByRole("button", { name: "Set up" }).click();
    await page.getByRole("heading", { name: "No museum here yet" }).waitFor();
    await page.getByLabel("Name", { exact: true }).fill("Desk Museum");
    await page.getByRole("button", { name: "Create the museum" }).click();
    await page.getByRole("heading", { name: "Queue" }).waitFor();
    assert.match(await notice().innerText(), /Created the museum/);
    assert.equal(await page.locator("#museum-title").innerText(), "Desk Museum");
  });

  it("pulls a page with names proposed, and the queue shows each in its span", async () => {
    await nav(/Add/).click();
    await page.getByLabel("Page address").fill(`${site.url}/post/angie`);
    await page.getByLabel(/Local model/).fill(model.url);
    await page.getByRole("button", { name: "Pull it in" }).click();
    await page.locator("#notice.ok").waitFor({ timeout: 60_000 });
    assert.match(await notice().innerText(), /Pull .* · committed [0-9a-f]+/);
    await page.locator("pre.log", { hasText: /23 passages, 9 plates/ }).waitFor();
    await nav(/Queue/).click();
    await page.getByRole("heading", { name: "Queue" }).waitFor();
    const rows = page.locator("article.row");
    assert.ok((await rows.count()) >= 2);
    assert.equal(await rows.first().locator("mark").innerText(), await rows.first().locator(".name").innerText(), "the span spells the name, marked");
  });

  it("keeps a name: shows the change first, then writes it", async () => {
    const row = page.locator("article.row", { has: page.locator(".name", { hasText: /^Watts Towers$/ }) }).first();
    await row.getByRole("button", { name: "Keep…" }).click();
    await row.getByLabel("Kind").selectOption("place");
    await row.getByRole("button", { name: "Show the change" }).click();
    await row.locator(".diff .path", { hasText: "new file: src/model/entities/watts-towers.json" }).waitFor();
    await row.getByRole("button", { name: "Write it" }).click();
    await page.locator("#notice.ok").waitFor();
    assert.match(await notice().innerText(), /Keep “Watts Towers” .* · committed/);
    await nav(/Entities/).click();
    await page.getByRole("heading", { name: /^Entities/ }).waitFor();
    await page.getByRole("link", { name: "Watts Towers" }).click();
    await page.getByRole("heading", { name: /Watts Towers/ }).waitFor();
    assert.match(await page.locator("main").innerText(), /Anchored by[\s\S]*Kept from[\s\S]*kept by Andrew/);
  });

  it("holds one back, and the queue moves it to Held back", async () => {
    await nav(/Queue/).click();
    await page.getByRole("heading", { name: "Queue" }).waitFor();
    const row = page.locator("article.row").first();
    const name = await row.locator(".name").innerText();
    await row.getByRole("button", { name: "Hold back" }).click();
    await row.getByRole("button", { name: "Write it" }).click();
    await page.locator("#notice.ok").waitFor();
    await page.getByRole("button", { name: /Held back/ }).click();
    await page.getByRole("button", { name: /Held back/, pressed: true }).waitFor();
    assert.ok((await page.locator("article.row .name").allInnerTexts()).includes(name));
  });

  it("takes in a phone's photo with a note", async () => {
    await nav(/Add/).click();
    await page.getByRole("heading", { name: "Add to the archive" }).waitFor();
    await page.getByLabel("Take a photo").setInputFiles(fileURLToPath(new URL("./fixtures/angie/plate-07.jpg", import.meta.url)));
    await page.getByPlaceholder(/What this is/).fill("The garden, from the porch.");
    await page.getByRole("button", { name: "Take them in" }).click();
    await page.locator("#notice.ok").waitFor({ timeout: 30_000 });
    await nav(/Records/).click();
    await page.getByRole("heading", { name: /^Records/ }).waitFor();
    await page.getByRole("link", { name: "r-0012" }).click();
    await page.getByRole("heading", { name: "plate-07.jpg" }).waitFor();
    assert.match(await page.locator("main").innerText(), /plate-07\.jpg[\s\S]*Andrew: The garden, from the porch\./);
  });

  it("checks green, and the museum's viewer shows the kept name, never the queue", async () => {
    await nav(/Check/).click();
    await page.getByRole("heading", { name: "Check" }).waitFor();
    assert.match(await page.locator("main").innerText(), /The model check passes/);
    const visitor = await browser.newPage();
    await visitor.goto(`${url}/#/entities`);
    await visitor.getByRole("link", { name: "Watts Towers" }).waitFor();
    const text = await visitor.locator("body").innerText();
    assert.ok(!/\bproposed\b|c-000\d/.test(text));
    assert.equal((await visitor.request.get(`${url}/desk/api/state`)).status(), 401, "a visitor has no way into the desk");
    await visitor.close();
  });

  it("signs out to the gate, with no page errors along the way", async () => {
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("heading", { name: "Sign in to the desk" }).waitFor();
    assert.deepEqual(errors, []);
  });
});
