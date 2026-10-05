/** What the browser tests share: Chromium, a committed museum, and its own dev server. */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { run } from "../helpers.ts";

/** MW_CHROMIUM, the sandbox's Chromium, or (undefined) Playwright's own install. */
export const executablePath = process.env.MW_CHROMIUM ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
/** Without a Chromium, the browser tests are skipped outside CI; in CI they must run. */
export const noBrowser = !executablePath && !process.env.CI ? "no Chromium (set MW_CHROMIUM)" : false;

export function commit(dir: string) {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=Curator", "-c", "user.email=curator@example.org", "commit", "-qm", "museum"], { cwd: dir });
}

/** The museum's own dev server (scripts/serve.mjs) on a free port, after the CMS build and, unless told not to, the public slice. */
export async function devServer(dir: string, { slice = true } = {}): Promise<{ url: string; proc: ChildProcess }> {
  for (const script of ["scripts/cms-build.ts", ...(slice ? ["scripts/build-public.ts"] : [])]) {
    const built = run(dir, script);
    assert.equal(built.code, 0, built.out);
  }
  const proc = spawn(process.execPath, ["scripts/serve.mjs"], { cwd: dir, env: { ...process.env, PORT: "0" } });
  const url = await new Promise<string>((ok) => proc.stdout!.on("data", (d) => ok(String(d).trim())));
  return { url, proc };
}
