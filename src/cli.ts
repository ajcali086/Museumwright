/**
 * mw: a converter that writes the folders the existing admin already edits.
 *
 *   mw init <name> [--repo owner/name] [--title "..."] [--dir path] [--no-install] [--no-git]
 *   mw pull <url> [--propose] [--model-url URL] [--max-width 3000] [--no-skip-log] [--museum dir]
 *   mw batch <folder> [--propose] [--model-url URL] [--no-skip-log] [--museum dir]
 *   mw serve [--museum dir] [--port 8080] [--host 0.0.0.0] [--state dir] [--model-url URL]
 *
 * pull and batch write into the museum repository at --museum (default:
 * the current directory), then run its model check.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { batch } from "./batch.ts";
import { init } from "./init.ts";
import { DEFAULT_MODEL_URL } from "./propose.ts";
import { pull } from "./pull.ts";
import { assertMuseum, type Outcome } from "./repo.ts";
import { RunLog } from "./util.ts";

const USAGE = `usage:
  mw init <name> [--repo owner/name] [--title "..."] [--dir path] [--no-install] [--no-git]
  mw pull <url> [--propose] [--model-url URL] [--max-width N] [--no-skip-log] [--museum dir]
  mw batch <folder> [--propose] [--model-url URL] [--no-skip-log] [--museum dir]
  mw serve [--museum dir] [--port 8080] [--host 0.0.0.0] [--state dir] [--model-url URL]`;

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) pos.push(a);
    else if (a.startsWith("--no-")) flags[a.slice(5)] = false;
    else if (["--propose", "--help"].includes(a)) flags[a.slice(2)] = true;
    else {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      flags[a.slice(2)] = v;
    }
  }
  return { pos, flags };
}

function report(o: Outcome, log: RunLog) {
  log.say(`claimed ${o.new.length} new IDs${o.new.length ? ` (${o.new[0]} … ${o.new.at(-1)})` : ""}; ${o.unchanged.length} unchanged; ${o.restored.length} restored; ${o.tombstoned.length} tombstoned`);
}

function check(dir: string, log: RunLog): number {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", "scripts/check-model.ts"], { cwd: dir, encoding: "utf8" });
  log.say((r.stdout + r.stderr).trim());
  return r.status ?? 1;
}

/** The museum box: the viewer for the LAN, the desk for the curator. Runs until stopped. */
async function serve(flags: Record<string, string | boolean>): Promise<number> {
  const { networkInterfaces } = await import("node:os");
  const { createMuseumServer } = await import("./serve/server.ts");
  const str = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);
  const port = Number(str("port") ?? process.env.PORT ?? 8080);
  const host = str("host") ?? "0.0.0.0";
  const { server, desk, dir } = createMuseumServer({ museum: str("museum") ?? "museum", state: str("state"), modelUrl: str("model-url") });
  await new Promise<void>((ok) => server.listen(port, host, ok));
  const actual = (server.address() as { port: number }).port;
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => `http://${i!.address}:${actual}/`);
  console.log(`museum: ${dir}`);
  console.log(`state:  ${desk.dir}`);
  console.log(`visitors: http://localhost:${actual}/${lan.length ? `  ${lan.join("  ")}` : ""}`);
  console.log(`desk:     http://localhost:${actual}/desk/`);
  if (!desk.configured) console.log(`desk setup code: ${desk.setupCode}  (type it at the desk once, with the passcode you choose)`);
  await new Promise(() => undefined);
  return 0;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);
  const log = new RunLog();
  if (cmd === "serve" && !flags.help) return serve(flags);
  if (!cmd || flags.help || !pos[0]) {
    console.log(USAGE);
    return cmd ? 1 : 0;
  }
  const str = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);
  if (cmd === "init") {
    const dir = init(pos[0], { repo: str("repo"), title: str("title"), dir: str("dir"), install: flags.install !== false, git: flags.git !== false }, log);
    log.say(`ready: ${dir}`);
    return 0;
  }
  if (cmd !== "pull" && cmd !== "batch") {
    console.error(USAGE);
    return 1;
  }
  const museum = resolve(str("museum") ?? ".");
  assertMuseum(museum);
  const common = { skipLog: flags["skip-log"] === false, propose: flags.propose === true, modelUrl: str("model-url") ?? process.env.MW_MODEL_URL ?? DEFAULT_MODEL_URL };
  const outcome =
    cmd === "pull"
      ? await pull(museum, pos[0], { ...common, maxWidth: str("max-width") ? Number(str("max-width")) : undefined }, log)
      : await batch(museum, pos[0], common, log);
  report(outcome, log);
  return check(museum, log);
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`mw: ${(e as Error).message}`);
    process.exit(1);
  },
);
