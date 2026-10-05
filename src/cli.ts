/**
 * mw, the easy way in (Shell Spec v1). Five commands, no flags required,
 * errors in plain words:
 *
 *   mw new            start a museum (asks a few questions)
 *   mw pull <url>     bring in a web page
 *   mw add <folder>   bring in files: photos, PDFs, text
 *   mw desk           open the curator's desk on this box's network
 *   mw sync           trade commits with GitHub
 *   mw doctor         check this box has what mw needs
 *
 * The older names stay for scripts: init, batch, serve. Every flag has a
 * default; `mw <command> --help` shows examples first.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statfsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { batch } from "./batch.ts";
import { init, outPath, STRUCTURE } from "./init.ts";
import { DEFAULT_MODEL_URL, reach } from "./propose.ts";
import { pull } from "./pull.ts";
import { type Outcome } from "./repo.ts";
import * as G from "./serve/git.ts";
import { isMuseum } from "./serve/museum.ts";
import { RunLog, slugify } from "./util.ts";

/** A refusal said plainly: what went wrong, and what to do. */
class Plain extends Error {}

type Flags = Record<string, string | boolean>;
type Command = {
  summary: string;
  usage: string;
  examples: string[];
  options: [string, string][];
  run: (pos: string[], flags: Flags) => Promise<number>;
};

const BOOLEAN = new Set(["help", "yes", "verbose", "propose", "commit"]);

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") flags.help = true;
    else if (a === "-y") flags.yes = true;
    else if (!a.startsWith("--")) pos.push(a);
    else if (a.startsWith("--no-")) flags[a.slice(5)] = false;
    else if (a.includes("=")) flags[a.slice(2, a.indexOf("="))] = a.slice(a.indexOf("=") + 1);
    else if (BOOLEAN.has(a.slice(2))) flags[a.slice(2)] = true;
    else {
      const v = argv[++i];
      if (v === undefined) throw new Plain(`${a} needs a value after it.`);
      flags[a.slice(2)] = v;
    }
  }
  return { pos, flags };
}

const str = (flags: Flags, k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);
const interactive = () => !!process.stdin.isTTY && !!process.stdout.isTTY;

/**
 * One reader for the whole run, its lines queued: answers typed ahead, or
 * pasted at once, go to the questions in order. The end of input is no
 * answer, said plainly.
 */
type Reader = { lines: string[]; waiting: ((l: string | null) => void)[]; closed: boolean };
let reader: Reader | undefined;
function nextLine(): Promise<string | null> {
  if (!reader) {
    const r: Reader = (reader = { lines: [], waiting: [], closed: false });
    const rl = createInterface({ input: process.stdin, terminal: false });
    rl.on("line", (l) => (r.waiting.length ? r.waiting.shift()!(l) : r.lines.push(l)));
    rl.on("close", () => {
      r.closed = true;
      for (const w of r.waiting.splice(0)) w(null);
    });
  }
  if (reader.lines.length) return Promise.resolve(reader.lines.shift()!);
  if (reader.closed) return Promise.resolve(null);
  return new Promise((ok) => reader!.waiting.push(ok));
}

/** A question; Enter takes the fallback. If input ends first, `atEnd` is the answer, or (undefined) nothing is written. */
async function ask(question: string, fallback = "", atEnd?: string): Promise<string> {
  process.stdout.write(`${question}${fallback ? ` [${fallback}]` : ""} `);
  const line = await nextLine();
  if (line === null) {
    process.stdout.write("\n");
    if (atEnd !== undefined) return atEnd;
    throw new Plain("No answer came, so nothing was written.");
  }
  return line.trim() || fallback;
}

/** The museum a command works on: --museum, or this folder. */
function museumHere(flags: Flags): string {
  const dir = resolve(str(flags, "museum") ?? ".");
  if (!isMuseum(dir))
    throw new Plain(
      `${dir === process.cwd() ? "This folder" : dir} isn't a museum (there's no meta/sequences.json).\n` +
        `  Make one:      mw new\n  Or go to one:  cd path/to/museum   (or add --museum path/to/museum)`,
    );
  return dir;
}

