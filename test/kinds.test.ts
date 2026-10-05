/**
 * Proposal kinds (Proposal Kinds Spec v1), generated: a pull where the
 * stand-in model proposes every kind, some with quotes their spans don't
 * hold. What survives the span rule reaches the queue; the museum's check
 * passes; a re-run claims nothing new.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { listGrammar } from "../src/kinds.ts";
import { angiePage } from "./fixtures/angie/page.ts";
import { answers } from "./fixtures/angie/answers.ts";
import { freshMuseum, jsonIn, mw, serve, stubModel } from "./helpers.ts";

describe("proposal kinds, generated", () => {
  let site: Awaited<ReturnType<typeof serve>>;
  let model: Awaited<ReturnType<typeof stubModel>>;
  let dir: string;
  let first: { code: number | null; out: string };
  const queue = () => jsonIn(join(dir, "src/data/corrections"));

  before(async () => {
    const fx = angiePage();
    const routes = new Map<string, { type: string; body: Uint8Array | string }>([["/post/angie", { type: "text/html", body: fx.html }]]);
    for (const [path, body] of fx.files) routes.set(path, { type: "image/jpeg", body });
    site = await serve(routes);
    model = await stubModel([["Watts Towers", "place"]], answers);
    dir = freshMuseum("kinds");
    first = await mw(["pull", `${site.url}/post/angie`, "--museum", dir], { MW_MODEL_URL: model.url });
  });
  after(() => {
    site.server.close();
    model.server.close();
  });

  it("asks for every kind, keeps what holds, drops what doesn't, and the check passes", () => {
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /propose: 1 contradiction, 1 question, 1 gap, 1 duplicate, 1 link; 3 dropped by the span rule/);
    assert.match(first.out, /check passes/);
    const kinds = [...new Set(queue().map((c) => c.kind))].sort();
    assert.deepEqual(kinds, ["contradiction", "duplicate", "gap", "link", "name", "question"]);
  });

  it("each kind cites its spans, word for word, in the queue's shape", () => {
    const by = (k: string) => queue().find((c) => c.kind === k);
    const c = by("contradiction");
    assert.deepEqual(c.cites.map((x: { quote: string }) => x.quote), ["born on July 21, 1917", "listing her as age 1"]);
    assert.equal(c.status, "proposed");
    assert.match(c.proposed_text, /“born on July 21, 1917” against “listing her as age 1”/);
    const q = by("question");
    assert.deepEqual([q.question.text, q.question.record], ["What was the operation in December 1930?", "r-0001"]);
    const g = by("gap");
    assert.deepEqual([g.gap.record, g.gap.missing, g.cites.length], ["r-0001", "where she was, and under what name", 2]);
    const d = by("duplicate");
    assert.ok(d.pair.a !== d.pair.b && d.cites.every((x: { span: string }) => x.span.startsWith("plate:")));
    const l = by("link");
    assert.deepEqual([l.pair.a, l.basis], ["r-0001", "shared name"]);
    for (const x of queue()) assert.match(x.source.model, /Qwen3/);
  });

  it("a re-run proposes nothing new", async () => {
    const again = await mw(["pull", `${site.url}/post/angie`, "--museum", dir], { MW_MODEL_URL: model.url });
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /Claimed 0 new IDs/);
  });

  it("builds grammars that only allow the kind's fields", () => {
    const g = listGrammar("links", [["a", "string"], ["basis", ["shared name", "shared date"]]], 3);
    assert.match(g, /root ::= "\{" ws "\\"links\\":"/);
    assert.match(g, /item \( ws "," ws item \)\{0,2\}/);
    assert.match(g, /f1 ::= "\\"shared name\\"" \| "\\"shared date\\""/);
  });
});
