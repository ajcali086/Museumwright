/**
 * The span rule, in one place for mw: the proposer, the desk and the tests
 * all read it from here. A museum's own check:model can't import mw, so
 * structure/scripts/lib/model.ts carries the same two functions; a test
 * holds the two copies to the same answers.
 */

/** A quote stands on its own at 12 characters or 3 words; shorter, it must be exactly a kept name. */
export const MIN_QUOTE_CHARS = 12;
export const MIN_QUOTE_WORDS = 3;

/** The span rule: the trimmed quote is in the span word for word, and is more than one character. */
export function spanHolds(span: string | undefined, quote: string | undefined): boolean {
  const q = (quote ?? "").trim();
  return span !== undefined && q.length > 1 && span.includes(q);
}

/**
 * Whether a quote is long enough to carry a claim. A verbatim surname matches
 * almost any span, so a short quote passes only when it is exactly one of
 * `names` (an entity's label or alias), where the name is the claim. Names
 * and links don't use this: there the short shared word is the claim.
 */
export function quoteCarries(quote: string | undefined, names: readonly string[] = []): boolean {
  const q = (quote ?? "").trim();
  return q.length >= MIN_QUOTE_CHARS || q.split(/\s+/).length >= MIN_QUOTE_WORDS || names.includes(q);
}

/** Proposal kinds whose quotes stand for a statement, not a shared word: each needs a quote long enough to carry it. */
export const CLAIM_KINDS: readonly string[] = ["contradiction", "question", "gap", "duplicate"];

/** The refusal for a quote too short to carry its claim, in the desk's and the check's words. */
export const tooShort = (quote: string | undefined) =>
  `“${(quote ?? "").trim()}” is too short to carry a claim: quote ${MIN_QUOTE_CHARS} characters or ${MIN_QUOTE_WORDS} words, or exactly an entity's name`;
