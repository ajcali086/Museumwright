/**
 * mw init <name>: a clean museum repository, generated bottom-up from the
 * structure definition (../structure), never by stripping an existing
 * museum. Each step is verified before the next:
 *
 *   1. folders     the model's folders, empty and correct
 *   2. config      src/cms/config.yml, the universal collections only
 *   3. workbench   /admin (Sveltia, pinned), the CMS build, the check, CI
 *   4. sequences   meta/sequences.json and meta/tombstones.json
 *   5. verify      check:model passes on the empty museum
 *   6. purity      no content from any other museum
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { purityHits } from "./purity.ts";
import { slugify, type RunLog } from "./util.ts";

export const STRUCTURE = fileURLToPath(new URL("../structure/", import.meta.url));

const FOLDERS = ["src/model/records", "src/model/entities", "src/model/questions", "src/data/corrections", "public/images/uploads", "meta"];
const UNIVERSAL = ["corrections", "records", "entities", "questions", "both_stand", "links", "evidence"];

/** Which step writes a structure file. */
function stepOf(path: string): 1 | 2 | 3 | 4 {
  if (path.startsWith("meta/")) return 4;
  if (path === "src/cms/config.yml") return 2;
  if (path.startsWith("src/model/") || path.startsWith("src/data/") || path.startsWith("public/images/")) return 1;
  return 3;
}

function structureFiles(dir = STRUCTURE): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? structureFiles(p) : [relative(STRUCTURE, p)];
    });
}

/**
 * Where a structure file lands. npm never packs a file named .gitignore, so
 * the structure keeps it as `gitignore`, and init puts the dot back.
 */
export const outPath = (f: string) => (f === "gitignore" ? ".gitignore" : f);

const escapes: Record<string, (s: string) => string> = {
  json: (s) => JSON.stringify(s).slice(1, -1),
  yml: (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"'),
  html: (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
};

export function render(path: string, text: string, vars: { slug: string; title: string; repo: string }) {
  const esc = escapes[path.split(".").pop()!] ?? ((s: string) => s);
  return text
    .replaceAll("@@MW_SLUG@@", vars.slug)
    .replaceAll("@@MW_TITLE@@", esc(vars.title))
    .replaceAll("@@MW_REPO@@", vars.repo);
}

export type InitOptions = { repo?: string; title?: string; dir?: string; install?: boolean; git?: boolean };

export function init(name: string, opts: InitOptions, log: RunLog): string {
  const slug = slugify(name);
  const title = opts.title ?? name;
  const repo = opts.repo ?? `OWNER/${slug}`;
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) throw new Error(`--repo ${repo}: expected owner/name`);
  const dir = resolve(opts.dir ?? slug);
  if (existsSync(dir) && readdirSync(dir).filter((f) => f !== ".git").length)
    throw new Error(`${dir} exists and isn't empty`);
  const vars = { slug, title, repo };
  const ok = (step: string, cond: boolean, detail: string) => {
    if (!cond) throw new Error(`${step}: ${detail}`);
    log.say(`  ${step} ✓ ${detail}`);
  };
  const files = structureFiles();
  const write = (step: number) => {
    for (const f of files.filter((x) => stepOf(x) === step)) {
      const out = join(dir, outPath(f));
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, render(f, readFileSync(join(STRUCTURE, f), "utf8"), vars));
    }
  };
  log.say(`init ${slug} → ${dir}`);

  write(1);
  ok("1 folders", FOLDERS.filter((f) => f !== "meta").every((f) => existsSync(join(dir, f))) && existsSync(join(dir, "src/model/evidence.json")), "records, entities, questions, evidence.json, corrections, uploads");

  write(2);
  const config = parse(readFileSync(join(dir, "src/cms/config.yml"), "utf8")) as { backend: Record<string, unknown>; collections: { name: string }[] };
  const names = config.collections.map((c) => c.name);
  ok("2 config", JSON.stringify(names) === JSON.stringify(UNIVERSAL), `collections ${names.join(", ")}`);

  write(3);
  const b = config.backend;
  ok("3 workbench", existsSync(join(dir, "public/admin/index.html")) && existsSync(join(dir, "scripts/check-model.ts")) && b.name === "github" && b.branch === "main" && JSON.stringify(b.auth_methods) === '["token"]' && b.repo === repo, `/admin pinned, backend github ${repo}@main, token auth`);
  if (!opts.repo) log.say(`    (no --repo: the backend names ${repo}; set it in src/cms/config.yml)`);

  write(4);
  const seq = JSON.parse(readFileSync(join(dir, "meta/sequences.json"), "utf8"));
  const tomb = JSON.parse(readFileSync(join(dir, "meta/tombstones.json"), "utf8"));
  ok("4 sequences", seq.record?.next === 1 && seq.correction?.next === 1 && !Object.keys(seq.claims).length && Array.isArray(tomb) && !tomb.length, "meta/sequences.json and meta/tombstones.json, nothing claimed");

  const check = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", "scripts/check-model.ts"], { cwd: dir, encoding: "utf8" });
  ok("5 verify", check.status === 0, (check.stdout + check.stderr).trim().split("\n").join(" / "));

  const hits = purityHits(dir, [name, title, slug, repo]);
  ok("6 purity", hits.length === 0, hits.length ? `content markers found:\n    ${hits.join("\n    ")}` : "no content from another museum");

  if (opts.install !== false) {
    log.say("  npm install");
    const npm = spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir, encoding: "utf8" });
    if (npm.status !== 0) log.say(`    npm install failed; run it yourself:\n${npm.stderr}`);
    else {
      const built = spawnSync("npm", ["run", "cms:build"], { cwd: dir, encoding: "utf8" });
      ok("  cms build", built.status === 0, built.status === 0 ? "public/admin/config.yml builds" : built.stderr);
    }
  }
  if (opts.git !== false) {
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", `Generate the museum (mw init ${slug})`], { cwd: dir });
      log.say("  git: main, one commit");
    } catch (e) {
      log.say(`  git: not committed (${(e as Error).message.split("\n")[0]})`);
    }
  }
  return dir;
}
