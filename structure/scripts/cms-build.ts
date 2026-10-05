/**
 * Writes public/admin/config.yml from src/cms/config.yml, its dropdowns
 * filled from the model. Run by `npm run dev` and `npm run build`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { buildConfig } from "./lib/cms.ts";

const root = new URL("../", import.meta.url);
const source = readFileSync(new URL("src/cms/config.yml", root), "utf8");
writeFileSync(new URL("public/admin/config.yml", root), buildConfig(source, root));
console.log("wrote public/admin/config.yml");