function checkMuseum(dir: string): { ok: boolean; lines: string[] } {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", "scripts/check-model.ts"], { cwd: dir, encoding: "utf8" });
  const lines = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").filter(Boolean);
  return { ok: r.status === 0, lines };
}

/**
 * After a pull or an add: the check decides. In a git repository that was
 * clean before, a passing run is one commit and a refused one is taken
 * back, as at the desk.
 */
function settle(dir: string, wasClean: boolean, message: string, o: Outcome): number {
  const c = checkMuseum(dir);
  console.log(`\nClaimed ${o.new.length} new ID${o.new.length === 1 ? "" : "s"}${o.new.length ? ` (${o.new[0]} … ${o.new.at(-1)})` : ""}; ${o.unchanged.length} already here${o.tombstoned.length ? `; ${o.tombstoned.length} retired, not re-created` : ""}.`);
  const git = G.isRepo(dir);
  if (!c.ok) {
    console.log("\nThe museum's check refused this:");
    for (const l of c.lines.slice(1)) console.log(`  ${l}`);
    if (git && wasClean) {
      G.discard(dir);
      console.log("\nNothing was kept: the museum is as it was before.");
    } else console.log("\nThe files are still there for you to fix or remove.");
    return 1;
  }
  console.log("✓ The museum's check passes.");
  if (git && wasClean && o.new.length + o.restored.length) {
    const hash = G.commitAll(dir, process.env.GIT_AUTHOR_NAME || "mw", message);
    if (hash) console.log(`✓ Committed ${hash}: ${message}`);
  } else if (git && !wasClean) console.log("  (Not committed: the museum had changes of its own before this. Commit them together when ready.)");
  return 0;
}

