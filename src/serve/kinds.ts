/**
 * Keeping the newer kinds of proposal at the desk. The machine only ever
 * wrote to the queue; what a kept proposal becomes is the curator's act:
 *
 *   contradiction  → a Both Stand entry, both claims cited, neither resolved
 *   question, gap  → an open question, raised by its record
 *   link           → a quiet door between the two records
 *   duplicate      → a merge pending at the desk; the merge itself, later,
 *                    is a curator's act too: one record retired, a dated note
 *                    on the other
 *
 * Holding one back (a considered non-conflict, two records judged distinct,
 * a link never rendered) is the queue's own decision, unchanged.
 */
import { DeskError } from "./auth.ts";
import { body, today, type Plan, type Write } from "./actions.ts";
import { planNote } from "./actions.ts";
import { planRetire } from "./edit.ts";
import { PATHS, readMuseum, spans, type Correction, type Museum } from "./museum.ts";
import { slugify } from "../util.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Cite = { span: string; quote: string };
type Proposal = Correction & { cites?: Cite[]; question?: { text: string; record: string }; gap?: { record: string; missing: string }; pair?: { a: string; b: string }; basis?: string };

function proposal(m: Museum, id: string, kind?: string): Proposal {
  const c = m.corrections.find((x) => x.id === id) as Proposal | undefined;
  if (!c) throw new DeskError(404, `No proposal ${id}.`);
  if (kind && c.kind !== kind) throw new DeskError(400, `${id} is a ${c.kind ?? "text"} proposal.`);
  if (c.status !== "proposed" && c.status !== "held") throw new DeskError(409, `${id} is already ${c.status}.`);
  return c;
}

/** The span rule, for every citation: no citation, no acceptance; the refusal quotes the span. */
export function citeRefusal(m: Museum, c: Proposal): string | undefined {
  const text = spans(m.records);
  if (!(c.cites ?? []).length) return `Can't keep ${c.id}: it cites no span.`;
  for (const x of c.cites ?? []) {
    const words = text.get(x.span);
    if (words === undefined) return `Can't keep ${c.id}: it cites ${x.span}, which isn't in the museum.`;
    if (!words.includes(x.quote)) return `Can't keep ${c.id}: the span ${x.span} doesn't contain “${x.quote}”. The span reads: “${words}”`;
  }
  return undefined;
}

const accepted = (c: Proposal, who: string): Write => ({ path: `${PATHS.corrections}/${c.id}.json`, after: body({ ...c, status: "accepted", decided_by: who, decided_on: today() }) });

function guard(m: Museum, c: Proposal) {
  const refusal = citeRefusal(m, c);
  if (refusal) throw new DeskError(422, refusal);
}

/** Both Stand entries on disk (the desk reads them; museum.ts doesn't need them). */
export function readBothStand(dir: string): { id: string; title: string; status: string; [k: string]: unknown }[] {
  const folder = join(dir, "src/model/both-stand");
  return existsSync(folder)
    ? readdirSync(folder)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((f) => JSON.parse(readFileSync(join(folder, f), "utf8")))
    : [];
}

