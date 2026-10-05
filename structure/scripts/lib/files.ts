/**
 * Reading the museum's folders: one JSON file per record, entity, question
 * or correction, plus a few single files. Plain fs, no bundler, so the
 * check, the CMS build and `mw` all read the repository the same way.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";

/** A folder's JSON files, by file name, sorted. A missing folder is empty. */
export function readFolder(base: URL, dir: string): { file: string; data: unknown }[] {
  const url = new URL(`${dir}/`, base);
  if (!existsSync(url)) return [];
  return readdirSync(url)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => ({ file, data: JSON.parse(readFileSync(new URL(file, url), "utf8")) }));
}

/** One JSON file, or the fallback if it isn't there. */
export function readJson<T>(base: URL, path: string, fallback: T): T {
  const url = new URL(path, base);
  return existsSync(url) ? (JSON.parse(readFileSync(url, "utf8")) as T) : fallback;
}
