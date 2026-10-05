/**
 * The public slice: what a visitor's render may read. It is built from
 * these folders and files only, and nothing else in this file names a
 * path. The corrections queue and meta/ are not among them, so a proposal
 * (a name the machine noticed, a correction not yet applied) has no path to
 * the public render: a build property, not a policy. check:model holds this
 * file to that list.
 */
import { readFolder, readJson } from "./files.ts";

export const PUBLIC_FOLDERS = ["src/model/records", "src/model/entities", "src/model/questions", "src/model/both-stand"] as const;
export const PUBLIC_FILES = ["src/model/museum.json", "src/model/evidence.json", "src/model/links.json"] as const;

/** Where an entry came from in the queue is the desk's business: it is left out, so no proposal's ID reaches a visitor. */
const unqueued = (rows: unknown[]) =>
  rows.map((r) => {
    if (!r || typeof r !== "object") return r;
    const { from_proposal: _from, ...rest } = r as Record<string, unknown>;
    return rest;
  });

export function publicSlice(base: URL) {
  const [records, entities, questions, bothStand] = PUBLIC_FOLDERS.map((dir) =>
    readFolder(base, dir).map((f) => f.data),
  );
  const [museum, evidence, links] = PUBLIC_FILES.map((path) => readJson<unknown>(base, path, null));
  return { museum, records, entities, questions: unqueued(questions), evidence, bothStand: unqueued(bothStand), links: unqueued((links as unknown[]) ?? []) };
}
