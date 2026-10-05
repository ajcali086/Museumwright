/** What the stand-in model "notices" in the Angie page for each newer kind: one good proposal of each, and some whose quotes aren't in their spans. */
import type { TaskAnswer } from "../../helpers.ts";

const find = (lines: { label: string; text: string }[], words: string) => lines.find((l) => l.text.includes(words))?.label ?? "none";


export const answers: TaskAnswer = (task, lines) => {
  if (task === "contradictions")
    return {
      pairs: [
        { a: find(lines, "born on July 21, 1917"), quote_a: "born on July 21, 1917", b: find(lines, "listing her as age 1"), quote_b: "listing her as age 1" },
        { a: find(lines, "born on July 21, 1917"), quote_a: "born in 1915", b: find(lines, "listing her as age 1"), quote_b: "listing her as age 1" },
      ],
    };
  if (task === "questions") {
    const p = find(lines, "never disclosed");
    return p === "none" ? { questions: [] } : { questions: [{ passage: p, quote: "The nature of the surgery was never disclosed.", question: "What was the operation in December 1930?" }, { passage: p, quote: "The surgery was disclosed.", question: "Invented?" }] };
  }
  if (task === "gaps") {
    const p = find(lines, "by 1942 she disappears");
    return p === "none" ? { gaps: [] } : { gaps: [{ from: p, quote_from: "by 1942 she disappears", to: p, quote_to: "until the 1950s", missing: "where she was, and under what name" }] };
  }
  if (task === "duplicates")
    return { pairs: [{ a: find(lines, "Dec 08, 1930"), quote_a: "Martinez News-Gazette, Martinez, California", b: find(lines, "Aug 07, 1951"), quote_b: "Martinez News-Gazette, Martinez, California" }] };
  if (task === "links")
    return {
      links: [
        { a: find(lines, "A Life of Hospitality"), quote_a: "Martinez Daily Standard", b: find(lines, "Jun 11, 1930, Page 6"), quote_b: "Martinez Daily Standard", basis: "shared name" },
        { a: find(lines, "A Life of Hospitality"), quote_a: "Sheriff's Gazette", b: find(lines, "Jun 11, 1930, Page 6"), quote_b: "Martinez Daily Standard", basis: "shared name" },
      ],
    };
  return {};
};

