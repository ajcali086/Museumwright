/** mw batch: images, a PDF with a text page and a scanned one, a text file, and one it can't read. */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { freshMuseum, jsonIn, mw, readJson, tmp, tree } from "./helpers.ts";

/** A two-page PDF: page 1 has a text layer, page 2 only a drawn shape (a "scan"). */
function makePdf(text: string): Buffer {
  const content1 = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const content2 = `0.2 g 72 400 300 200 re f`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R >>",
    `<< /Length ${content1.length} >>\nstream\n${content1}\nendstream`,
    `<< /Length ${content2.length} >>\nstream\n${content2}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

describe("mw batch", () => {
  const folder = join(tmp("batch-in"), "box-3");
  mkdirSync(join(folder, "letters"), { recursive: true });
  mkdirSync(join(folder, "z-dupes"), { recursive: true });
  cpSync(new URL("./fixtures/angie/plate-05.jpg", import.meta.url), join(folder, "photo-a.jpg"));
  cpSync(new URL("./fixtures/angie/plate-05.jpg", import.meta.url), join(folder, "z-dupes/photo-a-copy.jpg"));
  writeFileSync(join(folder, "letters/ledger.pdf"), makePdf("Received of Mr. Ezra Pound, ten dollars."));
  writeFileSync(join(folder, "notes.txt"), "Box 3, from the attic.\n\nThe ledger and one photograph.\n");
  writeFileSync(join(folder, "scan.tiff"), "II*\0not really a tiff");

  it("writes records for what it reads, logs what it skips, and passes the check", async () => {
    const dir = freshMuseum("batch");
    const r = await mw(["batch", folder, "--museum", dir]);
    assert.equal(r.code, 0, r.out);
    const records = jsonIn(join(dir, "src/model/records"));
    const pdf = records.find((x) => x.title === "ledger.pdf");
    assert.equal(pdf.kind, "document");
    assert.deepEqual(pdf.passages, [{ id: "p1-1", text: "Received of Mr. Ezra Pound, ten dollars." }]);
    assert.deepEqual(pdf.media, [`public/images/uploads/${pdf.id}.pdf`]);
    const scan = records.find((x) => x.title === "ledger.pdf, page 2");
    assert.equal(scan.kind, "image");
    assert.equal(scan.caption, "", "a scanned page is a plate, not an OCR guess");
    assert.equal(scan.found_in, pdf.id);
    assert.equal(scan.source.page, 2);
    assert.deepEqual([...readFileSync(join(dir, scan.media[0])).subarray(1, 4)], [0x50, 0x4e, 0x47]);
    const photo = records.filter((x) => x.kind === "image" && x.title.startsWith("photo-a"));
    assert.equal(photo.length, 1, "the same bytes twice are one record");
    assert.equal(photo[0].source.file, "photo-a.jpg");
    const notes = records.find((x) => x.title === "notes.txt");
    assert.deepEqual(notes.passages.map((p: { text: string }) => p.text), ["Box 3, from the attic.", "The ledger and one photograph."]);
    const log = records.find((x) => x.kind === "log");
    const logged = log.passages.map((p: { text: string }) => p.text).join("\n");
    assert.match(logged, /not a kind this tool reads\] scan\.tiff/);
    assert.match(logged, /the same file again\] z-dupes\/photo-a-copy\.jpg/);
    for (const x of records) assert.equal(x.status, "unverified");

    const before = tree(dir);
    const again = await mw(["batch", folder, "--museum", dir], { MW_NOW: "2026-11-01T00:00:00Z" });
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /claimed 0 new IDs/);
    assert.deepEqual(tree(dir), before);
  });

  it("respects tombstones: a retired record is not re-created, and its ID is never reissued", async () => {
    const dir = freshMuseum("tomb");
    await mw(["batch", folder, "--museum", dir]);
    const seq = readJson(join(dir, "meta/sequences.json"));
    const photoId = seq.claims[Object.keys(seq.claims).find((h) => seq.claims[h] && readJson(join(dir, "src/model/records", `${seq.claims[h]}.json`)).title === "photo-a.jpg")!];
    // The curator retires it: the file goes, the tombstone stays.
    writeFileSync(join(dir, "meta/tombstones.json"), JSON.stringify([{ id: photoId, date: "2026-10-05", reason: "Not ours." }], null, 2));
    const { rmSync } = await import("node:fs");
    rmSync(join(dir, "src/model/records", `${photoId}.json`));
    rmSync(join(dir, "public/images/uploads", `${photoId}.jpg`));
    writeFileSync(join(folder, "later.txt"), "A later note.\n");
    const r = await mw(["batch", folder, "--museum", dir]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`tombstoned, not re-created: ${photoId}`));
    const ids = jsonIn(join(dir, "src/model/records")).map((x) => x.id);
    assert.ok(!ids.includes(photoId));
    assert.equal(new Set(ids).size, ids.length);
  });
});
