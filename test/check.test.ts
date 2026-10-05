/** check:model on a generated museum: what it passes, and what it refuses. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { freshMuseum, run } from "./helpers.ts";

const write = (dir: string, path: string, data: unknown) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n");
};
const check = (dir: string) => run(dir, "scripts/check-model.ts");

/** A museum with one pulled document and one plate, as mw would have written them. */
function seeded() {
  const dir = freshMuseum("check");
  const source = (h: string) => ({ url: "https://example.org/post", extracted_at: "2026-10-04T12:00:00Z", input_hash: h, tool: "mw 0.1.0" });
  write(dir, "src/model/records/r-0001.json", {
    id: "r-0001", kind: "document", title: "A post", credit: "", rights_holder: "unknown", held: true, status: "unverified",
    passages: [{ id: "p1", text: "Ada Byron met Charles Babbage in London in 1833." }], media: [], source: source("sha256:a"), notes: [],
  });
  write(dir, "public/images/uploads/r-0002.jpg", "jpg");
  write(dir, "src/model/records/r-0002.json", {
    id: "r-0002", kind: "image", title: "Plate 1", caption: "The Analytical Engine, London.", credit: "", found_in: "r-0001",
    rights_holder: "unknown", held: true, status: "unverified", media: ["public/images/uploads/r-0002.jpg"], source: source("sha256:b"), notes: [],
  });
  write(dir, "meta/sequences.json", {
    record: { prefix: "r-", width: 4, next: 3 }, correction: { prefix: "c-", width: 4, next: 2 },
    claims: { "sha256:a": "r-0001", "sha256:b": "r-0002", "sha256:c": "c-0001" },
  });
  write(dir, "src/data/corrections/c-0001.json", {
    id: "c-0001", kind: "name", target: "r-0001#p1", proposed_text: "Charles Babbage", entity_kind: "person",
    reason: "Noticed.", proposed_by: "mw", date: "2026-10-04", status: "proposed",
  });
  return dir;
}