const COMMANDS: Record<string, Command> = {
  new: {
    summary: "start a museum (asks a few questions)",
    usage: "mw new [name]",
    examples: ['mw new', 'mw new "The Mill Museum"', 'mw new "The Mill Museum" --repo you/mill-museum --yes'],
    options: [
      ["--title <title>", "what visitors see, if not the name"],
      ["--repo <owner/name>", "the GitHub repository it will live in"],
      ["--dir <folder>", "where to make it (default: a folder named for it)"],
      ["--yes", "don't ask before writing"],
      ["--no-install", "skip npm install in the new museum"],
      ["--no-git", "don't start its git history"],
    ],
    run: async (pos, flags) => {
      const tty = interactive();
      let name = pos[0] ?? str(flags, "name");
      if (!name && tty) name = await ask("What is the museum called?");
      if (!name) throw new Plain('A museum needs a name:  mw new "The Mill Museum"');
      let title = str(flags, "title");
      if (!title && tty && !flags.yes) title = await ask("Title for visitors:", name, name);
      let repo = str(flags, "repo");
      if (repo === undefined && tty && !flags.yes) repo = (await ask("GitHub repository for it (owner/name), or leave blank:", "", "")) || undefined;
      if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Plain(`"${repo}" isn't a GitHub repository name. It looks like owner/name, for example you/mill-museum.`);
      const dir = resolve(str(flags, "dir") ?? slugify(name));
      if (existsSync(dir) && readdirSync(dir).filter((f) => f !== ".git").length) throw new Plain(`${dir} already has files in it. Pick another name or --dir.`);

      // Show what it will write, before it writes it.
      const files: string[] = [];
      const walk = (d: string) => {
        for (const f of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, f.name);
          if (f.isDirectory()) walk(p);
          else files.push(outPath(relative(STRUCTURE, p)));
        }
      };
      walk(STRUCTURE);
      console.log(`\nmw new will write ${files.length} files into ${relative(process.cwd(), dir) || "."}/:\n`);
      for (const f of files.sort()) console.log(`  ${f}`);
      console.log("");
      if (tty && !flags.yes) {
        const ok = (await ask("Write them? (Y/n)", "y", "n")).toLowerCase();
        process.stdin.pause();
        if (!ok.startsWith("y")) {
          console.log("Nothing was written.");
          return 1;
        }
      }
      const log = new RunLog();
      try {
        init(name, { repo, title: title || undefined, dir, install: flags.install !== false, git: flags.git !== false }, log);
      } catch (e) {
        throw new Plain(`The museum wasn't made: ${(e as Error).message}`);
      }
      const rel = relative(process.cwd(), dir) || ".";
      console.log(`\n✓ ${title || name} is ready in ${rel}/, and its check passes.\n\nNext:\n  cd ${rel}\n  mw desk                 open the desk, and build it in a browser\n  mw pull <web address>   or bring in a page from here\n  mw add <folder>         or bring in a folder of files`);
      return 0;
    },
  },

  pull: {
    summary: "bring in a web page",
    usage: "mw pull <web address>",
    examples: ["mw pull https://example.org/post/the-mill", "mw pull https://example.org/post/the-mill --museum ../mill-museum"],
    options: [
      ["--museum <folder>", "the museum (default: this folder)"],
      ["--no-propose", "don't ask the local model for names"],
      ["--model-url <url>", `the local model (default ${DEFAULT_MODEL_URL}, or MW_MODEL_URL)`],
      ["--max-width <px>", "the widest image to fetch (default 3000)"],
      ["--no-skip-log", "don't keep a record of what was left out"],
    ],
    run: async (pos, flags) => {
      const url = pos[0];
      if (!url) throw new Plain("Which page?  mw pull https://example.org/post/the-mill");
      if (!/^https?:\/\//i.test(url)) throw new Plain(`"${url}" isn't a web address. It starts with http:// or https://.`);
      const dir = museumHere(flags);
      const clean = G.isRepo(dir) && !G.dirty(dir).length;
      const o = await pull(dir, url, { propose: flags.propose !== false, modelUrl: modelUrl(flags), skipLog: flags["skip-log"] === false, maxWidth: str(flags, "max-width") ? Number(str(flags, "max-width")) : undefined }, new RunLog());
      return settle(dir, clean, `Pull ${url}`, o);
    },
  },

  add: {
    summary: "bring in files: photos, PDFs, text",
    usage: "mw add <folder>",
    examples: ["mw add ~/Pictures/box-3", "mw add ./scans --museum ../mill-museum"],
    options: [
      ["--museum <folder>", "the museum (default: this folder)"],
      ["--no-propose", "don't ask the local model for names in their text"],
      ["--model-url <url>", `the local model (default ${DEFAULT_MODEL_URL}, or MW_MODEL_URL)`],
      ["--no-skip-log", "don't keep a record of files left out"],
    ],
    run: async (pos, flags) => {
      const folder = pos[0];
      if (!folder) throw new Plain("Which folder?  mw add ~/Pictures/box-3");
      if (!existsSync(folder)) throw new Plain(`There's no folder at ${folder}.`);
      const dir = museumHere(flags);
      const clean = G.isRepo(dir) && !G.dirty(dir).length;
      const o = await batch(dir, folder, { propose: flags.propose !== false, modelUrl: modelUrl(flags), skipLog: flags["skip-log"] === false }, new RunLog());
      return settle(dir, clean, `Add ${relative(dir, resolve(folder)) || folder}`, o);
    },
  },

  desk: {
    summary: "open the curator's desk on this box's network",
    usage: "mw desk",
    examples: ["mw desk", "mw desk --port 80", "mw desk --museum /srv/mill-museum"],
    options: [
      ["--museum <folder>", "the museum (default: this folder if it is one, else ./museum, which the desk can create)"],
      ["--port <n>", "the port (default 8080, or PORT)"],
      ["--host <address>", "where to listen (default 0.0.0.0: the whole network)"],
      ["--state <folder>", "where the passcode is kept (default ~/.local/state/museumwright/…)"],
      ["--model-url <url>", `the local model (default ${DEFAULT_MODEL_URL})`],
    ],
    run: async (_pos, flags) => {
      const { networkInterfaces } = await import("node:os");
      const { createMuseumServer } = await import("./serve/server.ts");
      const museum = str(flags, "museum") ?? (isMuseum(process.cwd()) ? "." : "museum");
      const port = Number(str(flags, "port") ?? process.env.PORT ?? 8080);
      const host = str(flags, "host") ?? "0.0.0.0";
      const { server, desk, dir } = createMuseumServer({ museum, state: str(flags, "state"), modelUrl: str(flags, "model-url") });
      await new Promise<void>((ok, fail) => {
        server.once("error", (e: NodeJS.ErrnoException) =>
          fail(new Plain(e.code === "EADDRINUSE" ? `Port ${port} is already in use. Try another:  mw desk --port ${port + 1}` : e.code === "EACCES" ? `This user may not open port ${port}. Try a port above 1024:  mw desk --port 8080` : e.message)),
        );
        server.listen(port, host, ok);
      });
      const actual = (server.address() as { port: number }).port;
      const lan = Object.values(networkInterfaces())
        .flat()
        .filter((i) => i && i.family === "IPv4" && !i.internal)
        .map((i) => `http://${i!.address}:${actual}`);
      console.log(`The desk is open. Leave this window running; Ctrl+C stops it.\n`);
      console.log(`  Museum:   ${dir}${isMuseum(dir) ? "" : "  (not made yet: create it at the desk)"}`);
      console.log(`  Desk:     http://localhost:${actual}/desk/${lan.length ? `\n            ${lan.map((u) => `${u}/desk/`).join("\n            ")}   (from other devices)` : ""}`);
      console.log(`  Visitors: http://localhost:${actual}/${lan.length ? `   ${lan.map((u) => `${u}/`).join("   ")}` : ""}`);
      if (!desk.configured) console.log(`\n  Setup code: ${desk.setupCode}\n  Type it at the desk once, with a passcode you choose.`);
      await new Promise(() => undefined);
      return 0;
    },
  },

  sync: {
    summary: "trade commits with GitHub",
    usage: "mw sync",
    examples: ["mw sync", "mw sync --museum ../mill-museum"],
    options: [["--museum <folder>", "the museum (default: this folder)"]],
    run: async (_pos, flags) => {
      const dir = museumHere(flags);
      if (!G.isRepo(dir)) throw new Plain("This museum has no git history yet.\n  Start one:  git init -b main && git add -A && git commit -m \"The museum\"");
      const remote = G.git(dir, ["remote", "get-url", "origin"]);
      if (!remote.ok) throw new Plain("No GitHub repository is set for this museum.\n  Set one:  git remote add origin https://github.com/you/mill-museum.git");
      const dirty = G.dirty(dir);
      if (dirty.length)
        throw new Plain(`There are changes no commit holds yet:\n${dirty.slice(0, 10).map((l) => `  ${l}`).join("\n")}${dirty.length > 10 ? `\n  … and ${dirty.length - 10} more` : ""}\n  Commit them first:  git add -A && git commit -m "What changed"`);
      const fetched = G.fetchRemote(dir);
      if (!fetched.ok) {
        if (/couldn't find remote ref|not found|does not appear/i.test(fetched.out) && !/Could not resolve|unable to access/i.test(fetched.out)) {
          const pushed = G.git(dir, ["push", "-q", "-u", "origin", "main"]);
          if (!pushed.ok) throw new Plain(`GitHub didn't take the museum:\n  ${pushed.out.split("\n").join("\n  ")}`);
          console.log(`✓ Sent the museum to ${remote.out} (it was empty there).`);
          return 0;
        }
        throw new Plain(`Couldn't reach ${remote.out}. Is the web there?\n  ${fetched.out.split("\n").slice(-2).join("\n  ")}`);
      }
      const s = G.sync(dir);
      const ahead = s.ahead ?? 0;
      const behind = s.behind ?? 0;
      if (ahead && behind) {
        console.log(`Both sides moved: this box has ${ahead} commit${ahead === 1 ? "" : "s"} GitHub doesn't, and GitHub has ${behind} this box doesn't. Nothing was sent or taken.`);
        console.log(`\nTo settle it, take GitHub's and put the box's on top, then sync again:\n  git pull --rebase origin main\n  mw sync\nIf git stops on a conflict, it says which file; fix it, then  git rebase --continue.`);
        return 1;
      }
      if (behind) {
        const r = G.git(dir, ["merge", "--ff-only", "-q", "origin/main"]);
        if (!r.ok) throw new Plain(`Couldn't take GitHub's commits: ${r.out}`);
        const c = checkMuseum(dir);
        console.log(`✓ Took ${behind} commit${behind === 1 ? "" : "s"} from GitHub.`);
        console.log(c.ok ? "✓ The museum's check passes." : `The museum's check now finds problems:\n${c.lines.slice(1).map((l) => `  ${l}`).join("\n")}`);
        return c.ok ? 0 : 1;
      }
      if (ahead) {
        const r = G.git(dir, ["push", "-q", "origin", "main"]);
        if (!r.ok) throw new Plain(`GitHub didn't take the commits:\n  ${r.out.split("\n").join("\n  ")}`);
        G.fetchRemote(dir);
        console.log(`✓ Sent ${ahead} commit${ahead === 1 ? "" : "s"} to GitHub.`);
        return 0;
      }
      console.log("✓ Already in step with GitHub: nothing to send or take.");
      return 0;
    },
  },

  doctor: {
    summary: "check this box has what mw needs",
    usage: "mw doctor",
    examples: ["mw doctor", "mw doctor --museum /srv/mill-museum"],
    options: [
      ["--museum <folder>", "a museum to check too (default: this folder, if it is one)"],
      ["--model-url <url>", `the local model to look for (default ${DEFAULT_MODEL_URL})`],
    ],
    run: async (_pos, flags) => doctor(flags),
  },
};

