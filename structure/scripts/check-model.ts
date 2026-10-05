/**
 * The model's checks, for CI and by hand (npm run check:model): prints every
 * problem and exits 1 if there are any. An empty museum passes.
 */
import { problems } from "./lib/validate.ts";

const root = new URL("../", import.meta.url);
const found = problems(root);
if (found.length) {
  console.error(`model check failed (${found.length}):\n  ${found.join("\n  ")}`);
  process.exit(1);
}
console.log("model check passed");