describe("check:model", () => {
  it("passes an empty museum", () => {
    const r = check(freshMuseum("empty"));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /model check passed/);
  });

  it("passes a pulled museum with a proposal in the queue", () => {
    const r = check(seeded());
    assert.equal(r.code, 0, r.out);
  });

  const refuses = (what: string, change: (dir: string) => void, pattern: RegExp) =>
    it(`refuses ${what}`, () => {
      const dir = seeded();
      change(dir);
      const r = check(dir);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, pattern);
    });

  refuses("a name proposal whose span doesn't contain the string", (d) => {
    const c = JSON.parse(readFileSync(join(d, "src/data/corrections/c-0001.json"), "utf8"));
    write(d, "src/data/corrections/c-0001.json", { ...c, proposed_text: "Charles Babage" });
  }, /doesn't contain "Charles Babage"/);

  refuses("a kept name with no entity anchored to its record", (d) => {
    const c = JSON.parse(readFileSync(join(d, "src/data/corrections/c-0001.json"), "utf8"));
    write(d, "src/data/corrections/c-0001.json", { ...c, status: "accepted", decided_by: "curator", decided_on: "2026-10-05" });
  }, /kept, but no entity named "Charles Babbage" is anchored to r-0001/);

  it("passes a kept name once its entity is anchored to the record that spells it", () => {
    const d = seeded();
    const c = JSON.parse(readFileSync(join(d, "src/data/corrections/c-0001.json"), "utf8"));
    write(d, "src/data/corrections/c-0001.json", { ...c, status: "accepted", decided_by: "curator", decided_on: "2026-10-05" });
    write(d, "src/model/entities/charles-babbage.json", { id: "1a2b3c4d", slug: "charles-babbage", kind: "person", label: "Charles Babbage", anchors: ["r-0001"] });
    const r = check(d);
    assert.equal(r.code, 0, r.out);
  });

  it("passes a held-back proposal: a decision, not a deletion", () => {
    const d = seeded();
    const c = JSON.parse(readFileSync(join(d, "src/data/corrections/c-0001.json"), "utf8"));
    write(d, "src/data/corrections/c-0001.json", { ...c, status: "held", decided_by: "curator", decided_on: "2026-10-05" });
    assert.equal(check(d).code, 0);
  });

  refuses("an entity with no anchor", (d) =>
    write(d, "src/model/entities/ada.json", { id: "0badc0de", slug: "ada", kind: "person", label: "Ada Byron", anchors: [] }),
  /no anchor; a kept name needs the record that spells it/);

  refuses("an entity whose anchors don't spell its name", (d) =>
    write(d, "src/model/entities/ada.json", { id: "0badc0de", slug: "ada", kind: "person", label: "Ada Lovelace", anchors: ["r-0002"] }),
  /no anchor spells "Ada Lovelace"/);

  refuses("a record not filed under its ID", (d) => {
    const r = readFileSync(join(d, "src/model/records/r-0001.json"), "utf8");
    rmSync(join(d, "src/model/records/r-0001.json"));
    write(d, "src/model/records/post.json", r);
  }, /records\/post\.json: ID r-0001/);

  refuses("a held record that holds nothing", (d) => {
    const r = JSON.parse(readFileSync(join(d, "src/model/records/r-0002.json"), "utf8"));
    write(d, "src/model/records/r-0002.json", { ...r, media: [] });
  }, /held, but no file and no text/);

  refuses("a media path that isn't there", (d) => rmSync(join(d, "public/images/uploads/r-0002.jpg")), /r-0002\.jpg missing/);

  refuses("a tombstoned ID in use", (d) =>
    write(d, "meta/tombstones.json", [{ id: "r-0002", date: "2026-10-05", reason: "A duplicate scan." }]),
  /r-0002: tombstoned, but in use/);

  refuses("an ID claimed by two inputs", (d) => {
    const s = JSON.parse(readFileSync(join(d, "meta/sequences.json"), "utf8"));
    write(d, "meta/sequences.json", { ...s, claims: { ...s.claims, "sha256:z": "r-0001" } });
  }, /r-0001: claimed by two inputs/);

  refuses("a pulled record whose hash doesn't claim it", (d) => {
    const s = JSON.parse(readFileSync(join(d, "meta/sequences.json"), "utf8"));
    delete s.claims["sha256:b"];
    write(d, "meta/sequences.json", s);
  }, /r-0002: its input hash doesn't claim it/);

  refuses("an evidence quote not verbatim in its span", (d) =>
    write(d, "src/model/evidence.json", [{ id: "ev-001", claim: { span: "r-0001#p1", quote: "met Babbage" }, record: "r-0002", type: "supports", curator: "c", date: "2026-10-05" }]),
  /the quote isn't in r-0001#p1/);

  refuses("a contradiction no question carries", (d) =>
    write(d, "src/model/evidence.json", [{ id: "ev-001", claim: { span: "r-0001#p1", quote: "in 1833" }, record: "r-0002", type: "contradicts", curator: "c", date: "2026-10-05" }]),
  /a contradiction no question carries/);

  refuses("a public slice that reaches the queue", (d) => {
    const p = join(d, "scripts/lib/public.ts");
    write(d, "scripts/lib/public.ts", readFileSync(p, "utf8").replace('"src/model/both-stand"] as const', '"src/model/both-stand", "src/data/corrections"] as const'));
  }, /lists the queue or meta\//);

  // Proposal kinds: the span rule over every citation, and what a kept one must leave.
  const kind = (d: string, data: Record<string, unknown>) =>
    write(d, "src/data/corrections/c-0002.json", { id: "c-0002", target: "r-0001#p1", proposed_text: "x", reason: "r", proposed_by: "mw", date: "2026-10-04", status: "proposed", ...data });
  const decided = { decided_by: "curator", decided_on: "2026-10-05" };

  it("passes a contradiction whose claims are in their spans, word for word", () => {
    const d = seeded();
    kind(d, { kind: "contradiction", cites: [{ span: "r-0001#p1", quote: "in 1833" }, { span: "plate:r-0002", quote: "London" }] });
    assert.equal(check(d).code, 0, check(d).out);
  });

  refuses("a contradiction quoting words its span doesn't hold", (d) =>
    kind(d, { kind: "contradiction", cites: [{ span: "r-0001#p1", quote: "in 1834" }, { span: "plate:r-0002", quote: "London" }] }),
  /r-0001#p1 doesn't contain "in 1834"/);

  refuses("a kept contradiction no Both Stand entry carries", (d) =>
    kind(d, { kind: "contradiction", cites: [{ span: "r-0001#p1", quote: "in 1833" }, { span: "plate:r-0002", quote: "London" }], status: "accepted", ...decided }),
  /kept, but no Both Stand entry carries it/);

  refuses("a question raised by no record", (d) =>
    kind(d, { kind: "question", cites: [{ span: "r-0001#p1", quote: "in 1833" }], question: { text: "Where?", record: "r-0099" } }),
  /raised by r-0099, no such record/);

  refuses("a gap that cites one end of its chain", (d) =>
    kind(d, { kind: "gap", cites: [{ span: "r-0001#p1", quote: "in 1833" }], gap: { record: "r-0001", missing: "the years after" } }),
  /a gap cites both ends of its chain/);

  refuses("a link cited on one side only", (d) =>
    kind(d, { kind: "link", cites: [{ span: "r-0001#p1", quote: "London" }, { span: "r-0001#p1", quote: "in 1833" }], pair: { a: "r-0001", b: "r-0002" }, basis: "shared place" }),
  /cites no span on both sides/);

  refuses("a merged duplicate with neither record retired", (d) =>
    kind(d, { kind: "duplicate", cites: [{ span: "r-0001#p1", quote: "London" }, { span: "plate:r-0002", quote: "London" }], pair: { a: "r-0001", b: "r-0002" }, status: "applied", ...decided }),
  /merged, but neither record is retired/);

  refuses("a Both Stand entry settled with no note", (d) =>
    write(d, "src/model/both-stand/when.json", { id: "when", title: "When?", claim_a: { span: "r-0001#p1", quote: "in 1833" }, claim_b: { span: "plate:r-0002", quote: "London" }, status: "settled", opened_by: "c", opened_on: "2026-10-05" }),
  /settled, with no note saying how/);

  refuses("a link whose basis isn't in its span", (d) =>
    write(d, "src/model/links.json", [{ id: "ln-001", from: "r-0001", to: "r-0002", basis: "shared place", cites: [{ span: "r-0001#p1", quote: "Paris" }, { span: "plate:r-0002", quote: "London" }], curator: "c", date: "2026-10-05" }]),
  /r-0001#p1 doesn't contain "Paris"/);

  refuses("a text correction that changes nothing", (d) =>
    write(d, "src/data/corrections/c-0002.json", { id: "c-0002", target: "plate:r-0002", proposed_text: "The Analytical Engine, London.", reason: "r", proposed_by: "x", date: "2026-10-05", status: "proposed" }),
  /c-0002: changes nothing/);
});
