/** The span rule's two copies agree, and the desk's sign-in can't be raced past its delay. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as museum from "../structure/scripts/lib/model.ts";
import { Desk } from "../src/serve/auth.ts";
import * as mw from "../src/spanrule.ts";
import { tmp } from "./helpers.ts";

const SPAN = "Ada Byron met Charles Babbage in London in 1833.";
const HOLDS: [string | undefined, string | undefined][] = [
  [SPAN, "Charles Babbage"],
  [SPAN, "  in London in 1833.  "],
  [SPAN, "Babbage in Paris"],
  [SPAN, "A"],
  [SPAN, " "],
  [SPAN, ""],
  [SPAN, undefined],
  [undefined, "Babbage"],
  ["", "Babbage"],
];
const CARRIES: [string | undefined, string[]][] = [
  ["in London in 1833", []],
  ["in 1833", []],
  ["Charles Babbage", []],
  ["Babbage", []],
  ["Babbage", ["Babbage"]],
  ["  Babbage  ", ["Babbage"]],
  ["the", ["Babbage"]],
  ["three short words", []],
  ["exactly12chr", []],
  ["exactly11ch", []],
  [undefined, []],
];

describe("the span rule", () => {
  it("gives mw and a generated museum's check:model the same answers", () => {
    assert.equal(mw.MIN_QUOTE_CHARS, museum.MIN_QUOTE_CHARS);
    assert.equal(mw.MIN_QUOTE_WORDS, museum.MIN_QUOTE_WORDS);
    for (const [span, quote] of HOLDS) assert.equal(mw.spanHolds(span, quote), museum.spanHolds(span, quote), `spanHolds(${JSON.stringify(span)}, ${JSON.stringify(quote)})`);
    for (const [quote, names] of CARRIES) assert.equal(mw.quoteCarries(quote, names), museum.quoteCarries(quote, names), `quoteCarries(${JSON.stringify(quote)})`);
  });

  it("holds a trimmed quote in its span, word for word, never a single character", () => {
    assert.deepEqual(HOLDS.map(([s, q]) => mw.spanHolds(s, q)), [true, true, false, false, false, false, false, false, false]);
  });

  it("carries a claim at 12 characters or 3 words, or exactly a kept name", () => {
    assert.deepEqual(CARRIES.map(([q, n]) => mw.quoteCarries(q, n)), [true, false, true, false, true, true, false, true, true, false, false]);
  });
});

describe("the desk's sign-in", () => {
  it("makes guesses sent all at once wait their turn, each slower than the last", async () => {
    const desk = new Desk(tmp("auth"));
    desk.setUp(desk.setupCode, "the right passcode", "Curator");
    const started = Date.now();
    // Each miss waits 250 × 2^misses before it is tried: 0, 500 and 1000 ms, in turn.
    const guesses = await Promise.allSettled(["guess one", "guess two", "guess three"].map((p) => desk.signIn(p, "Someone")));
    assert.deepEqual(guesses.map((g) => g.status), ["rejected", "rejected", "rejected"]);
    assert.ok(Date.now() - started >= 1400, `three guesses at once took ${Date.now() - started} ms`);
    // The right passcode still opens the desk, after its turn.
    assert.equal(typeof (await desk.signIn("the right passcode", "Curator")), "string");
    assert.equal(typeof (await desk.signIn("the right passcode", "Curator")), "string");
  });
});
