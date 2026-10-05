/**
 * The shell, as the Shell Spec has it: five commands and a doctor, no
 * flags needed, examples before flags, refusals in plain words, and
 * pull/add committing what the check lets stand.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { angiePage } from "./fixtures/angie/page.ts";
import { MW, mw, serve, stubModel, tmp } from "./helpers.ts";

const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
const NO_MODEL = { MW_MODEL_URL: "http://127.0.0.1:9" };
const gitUser = { GIT_AUTHOR_NAME: "Andrew", GIT_AUTHOR_EMAIL: "a@museum.local", GIT_COMMITTER_NAME: "Andrew", GIT_COMMITTER_EMAIL: "a@museum.local" };

describe("the shell", () => {
  const root = tmp("shell");
  let site: Awaited<ReturnType<typeof serve>>;
  let model: Awaited<ReturnType<typeof stubModel>>;
  const fx = angiePage();
  let museum: string;

  before(async () => {
    const routes = new Map<string, { type: string; body: Uint8Array | string }>([["/post/angie", { type: "text/html", body: fx.html }]]);
    for (const [path, body] of fx.files) routes.set(path, { type: "image/jpeg", body });
    site = await serve(routes);
    model = await stubModel([["Watts Towers", "place"]]);
  });
  after(() => {
    site.server.close();
    model.server.close();
  });

  it("bare mw lists the five commands and the doctor, not a flag dump", async () => {
    const r = await mw([]);
    assert.equal(r.code, 0);
    for (const c of ["mw new", "mw pull <web address>", "mw add <folder>", "mw desk", "mw sync", "mw doctor"]) assert.ok(r.out.includes(c), c);
    assert.ok(!/--(museum|propose|model-url|port|yes)/.test(r.out), "no options in the overview");
  });

  it("--help shows examples first, flags last", async () => {
    const r = await mw(["pull", "--help"]);
    assert.ok(r.out.indexOf("For example:") < r.out.indexOf("Options (all optional):"));
    assert.match(r.out, /mw pull https:\/\/example\.org/);
  });

  it("refuses in plain words, without a stack trace", async () => {
    const unknown = await mw(["frobnicate"]);
    assert.equal(unknown.code, 1);
    assert.match(unknown.out, /mw doesn't know "frobnicate"/);
    const nameless = await mw(["new"], {}, root);
    assert.equal(nameless.code, 1);
    assert.match(nameless.out, /A museum needs a name:  mw new "The Mill Museum"/);
    const outside = await mw(["pull", "https://example.org"], {}, root);
    assert.match(outside.out, /This folder isn't a museum[\s\S]*mw new/);
    for (const r of [unknown, nameless, outside]) assert.ok(!/\n\s+at /.test(r.out), "no stack");
  });

  it("mw new shows the files it will write, then makes the museum, with its check green", async () => {
    const r = await mw(["new", "The Mill Museum", "--repo", "you/mill-museum", "--no-install"], gitUser, root);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /mw new will write \d+ files into the-mill-museum\//);
    for (const f of ["  .gitignore", "  src/cms/config.yml", "  meta/sequences.json", "  public/admin/index.html"]) assert.ok(r.out.includes(f), f);
    assert.match(r.out, /5 verify ✓ model check passed/);
    assert.match(r.out, /✓ The Mill Museum is ready in the-mill-museum\/[\s\S]*mw desk/);
    museum = join(root, "the-mill-museum");
    assert.equal(git(museum, "log", "--format=%s"), "Generate the museum (mw init the-mill-museum)");
  });

  it("mw pull proposes on its own when a model answers, and commits what the check lets stand", async () => {
    const r = await mw(["pull", `${site.url}/post/angie`], { MW_MODEL_URL: model.url, ...gitUser }, museum);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /propose: .* names noticed/);
    assert.match(r.out, /✓ The museum's check passes\.\n✓ Committed [0-9a-f]+: Pull /);
    assert.ok(readFileSync(join(museum, "src/data/corrections/c-0001.json"), "utf8").includes('"proposed"'));
    assert.equal(git(museum, "status", "--porcelain"), "");
  });

  it("without a model, it says so and goes on", async () => {
    const box = join(root, "box-3");
    mkdirSync(box);
    writeFileSync(join(box, "note.txt"), "The Watts Towers, from the train.\n");
    const r = await mw(["add", box], { ...NO_MODEL, ...gitUser }, museum);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /no model reachable at http:\/\/127\.0\.0\.1:9 .*the pile is empty/);
    assert.match(r.out, /Committed [0-9a-f]+: Add /);
    const again = await mw(["batch", box], { ...NO_MODEL, ...gitUser }, museum);
    assert.match(again.out, /Claimed 0 new IDs; 1 already here/);
  });

  it("a page that isn't there: said plainly, and nothing is kept", async () => {
    const r = await mw(["pull", `${site.url}/post/missing`], NO_MODEL, museum);
    assert.equal(r.code, 1);
    assert.match(r.out, /The page answered 404 \(not found\)/);
    assert.equal(git(museum, "status", "--porcelain"), "");
    const unreachable = await mw(["pull", "http://127.0.0.1:9/x", "--verbose"], NO_MODEL, museum);
    assert.match(unreachable.out, /Couldn't reach 127\.0\.0\.1:9\. Is the web there\?/);
    assert.match(unreachable.out, /\n\s+at /, "--verbose shows the rest");
  });

  it("mw sync sends, takes, and says what to do when both sides moved", async () => {
    const none = await mw(["sync"], {}, museum);
    assert.match(none.out, /No GitHub repository is set[\s\S]*git remote add origin/);
    const bare = join(root, "github.git");
    git(root, "init", "-q", "--bare", "-b", "main", bare);
    git(museum, "remote", "add", "origin", bare);
    assert.match((await mw(["sync"], {}, museum)).out, /✓ Sent the museum to .* \(it was empty there\)/);
    assert.match((await mw(["sync"], {}, museum)).out, /✓ Already in step with GitHub/);

    const other = join(root, "elsewhere");
    git(root, "clone", "-q", bare, other);
    const m = JSON.parse(readFileSync(join(other, "src/model/museum.json"), "utf8"));
    writeFileSync(join(other, "src/model/museum.json"), JSON.stringify({ ...m, rights_holder: "The family" }, null, 2) + "\n");
    git(other, "-c", "user.name=S", "-c", "user.email=s@s", "commit", "-qam", "Rights");
    git(other, "push", "-q", "origin", "main");
    const took = await mw(["sync"], {}, museum);
    assert.match(took.out, /✓ Took 1 commit from GitHub\.\n✓ The museum's check passes\./);

    writeFileSync(join(museum, "notes.md"), "box\n");
    assert.match((await mw(["sync"], {}, museum)).out, /changes no commit holds yet:[\s\S]*notes\.md[\s\S]*git add -A/);
    git(museum, "add", "-A");
    git(museum, "-c", "user.name=A", "-c", "user.email=a@a", "commit", "-qm", "Notes");
    assert.match((await mw(["sync"], {}, museum)).out, /✓ Sent 1 commit to GitHub\./);

    writeFileSync(join(other, "x.md"), "x\n");
    git(other, "add", "-A");
    git(other, "-c", "user.name=S", "-c", "user.email=s@s", "commit", "-qm", "X");
    git(other, "pull", "-q", "--rebase", "origin", "main");
    git(other, "push", "-q", "origin", "main");
    writeFileSync(join(museum, "y.md"), "y\n");
    git(museum, "add", "-A");
    git(museum, "-c", "user.name=A", "-c", "user.email=a@a", "commit", "-qm", "Y");
    const both = await mw(["sync"], {}, museum);
    assert.equal(both.code, 1);
    assert.match(both.out, /Both sides moved: this box has 1 commit GitHub doesn't, and GitHub has 1 this box doesn't\. Nothing was sent or taken\.[\s\S]*git pull --rebase origin main/);
  });

  it("mw doctor checks the box and the museum, and gives the fix for what's missing", async () => {
    const r = await mw(["doctor"], NO_MODEL, museum);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /✓ Node\.js \d+/);
    assert.match(r.out, /✓ git version/);
    assert.match(r.out, /! no local model at http:\/\/127\.0\.0\.1:9[\s\S]*llama-server -hf Qwen\/Qwen3-1\.7B-GGUF:Q4_K_M/);
    assert.match(r.out, /GB free here/);
    assert.match(r.out, /✓ the museum at .* passes its check/);
    assert.match(r.out, /This box is ready\./);
    const elsewhere = await mw(["doctor"], NO_MODEL, root);
    assert.match(elsewhere.out, /No museum here\. Make one:  mw new/);
  });

  it("mw desk opens the desk and prints its addresses and the setup code", async () => {
    const child = spawn(process.execPath, [MW, "desk", "--port", "0", "--museum", join(root, "desk-museum"), "--state", join(root, "desk-state")]);
    let out = "";
    await new Promise<void>((ok) => child.stdout.on("data", (d) => ((out += d), /Setup code: [A-Z0-9-]{19}/.test(out) && ok())));
    child.kill();
    assert.match(out, /The desk is open\. Leave this window running/);
    assert.match(out, /Desk:\s+http:\/\/localhost:\d+\/desk\//);
    assert.match(out, /not made yet: create it at the desk/);
  });

  it("keeps the old names for scripts: init, batch, serve", async () => {
    const r = await mw(["init", "Old Names", "--dir", join(root, "old"), "--no-install", "--no-git"]);
    assert.equal(r.code, 0, r.out);
    cpSync(join(root, "box-3"), join(root, "box-4"), { recursive: true });
    assert.equal((await mw(["batch", join(root, "box-4"), "--museum", join(root, "old")], NO_MODEL)).code, 0);
    assert.match((await mw(["serve", "--help"])).out, /^mw desk/);
  });
});
