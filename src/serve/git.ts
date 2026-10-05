/**
 * The museum's history, in git: every desk write is a commit, made on the
 * box whether or not the web is there. When it is, the same history goes to
 * GitHub and comes back from it. Plain git commands; git must be installed.
 */
import { execFileSync } from "node:child_process";

export type GitResult = { ok: boolean; out: string };

export function git(dir: string, args: string[], env: Record<string, string> = {}): GitResult {
  try {
    const out = execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26 });
    return { ok: true, out: out.trim() };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || err.message };
  }
}

const must = (r: GitResult, what: string) => {
  if (!r.ok) throw new Error(`${what}: ${r.out}`);
  return r.out;
};

/** The curator as git's author and committer. */
const as = (name: string) => ({
  GIT_AUTHOR_NAME: name,
  GIT_AUTHOR_EMAIL: "desk@museum.local",
  GIT_COMMITTER_NAME: name,
  GIT_COMMITTER_EMAIL: "desk@museum.local",
});

export const isRepo = (dir: string) => git(dir, ["rev-parse", "--is-inside-work-tree"]).ok;

export function initRepo(dir: string, name: string, message: string) {
  must(git(dir, ["init", "-q", "-b", "main"]), "git init");
  commitAll(dir, name, message);
}

/** What the working tree holds that the last commit doesn't (ignored files aside). */
export const dirty = (dir: string) => git(dir, ["status", "--porcelain"]).out.split("\n").filter(Boolean);

export function commitAll(dir: string, name: string, message: string): string | undefined {
  must(git(dir, ["add", "-A"]), "git add");
  if (!dirty(dir).length) return undefined;
  must(git(dir, ["commit", "-q", "-m", message], as(name)), "git commit");
  return git(dir, ["rev-parse", "--short", "HEAD"]).out;
}

/** Back to the last commit: what a refused write leaves behind is taken away. */
export function discard(dir: string) {
  git(dir, ["checkout", "-q", "--", "."]);
  git(dir, ["clean", "-fdq"]);
}

export function log(dir: string, n = 15) {
  const r = git(dir, ["log", `-${n}`, "--format=%h%x00%an%x00%cI%x00%s"]);
  if (!r.ok || !r.out) return [];
  return r.out.split("\n").map((l) => {
    const [hash, author, date, subject] = l.split("\0");
    return { hash, author, date, subject };
  });
}

/** The remote's address: owner/name means GitHub; anything else is used as given. */
export const remoteUrl = (repo: string) => (/^[\w.-]+\/[\w.-]+$/.test(repo) ? `https://github.com/${repo}.git` : repo);

/** A token, if any, as an HTTP header for this one command: never written into the repository's config. */
const auth = (token?: string) => (token ? ["-c", `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`] : []);

export function setRemote(dir: string, repo: string) {
  const url = remoteUrl(repo);
  if (git(dir, ["remote", "get-url", "origin"]).ok) must(git(dir, ["remote", "set-url", "origin", url]), "git remote");
  else must(git(dir, ["remote", "add", "origin", url]), "git remote");
}

export function sync(dir: string) {
  const remote = git(dir, ["remote", "get-url", "origin"]);
  const tracking = git(dir, ["rev-parse", "--verify", "-q", "refs/remotes/origin/main"]);
  const counts = tracking.ok ? git(dir, ["rev-list", "--left-right", "--count", "HEAD...origin/main"]).out.split(/\s+/).map(Number) : [];
  return {
    remote: remote.ok ? remote.out : null,
    ahead: tracking.ok ? counts[0] : null,
    behind: tracking.ok ? counts[1] : null,
  };
}

export function fetchRemote(dir: string, token?: string): GitResult {
  return git(dir, [...auth(token), "fetch", "-q", "origin", "main"]);
}

/** Take the remote's commits, only if that needs no merge: the desk never resolves a conflict by guessing. */
export function pullRemote(dir: string, token?: string): GitResult {
  const f = fetchRemote(dir, token);
  if (!f.ok) return f;
  return git(dir, ["merge", "--ff-only", "-q", "origin/main"]);
}

export function pushRemote(dir: string, token?: string): GitResult {
  const r = git(dir, [...auth(token), "push", "-q", "origin", "main"]);
  if (r.ok) fetchRemote(dir, token);
  return r;
}

export function cloneInto(url: string, dir: string, token?: string): GitResult {
  return git(process.cwd(), [...auth(token), "clone", "-q", "-b", "main", url, dir]);
}

/** The committed museum, as a gzipped tarball: the export. */
export function archive(dir: string): Buffer {
  return execFileSync("git", ["archive", "--format=tar.gz", "HEAD"], { cwd: dir, maxBuffer: 1 << 30 });
}
