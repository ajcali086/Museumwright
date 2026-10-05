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
