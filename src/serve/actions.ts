/**
 * What the desk can do to the museum, each as a plan of file writes. A plan
 * is shown first (the diff: what the repository will say), then written,
 * then checked by the museum's own check:model. If the check refuses, the
 * writes are taken back and the refusal is the answer; if it passes, the
 * public slice is rebuilt and the change is one git commit in the curator's
 * name. The desk never writes around the check.
 */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { slugify } from "../util.ts";
import { DeskError } from "./auth.ts";
import { commitAll, discard, dirty } from "./git.ts";
import { PATHS, readMuseum, recordText, spanRecord, spans, type Correction, type Entity, type Museum } from "./museum.ts";

export type Write = { path: string; after: string };
export type Diff = { path: string; before: string | null; after: string };
export type Plan = { summary: string; writes: Write[] };

const KINDS = ["person", "family", "place", "organization", "event"];
const body = (data: unknown) => JSON.stringify(data, null, 2) + "\n";

/** Today, as the curator's decisions are dated. MW_NOW pins it (tests). */
export const today = () => (process.env.MW_NOW ? new Date(process.env.MW_NOW) : new Date()).toISOString().slice(0, 10);

/** A script of the museum's own (check-model, build-public), run as the museum runs it. */
export function museumScript(dir: string, script: string) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", script], { cwd: dir, encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/** The check, in lines a curator can read: the rule, then what it found. */
export function check(dir: string) {
  const r = museumScript(dir, "scripts/check-model.ts");
  // Each line is a rule, then what it found: kept whole, since both halves may hold a colon.
  const problems = r.ok ? [] : r.out.split("\n").slice(1).map((l) => l.trim()).filter(Boolean);
  return { ok: r.ok, problems, out: r.out };
}

export function diffOf(dir: string, plan: Plan): Diff[] {
  return plan.writes.map((w) => {
    const p = join(dir, w.path);
    return { path: w.path, before: existsSync(p) ? readFileSync(p, "utf8") : null, after: w.after };
  });
}

/** Write a plan, check it, and keep it (rebuild the slice, commit) or take it back. */
export function apply(dir: string, plan: Plan, who: string) {
  if (dirty(dir).length) throw new DeskError(409, "The museum has changes no commit holds. Commit or discard them on the Sync desk first.");
  for (const w of plan.writes) {
    mkdirSync(dirname(join(dir, w.path)), { recursive: true });
    writeFileSync(join(dir, w.path), w.after);
  }
  return settle(dir, plan.summary, who);
}

/** After any write (a plan, a pull, an upload): the check decides whether it stays. */
export function settle(dir: string, summary: string, who: string) {
  const c = check(dir);
  if (!c.ok) {
    discard(dir);
    return { ok: false as const, refusal: `The check refused this, so nothing was kept. ${c.problems.join(" · ")}`, problems: c.problems };
  }
  museumScript(dir, "scripts/build-public.ts");
  const commit = commitAll(dir, who, summary);
  return { ok: true as const, commit, summary };
}

const findCorrection = (m: Museum, id: string): Correction => {
  const c = m.corrections.find((x) => x.id === id);
  if (!c) throw new DeskError(404, `No proposal ${id}.`);
  return c;
};

/** The span rule, at the desk: a name its span doesn't contain can't be kept, and the refusal names the span. */
export function spanRefusal(m: Museum, c: Correction): string | undefined {
  const text = spans(m.records).get(c.target);
  if (text === undefined) return `Can't keep “${c.proposed_text}”: its span ${c.target} isn't in the museum.`;
  if (!text.includes(c.proposed_text)) return `Can't keep “${c.proposed_text}”: the span ${c.target} doesn't contain it. The span reads: “${text}”`;
  return undefined;
}

function decided(c: Correction, status: string, who: string, note?: string): Write {
  const out: Correction = { ...c, status, decided_by: who, decided_on: today() };
  if (note?.trim()) out.curator_note = note.trim();
  return { path: `${PATHS.corrections}/${c.id}.json`, after: body(out) };
}

export type KeepAs = { mode: "new"; label: string; kind: string } | { mode: "existing"; entity: string };

/**
 * Keep a noticed name: as a new entity, or as another name of one the
 * museum has. Either way the entity is anchored to the record whose span
 * spells the name, and the proposal is accepted, by this curator, today.
 */
