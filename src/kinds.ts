/**
 * The newer kinds of proposal (Proposal Kinds Spec v1), asked of the local
 * model the way names are: a prompt, an answer constrained by a grammar to
 * the kind's fields, and then the span rule. Every quote the model gives
 * must be in the span it names, word for word, or the proposal is dropped
 * here; check:model refuses one that reaches the queue anyway.
 *
 *   contradiction  over all of a run's spans: two claims that can't both be true
 *   question       per record: something it leaves unanswered
 *   gap            per record: two dated ends of a chain, nothing between
 *   duplicate      over the museum's records: one thing twice
 *   link           over the museum's records: a shared name, place or date
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { proposalItem, type CiteRef, type Kind, type Provenance, type RecordRef } from "./records.ts";
import type { Item } from "./repo.ts";
import { inputHash } from "./util.ts";

export const NEW_KINDS: Kind[] = ["contradiction", "question", "gap", "duplicate", "link"];

/** A span this run brings in: its record's input hash, its label within the record ("p3", "caption"), its words. */
export type RunSpan = { record: string; span: string; text: string; prov: Provenance };

const STRING = String.raw`string ::= "\"" char{1,200} "\""
char   ::= [^"\\\x7F\x00-\x1F] | "\\" ( ["\\/bfnrt] | "u" [0-9a-fA-F]{4} )
ws     ::= [ \t\n]{0,2}`;

/** A grammar for a list of objects with these fields: strings, or one of a few words. */
export function listGrammar(list: string, fields: [string, "string" | readonly string[]][], max = 6): string {
  const item = fields
    .map(([name, type], i) => `${i ? ' ws "," ws ' : ""}"\\"${name}\\":" ws ${typeof type === "string" ? "string" : `f${i}`}`)
    .join("");
  const enums = fields.flatMap(([, type], i) => (typeof type === "string" ? [] : [`f${i} ::= ${type.map((t) => `"\\"${t}\\""`).join(" | ")}`]));
  return [`root ::= "{" ws "\\"${list}\\":" ws "[" ws ( item ( ws "," ws item ){0,${max - 1}} )? ws "]" ws "}"`, `item ::= "{" ws ${item} ws "}"`, ...enums, STRING].join("\n");
}

/** Qwen3's chat template, thinking off. The first line of the user turn names the task (and lets a stand-in tell them apart). */
const prompt = (task: string, system: string, body: string) =>
  `<|im_start|>system\n${system}<|im_end|>\n<|im_start|>user\nTask: ${task}\n${body}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`;

export type Ask = (prompt: string, grammar: string) => Promise<Record<string, unknown>>;

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}…` : t);
const asList = (o: Record<string, unknown>, key: string) => (Array.isArray(o[key]) ? (o[key] as Record<string, string>[]) : []);

/** The museum's own records, for duplicates and links: each with its spans' keys and words. */
function museumRecords(dir: string | undefined, runHashes: Set<string>): { id: string; title: string; spans: { key: string; text: string }[] }[] {
  const folder = dir ? join(dir, "src/model/records") : "";
  if (!dir || !existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(folder, f), "utf8")) as { id: string; title: string; kind: string; caption?: string; passages?: { id: string; text: string }[]; source?: { input_hash?: string } })
    // Not the log, and not this run's own records as saved before: a record is never its own duplicate.
    .filter((r) => r.kind !== "log" && !runHashes.has(r.source?.input_hash ?? ""))
    .map((r) => ({
      id: r.id,
      title: r.title,
      spans: [...(r.caption ? [{ key: `plate:${r.id}`, text: r.caption }] : []), ...(r.passages ?? []).map((p) => ({ key: `${r.id}#${p.id}`, text: p.text }))],
    }));
}

