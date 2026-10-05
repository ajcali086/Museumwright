/**
 * The local admin: every collection edited at the desk, with no GitHub and
 * no Sveltia. Each function is a plan of file writes in the same shapes
 * Sveltia saves, so the two can take turns on the same folders. Whatever a
 * form lets through, the museum's check has the last word.
 *
 * What a source gave stays as it gave it: a pulled record's caption,
 * credit and passages are not edited in place. They change only by a text
 * correction, proposed, accepted and applied, which keeps the words it
 * replaced.
 */
import { randomBytes } from "node:crypto";
import { slugify } from "../util.ts";
import { DeskError } from "./auth.ts";
import { body, today, type Plan, type Write } from "./actions.ts";
import { PATHS, readMuseum, spanRecord, spans, type Entity, type Museum, type Record_ } from "./museum.ts";

const KINDS = ["person", "family", "place", "organization", "event"];
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
const need = (v: string, what: string) => {
  if (!v) throw new DeskError(400, `${what} can't be empty.`);
  return v;
};

/** The next ID in a sequence nobody has taken, and the sequences file that says it is taken. */
function claimNext(m: Museum, which: "record" | "correction"): { id: string; write: Write } {
  const seq = m.sequences;
  if (!seq) throw new DeskError(409, "The museum has no meta/sequences.json.");
  const s = { ...seq[which] } as { prefix: string; next: number; width?: number };
  const taken = new Set([...m.records.map((r) => r.id), ...m.corrections.map((c) => c.id), ...m.tombstones.map((t) => t.id), ...Object.values(seq.claims)]);
  let id: string;
  do id = s.prefix + String(s.next++).padStart(s.width ?? 4, "0");
  while (taken.has(id));
  return { id, write: { path: PATHS.sequences, after: body({ ...seq, [which]: s }) } };
}

export type RecordInput = { id?: string; kind?: string; title?: string; caption?: string; credit?: string; alt?: string; rights_holder?: string };

/**
 * A record by hand: something the museum knows of, catalogued at the desk
 * (a held copy comes in through Add, as a file). Editing one: the title and
 * rights holder always; caption, credit and alt text only on a record no
 * source gave, since a source's words change only by correction.
 */
export function planSaveRecord(dir: string, input: RecordInput): Plan {
  const m = readMuseum(dir);
  const title = need(text(input.title), "A title");
  if (!input.id) {
    const kind = text(input.kind) || "object";
    if (!["object", "document", "image"].includes(kind)) throw new DeskError(400, "A record by hand is an object, a document or an image.");
    const { id, write } = claimNext(m, "record");
    const r: Record_ = { id, kind, title, caption: text(input.caption), credit: text(input.credit), rights_holder: text(input.rights_holder) || "unknown", held: false, status: "not-held", media: [], notes: [] };
    if (text(input.alt)) r.alt = text(input.alt);
    return { summary: `Catalogue ${id}: ${title}`, writes: [write, { path: `${PATHS.records}/${id}.json`, after: body(r) }] };
  }
  const r = m.records.find((x) => x.id === input.id);
  if (!r) throw new DeskError(404, `No record ${input.id}.`);
  const next: Record_ = { ...r, title, rights_holder: text(input.rights_holder) || r.rights_holder || "unknown" };
  for (const k of ["caption", "credit", "alt"] as const) {
    if (input[k] === undefined) continue;
    const v = text(input[k]);
    if (v === (r[k] ?? "")) continue;
    if (r.source) throw new DeskError(422, `${r.id}'s ${k} is as its source gives it. Propose a correction to change it.`);
    next[k] = v;
  }
  if (JSON.stringify(next) === JSON.stringify(r)) throw new DeskError(409, "Nothing changed.");
  return { summary: `Edit ${r.id}`, writes: [{ path: `${PATHS.records}/${r.id}.json`, after: body(next) }] };
}

export type EntityInput = { id?: string; label?: string; kind?: string; anchors?: string[]; aliases?: { name: string; sources?: string[] }[] };