export function planKeep(dir: string, id: string, as: KeepAs, who: string): Plan {
  const m = readMuseum(dir);
  const c = findCorrection(m, id);
  if (c.kind !== "name") throw new DeskError(400, `${id} isn't a name proposal.`);
  if (c.status !== "proposed" && c.status !== "held") throw new DeskError(409, `${id} is already ${c.status}.`);
  const refusal = spanRefusal(m, c);
  if (refusal) throw new DeskError(422, refusal);
  const record = spanRecord(c.target);
  const name = c.proposed_text;

  let entity: Entity;
  let path: string;
  if (as.mode === "new") {
    const label = as.label.trim() || name;
    if (!KINDS.includes(as.kind)) throw new DeskError(400, `An entity is a ${KINDS.join(", ")}.`);
    const r = m.records.find((x) => x.id === record);
    if (label !== name && !(r && recordText(r).includes(label)))
      throw new DeskError(422, `“${label}” isn't how ${record} spells it. Keep the name as spelled, “${name}”, or pick an existing entity.`);
    const used = new Set(m.entities.map((e) => e.id));
    let eid: string;
    do eid = randomBytes(4).toString("hex");
    while (used.has(eid));
    const slugs = new Set(m.entities.map((e) => e.slug));
    const base = slugify(label);
    let slug = base;
    for (let i = 2; slugs.has(slug); i++) slug = `${base}-${i}`;
    entity = { id: eid, slug, kind: as.kind, label, aliases: label === name ? [] : [{ name, sources: [record] }], anchors: [record], notes: [] };
    path = `${PATHS.entities}/${slug}.json`;
  } else {
    const found = m.entityFiles.find((f) => f.data.id === as.entity || f.data.slug === as.entity);
    if (!found) throw new DeskError(404, `No entity ${as.entity}.`);
    const e = found.data;
    const aliases = [...(e.aliases ?? [])];
    if (e.label !== name) {
      const a = aliases.find((x) => x.name === name);
      if (a) a.sources = [...new Set([...(a.sources ?? []), record])];
      else aliases.push({ name, sources: [record] });
    }
    entity = { ...e, aliases, anchors: [...new Set([...(e.anchors ?? []), record])] };
    path = `${PATHS.entities}/${found.file}`;
  }
  return {
    summary: `Keep “${name}” (${c.id}) as ${as.mode === "new" ? "the entity" : "a name of"} ${entity.label}, anchored to ${record}`,
    writes: [{ path, after: body(entity) }, decided(c, "accepted", who)],
  };
}

/** Hold back (a decision, not a deletion) or reject a proposal. */
export function planDecide(dir: string, ids: string[], status: "held" | "rejected", who: string, note?: string): Plan {
  const m = readMuseum(dir);
  const writes = ids.map((id) => {
    const c = findCorrection(m, id);
    if (c.status !== "proposed" && !(c.status === "held" && status === "rejected")) throw new DeskError(409, `${id} is already ${c.status}.`);
    return decided(c, status, who, note);
  });
  const verb = status === "held" ? "Hold back" : "Reject";
  return { summary: ids.length === 1 ? `${verb} “${findCorrection(m, ids[0]).proposed_text}” (${ids[0]})` : `${verb} ${ids.length} proposals`, writes };
}

/** A record's status changes only with a dated note saying why. */
export function planStatus(dir: string, id: string, status: "verified" | "unverified", note: string): Plan {
  const m = readMuseum(dir);
  const r = m.records.find((x) => x.id === id);
  if (!r) throw new DeskError(404, `No record ${id}.`);
  if (!note.trim()) throw new DeskError(400, "A status changes only with a note saying why.");
  if (!r.held) throw new DeskError(409, `${id} isn't held, so it can't be ${status}.`);
  if (r.status === status) throw new DeskError(409, `${id} is already ${status}.`);
  return {
    summary: `${id}: ${r.status} → ${status}`,
    writes: [{ path: `${PATHS.records}/${id}.json`, after: body({ ...r, status, notes: [...(r.notes ?? []), { date: today(), note: note.trim() }] }) }],
  };
}

/** A curator's note on a record (a capture's "what this is", say): dated, never a caption. */
export function planNote(dir: string, id: string, note: string): Plan {
  const m = readMuseum(dir);
  const r = m.records.find((x) => x.id === id);
  if (!r) throw new DeskError(404, `No record ${id}.`);
  if (!note.trim()) throw new DeskError(400, "An empty note says nothing.");
  return { summary: `Note on ${id}`, writes: [{ path: `${PATHS.records}/${id}.json`, after: body({ ...r, notes: [...(r.notes ?? []), { date: today(), note: note.trim() }] }) }] };
}
