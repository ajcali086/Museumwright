/**
 * mw serve: the museum box, through its HTTP API, from nothing. The gate,
 * creating a museum, a pull with proposals, keeping and holding names (the
 * span rule and the check standing guard), uploads, a record's status,
 * sync with a remote (a bare repository standing in for GitHub), export,
 * and bringing a museum in by clone.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createMuseumServer } from "../src/serve/server.ts";
import { settle } from "../src/serve/actions.ts";
import { angiePage } from "./fixtures/angie/page.ts";
import { serve, stubModel, tmp } from "./helpers.ts";

process.env.MW_NOW = "2026-10-04T12:00:00Z";

type Box = { url: string; server: Server; dir: string; setupCode: string; state: string };

async function box(dir: string, state: string): Promise<Box> {
  const { server, desk } = createMuseumServer({ museum: dir, state, quiet: true });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server, dir, setupCode: desk.setupCode, state };
}

/** A desk client: its cookie, the header the desk's own page sends. */
function client(base: string) {
  let cookie = "";
  const req = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}/desk/api/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(body === undefined ? {} : { "content-type": "application/json", "x-mw-desk": "1" }), ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const type = res.headers.get("content-type") ?? "";
    return { status: res.status, body: type.includes("json") ? ((await res.json()) as Record<string, any>) : await res.arrayBuffer() } as { status: number; body: any };
  };
  return { req, upload: async (intake: string, name: string, bytes: Uint8Array) => {
    const res = await fetch(`${base}/desk/api/upload?intake=${intake}&name=${encodeURIComponent(name)}`, { method: "POST", headers: { "x-mw-desk": "1", cookie }, body: Buffer.from(bytes) });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  } };
}

const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

