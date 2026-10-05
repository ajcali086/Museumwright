/**
 * The model's checks. Each returns the problems it finds, as lines naming
 * the file or ID; an empty list is a pass. An empty museum passes: the
 * build's first green comes before any content exists.
 */
import { existsSync, readFileSync } from "node:fs";
import {
  ENTITY_KINDS,
  loadModel,
  recordText,
  spanRecord,
  spans,
  type Model,
  type Sequence,
} from "./model.ts";
import { PUBLIC_FILES, PUBLIC_FOLDERS, publicSlice } from "./public.ts";

const iso = /^\d{4}-\d{2}-\d{2}$/;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const fail = (cond: boolean, msg: string) => (cond ? [] : [msg]);
const dupes = (ids: string[]) => ids.filter((id, i) => ids.indexOf(id) !== i);

const RECORD_KINDS = ["image", "document", "object", "log"];
const RECORD_STATUSES = ["verified", "unverified", "not-held"];
const CORRECTION_STATUSES = ["proposed", "accepted", "applied", "rejected", "held"];

type Check = { name: string; run: (m: Model, base: URL) => string[] };

/** A sequence-shaped ID's number, or undefined if the ID isn't one of the sequence's. */
function seqNumber(seq: Sequence, id: string): number | undefined {
  const m = new RegExp(`^${seq.prefix.replace(/[-]/g, "\\-")}(\\d+)$`).exec(id);
  return m ? Number(m[1]) : undefined;
}