const ALIASES: Record<string, string> = { batch: "add", serve: "desk", init: "new" };

const modelUrl = (flags: Flags) => str(flags, "model-url") ?? process.env.MW_MODEL_URL ?? DEFAULT_MODEL_URL;

/** The fix for what's missing, as the command for this kind of computer. */
function install(pkg: { apt: string; brew: string; winget?: string }): string {
  if (process.platform === "darwin") return `brew install ${pkg.brew}`;
  if (process.platform === "win32") return pkg.winget ? `winget install ${pkg.winget}` : `(install ${pkg.brew} for Windows)`;
  return `sudo apt install ${pkg.apt}`;
}

const has = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return r.error ? undefined : `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
};

async function doctor(flags: Flags): Promise<number> {
  let failed = 0;
  const line = (state: "ok" | "warn" | "fail", what: string, fix?: string) => {
    if (state === "fail") failed++;
    console.log(`${state === "ok" ? "✓" : state === "warn" ? "!" : "✗"} ${what}${fix ? `\n    ${fix}` : ""}`);
  };
  console.log("Checking this box for mw:\n");

  const [major, minor] = process.versions.node.split(".").map(Number);
  const nodeOk = major > 22 || (major === 22 && minor >= 6);
  line(nodeOk ? "ok" : "fail", `Node.js ${process.versions.node}${nodeOk ? "" : " (mw needs 22.6 or newer)"}`, nodeOk ? undefined : "Install a newer Node.js from https://nodejs.org (the LTS), then open a new terminal.");

  const gitV = has("git", ["--version"]);
  line(gitV ? "ok" : "fail", gitV ? gitV : "git isn't installed (the museum's history lives in it)", gitV ? undefined : install({ apt: "git", brew: "git", winget: "Git.Git" }));

  const poppler = ["pdfinfo", "pdftotext", "pdftoppm"].every((c) => has(c, ["-v"]) !== undefined);
  line(poppler ? "ok" : "warn", poppler ? "poppler (for PDFs)" : "poppler isn't installed: PDFs will be skipped, everything else works", poppler ? undefined : install({ apt: "poppler-utils", brew: "poppler" }));

  const url = modelUrl(flags);
  const m = await reach(url);
  line("model" in m ? "ok" : "warn", "model" in m ? `the local model answers at ${url} (${m.model})` : `no local model at ${url}: names won't be proposed, everything else works`, "model" in m ? undefined : "Start one:  llama-server -hf Qwen/Qwen3-1.7B-GGUF:Q4_K_M --port 8080");

  const where = resolve(str(flags, "museum") ?? ".");
  try {
    const fs = statfsSync(existsSync(where) ? where : process.cwd());
    const free = (fs.bavail * fs.bsize) / 1024 ** 3;
    line(free >= 2 ? "ok" : free >= 0.5 ? "warn" : "fail", `${free.toFixed(1)} GB free here`, free >= 2 ? undefined : "Photographs fill a disk quickly: free some space, or put the museum on a bigger one.");
  } catch {
    line("warn", "couldn't tell how much disk is free");
  }

  if (isMuseum(where)) {
    const c = checkMuseum(where);
    line(c.ok ? "ok" : "fail", c.ok ? `the museum at ${where} passes its check` : `the museum at ${where} fails its check:`, c.ok ? undefined : c.lines.slice(1, 6).join("\n    "));
    if (G.isRepo(where)) {
      const r = G.git(where, ["remote", "get-url", "origin"]);
      line(r.ok ? "ok" : "warn", r.ok ? `GitHub: ${r.out}` : "no GitHub repository set (fine offline; mw sync needs one)", r.ok ? undefined : "Set one when you want it:  git remote add origin https://github.com/you/mill-museum.git");
    } else line("warn", "the museum has no git history", 'Start one:  git init -b main && git add -A && git commit -m "The museum"');
  } else console.log(`- No museum here. Make one:  mw new`);

  console.log(failed ? `\n${failed} thing${failed === 1 ? "" : "s"} to fix before mw will work.` : "\nThis box is ready.");
  return failed ? 1 : 0;
}

