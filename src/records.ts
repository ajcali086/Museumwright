/** The shapes mw writes: records and name proposals, in the folders the admin already edits. */
import type { Item, Ref } from "./repo.ts";
import { mediaPath } from "./repo.ts";

export const TOOL = "mw 0.1.0";

export type Provenance = { url?: string; file?: string; file_url?: string; page?: number; extracted_at: string };

const source = (p: Provenance, hash: string, extra: Record<string, unknown> = {}) => ({
  ...(p.url ? { url: p.url } : {}),
  ...(p.file ? { file: p.file } : {}),
  ...(p.file_url ? { file_url: p.file_url } : {}),
  ...(p.page ? { page: p.page } : {}),
  ...extra,
  extracted_at: p.extracted_at,
  input_hash: hash,
  tool: TOOL,
});

const base = { rights_holder: "unknown", held: true, status: "unverified" } as const;

export function documentItem(o: {
  hash: string;
  label: string;
  title: string;
  credit: string;
  passages: { id: string; text: string }[];
  prov: Provenance;
  media?: { bytes: Uint8Array; ext: string };
}): Item {
  return {
    hash: o.hash,
    type: "record",
    label: o.label,
    media: o.media,
    build: (id) => ({
      id,
      kind: "document",
      title: o.title,
      credit: o.credit,
      passages: o.passages,
      ...base,
      media: o.media ? [mediaPath(id, o.media.ext)] : [],
      source: source(o.prov, o.hash),
      notes: [],
    }),
  };
}

export function imageItem(o: {
  hash: string;
  label: string;
  title: string;
  caption: string;
  credit: string;
  alt?: string;
  parent?: string;
  position?: number;
  follows?: string;
  prov: Provenance;
  media: { bytes: Uint8Array; ext: string };
}): Item {
  return {
    hash: o.hash,
    type: "record",
    label: o.label,
    media: o.media,
    build: (id, ref: Ref) => {
      const found = o.parent ? ref(o.parent) : undefined;
      return {
        id,
        kind: "image",
        title: o.title,
        caption: o.caption,
        credit: o.credit,
        ...(o.alt ? { alt: o.alt } : {}),
        ...(found ? { found_in: found } : {}),
        ...(found && o.position ? { position: o.position } : {}),
        ...(found && o.follows ? { follows: o.follows } : {}),
        ...base,
        media: [mediaPath(id, o.media.ext)],
        source: source(o.prov, o.hash),
        notes: [],
      };
    },
  };
}

/** The skipped-content log: what the run left out, kept as a record of its own. */
export function logItem(o: { hash: string; title: string; parent?: string; lines: string[]; prov: Provenance }): Item {
  return {
    hash: o.hash,
    type: "record",
    label: o.title,
    build: (id, ref) => {
      const found = o.parent ? ref(o.parent) : undefined;
      return {
        id,
        kind: "log",
        title: o.title,
        ...(found ? { found_in: found } : {}),
        passages: o.lines.map((text, i) => ({ id: `s${i + 1}`, text })),
        ...base,
        media: [],
        source: source(o.prov, o.hash),
        notes: [],
      };
    },
  };
}

/** A name the model noticed, in the corrections shape, status proposed. A proposal, not an entity. */
export function nameItem(o: {
  hash: string;
  record: string;
  span: string;
  name: string;
  kind: string;
  model: string;
  prov: Provenance;
}): Item {
  return {
    hash: o.hash,
    type: "correction",
    label: `name "${o.name}"`,
    requires: [o.record],
    build: (id, ref) => {
      const target = o.span === "caption" ? `plate:${ref(o.record)}` : `${ref(o.record)}#${o.span}`;
      return {
        id,
        kind: "name",
        target,
        proposed_text: o.name,
        entity_kind: o.kind,
        reason: `Noticed in ${target} by the local model. A proposal, not an entity: keep it by creating the entity, anchored to ${ref(o.record)}, or hold it back.`,
        proposed_by: "mw",
        date: o.prov.extracted_at.slice(0, 10),
        status: "proposed",
        source: source(o.prov, o.hash, { model: o.model }),
      };
    },
  };
}

/** A record a proposal points at: one this run is bringing in (by its input hash), or one the museum has (by its ID). */
export type RecordRef = { hash: string } | { id: string };
/** A citation: the record, the span within it ("p3", "caption", or for a record the museum has, its full span key), the words. */
export type CiteRef = { ref: RecordRef; span: string; quote: string };

export type Kind = "contradiction" | "question" | "gap" | "duplicate" | "link";

/**
 * A proposal of one of the newer kinds, in the queue's shape: status
 * proposed, every claim cited. What it becomes once kept is the curator's
 * act at the desk; the machine writes nothing beyond the queue.
 */
export function proposalItem(o: {
  hash: string;
  kind: Kind;
  cites: CiteRef[];
  summary: (id: (r: RecordRef) => string) => string;
  question?: { text: string; record: RecordRef };
  gap?: { record: RecordRef; missing: string };
  pair?: { a: RecordRef; b: RecordRef };
  basis?: string;
  model: string;
  prov: Provenance;
}): Item {
  const refs = [...o.cites.map((c) => c.ref), ...(o.question ? [o.question.record] : []), ...(o.gap ? [o.gap.record] : []), ...(o.pair ? [o.pair.a, o.pair.b] : [])];
  return {
    hash: o.hash,
    type: "correction",
    label: `${o.kind} proposal`,
    requires: [...new Set(refs.flatMap((r) => ("hash" in r ? [r.hash] : [])))],
    build: (id, ref) => {
      const rid = (r: RecordRef) => ("hash" in r ? ref(r.hash)! : r.id);
      const key = (c: CiteRef) => ("id" in c.ref && c.span.includes(c.ref.id) ? c.span : c.span === "caption" ? `plate:${rid(c.ref)}` : `${rid(c.ref)}#${c.span}`);
      const cites = o.cites.map((c) => ({ span: key(c), quote: c.quote }));
      return {
        id,
        kind: o.kind,
        target: cites[0]?.span ?? (o.question ? `plate:${rid(o.question.record)}` : ""),
        proposed_text: o.summary(rid),
        cites,
        ...(o.question ? { question: { text: o.question.text, record: rid(o.question.record) } } : {}),
        ...(o.gap ? { gap: { record: rid(o.gap.record), missing: o.gap.missing } } : {}),
        ...(o.pair ? { pair: { a: rid(o.pair.a), b: rid(o.pair.b) } } : {}),
        ...(o.basis ? { basis: o.basis } : {}),
        reason: `Noticed by the local model. A proposal: the curator keeps it or holds it back.`,
        proposed_by: "mw",
        date: o.prov.extracted_at.slice(0, 10),
        status: "proposed",
        source: source(o.prov, o.hash, { model: o.model }),
      };
    },
  };
}
