/**
 * mw serve: the museum box. One server on the LAN:
 *
 *   /        the museum, for visitors: the viewer over the public slice,
 *            and the files it shows. Read-only, no sign-in.
 *   /desk    the curator's desk, behind the passcode: build the archive
 *            from nothing (create, pull a page, upload files or phone
 *            captures), decide the queue, check, and sync with GitHub
 *            when the web is there.
 *
 * Everything the desk does is a file in the museum's folders, checked by
 * the museum's own check:model and committed to its git history on the box.
 * Offline, nothing is lost; online, the same commits go to GitHub.
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { batch } from "../batch.ts";
import { init } from "../init.ts";
import { DEFAULT_MODEL_URL } from "../propose.ts";
import { pull } from "../pull.ts";
import { RunLog } from "../util.ts";
import { apply, check, diffOf, museumScript, planDecide, planKeep, planNote, planStatus, settle, type KeepAs, type Plan } from "./actions.ts";
import { Desk, DeskError, stateDirFor } from "./auth.ts";
import * as G from "./git.ts";
import { isMuseum, readMuseum, spanRecord, spans } from "./museum.ts";

export const DESK_DIR = fileURLToPath(new URL("../../desk/", import.meta.url));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".yml": "application/yaml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
};

export type ServeOptions = { museum: string; state?: string; modelUrl?: string; quiet?: boolean };

export function createMuseumServer(opts: ServeOptions) {
  const dir = resolve(opts.museum);
  const desk = new Desk(stateDirFor(dir, opts.state));
  const intakeRoot = join(desk.dir, "intake");

  // One write at a time: two curators deciding at once take turns.
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T> | T): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  const send = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(data));
  };

  function serveFile(res: ServerResponse, root: string, path: string, extra: Record<string, string> = {}) {
    let file = normalize(join(root, path));
    if (!file.startsWith(root.endsWith(sep) ? root : root + sep) && file !== root) return res.writeHead(403).end();
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) return res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    res.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", "x-content-type-options": "nosniff", ...extra });
    createReadStream(file).pipe(res);
  }

  const cookie = (req: IncomingMessage) => /(?:^|;\s*)mw_desk=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
  const setCookie = (res: ServerResponse, token: string, maxAge: number) =>
    res.setHeader("set-cookie", `mw_desk=${token}; HttpOnly; SameSite=Strict; Path=/desk; Max-Age=${maxAge}`);

  async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 1 << 20) throw new DeskError(413, "That request is too large.");
      chunks.push(c as Buffer);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    try {
      const parsed = text ? JSON.parse(text) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      return parsed as Record<string, unknown>;
    } catch {
      throw new DeskError(400, "That request isn't JSON the desk can read.");
    }
  }

  const str = (v: unknown, what: string) => {
    if (typeof v !== "string") throw new DeskError(400, `Missing ${what}.`);
    return v;
  };

  function needMuseum() {
    if (!isMuseum(dir)) throw new DeskError(409, "There is no museum here yet. Create one first.");
  }

  /** The whole desk, as one read: what the curator sees on every screen. */
  function state(who: string) {
    if (!isMuseum(dir)) return { who, museum: null, path: dir };
    const m = readMuseum(dir);
    const text = spans(m.records);
    const byId = new Map(m.records.map((r) => [r.id, r]));
    const anchored = new Set(m.entities.flatMap((e) => e.anchors ?? []));
    const s = desk.read();
    const c = check(dir);
    return {
      who,
      path: dir,
      museum: m.museum,
      queue: m.corrections
        .map((x) => {
          const rid = spanRecord(x.target);
          const span = text.get(x.target);
          return {
            ...x,
            span: { key: x.target, text: span ?? null, record: rid, recordTitle: byId.get(rid)?.title ?? null, kind: x.target.startsWith("plate:") ? "caption" : "passage" },
            holds: span !== undefined && span.includes(x.proposed_text),
          };
        })
        .sort((a, b) => (a.status === "proposed" ? 0 : 1) - (b.status === "proposed" ? 0 : 1) || a.id.localeCompare(b.id, "en", { numeric: true })),
      records: m.records.map((r) => ({ ...r, passages: undefined, passageCount: (r.passages ?? []).length, media: (r.media ?? []).map((p) => "/" + p.replace(/^public\//, "")) })),
      entities: m.entities,
      unanchored: m.records.filter((r) => (r.kind === "image" || r.kind === "document") && !anchored.has(r.id)).map((r) => r.id),
      questions: m.questions.length,
      evidence: m.evidence.length,
      ids: { record: m.sequences?.record ?? null, correction: m.sequences?.correction ?? null, claims: Object.keys(m.sequences?.claims ?? {}).length, tombstones: m.tombstones },
      check: { ok: c.ok, problems: c.problems },
      git: { log: G.log(dir), dirty: G.dirty(dir), ...G.sync(dir), repo: s.remote?.repo ?? null, token: !!s.remote?.token },
      modelUrl: opts.modelUrl ?? process.env.MW_MODEL_URL ?? DEFAULT_MODEL_URL,
    };
  }

  /** A plan, previewed or kept. */
  function planned(plan: Plan, preview: boolean, who: string) {
    if (preview) return { preview: true, summary: plan.summary, diff: diffOf(dir, plan) };
    return apply(dir, plan, who);
  }

  async function api(req: IncomingMessage, res: ServerResponse, path: string) {
    const method = req.method ?? "GET";
    if (method !== "GET") {
      // Writes come from the desk's own page: a custom header no cross-site form can send, and our own origin.
      const origin = req.headers.origin;
      const sameOrigin = (() => {
        if (!origin) return true;
        try {
          return new URL(origin).host === req.headers.host;
        } catch {
          return false; // "null", from a sandboxed frame or a file
        }
      })();
      if (req.headers["x-mw-desk"] !== "1" || !sameOrigin) throw new DeskError(403, "Not from the desk.");
    }
    const token = cookie(req);

    if (path === "session" && method === "GET") return send(res, 200, { configured: desk.configured, who: desk.who(token) ?? null });
    if (path === "setup" && method === "POST") {
      const b = await readJson(req);
      const t = desk.setUp(str(b.code, "the setup code"), str(b.passcode, "a passcode"), str(b.name, "your name"));
      setCookie(res, t, 12 * 3600);
      return send(res, 200, { ok: true });
    }
    if (path === "login" && method === "POST") {
      const b = await readJson(req);
      const t = await desk.signIn(str(b.passcode, "the passcode"), str(b.name, "your name"));
      setCookie(res, t, 12 * 3600);
      return send(res, 200, { ok: true });
    }
    if (path === "logout" && method === "POST") {
      desk.signOut(token);
      setCookie(res, "", 0);
      return send(res, 200, { ok: true });
    }

    const who = desk.who(token);
    if (!who) throw new DeskError(401, "Sign in at the desk first.");

    if (path === "state" && method === "GET") return send(res, 200, state(who));
    if (path === "export" && method === "GET") {
      needMuseum();
      if (!G.log(dir, 1).length) throw new DeskError(409, "Nothing is committed yet.");
      const slug = readMuseum(dir).museum?.slug ?? "museum";
      res.writeHead(200, { "content-type": "application/gzip", "content-disposition": `attachment; filename="${slug}-${G.log(dir, 1)[0].hash}.tar.gz"` });
      return res.end(G.archive(dir));
    }
    if (path === "upload" && method === "POST") {
      // One file per request, streamed into the intake folder, outside the museum until it is ingested.
      const url = new URL(req.url ?? "", "http://x");
      const intake = url.searchParams.get("intake") ?? "";
      const name = basename(url.searchParams.get("name") ?? "").replace(/[^\w.\- ]+/g, "_").slice(0, 120);
      if (!/^[\w-]{6,40}$/.test(intake) || !name || name.startsWith(".")) throw new DeskError(400, "Name the file and its intake.");
      const folder = join(intakeRoot, intake);
      mkdirSync(folder, { recursive: true });
      let size = 0;
      await new Promise<void>((ok, fail) => {
        const out = createWriteStream(join(folder, name));
        req.on("data", (c: Buffer) => {
          size += c.length;
          if (size > 512 * 1024 * 1024) {
            req.destroy();
            fail(new DeskError(413, "A file over 512 MB is too large for the desk."));
          }
        });
        req.pipe(out);
        out.on("finish", ok);
        out.on("error", fail);
      });
      return send(res, 200, { ok: true, name, bytes: size });
    }

    const b = method === "POST" ? await readJson(req) : {};
    const preview = b.preview === true;

    return send(
      res,
      200,
      await exclusive(async () => {
        switch (path) {
          case "create": {
            if (isMuseum(dir)) throw new DeskError(409, "There is already a museum here.");
            if (existsSync(dir) && readdirSync(dir).length) throw new DeskError(409, `${dir} isn't empty, and isn't a museum.`);
            if (b.mode === "clone") {
              const repo = str(b.repo, "the repository").trim();
              const tokenV = typeof b.token === "string" && b.token.trim() ? b.token.trim() : undefined;
              const r = G.cloneInto(G.remoteUrl(repo), dir, tokenV);
              if (!r.ok) throw new DeskError(502, `Couldn't clone ${repo}: ${r.out}`);
              if (!isMuseum(dir)) {
                rmSync(dir, { recursive: true, force: true });
                throw new DeskError(422, `${repo} isn't a museum repository (no meta/sequences.json).`);
              }
              desk.write({ ...desk.read(), remote: { repo, token: tokenV } });
              museumScript(dir, "scripts/build-public.ts");
              return { ok: true, summary: `Cloned ${repo}` };
            }
            const name = str(b.name, "a name").trim();
            if (!name) throw new DeskError(400, "A museum needs a name.");
            const repo = typeof b.repo === "string" && b.repo.trim() ? b.repo.trim() : undefined;
            const log = new RunLog(true);
            try {
              init(name, { repo: repo && /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : undefined, title: typeof b.title === "string" && b.title.trim() ? b.title.trim() : undefined, dir, install: false, git: false }, log);
            } catch (e) {
              throw new DeskError(422, (e as Error).message);
            }
            museumScript(dir, "scripts/build-public.ts");
            G.initRepo(dir, who, `Generate the museum (mw init ${name})`);
            if (repo) {
              G.setRemote(dir, repo);
              desk.write({ ...desk.read(), remote: { repo } });
            }
            return { ok: true, summary: "Created the museum", log: log.lines };
          }
          case "pull": {
            needMuseum();
            const url = str(b.url, "a page address").trim();
            if (!/^https?:\/\//i.test(url)) throw new DeskError(400, "A page address starts with http:// or https://.");
            if (G.dirty(dir).length) throw new DeskError(409, "The museum has uncommitted changes. Commit or discard them on the Sync desk first.");
            const log = new RunLog(true);
            try {
              const out = await pull(dir, url, { propose: b.propose === true, modelUrl: (b.modelUrl as string) || opts.modelUrl || process.env.MW_MODEL_URL || DEFAULT_MODEL_URL }, log);
              log.say(`claimed ${out.new.length} new IDs; ${out.unchanged.length} unchanged`);
            } catch (e) {
              G.discard(dir);
              throw new DeskError(502, `The pull didn't finish, and nothing was kept: ${(e as Error).message}`);
            }
            return { ...settle(dir, `Pull ${url}`, who), log: log.lines };
          }
          case "ingest": {
            needMuseum();
            const intake = str(b.intake, "the intake");
            const folder = join(intakeRoot, intake);
            if (!/^[\w-]{6,40}$/.test(intake) || !existsSync(folder)) throw new DeskError(404, "No such intake.");
            if (G.dirty(dir).length) throw new DeskError(409, "The museum has uncommitted changes. Commit or discard them on the Sync desk first.");
            const log = new RunLog(true);
            try {
              const out = await batch(dir, folder, { propose: b.propose === true, modelUrl: opts.modelUrl || process.env.MW_MODEL_URL || DEFAULT_MODEL_URL }, log);
              log.say(`claimed ${out.new.length} new IDs; ${out.unchanged.length} unchanged`);
              // A curator's word on a file ("what this is") is a dated note on its record, never its caption.
              const notes = (b.notes ?? {}) as Record<string, string>;
              for (const r of readMuseum(dir).records) {
                const note = typeof r.source?.file === "string" ? notes[r.source.file as string] : undefined;
                if (note?.trim() && out.new.includes(r.id)) for (const w of planNote(dir, r.id, `${who}: ${note}`).writes) writeFileSync(join(dir, w.path), w.after);
              }
            } catch (e) {
              G.discard(dir);
              throw new DeskError(422, `The files weren't taken in, and nothing was kept: ${(e as Error).message}`);
            }
            const kept = settle(dir, `Take in ${readdirSync(folder).length} files`, who);
            if (kept.ok) rmSync(folder, { recursive: true, force: true });
            return { ...kept, log: log.lines };
          }
          case "keep":
            needMuseum();
            return planned(planKeep(dir, str(b.id, "the proposal"), b.as as KeepAs, who), preview, who);
          case "decide": {
            needMuseum();
            const ids = Array.isArray(b.ids) ? (b.ids as string[]) : [];
            if (!ids.length) throw new DeskError(400, "Pick at least one proposal.");
            const status = b.status === "rejected" ? "rejected" : b.status === "held" ? "held" : undefined;
            if (!status) throw new DeskError(400, "A decision is held or rejected.");
            return planned(planDecide(dir, ids, status, who, typeof b.note === "string" ? b.note : undefined), preview, who);
          }
          case "status":
            needMuseum();
            return planned(planStatus(dir, str(b.id, "the record"), b.status === "verified" ? "verified" : "unverified", str(b.note, "a note")), preview, who);
          case "note":
            needMuseum();
            return planned(planNote(dir, str(b.id, "the record"), str(b.note, "a note")), preview, who);
          case "check":
            needMuseum();
            return check(dir);
          case "discard":
            needMuseum();
            G.discard(dir);
            return { ok: true, summary: "Discarded the uncommitted changes" };
          case "remote": {
            needMuseum();
            const repo = str(b.repo, "the repository").trim();
            const tokenV = typeof b.token === "string" ? b.token.trim() : undefined;
            G.setRemote(dir, repo);
            const prev = desk.read().remote;
            desk.write({ ...desk.read(), remote: { repo, token: tokenV === undefined ? prev?.token : tokenV || undefined } });
            return { ok: true, summary: `GitHub: ${repo}` };
          }
          case "sync": {
            needMuseum();
            const remote = desk.read().remote;
            if (!remote) throw new DeskError(409, "Set the GitHub repository first.");
            if (b.action === "pull") {
              if (G.dirty(dir).length) throw new DeskError(409, "Commit or discard the uncommitted changes before taking GitHub's.");
              const r = G.pullRemote(dir, remote.token);
              if (!r.ok) throw new DeskError(502, /ff-only|Not possible to fast-forward|diverg/i.test(r.out) ? "The box and GitHub have both moved on. Nothing was merged: settle it in git, then sync again." : `Couldn't reach GitHub: ${r.out}`);
              const c = check(dir);
              museumScript(dir, "scripts/build-public.ts");
              return { ok: true, summary: "Took GitHub's commits", check: c };
            }
            if (b.action === "push") {
              const r = G.pushRemote(dir, remote.token);
              if (!r.ok) throw new DeskError(502, /rejected|non-fast-forward|fetch first/i.test(r.out) ? "GitHub has commits the box doesn't. Take them first (Pull), then push." : `Couldn't reach GitHub: ${r.out}`);
              return { ok: true, summary: "Sent the box's commits to GitHub" };
            }
            throw new DeskError(400, "Sync is pull or push.");
          }
          default:
            throw new DeskError(404, "No such desk action.");
        }
      }),
    );
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = decodeURIComponent(url.pathname);
    try {
      if (path === "/desk") return res.writeHead(301, { location: "/desk/" }).end();
      if (path.startsWith("/desk/api/")) return await api(req, res, path.slice("/desk/api/".length));
      if (path.startsWith("/desk/"))
        return serveFile(res, DESK_DIR, path.slice("/desk/".length) || "index.html", {
          "content-security-policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
          "cache-control": "no-store",
        });
      if (req.method !== "GET" && req.method !== "HEAD") return res.writeHead(405).end();
      if (!isMuseum(dir) || !existsSync(join(dir, "public"))) return serveFile(res, DESK_DIR, "setting-up.html");
      return serveFile(res, join(dir, "public"), path);
    } catch (e) {
      const err = e as DeskError;
      if (!res.headersSent) send(res, err.status ?? 500, { ok: false, refusal: err.message });
      if (!(e instanceof DeskError) && !opts.quiet) console.error(e);
    }
  });

  return { server, desk, dir };
}
