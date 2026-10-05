/**
 * The public slice: what a visitor's render may read. It is built from
 * these folders and files only, and nothing else in this file names a
 * path. The corrections queue and meta/ are not among them, so a proposal
 * (a name the machine noticed, a correction not yet applied) has no path to
 * the public render: a build property, not a policy. check:model holds this
 * file to that list.
 */
import { readFolder, readJson } from "./files.ts";

export const PUBLIC_FOLDERS = ["src/model/records", "src/model/entities", "src/model/questions"] as const;
export const PUBLIC_FILES = ["src/model/museum.json", "src/model/evidence.json"] as const;

export function publicSlice(base: URL) {
  const [records, entities, questions] = PUBLIC_FOLDERS.map((dir) =>
    readFolder(base, dir).map((f) => f.data),
  );
  const [museum, evidence] = PUBLIC_FILES.map((path) => readJson<unknown>(base, path, null));
  return { museum, records, entities, questions, evidence };
}
