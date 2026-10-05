/**
 * §8, the Angie test: mw pull on the Angie page (the local reconstruction,
 * fixtures/angie), then what the admin would open.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { angiePage } from "./fixtures/angie/page.ts";
import { freshMuseum, jsonIn, mw, readJson, run, serve, stubModel, tree } from "./helpers.ts";

const fx = angiePage();
const routes = new Map<string, { type: string; body: Uint8Array | string }>([
  ["/post/angie", { type: "text/html; charset=utf-8", body: fx.html }],
  ...[...fx.files].map(([path, body]) => [path, { type: path.endsWith(".gif") ? "image/gif" : "image/jpeg", body }] as const),
]);
const NAMES: [string, string][] = [
  ["Angelina Jean Colacurcio", "person"],
  ["Martinez, California", "place"],
  ["Saverio \"Sam\" Calicura", "person"],
  ["Watts Towers", "place"],
  ["Martinez Daily Standard", "organization"],
  ["Edna Lee's Beauty Salon No. 2", "organization"],
  ["Virginia Sullivan", "person"],
];

describe("the Angie test", () => {
  let site: Awaited<ReturnType<typeof serve>>;
  let model: Awaited<ReturnType<typeof stubModel>>;
  let dir: string;
  let first: { code: number | null; out: string };
  const records = () => jsonIn(join(dir, "src/model/records"));
  const corrections = () => jsonIn(join(dir, "src/data/corrections"));

  before(async () => {
    site = await serve(routes);
    model = await stubModel(NAMES);
    dir = freshMuseum("angie-test");
    first = await mw(["pull", `${site.url}/post/angie`, "--propose", "--model-url", model.url, "--museum", dir]);
  });
  after(() => {
    site.server.close();
    model.server.close();
  });

  it("runs, and the build passes before anyone marks a name kept", () => {
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /model check passed/);
    const built = run(dir, "scripts/cms-build.ts");
    assert.equal(built.code, 0, built.out);
  });

  it("1. plates are records with their captions and credits, verbatim, status unverified", () => {
    const all = records();
    const doc = all.find((r) => r.kind === "document");
    const plates = all.filter((r) => r.kind === "image").sort((a, b) => a.position - b.position);
    assert.equal(doc.title, fx.title);
    assert.equal(doc.credit, fx.author);
    assert.deepEqual(doc.passages.map((p: { text: string }) => p.text), fx.paragraphs);
    // Eight captioned images and one without a caption; the pixel, the logo and the repeat are not plates.
    assert.equal(plates.length, 9);
    const captioned = plates.filter((p) => p.caption);
    assert.deepEqual(captioned.map((p) => p.caption), fx.captions);
    const bare = plates.find((p) => !p.caption);
    assert.equal(bare.caption, "", "an image without a caption is honestly empty");
    for (const p of plates) {
      assert.equal(p.status, "unverified");
      assert.equal(p.held, true);
      assert.equal(p.credit, "", "the page marks no credit apart from the caption, so none is invented");
      assert.equal(p.found_in, doc.id);
      assert.equal(p.source.url, `${site.url}/post/angie`);
      assert.equal(p.source.extracted_at, "2026-10-04T12:00:00Z");
      const bytes = readFileSync(join(dir, p.media[0]));
      assert.ok(bytes.length > 1000);
    }
    for (const r of all) assert.equal(r.status, "unverified");
  });

  it("fetches the srcset's largest within the cap, and only the files it keeps", () => {
    const plate2 = records().find((r) => r.kind === "image" && r.position === 2);
    assert.match(plate2.source.file_url, /\/media\/plate-2\.jpg$/);
    assert.deepEqual(new Uint8Array(readFileSync(join(dir, plate2.media[0]))), fx.files.get("/media/plate-2.jpg"));
    assert.ok(!site.hits.includes("/media/plate-2-w9000.jpg"));
    assert.ok(!site.hits.includes("/media/logo.jpg"), "the header's logo is chrome, not fetched");
    const uploads = readdirSync(join(dir, "public/images/uploads")).filter((f) => f !== ".gitkeep");
    assert.equal(uploads.length, 9);
  });

  it("keeps the skipped content as a log record", () => {
    const log = records().find((r) => r.kind === "log");
    const text = log.passages.map((p: { text: string }) => p.text).join("\n");
    for (const dropped of ["Home About Blog Contact", "Advertisement", "Share on Facebook", "Write a comment", "Subscribe to the newsletter", "Recent posts", "All rights reserved", "decoration, 1×1", "the same image again"])
      assert.ok(text.includes(dropped), `log names ${dropped}`);
    const doc = records().find((r) => r.kind === "document");
    const prose = doc.passages.map((p: { text: string }) => p.text).join("\n");
    for (const chrome of ["Advertisement", "Share on Facebook", "Subscribe", "All rights reserved", "Recent posts"]) assert.ok(!prose.includes(chrome));
  });

  it("2. the entity list is empty", () => {
    assert.deepEqual(readdirSync(join(dir, "src/model/entities")), [".gitkeep"]);
    assert.deepEqual(readJson(join(dir, "src/model/evidence.json")), []);
    assert.deepEqual(readdirSync(join(dir, "src/model/questions")), [".gitkeep"]);
  });

  it("4. --propose: noticed names are in the corrections queue as proposed, each citing a span that contains the string", () => {
    const all = records();
    const spans = new Map<string, string>();
    for (const r of all) {
      for (const p of r.passages ?? []) spans.set(`${r.id}#${p.id}`, p.text);
      if (r.kind === "image") spans.set(`plate:${r.id}`, r.caption);
    }
    const queue = corrections();
    assert.ok(queue.length >= NAMES.length, `${queue.length} proposals`);
    for (const c of queue) {
      assert.equal(c.kind, "name");
      assert.equal(c.status, "proposed");
      assert.ok(spans.get(c.target)?.includes(c.proposed_text), `${c.id}: ${c.target} contains "${c.proposed_text}"`);
      assert.match(c.source.model, /Qwen3-1\.7B/);
    }
    assert.ok(!queue.some((c) => c.proposed_text === "Josephine Bonaparte"), "a name not in its span is dropped");
    assert.ok(queue.some((c) => c.target.startsWith("plate:")), "captions are spans too");
    assert.match(first.out, /dropped by the span rule/);
    assert.ok(model.prompts.length > 0);
  });

  it("the public slice carries no proposal", () => {
    const built = run(dir, "scripts/build-public.ts");
    assert.equal(built.code, 0, built.out);
    const slice = readFileSync(join(dir, "public/data/museum.json"), "utf8");
    for (const c of corrections()) assert.ok(!slice.includes(c.id));
  });

  it("5. a re-run over the same input changes nothing: same IDs, no duplicate entries", async () => {
    const before = tree(dir);
    const again = await mw(["pull", `${site.url}/post/angie`, "--propose", "--model-url", model.url, "--museum", dir], { MW_NOW: "2026-10-05T09:30:00Z" });
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /claimed 0 new IDs/);
    assert.deepEqual(tree(dir), before);
  });

  it("same input, same IDs: a second museum pulled from the same page gets the same IDs", async () => {
    const other = freshMuseum("angie-twin");
    const r = await mw(["pull", `${site.url}/post/angie`, "--propose", "--model-url", model.url, "--museum", other]);
    assert.equal(r.code, 0, r.out);
    const ids = (d: string) => readdirSync(join(d, "src/model/records")).concat(readdirSync(join(d, "src/data/corrections"))).sort();
    assert.deepEqual(ids(other), ids(dir));
    assert.deepEqual(readJson(join(other, "meta/sequences.json")), readJson(join(dir, "meta/sequences.json")));
  });

  it("with no model reachable, the run completes with an empty pile and says so", async () => {
    const other = freshMuseum("angie-nomodel");
    const r = await mw(["pull", `${site.url}/post/angie`, "--propose", "--model-url", "http://127.0.0.1:9", "--museum", other]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /no model reachable .*the pile is empty/);
    assert.deepEqual(readdirSync(join(other, "src/data/corrections")), [".gitkeep"]);
    assert.equal(jsonIn(join(other, "src/model/records")).length, 11);
  });
});
