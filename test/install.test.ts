/**
 * Installed as a package, the way `npx github:ajcali086/Museumwright-` gets
 * it: packed (npm builds dist/ on prepare), installed under node_modules,
 * and run from there, where Node won't strip types.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { tmp } from "./helpers.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

describe("installed from a package", () => {
  it("packs bin, dist and the structure (gitignore included), and mw init runs from node_modules", () => {
    const out = tmp("pack");
    const tgz = execFileSync("npm", ["pack", "--silent", "--pack-destination", out], { cwd: ROOT, encoding: "utf8" }).trim().split("\n").pop()!;
    const listing = execFileSync("tar", ["-tzf", join(out, tgz)], { encoding: "utf8" });
    for (const f of ["package/bin/mw.mjs", "package/dist/cli.js", "package/structure/gitignore", "package/structure/.github/workflows/ci.yml", "package/structure/src/model/records/.gitkeep"])
      assert.ok(listing.includes(f), f);
    assert.ok(!listing.includes("package/test/"), "the fixtures stay out of the package");

    const consumer = tmp("consumer");
    writeFileSync(join(consumer, "package.json"), '{ "name": "consumer", "private": true }\n');
    const install = spawnSync("npm", ["install", "--no-audit", "--no-fund", join(out, tgz)], { cwd: consumer, encoding: "utf8" });
    assert.equal(install.status, 0, install.stderr);
    const mill = join(consumer, "mill");
    const init = spawnSync("npx", ["mw", "init", "mill", "--repo", "someone/mill", "--dir", mill, "--no-install", "--no-git"], { cwd: consumer, encoding: "utf8" });
    assert.equal(init.status, 0, init.stdout + init.stderr);
    assert.match(init.stdout, /6 purity ✓/);
    assert.ok(existsSync(join(mill, ".gitignore")), "the dot is put back");
    assert.ok(!readdirSync(mill).includes("gitignore"));
  });
});