/** An entity made or edited at the desk: anchored to records that spell it, or the check refuses it. Its slug, once made, stays. */
export function planSaveEntity(dir: string, input: EntityInput): Plan {
  const m = readMuseum(dir);
  const label = need(text(input.label), "A name");
  const kind = text(input.kind);
  if (!KINDS.includes(kind)) throw new DeskError(400, `An entity is a ${KINDS.join(", ")}.`);
  const anchors = [...new Set(list(input.anchors))];
  if (!anchors.length) throw new DeskError(422, "An entity needs at least one anchor: a record that spells its name.");
  const aliases = (Array.isArray(input.aliases) ? input.aliases : [])
    .map((a) => ({ name: text(a?.name), sources: [...new Set(list(a?.sources))] }))
    .filter((a) => a.name);
  if (!input.id) {
    const used = new Set(m.entities.map((e) => e.id));
    let id: string;
    do id = randomBytes(4).toString("hex");
    while (used.has(id));
    const slugs = new Set(m.entities.map((e) => e.slug));
    const base = slugify(label);
    let slug = base;
    for (let i = 2; slugs.has(slug); i++) slug = `${base}-${i}`;
    const e: Entity = { id, slug, kind, label, aliases, anchors, notes: [] };
    return { summary: `New entity: ${label}`, writes: [{ path: `${PATHS.entities}/${slug}.json`, after: body(e) }] };
  }
  const found = m.entityFiles.find((f) => f.data.id === input.id);
  if (!found) throw new DeskError(404, `No entity ${input.id}.`);
  const e: Entity = { ...found.data, label, kind, aliases, anchors };
  return { summary: `Edit entity: ${label}`, writes: [{ path: `${PATHS.entities}/${found.file}`, after: body(e) }] };
}

export type QuestionInput = {
  id?: string;
  title?: string;
  what_we_know?: string;
  what_we_dont?: string;
  what_might_answer_it?: string;
  evidence_needed?: string;
  last_known_source?: string[];
  entities?: string[];
  evidence?: string[];
  status?: string;
};

/** A bounded question, opened by a person. It closes only on evidence (the check says so). */
export function planSaveQuestion(dir: string, input: QuestionInput, who: string): Plan {
  const m = readMuseum(dir);
  const q = {
    title: need(text(input.title), "A title"),
    what_we_know: need(text(input.what_we_know), "What we know"),
    what_we_dont: need(text(input.what_we_dont), "What we don't"),
    what_might_answer_it: need(text(input.what_might_answer_it), "What might answer it"),
    evidence_needed: need(text(input.evidence_needed), "Evidence needed"),
    last_known_source: list(input.last_known_source),
    entities: list(input.entities),
    status: input.status === "answered" ? "answered" : "open",
    evidence: list(input.evidence),
  };
  if (!input.id) {
    const ids = new Set(m.questions.map((x) => x.id));
    const base = slugify(q.title).slice(0, 60).replace(/-+$/, "");
    let id = base;
    for (let i = 2; ids.has(id); i++) id = `${base}-${i}`;
    return { summary: `Open a question: ${q.title}`, writes: [{ path: `${PATHS.questions}/${id}.json`, after: body({ id, ...q, curator: who, date: today() }) }] };
  }
  const old = m.questions.find((x) => x.id === input.id) as Record<string, unknown> | undefined;
  if (!old) throw new DeskError(404, `No question ${input.id}.`);
  return { summary: `Edit the question: ${q.title}`, writes: [{ path: `${PATHS.questions}/${input.id}.json`, after: body({ ...old, ...q }) }] };
}

export type EvidenceInput = { span?: string; quote?: string; record?: string; type?: string; note?: string };

