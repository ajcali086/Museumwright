/**
 * The purity rule: a freshly generated museum holds no material from the
 * museums this structure was learned from. The markers are their names,
 * places and particulars; the grep runs over every file init wrote.
 * The new museum's own name, title and repository are what the person
 * typed, so they are taken out before the grep.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const MARKERS = [
  "Spirit of Martinez",
  "spirit-of-martinez",
  "spiritofmartinez",
  "Martinez",
  "Calicura",
  "Colacurcio",
  "Angie",
  "Angelina",
  "Angiolina",
  "Horham",
  "44-6838",
  "95th Bomb",
  "Bomb Group",
  "Sheridan",
  "Dykhorst",
  "Rodia",
  "Ideal Hotel",
  "B-17",
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    if (f === ".git" || f === "node_modules" || f === "package-lock.json") return [];
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

/** Each hit, as "path: marker". Empty is pure. */
export function purityHits(dir: string, own: string[] = []): string[] {
  const allowed = own.filter((s) => s.length > 2).sort((a, b) => b.length - a.length);
  return files(dir).flatMap((path) => {
    let text = readFileSync(path, "latin1") + "\n" + relative(dir, path);
    for (const s of allowed) text = text.split(s).join("");
    const lower = text.toLowerCase();
    return MARKERS.filter((m) => lower.includes(m.toLowerCase())).map((m) => `${relative(dir, path)}: ${m}`);
  });
}