export const checks: Check[] = [
  {
    name: "the structure is in place: the museum record, sequences and tombstones",
    run: (m) => [
      ...fail(!!m.museum?.slug && !!m.museum?.title, "src/model/museum.json: no slug or title"),
      ...fail(
        !!m.sequences?.record && !!m.sequences?.correction && !!m.sequences?.claims,
        "meta/sequences.json: missing or malformed",
      ),
      ...fail(Array.isArray(m.tombstones), "meta/tombstones.json: missing or not a list"),
    ],
  },
  {
    name: "each record, question and correction is filed under its ID, each entity under its slug",
    run: (m) => [
      ...m.files.records.flatMap(({ file, data }) => fail(file === `${data.id}.json`, `records/${file}: ID ${data.id}`)),
      ...m.files.questions.flatMap(({ file, data }) => fail(file === `${data.id}.json`, `questions/${file}: ID ${data.id}`)),
      ...m.files.corrections.flatMap(({ file, data }) => fail(file === `${data.id}.json`, `corrections/${file}: ID ${data.id}`)),
      ...m.files.entities.flatMap(({ file, data }) => fail(file === `${data.slug}.json`, `entities/${file}: slug ${data.slug}`)),
    ],
  },
  {
    name: "IDs are well formed and unique",
    run: (m) => [
      ...m.records.flatMap((r) => fail(/^[a-z0-9-]+$/.test(r.id ?? ""), `record ${r.id}: malformed`)),
      ...m.entities.flatMap((e) => [
        ...fail(/^[0-9a-f]{8}$/.test(e.id ?? ""), `entity ${e.slug}: ID ${e.id} malformed`),
        ...fail(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(e.slug ?? ""), `entity ${e.id}: slug ${e.slug} malformed`),
      ]),
      ...m.questions.flatMap((q) => fail(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(q.id ?? ""), `question ${q.id}: malformed`)),
      ...m.corrections.flatMap((c) => fail(/^c-[a-z0-9-]+$/.test(c.id ?? ""), `correction ${c.id}: malformed`)),
      ...m.evidence.flatMap((l) => fail(/^ev-\d{3}$/.test(l.id ?? ""), `evidence ${l.id}: malformed`)),
      ...dupes(m.records.map((r) => r.id)).map((id) => `record ${id}: duplicate`),
      ...dupes(m.entities.map((e) => e.id)).map((id) => `entity ${id}: duplicate ID`),
      ...dupes(m.questions.map((q) => q.id)).map((id) => `question ${id}: duplicate`),
      ...dupes(m.corrections.map((c) => c.id)).map((id) => `correction ${id}: duplicate`),
      ...dupes(m.evidence.map((l) => l.id)).map((id) => `evidence ${id}: duplicate`),
    ],
  },
  {
    name: "each record has a kind, a title and a status; held and status agree; a held copy is a file or the text; every file named exists",
    run: (m, base) =>
      m.records.flatMap((r) => {
        const media = r.media ?? [];
        const passages = r.passages ?? [];
        return [
          ...fail(RECORD_KINDS.includes(r.kind), `${r.id}: kind ${r.kind}`),
          ...fail(!!r.title?.trim(), `${r.id}: no title`),
          ...fail(RECORD_STATUSES.includes(r.status), `${r.id}: status ${r.status}`),
          ...fail(r.held === (r.status !== "not-held"), `${r.id}: held ${r.held}, status ${r.status}`),
          ...(r.held
            ? fail(media.length > 0 || passages.length > 0, `${r.id}: held, but no file and no text`)
            : fail(media.length === 0, `${r.id}: not held, names files`)),
          ...media.flatMap((path) => fail(existsSync(new URL(path, base)), `${r.id}: ${path} missing`)),
          ...dupes(passages.map((p) => p.id)).map((id) => `${r.id}: passage ${id} twice`),
          ...passages.flatMap((p) => fail(/^[a-z0-9-]+$/.test(p.id ?? "") && typeof p.text === "string", `${r.id}: passage ${p.id} malformed`)),
          ...(r.found_in
            ? fail(m.records.some((x) => x.id === r.found_in) && r.found_in !== r.id, `${r.id}: found in ${r.found_in}, no such record`)
            : []),
          ...(r.notes ?? []).flatMap((n) => fail(iso.test(n.date ?? "") && !!n.note?.trim(), `${r.id}: a note undated or empty`)),
        ];
      }),
  },
  {
    name: "a record mw wrote says where from and when, and its input hash claims its ID",
    run: (m) =>
      m.records.flatMap((r) => {
        const s = r.source;
        if (!s) return [];
        return [
          ...fail(!!(s.url || s.file), `${r.id}: source names no URL or file`),
          ...fail(instant.test(s.extracted_at ?? ""), `${r.id}: extracted_at ${s.extracted_at}`),
          ...fail(!!s.input_hash && m.sequences?.claims[s.input_hash] === r.id, `${r.id}: its input hash doesn't claim it in meta/sequences.json`),
        ];
      }),
  },
  {
    name: "IDs are claimed once: no ID claimed twice, none past its sequence, none tombstoned in use",
    run: (m) => {
      if (!m.sequences || !Array.isArray(m.tombstones)) return [];
      const { record, correction, claims } = m.sequences;
      const claimed = Object.values(claims);
      const dead = new Set(m.tombstones.map((t) => t.id));
      const live = [...m.records.map((r) => r.id), ...m.corrections.map((c) => c.id)];
      return [
        ...[record, correction].flatMap((s) =>
          fail(typeof s.prefix === "string" && Number.isInteger(s.next) && s.next >= 1 && Number.isInteger(s.width), `sequence ${s.prefix}: malformed`),
        ),
        ...dupes(claimed).map((id) => `${id}: claimed by two inputs`),
        ...claimed.flatMap((id) => {
          const seq = id.startsWith(correction.prefix) ? correction : record;
          const n = seqNumber(seq, id);
          return fail(n !== undefined && n < seq.next, `${id}: claimed, but past its sequence (next ${seq.next})`);
        }),
        ...live.flatMap((id) => fail(!dead.has(id), `${id}: tombstoned, but in use`)),
        ...m.tombstones.flatMap((t) => fail(!!t.id && iso.test(t.date ?? "") && !!t.reason?.trim(), `tombstone ${t.id}: needs an ID, a date and a reason`)),
        ...dupes(m.tombstones.map((t) => t.id)).map((id) => `tombstone ${id}: twice`),
      ];
    },
  },
  {
    name: "each entity is anchored: at least one record, every anchor exists, one spells its name, each alias as its sources write it",
    run: (m) =>
      m.entities.flatMap((e) => {
        const anchors = e.anchors ?? [];
        const names = [e.label, ...(e.aliases ?? []).map((a) => a.name)];
        const rec = (id: string) => m.records.find((r) => r.id === id);
        return [
          ...fail(ENTITY_KINDS.includes(e.kind), `${e.slug}: kind ${e.kind}`),
          ...fail(!!e.label?.trim(), `${e.slug}: no label`),
          ...fail(anchors.length > 0, `${e.slug}: no anchor; a kept name needs the record that spells it`),
          ...anchors.flatMap((id) => fail(!!rec(id), `${e.slug}: anchor ${id}, no such record`)),
          ...(anchors.length
            ? fail(anchors.some((id) => { const r = rec(id); return !!r && names.some((n) => recordText(r).includes(n)); }), `${e.slug}: no anchor spells "${e.label}" or an alias`)
            : []),
          ...(e.aliases ?? []).flatMap((a) =>
            (a.sources ?? []).flatMap((id) => {
              const r = rec(id);
              return r ? fail(recordText(r).includes(a.name), `${e.slug}: ${id} doesn't write "${a.name}"`) : [`${e.slug}: alias source ${id}, no such record`];
            }),
          ),
        ];
      }),
  },
  {
    name: "each question is bounded, its references resolve, and one closes only on evidence",
    run: (m) =>
      m.questions.flatMap((q) => [
        ...["title", "what_we_know", "what_we_dont", "what_might_answer_it", "evidence_needed", "curator"].flatMap((k) =>
          fail(!!String((q as Record<string, unknown>)[k] ?? "").trim(), `${q.id}: no ${k}`),
        ),
        ...fail(iso.test(q.date ?? ""), `${q.id}: date ${q.date}`),
        ...fail(["open", "answered"].includes(q.status), `${q.id}: status ${q.status}`),
        ...(q.last_known_source ?? []).flatMap((id) => fail(m.records.some((r) => r.id === id), `${q.id}: rests on ${id}, no such record`)),
        ...(q.entities ?? []).flatMap((id) => fail(m.entities.some((e) => e.id === id), `${q.id}: entity ${id}, none such`)),
        ...(q.evidence ?? []).flatMap((id) => fail(m.evidence.some((l) => l.id === id), `${q.id}: evidence ${id}, none such`)),
        ...(q.status === "answered" ? fail((q.evidence ?? []).length > 0, `${q.id}: answered, on no evidence`) : []),
      ]),
  },
  {
    name: "each evidence link quotes its span verbatim, names a record, and every contradiction is carried by a question",
    run: (m) => {
      const text = spans(m.records);
      return m.evidence.flatMap((l) => [
        ...fail(m.records.some((r) => r.id === l.record), `${l.id}: record ${l.record}, none such`),
        ...fail(["supports", "contradicts", "qualifies"].includes(l.type), `${l.id}: type ${l.type}`),
        ...fail(text.has(l.claim?.span), `${l.id}: span ${l.claim?.span}, none such`),
        ...(text.has(l.claim?.span)
          ? fail(!!l.claim.quote && text.get(l.claim.span)!.includes(l.claim.quote), `${l.id}: the quote isn't in ${l.claim.span}`)
          : []),
        ...fail(iso.test(l.date ?? "") && !!l.curator?.trim(), `${l.id}: who and when`),
        ...(l.type === "contradicts"
          ? fail(m.questions.some((q) => (q.evidence ?? []).includes(l.id)), `${l.id}: a contradiction no question carries`)
          : []),
      ]);
    },
  },
  {
    name: "each correction targets a span, says what, why, who and when, and is decided once it leaves the queue",
    run: (m) => {
      const text = spans(m.records);
      return m.corrections.flatMap((c) => [
        ...fail(["text", "name", undefined].includes(c.kind), `${c.id}: kind ${c.kind}`),
        ...fail(text.has(c.target), `${c.id}: ${c.target} is no span`),
        ...fail(CORRECTION_STATUSES.includes(c.status), `${c.id}: status ${c.status}`),
        ...fail(!!c.proposed_text?.trim(), `${c.id}: nothing proposed`),
        ...fail(!!c.reason?.trim(), `${c.id}: no reason`),
        ...fail(!!c.proposed_by?.trim(), `${c.id}: no proposer`),
        ...fail(iso.test(c.date ?? ""), `${c.id}: date ${c.date}`),
        // A text correction proposes words the span doesn't read yet; once applied, the span reads
        // them, and the correction keeps the words they replaced.
        ...(c.kind !== "name" && text.has(c.target)
          ? c.status === "applied"
            ? [
                ...fail(c.proposed_text === text.get(c.target), `${c.id}: applied, but ${c.target} doesn't read as corrected`),
                ...fail(typeof c.original_text === "string", `${c.id}: applied, without the words it replaced`),
              ]
            : fail(c.proposed_text !== text.get(c.target), `${c.id}: changes nothing`)
          : []),
        ...(c.status === "proposed"
          ? []
          : [
              ...fail(!!c.decided_by?.trim(), `${c.id}: ${c.status}, but by nobody`),
              ...fail(iso.test(c.decided_on ?? ""), `${c.id}: ${c.status}, but undated`),
            ]),
      ]);
    },
  },
  {
    name: "the span rule: a name proposal's span contains the name as spelled, and a kept name is an entity anchored to that record",
    run: (m) => {
      const text = spans(m.records);
      return m.corrections
        .filter((c) => c.kind === "name")
        .flatMap((c) => {
          const span = text.get(c.target);
          const record = spanRecord(c.target);
          const kept = m.entities.find((e) => e.label === c.proposed_text || (e.aliases ?? []).some((a) => a.name === c.proposed_text));
          return [
            ...fail(span !== undefined && !!c.proposed_text && span.includes(c.proposed_text), `${c.id}: ${c.target} doesn't contain "${c.proposed_text}"`),
            ...(c.entity_kind ? fail(ENTITY_KINDS.includes(c.entity_kind), `${c.id}: entity kind ${c.entity_kind}`) : []),
            ...(c.status === "applied" ? [`${c.id}: a name is kept (accepted), not applied`] : []),
            ...(c.status === "accepted"
              ? fail(!!kept && (kept.anchors ?? []).includes(record), `${c.id}: kept, but no entity named "${c.proposed_text}" is anchored to ${record}`)
              : []),
          ];
        });
    },
  },
  {
    name: "the public slice has no path to the queue: it reads only its own folders, and carries no proposal",
    run: (m, base) => {
      const listed = [...PUBLIC_FOLDERS, ...PUBLIC_FILES].join(" ");
      const source = readFileSync(new URL("scripts/lib/public.ts", base), "utf8");
      const slice = JSON.stringify(publicSlice(base));
      return [
        ...fail(!/corrections|meta\//.test(listed), "scripts/lib/public.ts: lists the queue or meta/"),
        ...fail(!/src\/data|meta\/|model\.ts|validate\.ts/.test(source.replace(/^\s*(\*|\/\/).*$/gm, "")), "scripts/lib/public.ts: reaches beyond its list"),
        ...m.corrections.flatMap((c) => fail(!slice.includes(`"${c.id}"`), `${c.id}: in the public slice`)),
      ];
    },
  },
];

/** Every problem the checks find in the repository at `base`. */
export function problems(base: URL): string[] {
  const model = loadModel(base);
  return checks.flatMap((c) => c.run(model, base).map((p) => `${c.name}: ${p}`));
}