/** An evidence link: a curator's act, appended, never rewritten. The quote must be in its span, verbatim. */
export function planAddEvidence(dir: string, input: EvidenceInput, who: string): Plan {
  const m = readMuseum(dir);
  const span = need(text(input.span), "The span");
  const quote = need(typeof input.quote === "string" ? input.quote : "", "The quote");
  const record = need(text(input.record), "The record");
  const type = text(input.type);
  if (!["supports", "contradicts", "qualifies"].includes(type)) throw new DeskError(400, "Evidence supports, contradicts or qualifies.");
  const words = spans(m.records).get(span);
  if (words === undefined) throw new DeskError(404, `No span ${span}.`);
  if (!words.includes(quote)) throw new DeskError(422, `The quote isn't in ${span}, word for word. The span reads: “${words}”`);
  const used = new Set((m.evidence as { id: string }[]).map((e) => e.id));
  let n = used.size + 1;
  let id: string;
  do id = `ev-${String(n++).padStart(3, "0")}`;
  while (used.has(id));
  const link = { id, claim: { span, quote }, record, type, ...(text(input.note) ? { note: text(input.note) } : {}), curator: who, date: today() };
  return { summary: `Evidence ${id}: ${record} ${type} ${span}`, writes: [{ path: PATHS.evidence, after: body([...m.evidence, link]) }] };
}

/** A text correction: the whole passage or caption, as it should read, into the queue. */
export function planProposeText(dir: string, input: { target?: string; proposed_text?: string; reason?: string }, who: string): Plan {
  const m = readMuseum(dir);
  const target = need(text(input.target), "The passage or caption");
  const words = spans(m.records).get(target);
  if (words === undefined) throw new DeskError(404, `No span ${target}.`);
  const proposed = need(typeof input.proposed_text === "string" ? input.proposed_text.trim() : "", "The corrected text");
  if (proposed === words) throw new DeskError(409, "That is how it reads already.");
  const { id, write } = claimNext(m, "correction");
  const c = { id, kind: "text", target, proposed_text: proposed, reason: need(text(input.reason), "A reason"), proposed_by: who, date: today(), status: "proposed" };
  return { summary: `Propose a correction to ${target} (${id})`, writes: [write, { path: `${PATHS.corrections}/${id}.json`, after: body(c) }] };
}

/** Apply an accepted text correction: the span reads as corrected, and the correction keeps the words it replaced. */
export function planApply(dir: string, id: string, who: string): Plan {
  const m = readMuseum(dir);
  const c = m.corrections.find((x) => x.id === id);
  if (!c) throw new DeskError(404, `No correction ${id}.`);
  if (c.kind === "name") throw new DeskError(400, `${id} is a name: it is kept, not applied.`);
  if (c.status !== "accepted") throw new DeskError(409, `${id} is ${c.status}; only an accepted correction is applied.`);
  const words = spans(m.records).get(c.target);
  if (words === undefined) throw new DeskError(404, `No span ${c.target}.`);
  const rid = spanRecord(c.target);
  const r = m.records.find((x) => x.id === rid)!;
  const next: Record_ = c.target.startsWith("plate:")
    ? { ...r, caption: c.proposed_text }
    : { ...r, passages: (r.passages ?? []).map((p) => (`${r.id}#${p.id}` === c.target ? { ...p, text: c.proposed_text } : p)) };
  next.notes = [...(r.notes ?? []), { date: today(), note: `${c.target} corrected by ${c.id} (${c.reason})` }];
  return {
    summary: `Apply ${id} to ${c.target}`,
    writes: [
      { path: `${PATHS.records}/${rid}.json`, after: body(next) },
      { path: `${PATHS.corrections}/${id}.json`, after: body({ ...c, status: "applied", original_text: words, decided_by: who, decided_on: today() }) },
    ],
  };
}

/**
 * Retire a record: its ID goes on the tombstones, never to be reissued, and
 * its file and held files go. The check refuses it while anything still
 * points at it, and says what.
 */
export function planRetire(dir: string, id: string, reason: string): Plan {
  const m = readMuseum(dir);
  const r = m.records.find((x) => x.id === id);
  if (!r) throw new DeskError(404, `No record ${id}.`);
  const why = need(text(reason), "A reason");
  return {
    summary: `Retire ${id}: ${why}`,
    writes: [
      { path: PATHS.tombstones, after: body([...m.tombstones, { id, date: today(), reason: why }]) },
      { path: `${PATHS.records}/${id}.json`, delete: true },
      ...(r.media ?? []).map((path) => ({ path, delete: true as const })),
    ],
  };
}