export function readLinks(dir: string): { id: string; from: string; to: string; basis: string; cites: Cite[]; [k: string]: unknown }[] {
  const file = join(dir, "src/model/links.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
}

/** Keep a contradiction: a Both Stand entry with both claims cited, neither resolved. */
export function planKeepContradiction(dir: string, id: string, title: string, who: string): Plan {
  const m = readMuseum(dir);
  const c = proposal(m, id, "contradiction");
  guard(m, c);
  const t = title.trim() || c.proposed_text;
  const taken = new Set(readBothStand(dir).map((b) => b.id));
  const base = slugify(t).slice(0, 60).replace(/-+$/, "") || "both-stand";
  let bid = base;
  for (let i = 2; taken.has(bid); i++) bid = `${base}-${i}`;
  const [a, b] = c.cites!;
  const entry = { id: bid, title: t, claim_a: a, claim_b: b, status: "standing", opened_by: who, opened_on: today(), from_proposal: c.id };
  return { summary: `Both stand: ${t} (from ${c.id})`, writes: [{ path: `src/model/both-stand/${bid}.json`, after: body(entry) }, accepted(c, who)] };
}

export type QuestionFields = { title?: string; what_we_know?: string; what_we_dont?: string; what_might_answer_it?: string; evidence_needed?: string };

/** Keep a question or a gap: an open question, raised by its record, carrying the proposal's words. */
export function planKeepQuestion(dir: string, id: string, f: QuestionFields, who: string): Plan {
  const m = readMuseum(dir);
  const c = proposal(m, id);
  if (c.kind !== "question" && c.kind !== "gap") throw new DeskError(400, `${id} is a ${c.kind} proposal.`);
  guard(m, c);
  const record = c.kind === "question" ? c.question!.record : c.gap!.record;
  const need = (v: string | undefined, what: string) => {
    if (!v?.trim()) throw new DeskError(400, `${what} can't be empty: a question is bounded.`);
    return v.trim();
  };
  const title = need(f.title || (c.kind === "question" ? c.question!.text : c.proposed_text), "The question");
  const ids = new Set(m.questions.map((q) => q.id));
  const base = slugify(title).slice(0, 60).replace(/-+$/, "");
  let qid = base;
  for (let i = 2; ids.has(qid); i++) qid = `${base}-${i}`;
  const q = {
    id: qid,
    title,
    what_we_know: need(f.what_we_know, "What we know"),
    what_we_dont: need(f.what_we_dont || (c.kind === "gap" ? c.gap!.missing : ""), "What we don't"),
    what_might_answer_it: need(f.what_might_answer_it, "What might answer it"),
    evidence_needed: need(f.evidence_needed, "Evidence needed"),
    last_known_source: [record],
    entities: [],
    status: "open",
    evidence: [],
    curator: who,
    date: today(),
    from_proposal: c.id,
  };
  return { summary: `Open a question from ${c.id}: ${title}`, writes: [{ path: `${PATHS.questions}/${qid}.json`, after: body(q) }, accepted(c, who)] };
}

/** Keep a link: a quiet door between the two records, its basis cited on both sides. */
export function planKeepLink(dir: string, id: string, who: string): Plan {
  const m = readMuseum(dir);
  const c = proposal(m, id, "link");
  guard(m, c);
  const links = readLinks(dir);
  let n = links.length + 1;
  const used = new Set(links.map((l) => l.id));
  let lid: string;
  do lid = `ln-${String(n++).padStart(3, "0")}`;
  while (used.has(lid));
  const link = { id: lid, from: c.pair!.a, to: c.pair!.b, basis: c.basis, cites: c.cites, curator: who, date: today(), from_proposal: c.id };
  return { summary: `Link ${c.pair!.a} and ${c.pair!.b} (${c.basis}), from ${c.id}`, writes: [{ path: "src/model/links.json", after: body([...links, link]) }, accepted(c, who)] };
}

/** Keep a duplicate: the pair is marked for a merge, pending at the desk. Nothing merges yet. */
export function planKeepDuplicate(dir: string, id: string, who: string): Plan {
  const m = readMuseum(dir);
  const c = proposal(m, id, "duplicate");
  guard(m, c);
  return { summary: `Mark ${c.pair!.a} and ${c.pair!.b} for merging (${c.id})`, writes: [accepted(c, who)] };
}

/**
 * Merge a pair marked as a duplicate: the curator's act. One record stays,
 * with a dated note; the other is retired (its ID tombstoned, its files
 * gone), and the check refuses while anything still points at it.
 */
export function planMerge(dir: string, id: string, keep: string, who: string): Plan {
  const m = readMuseum(dir);
  const c = m.corrections.find((x) => x.id === id) as Proposal | undefined;
  if (!c || c.kind !== "duplicate") throw new DeskError(404, `No duplicate proposal ${id}.`);
  if (c.status !== "accepted") throw new DeskError(409, `${id} is ${c.status}; only a pair marked for merging is merged.`);
  const { a, b } = c.pair!;
  if (keep !== a && keep !== b) throw new DeskError(400, `Keep ${a} or ${b}.`);
  const gone = keep === a ? b : a;
  const retire = planRetire(dir, gone, `The same as ${keep} (${c.id}), merged by ${who}.`);
  const note = planNote(dir, keep, `${gone} merged into this record: the same thing twice (${c.id}).`);
  return {
    summary: `Merge ${gone} into ${keep} (${c.id})`,
    writes: [...retire.writes, ...note.writes, { path: `${PATHS.corrections}/${c.id}.json`, after: body({ ...c, status: "applied", decided_by: who, decided_on: today() }) }],
  };
}

/** Settle a Both Stand entry: only with a note saying how. */
export function planSettle(dir: string, bid: string, note: string): Plan {
  const entry = readBothStand(dir).find((b) => b.id === bid);
  if (!entry) throw new DeskError(404, `No Both Stand entry ${bid}.`);
  if (!note.trim()) throw new DeskError(400, "A Both Stand entry is settled only with a note saying how.");
  if (entry.status === "settled") throw new DeskError(409, `${bid} is already settled.`);
  return { summary: `Settle ${bid}`, writes: [{ path: `src/model/both-stand/${bid}.json`, after: body({ ...entry, status: "settled", settled_note: note.trim() }) }] };
}