export async function proposeKinds(o: { spans: RunSpan[]; ask: Ask; model: string; dir?: string; kinds: Kind[]; titles?: Map<string, string> }): Promise<{ items: Item[]; dropped: number }> {
  const items: Item[] = [];
  let dropped = 0;
  const spans = o.spans.filter((s) => s.text.trim());
  if (!spans.length) return { items, dropped };
  const prov = spans[0].prov;
  const label = new Map(spans.map((s, i) => [`S${i + 1}`, s]));
  const holds = (s: RunSpan | undefined, quote: string | undefined): s is RunSpan => !!s && !!quote && quote.length > 1 && s.text.includes(quote);
  const cite = (s: RunSpan, quote: string): CiteRef => ({ ref: { hash: s.record }, span: s.span, quote });

  // Contradictions: over every span the run brings in.
  if (o.kinds.includes("contradiction") && spans.length > 1) {
    const body = spans.slice(0, 80).map((s, i) => `[S${i + 1}] ${clip(s.text, 400)}`).join("\n");
    const out = await o.ask(
      prompt("contradictions", "You find pairs of statements that cannot both be true: the same thing given two different dates, places, numbers or names. Give each statement's label and copy its words exactly. If none conflict, return an empty list.", body),
      listGrammar("pairs", [["a", "string"], ["quote_a", "string"], ["b", "string"], ["quote_b", "string"]]),
    );
    for (const p of asList(out, "pairs")) {
      const a = label.get(p.a);
      const b = label.get(p.b);
      if (!holds(a, p.quote_a) || !holds(b, p.quote_b) || (a === b && p.quote_a === p.quote_b)) {
        dropped++;
        continue;
      }
      items.push(
        proposalItem({
          hash: inputHash("contradiction", a.record, a.span, p.quote_a, b.record, b.span, p.quote_b),
          kind: "contradiction",
          cites: [cite(a, p.quote_a), cite(b, p.quote_b)],
          summary: () => `“${p.quote_a}” against “${p.quote_b}”`,
          model: o.model,
          prov,
        }),
      );
    }
  }

  // Questions and gaps: per record.
  const byRecord = new Map<string, RunSpan[]>();
  for (const s of spans) byRecord.set(s.record, [...(byRecord.get(s.record) ?? []), s]);
  for (const [record, own] of byRecord) {
    const local = new Map(own.map((s) => [s.span === "caption" ? "caption" : s.span, s]));
    const body = own.map((s) => `[${s.span}] ${clip(s.text, 500)}`).join("\n");
    if (o.kinds.includes("question")) {
      const out = await o.ask(
        prompt("questions", "You read one record and list what it leaves unanswered that a curator could look for: who, when, where, what became of it. Give the passage label that raises each question and copy the words that raise it exactly. If nothing is left open, return an empty list.", body),
        listGrammar("questions", [["passage", "string"], ["quote", "string"], ["question", "string"]], 4),
      );
      for (const q of asList(out, "questions")) {
        const s = local.get(q.passage);
        if (!holds(s, q.quote) || !q.question?.trim()) {
          dropped++;
          continue;
        }
        items.push(
          proposalItem({
            hash: inputHash("question", record, s.span, q.quote, q.question.trim()),
            kind: "question",
            cites: [cite(s, q.quote)],
            question: { text: q.question.trim(), record: { hash: record } },
            summary: () => q.question.trim(),
            model: o.model,
            prov,
          }),
        );
      }
    }
    if (o.kinds.includes("gap")) {
      const out = await o.ask(
        prompt("gaps", "You read one record's account and find gaps in its chain: two dated statements with nothing known between them. Give each end's passage label, copy its words exactly, and say in a few words what is missing between them. If there is no gap, return an empty list.", body),
        listGrammar("gaps", [["from", "string"], ["quote_from", "string"], ["to", "string"], ["quote_to", "string"], ["missing", "string"]], 4),
      );
      for (const g of asList(out, "gaps")) {
        const a = local.get(g.from);
        const b = local.get(g.to);
        if (!holds(a, g.quote_from) || !holds(b, g.quote_to) || !g.missing?.trim()) {
          dropped++;
          continue;
        }
        items.push(
          proposalItem({
            hash: inputHash("gap", record, a.span, g.quote_from, b.span, g.quote_to),
            kind: "gap",
            cites: [cite(a, g.quote_from), cite(b, g.quote_to)],
            gap: { record: { hash: record }, missing: g.missing.trim() },
            summary: () => `${g.quote_from} → ${g.quote_to}: ${g.missing.trim()}`,
            model: o.model,
            prov,
          }),
        );
      }
    }
  }

  // Duplicates and links: over the museum's records and this run's, each pair with at least one of this run's.
  const pairs = o.kinds.filter((k) => k === "duplicate" || k === "link");
  if (pairs.length) {
    type Entry = { label: string; ref: RecordRef; title: string; spans: { key: string; text: string; run?: RunSpan }[]; fresh: boolean };
    const entries: Entry[] = [];
    for (const [record, own] of byRecord)
      entries.push({ label: `N${entries.length + 1}`, ref: { hash: record }, title: o.titles?.get(record) ?? clip(own[0].text, 60), spans: own.map((s) => ({ key: s.span, text: s.text, run: s })), fresh: true });
    for (const r of museumRecords(o.dir, new Set(byRecord.keys())).slice(0, 120)) if (r.spans.length) entries.push({ label: r.id, ref: { id: r.id }, title: r.title, spans: r.spans, fresh: false });
    const byLabel = new Map(entries.map((e) => [e.label, e]));
    if (entries.length > 1) {
      const body = entries.map((e) => `[${e.label}] ${e.title} — ${clip(e.spans.map((s) => s.text).join(" "), 300)}`).join("\n");
      /** The span of a record that holds the quote, as a citation; undefined if none does. */
      const find = (e: Entry | undefined, quote: string | undefined): CiteRef | undefined => {
        if (!e || !quote || quote.length < 2) return undefined;
        const s = e.spans.find((x) => x.text.includes(quote));
        return s ? { ref: e.ref, span: s.key, quote } : undefined;
      };
      const pairOf = (p: Record<string, string>) => {
        const a = byLabel.get(p.a);
        const b = byLabel.get(p.b);
        const ca = find(a, p.quote_a);
        const cb = find(b, p.quote_b);
        if (!a || !b || a === b || !(a.fresh || b.fresh) || !ca || !cb) return undefined;
        return { a, b, ca, cb };
      };
      const refKey = (r: RecordRef) => ("hash" in r ? r.hash : r.id);
      if (pairs.includes("duplicate")) {
        const out = await o.ask(
          prompt("duplicates", "You compare records and list pairs that may be the same object recorded twice: the same caption, credit, size or description. Give both labels and copy the matching words from each exactly. If none match, return an empty list.", body),
          listGrammar("pairs", [["a", "string"], ["quote_a", "string"], ["b", "string"], ["quote_b", "string"]], 4),
        );
        for (const p of asList(out, "pairs")) {
          const m = pairOf(p);
          if (!m) {
            dropped++;
            continue;
          }
          items.push(
            proposalItem({
              hash: inputHash("duplicate", ...[refKey(m.a.ref), refKey(m.b.ref)].sort(), m.ca.quote, m.cb.quote),
              kind: "duplicate",
              cites: [m.ca, m.cb],
              pair: { a: m.a.ref, b: m.b.ref },
              summary: (id) => `${id(m.a.ref)} and ${id(m.b.ref)} may be one thing twice`,
              model: o.model,
              prov,
            }),
          );
        }
      }
      if (pairs.includes("link")) {
        const BASES = ["shared name", "shared place", "shared date"] as const;
        const out = await o.ask(
          prompt("links", "You compare records and list pairs that are connected: they name the same person, the same place, or the same date. Give both labels, what they share, and copy the shared words from each exactly. If none connect, return an empty list.", body),
          listGrammar("links", [["a", "string"], ["quote_a", "string"], ["b", "string"], ["quote_b", "string"], ["basis", BASES]], 6),
        );
        for (const p of asList(out, "links")) {
          const m = pairOf(p);
          if (!m || !BASES.includes(p.basis as (typeof BASES)[number])) {
            dropped++;
            continue;
          }
          items.push(
            proposalItem({
              hash: inputHash("link", ...[refKey(m.a.ref), refKey(m.b.ref)].sort(), p.basis, m.ca.quote, m.cb.quote),
              kind: "link",
              cites: [m.ca, m.cb],
              pair: { a: m.a.ref, b: m.b.ref },
              basis: p.basis,
              summary: (id) => `${id(m.a.ref)} ↔ ${id(m.b.ref)}: ${p.basis}`,
              model: o.model,
              prov,
            }),
          );
        }
      }
    }
  }
  return { items, dropped };
}
