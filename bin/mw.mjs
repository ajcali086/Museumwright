#!/usr/bin/env node
// mw: the Museumwright starter. Runs src/cli.ts under Node's type stripping,
// and lets Node's fetch use the environment's proxy where one is set.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const env = { ...process.env };
if ((env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY) && !env.NODE_USE_ENV_PROXY)
  env.NODE_USE_ENV_PROXY = "1";
const run = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", cli, ...process.argv.slice(2)],
  { stdio: "inherit", env },
);
process.exit(run.status ?? 1);
