/**
 * A stand-in for the GitHub API, enough for Sveltia to sign in with a token
 * and read a repository: answered from a local git repository (the museum
 * mw init generated), so the admin shows exactly what is committed. Reads
 * only; anything it doesn't answer is recorded in `unknown`, so a test
 * fails loudly when Sveltia asks for something new.
 */
import { execFileSync } from "node:child_process";
import type { Route } from "playwright-core";

const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "buffer", maxBuffer: 1 << 28 });

export function githubStub(dir: string, owner: string, repo: string) {
  const unknown: string[] = [];
  const head = () => git(dir, "rev-parse", "HEAD").toString().trim();
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  const tree = () =>
    git(dir, "ls-tree", "-r", "-l", "HEAD")
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [meta, path] = line.split("\t");
        const [mode, type, sha, size] = meta.split(/\s+/);
        return { path, mode, type, sha, size: Number(size), url: `https://api.github.com/repos/${owner}/${repo}/git/blobs/${sha}` };
      });

  async function graphql(route: Route) {
    const { query, variables } = JSON.parse(route.request().postData() ?? "{}") as { query: string; variables: Record<string, unknown> };
    const q = query.replace(/\s+/g, " ");
    if (q.includes("pullRequests(")) return json(route, { data: { repository: { pullRequests: { nodes: [] } } } });
    if (/object\(oid: "[0-9a-f]{40}"\) \{ \.\.\. on Commit \{ (status|deployments|checkSuites)/.test(q)) {
      // Deploy previews and checks on a commit: none here.
      const repository: Record<string, unknown> = {};
      for (const m of q.matchAll(/(\w+): object\(oid:/g)) repository[m[1]] = { status: null, deployments: { nodes: [] }, checkSuites: { nodes: [] } };
      return json(route, { data: { repository } });
    }
    if (q.includes("refUpdateRule")) return json(route, { data: { repository: { ref: { refUpdateRule: null } } } });
    if (q.includes("history(first: 1, path:")) {
      // The last commit to each file, by alias: `commit_N: ref(...) { ... history(first: 1, path: "<path>") ... }`.
      const repository: Record<string, unknown> = {};
      for (const m of q.matchAll(/(\w+): ref\(qualifiedName: \$branch\) \{ target \{ \.\.\. on Commit \{ history\(first: 1, path: "([^"]+)"\)/g)) {
        const [name, email, date] = git(dir, "log", "-1", "--format=%an%x00%ae%x00%cI", "--", m[2]).toString().trim().split("\0");
        repository[m[1]] = { target: { history: { nodes: name ? [{ author: { name, email, user: null }, committedDate: date }] : [] } } };
      }
      return json(route, { data: { repository } });
    }
    if (q.includes("target { ... on Commit { oid } }")) return json(route, { data: { repository: { ref: { target: { oid: head() } } } } });
    if (q.includes("history(first: 1)")) {
      const oid = head();
      const message = git(dir, "log", "-1", "--format=%s").toString().trim();
      return json(route, { data: { repository: { ref: { target: { history: { nodes: [{ oid, message }] } } } } } });
    }
    if (q.includes("... on Blob")) {
      // Blobs asked for in a batch, by alias: `<alias>: object(oid: "<sha>") { ... on Blob { text } }`.
      const repository: Record<string, unknown> = {};
      for (const m of q.matchAll(/(\w+)\s*:\s*object\(oid:\s*"([0-9a-f]{40})"\)/g)) {
        const bytes = git(dir, "cat-file", "blob", m[2]);
        repository[m[1]] = { id: m[2], text: bytes.toString("utf8"), byteSize: bytes.length, isBinary: false };
      }
      return json(route, { data: { repository } });
    }
    unknown.push(`graphql: ${q.slice(0, 300)} ${JSON.stringify(variables ?? {})}`);
    return json(route, { errors: [{ message: "not in the stand-in" }] }, 200);
  }

  async function handle(route: Route) {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const base = `/repos/${owner}/${repo}`;
    if (p === "/user") return json(route, { login: "curator", id: 1, name: "Curator", email: "curator@example.org", avatar_url: "", html_url: "https://github.com/curator" });
    if (p === "/graphql") return graphql(route);
    if (p === base)
      return json(route, { name: repo, full_name: `${owner}/${repo}`, default_branch: "main", private: false, permissions: { admin: true, push: true, pull: true }, owner: { login: owner } });
    if (p === `${base}/branches/main`) return json(route, { name: "main", commit: { sha: head() } });
    if (p.startsWith(`${base}/git/trees/`)) return json(route, { sha: head(), tree: tree(), truncated: false });
    if (p.startsWith(`${base}/git/blobs/`)) {
      const sha = p.split("/").pop()!;
      return json(route, { sha, encoding: "base64", content: git(dir, "cat-file", "blob", sha).toString("base64") });
    }
    if (p.startsWith(`${base}/contents/`)) {
      const path = decodeURIComponent(p.slice(`${base}/contents/`.length));
      return route.fulfill({ status: 200, body: git(dir, "show", `HEAD:${path}`) });
    }
    unknown.push(`${req.method()} ${url.pathname}${url.search}`);
    return json(route, { message: "Not Found" }, 404);
  }

  return { handle, unknown };
}
