#!/usr/bin/env node
// mw: the Museumwright starter. In a checkout it runs src/cli.ts under
// Node's type stripping; installed as a package (from git, under
// node_modules, where Node won't strip types) it runs the build in dist/.
// Either way, Node's fetch uses the environment's proxy where one is set.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const dist = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const installed = /[\\/]node_modules[\\/]/.test(src);
const useSrc = existsSync(src) && !installed;
if (!useSrc && !existsSync(dist)) {
  console.error("mw: dist/ is missing; run `npm run build` (npm does this on install from git)");
  process.exit(1);
}
const env = { ...process.env };
if ((env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY) && !env.NODE_USE_ENV_PROXY)
  env.NODE_USE_ENV_PROXY = "1";
const args = useSrc
  ? ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", src]
  : [dist];
const run = spawnSync(process.execPath, [...args, ...process.argv.slice(2)], { stdio: "inherit", env });
process.exit(run.status ?? 1);
