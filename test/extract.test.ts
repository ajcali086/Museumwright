import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bestCandidate, extract, parseSrcset } from "../src/extract.ts";

describe("extract", () => {
  it("parses a srcset whose URLs carry commas", () => {
    const c = parseSrcset("https://img.example/v1/fill/w_740,h_493,al_c/a.jpg 740w, https://img.example/v1/fill/w_1480,h_986,al_c/a.jpg 1480w");
    assert.deepEqual(c.map((x) => x.w), [740, 1480]);
    assert.equal(c[1].url, "https://img.example/v1/fill/w_1480,h_986,al_c/a.jpg");
    assert.equal(bestCandidate(c, 1000)?.w, 740);
    assert.equal(bestCandidate(c, 3000)?.w, 1480);
    assert.equal(bestCandidate(parseSrcset("a.jpg, b.jpg 2x"), 3000)?.url, "b.jpg");
  });

  it("separates a credit the page marks, and keeps the caption verbatim", () => {
    const ex = extract(
      `<html><body><article>
        <p>A paragraph long enough to count as the content of the page, with a comma, and more.</p>
        <figure><img src="/a.jpg"><figcaption>The mill in 1902, from the east. <span class="photo-credit">Photo: County Archive</span></figcaption></figure>
        <p>Another paragraph long enough to count as content, so the root is the article.</p>
      </article></body></html>`,
      "https://example.org/post",
    );
    const img = ex.blocks.find((b) => b.kind === "image");
    assert.ok(img && img.kind === "image");
    assert.equal(img.caption, "The mill in 1902, from the east.");
    assert.equal(img.credit, "Photo: County Archive");
    assert.deepEqual(img.urls, ["https://example.org/a.jpg"]);
  });

  it("takes a caption the page puts after an image, and never one it doesn't", () => {
    const ex = extract(
      `<html><body><main>
        <p>A paragraph long enough to count as the content of the page, with a comma, and more.</p>
        <div><img src="/a.jpg"></div><p class="image-caption">The harbour, 1911.</p>
        <img src="/b.jpg"><p>A paragraph right after an image is not its caption, whatever it says.</p>
      </main></body></html>`,
      "https://example.org/",
    );
    const imgs = ex.blocks.filter((b) => b.kind === "image");
    assert.deepEqual(imgs.map((b) => b.kind === "image" && b.caption), ["The harbour, 1911.", ""]);
    assert.ok(ex.blocks.some((b) => b.kind === "text" && b.text.startsWith("A paragraph right after")));
  });

  it("keeps inline emphasis's words as written, without adding spaces", () => {
    const ex = extract(`<html><body><article><p>She owned the <strong>Ideal</strong>, then <em>sold</em> it — in 1955.</p><p>More text here to be sure this is the article, with commas, and words.</p></article></body></html>`, "https://x.org/");
    assert.equal(ex.blocks[0].kind === "text" && ex.blocks[0].text, "She owned the Ideal, then sold it — in 1955.");
  });
});
