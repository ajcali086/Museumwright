/**
 * The local admin: a museum built and edited at the desk with no remote at
 * all. Records by hand, entities, questions, evidence, text corrections
 * proposed, accepted and applied, a record retired; each refusal where the
 * museum's rules say no. Nothing here needs GitHub, the web, or Sveltia.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { box, client, type Box } from "./admin/box.ts";
import { tmp } from "./helpers.ts";

process.env.MW_NOW = "2026-10-04T12:00:00Z";
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

describe("the local admin, no remote", () => {
  let b: Box;
  let c: ReturnType<typeof client>;
  const root = tmp("local");
  const save = (collection: string, data: Record<string, unknown>, preview = false) => c.req("save", { collection, data, preview });

  before(async () => {
    b = await box(join(root, "museum"), join(root, "state"));
    c = client(b.url);
    await c.req("setup", { code: b.setupCode, passcode: "lanternfish", name: "Andrew" });
    const made = await c.req("create", { mode: "new", name: "Local Museum" });
    assert.equal(made.body.ok, true, JSON.stringify(made.body));
    // A held photograph to work with, taken in from the box itself.
    await c.upload("intake-local-1", "mill.jpg", new Uint8Array(readFileSync(new URL("./fixtures/angie/plate-07.jpg", import.meta.url))));
    await c.upload("intake-local-1", "ledger.txt", new TextEncoder().encode("Received of Ezra Pound, ten dollars, for the mill.\n\nPaid in full, May 1911.\n"));
    const taken = await c.req("ingest", { intake: "intake-local-1" });
    assert.equal(taken.body.ok, true, JSON.stringify(taken.body));
  });
  after(() => b.server.close());

  it("has no remote, and needs none", async () => {
    const s = (await c.req("state")).body;
    assert.equal(s.git.remote, null);
    assert.equal(s.check.ok, true);
    assert.deepEqual(s.records.map((r: { id: string; title: string }) => [r.id, r.title]), [["r-0001", "ledger.txt"], ["r-0002", "mill.jpg"]]);
    assert.equal(s.site.built, true);
  });

  it("catalogues a record by hand: an object the museum knows of, its ID from the sequence", async () => {
    const p = await save("records", { title: "The mill's bell", kind: "object", caption: "Cast iron, the date ground off.", credit: "Seen at the site, 2026" }, true);
    assert.deepEqual(p.body.diff.map((d: { path: string }) => d.path), ["meta/sequences.json", "src/model/records/r-0003.json"]);
    const r = await save("records", { title: "The mill's bell", kind: "object", caption: "Cast iron, the date ground off.", credit: "Seen at the site, 2026" });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    const rec = json(join(b.dir, "src/model/records/r-0003.json"));
    assert.deepEqual([rec.held, rec.status, rec.caption], [false, "not-held", "Cast iron, the date ground off."]);
    assert.equal(json(join(b.dir, "meta/sequences.json")).record.next, 4);
  });

  it("edits a record: a title freely; a source's words only by correction", async () => {
    assert.equal((await save("records", { id: "r-0002", title: "The mill, from the race", rights_holder: "The family" })).body.ok, true);
    assert.equal(json(join(b.dir, "src/model/records/r-0002.json")).title, "The mill, from the race");
    const refused = await save("records", { id: "r-0002", title: "The mill, from the race", caption: "Something else" });
    assert.equal(refused.status, 422);
    assert.match(refused.body.refusal, /as its source gives it\. Propose a correction/);
    assert.equal((await save("records", { id: "r-0003", title: "The mill's bell", caption: "Cast iron; the date ground off." })).body.ok, true, "a record by hand is the curator's own words");
  });

  it("makes an entity anchored to a record that spells it, and refuses one anchored to nothing that does", async () => {
    const bad = await save("entities", { label: "Ezra Pound", kind: "person", anchors: ["r-0002"] });
    assert.equal(bad.body.ok, false);
    assert.match(bad.body.refusal, /no anchor spells "Ezra Pound"/);
    assert.ok(!existsSync(join(b.dir, "src/model/entities/ezra-pound.json")), "the refused write was taken back");
    const none = await save("entities", { label: "Ezra Pound", kind: "person", anchors: [] });
    assert.equal(none.status, 422);
    const good = await save("entities", { label: "Ezra Pound", kind: "person", anchors: ["r-0001"] });
    assert.equal(good.body.ok, true, JSON.stringify(good.body));
    const e = json(join(b.dir, "src/model/entities/ezra-pound.json"));
    assert.match(e.id, /^[0-9a-f]{8}$/);
    const edit = await save("entities", { id: e.id, label: "Ezra Pound", kind: "person", anchors: ["r-0001"], aliases: [{ name: "Pound", sources: ["r-0001"] }] });
    assert.equal(edit.body.ok, true, JSON.stringify(edit.body));
    assert.deepEqual(json(join(b.dir, "src/model/entities/ezra-pound.json")).aliases, [{ name: "Pound", sources: ["r-0001"] }]);
  });

  it("links evidence only with a quote its span holds, word for word", async () => {
    const bad = await save("evidence", { span: "r-0001#p2", quote: "Paid in full, June 1911.", record: "r-0001", type: "supports" });
    assert.equal(bad.status, 422);
    assert.match(bad.body.refusal, /isn't in r-0001#p2, word for word/);
    const good = await save("evidence", { span: "r-0001#p2", quote: "May 1911", record: "r-0001", type: "contradicts", note: "The bell's plaque says 1912." });
    assert.equal(good.body.ok, false, "a contradiction must be carried by a question");
    assert.match(good.body.refusal, /a contradiction no question carries/);
    const ok = await save("evidence", { span: "r-0001#p2", quote: "May 1911", record: "r-0001", type: "supports" });
    assert.equal(ok.body.ok, true, JSON.stringify(ok.body));
    assert.equal(json(join(b.dir, "src/model/evidence.json"))[0].id, "ev-001");
  });

  it("opens a question, and refuses to answer it without evidence", async () => {
    const q = { title: "When was the bell cast?", what_we_know: "The date is ground off.", what_we_dont: "The year.", what_might_answer_it: "The foundry's books.", evidence_needed: "A record of the casting.", last_known_source: ["r-0003"] };
    const r = await save("questions", q);
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    const saved = json(join(b.dir, "src/model/questions/when-was-the-bell-cast.json"));
    assert.deepEqual([saved.status, saved.curator, saved.date], ["open", "Andrew", "2026-10-04"]);
    const answered = await save("questions", { ...q, id: saved.id, status: "answered" });
    assert.equal(answered.body.ok, false);
    assert.match(answered.body.refusal, /answered, on no evidence/);
    const withEvidence = await save("questions", { ...q, id: saved.id, status: "answered", evidence: ["ev-001"] });
    assert.equal(withEvidence.body.ok, true, JSON.stringify(withEvidence.body));
  });

  it("corrects a passage: proposed, accepted, applied; the record reads so, and the correction keeps the old words", async () => {
    const p = await save("corrections", { target: "r-0001#p1", proposed_text: "Received of Ezra Pound, ten dollars, for the mill race.", reason: "The ledger's own page says race." });
    assert.equal(p.body.ok, true, JSON.stringify(p.body));
    const id = (await c.req("state")).body.queue.find((q: { kind: string }) => q.kind === "text").id;
    assert.equal((await c.req("apply", { id })).status, 409, "applied only once accepted");
    assert.equal((await c.req("decide", { ids: [id], status: "accepted" })).body.ok, true);
    const applied = await c.req("apply", { id });
    assert.equal(applied.body.ok, true, JSON.stringify(applied.body));
    const rec = json(join(b.dir, "src/model/records/r-0001.json"));
    assert.equal(rec.passages[0].text, "Received of Ezra Pound, ten dollars, for the mill race.");
    const corr = json(join(b.dir, `src/data/corrections/${id}.json`));
    assert.deepEqual([corr.status, corr.original_text], ["applied", "Received of Ezra Pound, ten dollars, for the mill."]);
    assert.equal((await c.req("state")).body.check.ok, true);
    assert.equal((await save("corrections", { target: "r-0001#p2", proposed_text: "Paid in full, May 1911.", reason: "x" })).status, 409, "a correction that changes nothing");
  });

  it("refuses to retire a record something still points at, then retires one for good", async () => {
    const held = await c.req("retire", { id: "r-0003", reason: "Not the mill's." });
    assert.equal(held.body.ok, false, "the question rests on it");
    assert.ok(existsSync(join(b.dir, "src/model/records/r-0003.json")), "taken back");
    const r = await c.req("retire", { id: "r-0002", reason: "A duplicate of the family's print." });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.ok(!existsSync(join(b.dir, "src/model/records/r-0002.json")));
    assert.ok(!existsSync(join(b.dir, "public/images/uploads/r-0002.jpg")));
    assert.deepEqual(json(join(b.dir, "meta/tombstones.json")), [{ id: "r-0002", date: "2026-10-04", reason: "A duplicate of the family's print." }]);
    // The same photo again: its input is claimed by a tombstoned ID, so it isn't re-created.
    await c.upload("intake-local-2", "mill-again.jpg", new Uint8Array(readFileSync(new URL("./fixtures/angie/plate-07.jpg", import.meta.url))));
    const again = await c.req("ingest", { intake: "intake-local-2" });
    assert.match(again.body.log.join("\n"), /claimed 0 new IDs/);
    const next = await save("records", { title: "Another", kind: "object" });
    assert.equal(next.body.ok, true);
    assert.ok(existsSync(join(b.dir, "src/model/records/r-0004.json")), "r-0002 is never reissued");
  });

  it("keeps the whole history on the box, one commit per act, in the curator's name", () => {
    const log = execFileSync("git", ["log", "--format=%an|%s"], { cwd: b.dir, encoding: "utf8" }).trim().split("\n");
    assert.ok(log.length >= 12);
    assert.ok(log.every((l) => l.startsWith("Andrew|")));
    assert.ok(log.some((l) => /Retire r-0002/.test(l)));
    assert.ok(log.some((l) => /Apply c-\d+ to r-0001#p1/.test(l)));
  });

  it("the site shows what the museum holds now, and none of the queue", async () => {
    const slice = await (await fetch(`${b.url}/data/museum.json`)).text();
    assert.match(slice, /for the mill race\./);
    assert.match(slice, /"label": "Ezra Pound"/);
    assert.ok(!/"c-\d+"/.test(slice));
    const s = (await c.req("state")).body;
    assert.deepEqual([s.site.records, s.site.entities, s.site.questions, s.site.evidence], [s.records.length, 1, 1, 1]);
    writeFileSync(join(root, "done"), "");
  });
});