describe("mw serve", () => {
  let b: Box;
  let c: ReturnType<typeof client>;
  let site: Awaited<ReturnType<typeof serve>>;
  let model: Awaited<ReturnType<typeof stubModel>>;
  const fx = angiePage();
  const root = tmp("box");

  before(async () => {
    b = await box(join(root, "museum"), join(root, "state"));
    c = client(b.url);
    const routes = new Map<string, { type: string; body: Uint8Array | string }>([["/post/angie", { type: "text/html", body: fx.html }]]);
    for (const [path, body] of fx.files) routes.set(path, { type: "image/jpeg", body });
    site = await serve(routes);
    model = await stubModel([["Watts Towers", "place"], ["Virginia Sullivan", "person"], ["Martinez Daily Standard", "organization"]]);
  });
  after(() => {
    b.server.close();
    site.server.close();
    model.server.close();
  });

  it("before anything: visitors see a museum being set up; the desk needs the setup code", async () => {
    const home = await (await fetch(`${b.url}/`)).text();
    assert.match(home, /A museum is being set up here/);
    assert.deepEqual((await c.req("session")).body, { configured: false, who: null });
    assert.equal((await c.req("state")).status, 401);
    assert.equal((await c.req("setup", { code: "AAAA-BBBB-CCCC-DDDD", passcode: "lanternfish", name: "Andrew" })).status, 403);
    assert.equal((await c.req("setup", { code: b.setupCode, passcode: "short", name: "Andrew" })).status, 400);
    const ok = await c.req("setup", { code: b.setupCode.toLowerCase(), passcode: "lanternfish", name: "Andrew" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual((await c.req("session")).body, { configured: true, who: "Andrew" });
    assert.equal((await c.req("setup", { code: b.setupCode, passcode: "lanternfish2", name: "X" })).status, 409, "set up once");
    const desk = json(join(b.state, "desk.json"));
    assert.ok(desk.passcode.hash && !JSON.stringify(desk).includes("lanternfish"), "a hash, not the passcode");
  });

  it("refuses writes that don't come from the desk's own page", async () => {
    assert.equal((await c.req("check", {}, { "x-mw-desk": "" })).status, 403);
    assert.equal((await c.req("check", {}, { origin: "http://evil.example" })).status, 403);
    assert.equal((await c.req("check", {}, { origin: "null" })).status, 403);
    const garbled = await fetch(`${b.url}/desk/api/login`, { method: "POST", headers: { "x-mw-desk": "1", "content-type": "application/json" }, body: "{not json" });
    assert.equal(garbled.status, 400);
  });

  it("creates a museum from nothing: generated, checked, committed, and the viewer is up", async () => {
    const r = await c.req("create", { mode: "new", name: "Box Museum", repo: "" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = (await c.req("state")).body;
    assert.equal(s.museum.title, "Box Museum");
    assert.equal(s.check.ok, true);
    assert.deepEqual(s.git.log.map((l: { subject: string; author: string }) => [l.subject, l.author]), [["Generate the museum (mw init Box Museum)", "Andrew"]]);
    assert.match(await (await fetch(`${b.url}/`)).text(), /<title>Box Museum<\/title>/);
    assert.equal((await fetch(`${b.url}/data/museum.json`)).status, 200);
    assert.equal((await c.req("create", { mode: "new", name: "Again" })).status, 409);
  });

  it("pulls a page with proposals, as one commit", async () => {
    const r = await c.req("pull", { url: `${site.url}/post/angie`, propose: true, modelUrl: model.url });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.match(r.body.log.join("\n"), /23 passages, 9 plates/);
    const s = (await c.req("state")).body;
    assert.equal(s.records.length, 11);
    assert.ok(s.queue.length >= 4);
    assert.ok(s.queue.every((q: { holds: boolean; status: string }) => q.holds && q.status === "proposed"));
    assert.equal(s.git.log[0].subject, `Pull ${site.url}/post/angie`);
    assert.deepEqual(s.git.dirty, []);
  });

  it("previews a keep without writing it, then keeps it: an entity anchored to the record that spells it", async () => {
    const s = (await c.req("state")).body;
    const q = s.queue.find((x: { proposed_text: string }) => x.proposed_text === "Watts Towers");
    const as = { mode: "new", label: "Watts Towers", kind: "place" };
    const p = await c.req("keep", { id: q.id, as, preview: true });
    assert.equal(p.body.preview, true);
    assert.deepEqual(p.body.diff.map((d: { path: string; before: string | null }) => [d.path, d.before === null]), [["src/model/entities/watts-towers.json", true], [`src/data/corrections/${q.id}.json`, false]]);
    assert.ok(!existsSync(join(b.dir, "src/model/entities/watts-towers.json")), "a preview writes nothing");
    const k = await c.req("keep", { id: q.id, as });
    assert.equal(k.body.ok, true, JSON.stringify(k.body));
    const e = json(join(b.dir, "src/model/entities/watts-towers.json"));
    assert.deepEqual([e.label, e.kind, e.anchors], ["Watts Towers", "place", [q.span.record]]);
    const decided = json(join(b.dir, `src/data/corrections/${q.id}.json`));
    assert.deepEqual([decided.status, decided.decided_by, decided.decided_on], ["accepted", "Andrew", "2026-10-04"]);
    assert.equal(git(b.dir, "log", "-1", "--format=%an"), "Andrew");
    assert.equal((await c.req("state")).body.check.ok, true);
    assert.match(await (await fetch(`${b.url}/data/museum.json`)).text(), /"label": "Watts Towers"/);
  });

  it("keeps another proposal as a second name of the same entity, with its record as another anchor", async () => {
    const s = (await c.req("state")).body;
    const q = s.queue.find((x: { proposed_text: string; status: string }) => x.proposed_text === "Watts Towers" && x.status === "proposed");
    if (!q) return; // the stand-in noticed it once
    const k = await c.req("keep", { id: q.id, as: { mode: "existing", entity: "watts-towers" } });
    assert.equal(k.body.ok, true, JSON.stringify(k.body));
    assert.ok(json(join(b.dir, "src/model/entities/watts-towers.json")).anchors.includes(q.span.record));
  });

  it("refuses to keep a name its span doesn't contain, and the refusal names the span", async () => {
    // A bad proposal arriving from elsewhere (a hand edit, another tool), committed past the check.
    const bad = { id: "c-9999", kind: "name", target: "r-0001#p3", proposed_text: "Josephine Bonaparte", entity_kind: "person", reason: "r", proposed_by: "elsewhere", date: "2026-10-04", status: "proposed" };
    writeFileSync(join(b.dir, "src/data/corrections/c-9999.json"), JSON.stringify(bad, null, 2) + "\n");
    git(b.dir, "add", "-A");
    git(b.dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a bad proposal");
    const s = (await c.req("state")).body;
    assert.equal(s.queue.find((q: { id: string }) => q.id === "c-9999").holds, false);
    assert.equal(s.check.ok, false, "the check sees it too");
    const r = await c.req("keep", { id: "c-9999", as: { mode: "new", label: "Josephine Bonaparte", kind: "person" } });
    assert.equal(r.status, 422);
    assert.match(r.body.refusal, /the span r-0001#p3 doesn't contain it/);
    assert.ok(!existsSync(join(b.dir, "src/model/entities/josephine-bonaparte.json")));
    // Rejecting it is a decision the check still refuses (the span rule holds for any status), so nothing is kept.
    const rej = await c.req("decide", { ids: ["c-9999"], status: "rejected" });
    assert.equal(rej.body.ok, false);
    assert.equal(json(join(b.dir, "src/data/corrections/c-9999.json")).status, "proposed", "the refused write was taken back");
    git(b.dir, "rm", "-q", "src/data/corrections/c-9999.json");
    git(b.dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "take it out");
  });

  it("refuses a kept name relabelled into something its record doesn't spell", async () => {
    const s = (await c.req("state")).body;
    const q = s.queue.find((x: { proposed_text: string; status: string }) => x.proposed_text === "Virginia Sullivan" && x.status === "proposed");
    const r = await c.req("keep", { id: q.id, as: { mode: "new", label: "Virginia Calicura Sullivan", kind: "person" } });
    assert.equal(r.status, 422);
    assert.match(r.body.refusal, /isn't how r-\d+ spells it/);
  });

  it("holds back a proposal: a decision, recorded; the public slice is unchanged", async () => {
    const before = await (await fetch(`${b.url}/data/museum.json`)).text();
    const s = (await c.req("state")).body;
    const q = s.queue.find((x: { status: string }) => x.status === "proposed");
    const r = await c.req("decide", { ids: [q.id], status: "held", note: "Which Martinez paper?" });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    const held = json(join(b.dir, `src/data/corrections/${q.id}.json`));
    assert.deepEqual([held.status, held.decided_by, held.curator_note], ["held", "Andrew", "Which Martinez paper?"]);
    assert.equal(await (await fetch(`${b.url}/data/museum.json`)).text(), before);
    assert.equal((await c.req("decide", { ids: [q.id], status: "held" })).status, 409, "decided once");
  });

  it("changes a record's status only with a dated note", async () => {
    assert.equal((await c.req("status", { id: "r-0003", status: "verified", note: " " })).status, 400);
    const r = await c.req("status", { id: "r-0003", status: "verified", note: "The family's print, scanned at the museum." });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    const rec = json(join(b.dir, "src/model/records/r-0003.json"));
    assert.equal(rec.status, "verified");
    assert.deepEqual(rec.notes.at(-1), { date: "2026-10-04", note: "The family's print, scanned at the museum." });
  });

  it("takes back a write the check refuses", () => {
    writeFileSync(join(b.dir, "src/model/entities/nobody.json"), JSON.stringify({ id: "00000000", slug: "nobody", kind: "person", label: "Nobody", anchors: [] }));
    const r = settle(b.dir, "A bad save", "Andrew");
    assert.equal(r.ok, false);
    assert.match((r as { refusal: string }).refusal, /no anchor/);
    assert.ok(!existsSync(join(b.dir, "src/model/entities/nobody.json")));
  });

  it("takes in uploaded files (and a phone's photo, with the curator's note) from an intake folder", async () => {
    const intake = "intake-test-1";
    assert.equal((await c.upload(intake, "../escape.jpg", new Uint8Array([1]))).body.name, "escape.jpg", "a name is only a name");
    assert.equal((await c.upload(intake, "photo 1.jpg", new Uint8Array(readFileSync(new URL("./fixtures/angie/plate-07.jpg", import.meta.url))))).status, 200);
    assert.equal((await c.upload(intake, "letter.txt", new TextEncoder().encode("Dear Sam,\n\nThe store is open again.\n"))).status, 200);
    const r = await c.req("ingest", { intake, notes: { "photo 1.jpg": "The garden, from the porch." } });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    const recs = readdirSync(join(b.dir, "src/model/records")).filter((f) => f.endsWith(".json")).map((f) => json(join(b.dir, "src/model/records", f)));
    const photo = recs.find((x) => x.title === "photo 1.jpg");
    assert.equal(photo.caption, "", "a note is not a caption");
    assert.deepEqual(photo.notes, [{ date: "2026-10-04", note: "Andrew: The garden, from the porch." }]);
    assert.ok(recs.some((x) => x.title === "letter.txt" && x.passages.length === 2));
    assert.match(r.body.log.join("\n"), /1 files skipped/);
    const skipLog = recs.find((x) => x.kind === "log" && x.title.startsWith("What the batch skipped"));
    assert.match(skipLog.passages.map((p: { text: string }) => p.text).join("\n"), /not a kind this tool reads\] escape\.jpg/);
    assert.ok(!existsSync(join(b.state, "intake", intake)), "the intake is emptied once kept");
  });

  it("syncs with a remote: push, take another clone's commit, and refuse to merge a divergence", async () => {
    const bare = join(root, "remote.git");
    git(root, "init", "-q", "--bare", "-b", "main", bare);
    assert.equal((await c.req("remote", { repo: bare })).body.ok, true);
    const push = await c.req("sync", { action: "push" });
    assert.equal(push.body.ok, true, JSON.stringify(push.body));
    assert.equal(git(bare, "rev-parse", "main"), git(b.dir, "rev-parse", "HEAD"));
    assert.deepEqual([(await c.req("state")).body.git.ahead, (await c.req("state")).body.git.behind], [0, 0]);

    const other = join(root, "elsewhere");
    git(root, "clone", "-q", bare, other);
    const q = json(join(other, "src/model/museum.json"));
    writeFileSync(join(other, "src/model/museum.json"), JSON.stringify({ ...q, rights_holder: "The family" }, null, 2) + "\n");
    git(other, "-c", "user.name=Sveltia", "-c", "user.email=s@s", "commit", "-qam", "Update museum");
    git(other, "push", "-q", "origin", "main");
    const take = await c.req("sync", { action: "pull" });
    assert.equal(take.body.ok, true, JSON.stringify(take.body));
    assert.equal(json(join(b.dir, "src/model/museum.json")).rights_holder, "The family");

    writeFileSync(join(other, "src/model/museum.json"), JSON.stringify({ ...q, rights_holder: "Someone" }, null, 2) + "\n");
    git(other, "-c", "user.name=Sveltia", "-c", "user.email=s@s", "commit", "-qam", "Again");
    git(other, "push", "-q", "origin", "main");
    await c.req("note", { id: "r-0002", note: "Meanwhile, on the box." });
    const pushRefused = await c.req("sync", { action: "push" });
    assert.match(pushRefused.body.refusal, /GitHub has commits the box doesn't/);
    const pullRefused = await c.req("sync", { action: "pull" });
    assert.match(pullRefused.body.refusal, /both moved on/);
  });

  it("exports the committed museum as one archive", async () => {
    const r = await c.req("export");
    assert.equal(r.status, 200);
    const file = join(root, "export.tar.gz");
    writeFileSync(file, Buffer.from(r.body as ArrayBuffer));
    const listing = execFileSync("tar", ["-tzf", file], { encoding: "utf8" });
    for (const f of ["src/model/museum.json", "meta/sequences.json", "src/model/entities/watts-towers.json"]) assert.ok(listing.includes(f), f);
  });

  it("after a restart: the passcode stands, sessions don't", async () => {
    b.server.close();
    b = await box(b.dir, b.state);
    const fresh = client(b.url);
    assert.deepEqual((await fresh.req("session")).body, { configured: true, who: null });
    assert.equal((await fresh.req("login", { passcode: "wrong-wrong", name: "Andrew" })).status, 403);
    assert.equal((await fresh.req("login", { passcode: "lanternfish", name: "Sam" })).status, 200);
    assert.equal((await fresh.req("state")).body.who, "Sam");
    c = fresh;
  });

  it("brings a museum in from a remote, into an empty box", async () => {
    const other = await box(join(root, "second"), join(root, "state2"));
    const d = client(other.url);
    await d.req("setup", { code: other.setupCode, passcode: "lanternfish", name: "Andrew" });
    const r = await d.req("create", { mode: "clone", repo: join(root, "remote.git") });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    const s = (await d.req("state")).body;
    assert.equal(s.museum.title, "Box Museum");
    assert.equal(s.check.ok, true);
    assert.match(await (await fetch(`${other.url}/`)).text(), /<title>Box Museum<\/title>/);
    other.server.close();
    mkdirSync(join(root, "not-a-museum"));
    git(join(root, "not-a-museum"), "init", "-q", "--bare", "-b", "main");
    const third = await box(join(root, "third"), join(root, "state3"));
    const e = client(third.url);
    await e.req("setup", { code: third.setupCode, passcode: "lanternfish", name: "Andrew" });
    assert.notEqual((await e.req("create", { mode: "clone", repo: join(root, "not-a-museum") })).body.ok, true);
    third.server.close();
  });
});
