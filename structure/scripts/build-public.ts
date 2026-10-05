/**
 * Writes the public slice (scripts/lib/public.ts) to public/data/museum.json,
 * for whatever render reads it. Run by `npm run build`, after the model check.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { publicSlice } from "./lib/public.ts";

const root = new URL("../", import.meta.url);
mkdirSync(new URL("public/data/", root), { recursive: true });
const slice = publicSlice(root);
writeFileSync(new URL("public/data/museum.json", root), JSON.stringify(slice, null, 2) + "\n");
console.log(`wrote public/data/museum.json (${slice.records.length} records, ${slice.entities.length} entities)`);
