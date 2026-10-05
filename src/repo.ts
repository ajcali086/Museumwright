/**
 * A museum repository, as mw writes to it. Everything a run would write is
 * planned first, keyed by its input hash; IDs are claimed once, from
 * meta/sequences.json, at the end of the run, and then the files are
 * written. An input already claimed keeps its ID and its file is left as
 * the curator last saved it; a tombstoned one is not re-created. Same
 * input, same IDs.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunLog } from "./util.ts";

export type Sequence = { prefix: string; width: number; next: number };
export type Sequences = { record: Sequence; correction: Sequence; claims: Record<string, string> };
export type Tombstone = { id: string; date: string; reason: string };

/** Looks up the ID an input hash claims, once IDs are claimed. */
export type Ref = (hash: string) => string | undefined;

export type Item = {
  hash: string;
  type: "record" | "correction";
  /** For the run log. */
  label: string;
  /** The JSON file, given its ID and the IDs of the inputs it refers to. */
  build: (id: string, ref: Ref) => Record<string, unknown>;
  /** Inputs it can't stand without (a proposal's record): if one is tombstoned, it isn't written. */
  requires?: string[];
  /** A file to hold: written to public/images/uploads/<id>.<ext>. */
  media?: { bytes: Uint8Array; ext: string };
};

const FOLDERS = { record: "src/model/records", correction: "src/data/corrections" } as const;
export const UPLOADS = "public/images/uploads";

export function assertMuseum(dir: string) {
  for (const path of ["meta/sequences.json", "meta/tombstones.json", FOLDERS.record, FOLDERS.correction])
    if (!existsSync(join(dir, path)))
      throw new Error(`${dir} is not a museum repository (no ${path}); run mw init first`);
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const writeJson = (path: string, data: unknown) =>
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");

export type Outcome = { new: string[]; unchanged: string[]; restored: string[]; tombstoned: string[] };

/** Claims IDs for the plan, in order, and writes what is new. */
export function commit(dir: string, plan: Item[], log: RunLog): Outcome {
  assertMuseum(dir);
  const seqPath = join(dir, "meta/sequences.json");
  const seq = readJson<Sequences>(seqPath);
  const dead = new Set(readJson<Tombstone[]>(join(dir, "meta/tombstones.json")).map((t) => t.id));
  const inUse = new Set(
    Object.values(FOLDERS).flatMap((f) =>
      readdirSync(join(dir, f))
        .filter((x) => x.endsWith(".json"))
        .map((x) => x.replace(/\.json$/, "")),
    ),
  );
  const taken = new Set([...inUse, ...dead, ...Object.values(seq.claims)]);
  const claim = (s: Sequence) => {
    for (;;) {
      const id = s.prefix + String(s.next++).padStart(s.width, "0");
      if (!taken.has(id)) return taken.add(id), id;
    }
  };

  const ref: Ref = (hash) => {
    const id = seq.claims[hash];
    return id && !dead.has(id) ? id : undefined;
  };
  const out: Outcome = { new: [], unchanged: [], restored: [], tombstoned: [] };
  const toWrite: { item: Item; id: string }[] = [];
  const seen = new Set<string>();
  for (const item of plan) {
    if (seen.has(item.hash)) continue;
    seen.add(item.hash);
    const had = seq.claims[item.hash];
    const orphan = item.requires?.find((h) => !ref(h));
    if (orphan) {
      log.say(`  not written: ${item.label} rests on a tombstoned record`);
    } else if (had && dead.has(had)) {
      out.tombstoned.push(had);
      log.say(`  tombstoned, not re-created: ${had} (${item.label})`);
    } else if (had && inUse.has(had)) {
      out.unchanged.push(had);
    } else if (had) {
      out.restored.push(had);
      toWrite.push({ item, id: had });
      log.say(`  restored under its claimed ID: ${had} (${item.label})`);
    } else {
      const id = claim(item.type === "record" ? seq.record : seq.correction);
      seq.claims[item.hash] = id;
      out.new.push(id);
      toWrite.push({ item, id });
    }
  }

  // The claims first: an ID, once handed out, is never handed out again.
  if (out.new.length) writeJson(seqPath, seq);
  mkdirSync(join(dir, UPLOADS), { recursive: true });
  for (const { item, id } of toWrite) {
    if (item.media) writeFileSync(join(dir, UPLOADS, `${id}.${item.media.ext}`), item.media.bytes);
    writeJson(join(dir, FOLDERS[item.type], `${id}.json`), item.build(id, ref));
  }
  return out;
}

/** The repository path of a record's held file. */
export const mediaPath = (id: string, ext: string) => `${UPLOADS}/${id}.${ext}`;
