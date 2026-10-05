/**
 * The museum, as the desk reads it: the same folders the check, Sveltia and
 * mw use. Plain JSON off disk, every time: there is no other copy.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Passage = { id: string; text: string };
export type Record_ = {
  id: string;
  kind: string;
  title: string;
  caption?: string;
  credit?: string;
  alt?: string;
  found_in?: string;
  position?: number;
  passages?: Passage[];
  held: boolean;
  status: string;
  media?: string[];
  source?: Record<string, unknown>;
  notes?: { date: string; note: string }[];
  [k: string]: unknown;
};
export type Entity = {
  id: string;
  slug: string;
  kind: string;
  label: string;
  aliases?: { name: string; sources?: string[] }[];
  anchors?: string[];
  notes?: { date: string; note: string }[];
  [k: string]: unknown;
};
export type Correction = {
  id: string;
  kind?: string;
  target: string;
  proposed_text: string;
  entity_kind?: string;
  reason: string;
  proposed_by: string;
  date: string;
  status: string;
  decided_by?: string;
  decided_on?: string;
  source?: Record<string, unknown>;
  [k: string]: unknown;
};

export const PATHS = {
  records: "src/model/records",
  entities: "src/model/entities",
  questions: "src/model/questions",
  corrections: "src/data/corrections",
  evidence: "src/model/evidence.json",
  museum: "src/model/museum.json",
  sequences: "meta/sequences.json",
  tombstones: "meta/tombstones.json",
} as const;

const folder = <T>(dir: string): { file: string; data: T }[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((file) => ({ file, data: JSON.parse(readFileSync(join(dir, file), "utf8")) as T }))
    : [];
const json = <T>(path: string, fallback: T): T => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback);

export const isMuseum = (dir: string) => existsSync(join(dir, PATHS.sequences)) && existsSync(join(dir, PATHS.records));

export function readMuseum(dir: string) {
  const records = folder<Record_>(join(dir, PATHS.records));
  const entities = folder<Entity>(join(dir, PATHS.entities));
  const corrections = folder<Correction>(join(dir, PATHS.corrections));
  return {
    museum: json<{ slug: string; title: string } | null>(join(dir, PATHS.museum), null),
    records: records.map((f) => f.data),
    entities: entities.map((f) => f.data),
    entityFiles: entities,
    corrections: corrections.map((f) => f.data),
    questions: folder<{ id: string; title: string; status: string }>(join(dir, PATHS.questions)).map((f) => f.data),
    evidence: json<unknown[]>(join(dir, PATHS.evidence), []),
    sequences: json<{ record: { prefix: string; next: number }; correction: { prefix: string; next: number }; claims: Record<string, string> } | null>(join(dir, PATHS.sequences), null),
    tombstones: json<{ id: string; date: string; reason: string }[]>(join(dir, PATHS.tombstones), []),
  };
}
export type Museum = ReturnType<typeof readMuseum>;

/** Every span's words: "r-0001#p3" for a passage, "plate:r-0002" for a caption. As the check reads them. */
export function spans(records: Record_[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of records) {
    for (const p of r.passages ?? []) out.set(`${r.id}#${p.id}`, p.text);
    if (r.kind === "image" || r.caption) out.set(`plate:${r.id}`, r.caption ?? "");
  }
  return out;
}

export const spanRecord = (key: string) => (key.startsWith("plate:") ? key.slice(6) : key.split("#")[0]);

export const recordText = (r: Record_) =>
  [r.title, r.caption ?? "", r.credit ?? "", r.alt ?? "", ...(r.passages ?? []).map((p) => p.text)].join("\n");