function overview() {
  console.log("mw builds a museum's archive.\n");
  for (const [name, c] of Object.entries(COMMANDS)) {
    if (name === "doctor") console.log("");
    console.log(`  ${c.usage.replace(/^mw /, "mw ").padEnd(20)} ${c.summary}`);
  }
  console.log("\nmw <command> --help shows examples. New box? Start with  mw doctor");
}

function help(name: string) {
  const c = COMMANDS[name];
  console.log(`${c.usage}  —  ${c.summary}\n\nFor example:\n${c.examples.map((e) => `  ${e}`).join("\n")}`);
  if (c.options.length) console.log(`\nOptions (all optional):\n${c.options.map(([f, d]) => `  ${f.padEnd(22)} ${d}`).join("\n")}\n  --verbose              show everything when something goes wrong`);
}

async function main(): Promise<number> {
  const [first, ...rest] = process.argv.slice(2);
  if (!first || first === "--help" || first === "-h" || first === "help") {
    if (first === "help" && rest[0] && COMMANDS[ALIASES[rest[0]] ?? rest[0]]) help(ALIASES[rest[0]] ?? rest[0]);
    else overview();
    return 0;
  }
  const name = ALIASES[first] ?? first;
  const cmd = COMMANDS[name];
  if (!cmd) {
    console.error(`mw doesn't know "${first}".\n`);
    overview();
    return 1;
  }
  const { pos, flags } = parseArgs(rest);
  verbose = flags.verbose === true;
  if (flags.help) {
    help(name);
    return 0;
  }
  return cmd.run(pos, flags);
}

let verbose = false;

/** What went wrong, in the words a curator can act on. */
function plainly(e: unknown): string {
  const err = e as Error & { cause?: { code?: string; hostname?: string } };
  if (err instanceof Plain) return err.message;
  const m = err.message ?? String(e);
  const status = /^GET (\S+): (\d{3})/.exec(m);
  if (status) return `The page answered ${status[2]}${status[2] === "404" ? " (not found)" : status[2] === "403" ? " (not allowed)" : ""}: ${status[1]}`;
  if (/is not a museum repository/.test(m)) return m.replace(/^(\S+) is not a museum repository \(no (\S+)\); run mw init first$/, "$1 isn't a museum (no $2). Make one:  mw new");
  return m;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`\n${plainly(e)}`);
    if (verbose) console.error(`\n${(e as Error).stack ?? e}`);
    else if (!(e instanceof Plain)) console.error("\n(mw --verbose … shows the details.)");
    process.exit(1);
  },
);
