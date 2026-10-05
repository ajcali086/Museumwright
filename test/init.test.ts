/** mw init: generated, not stripped; verified step by step; pure. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { render, STRUCTURE } from "../src/init.ts";
import { MARKERS, purityHits } from "../src/purity.ts";
import { freshMuseum, run } from "./helpers.ts";

describe("mw init", () => {
  it("the structure definition itself holds no content from any museum", () => {
    assert.deepEqual(purityHits(STRUCTURE), []);
  });

  it("generates the folders, the universal collections, the workbench and the sequences, and the empty museum passes", () => {
    const dir = freshMuseum("plain");
    for (const f of ["src/model/records", "src/model/entities", "src/model/questions", "src/model/evidence.json", "src/data/corrections", "public/images/uploads", "meta/sequences.json", "meta/tombstones.json", "public/admin/index.html", "scripts/cms-build.ts", "scripts/lib/cms.ts", "scripts/check-model.ts", ".github/workflows/ci.yml"])
      assert.ok(existsSync(join(dir, f)), f);
    const config = parse(readFileSync(join(dir, "src/cms/config.yml"), "utf8"));
    assert.deepEqual(config.collections.map((c: { name: string }) => c.name), ["corrections", "records", "entities", "questions", "evidence"]);
    assert.deepEqual(config.backend, { ...config.backend, name: "github", repo: "someone/plain", branch: "main", auth_methods: ["token"] });
    assert.match(readFileSync(join(dir, "public/admin/index.html"), "utf8"), /@sveltia\/cms@\d+\.\d+\.\d+\//);
    assert.match(readFileSync(join(dir, ".github/workflows/ci.yml"), "utf8"), /npm run check:model/);
    assert.equal(run(dir, "scripts/check-model.ts").code, 0);
    const built = run(dir, "scripts/cms-build.ts");
    assert.equal(built.code, 0, built.out);
    // An empty set is a text box, not a dropdown with no options.
    const served = readFileSync(join(dir, "public/admin/config.yml"), "utf8");
    assert.ok(!served.includes('"@records"'));
  });

  it("the purity grep catches a marker, and leaves out the museum's own name", () => {
    const dir = freshMuseum("pure");
    assert.deepEqual(purityHits(dir, ["pure", "someone/pure"]), []);
    writeFileSync(join(dir, "README.md"), readFileSync(join(dir, "README.md"), "utf8") + "\nForked from The Spirit of Martinez.\n");
    assert.ok(purityHits(dir, ["pure"]).some((h) => h.startsWith("README.md: ")));
    assert.ok(MARKERS.length > 10);
  });

  it("escapes the title for each file it lands in", () => {
    const vars = { slug: "s", title: 'The "Mill" & <Dam>', repo: "o/s" };
    assert.equal(JSON.parse(render("x.json", '{"t": "@@MW_TITLE@@"}', vars)).t, 'The "Mill" & <Dam>');
    assert.equal(parse(render("x.yml", 'a: "@@MW_TITLE@@ · Curator"', vars)).a, 'The "Mill" & <Dam> · Curator');
    assert.equal(render("x.html", "<title>@@MW_TITLE@@</title>", vars), "<title>The &quot;Mill&quot; &amp; &lt;Dam&gt;</title>");
  });
});
