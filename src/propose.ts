/**
 * --propose: the machine's names, in the queue's shape.
 *
 * The worker is local: Qwen3-1.7B (Apache 2.0), GGUF Q4_K_M, served by
 * llama.cpp's llama-server, for example
 *
 *   llama-server -hf Qwen/Qwen3-1.7B-GGUF:Q4_K_M --port 8080
 *
 * Generation is constrained by a grammar to the proposal's fields, so the
 * model fills fields and cannot invent structure. Then the span rule: a
 * name the span doesn't contain, exactly as spelled, is dropped here, and
 * refused by check:model if it ever reaches the queue. If no model is
 * reachable, the pile is empty and the run log says so.
 */
import { NEW_KINDS, proposeKinds } from "./kinds.ts";
import { inputHash, type RunLog } from "./util.ts";
import type { Kind } from "./records.ts";
import { nameItem, type Provenance } from "./records.ts";
import type { Item } from "./repo.ts";

export const DEFAULT_MODEL_URL = "http://127.0.0.1:8080";
export const KINDS = ["person", "family", "place", "organization", "event"] as const;

/** The proposal's fields, and nothing else: a JSON list of names, each with a kind. */
export const GRAMMAR = String.raw`root   ::= "{" ws "\"names\":" ws "[" ws ( item ( ws "," ws item ){0,24} )? ws "]" ws "}"
item   ::= "{" ws "\"name\":" ws string ws "," ws "\"kind\":" ws kind ws "}"
kind   ::= "\"person\"" | "\"family\"" | "\"place\"" | "\"organization\"" | "\"event\""
string ::= "\"" char{1,80} "\""
char   ::= [^"\\\x7F\x00-\x1F] | "\\" ( ["\\/bfnrt] | "u" [0-9a-fA-F]{4} )
ws     ::= [ \t\n]{0,2}`;

const SYSTEM =
  "You list the proper names a passage contains: people, families, places, organizations and events. " +
  "Copy each name exactly as the passage spells it, character for character. " +
  "List only names that appear in the passage. If there are none, return an empty list.";

/** Qwen3's chat template, thinking off. */
const prompt = (text: string) =>
  `<|im_start|>system\n${SYSTEM}<|im_end|>\n<|im_start|>user\nPassage:\n${text}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`;

export type Span = { record: string; span: string; text: string; prov: Provenance };
export type Name = { name: string; kind: (typeof KINDS)[number] };

async function getJson(url: string, ms: number): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

/**
 * The model, if a llama.cpp server answers at `base` with one loaded: its
 * alias (or path) exactly as the server knows it, since newer servers want
 * that very string as `model` in every request.
 */
export async function reach(base: string): Promise<{ model: string } | { why: string }> {
  try {
    const health = (await getJson(`${base}/health`, 3000)) as { status?: string };
    if (health?.status !== "ok") return { why: `${base}/health says ${JSON.stringify(health)}` };
    const props = (await getJson(`${base}/props`, 3000).catch(() => ({}))) as { model_path?: string; model_alias?: string };
    const model = props.model_alias || props.model_path;
    return model ? { model } : { why: `the server at ${base} has no model loaded` };
  } catch (e) {
    return { why: `no model reachable at ${base} (${(e as Error).message})` };
  }
}

/** A model's short name, for records and logs: no folders, no .gguf. */
export const modelName = (model: string) => model.split(/[\\/]/).pop()!.replace(/\.gguf$/i, "");

/** One completion, constrained by a grammar, parsed. Older servers ignore `model`. */
export async function complete(base: string, model: string, text: string, grammar: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/completion`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({ model, prompt: text, grammar, temperature: 0, seed: 42, n_predict: 1024, cache_prompt: true }),
  });
  if (!res.ok) throw new Error(`/completion: ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`.trim());
  const { content } = (await res.json()) as { content: string };
  return JSON.parse(content) as Record<string, unknown>;
}

export async function namesIn(base: string, model: string, text: string): Promise<Name[]> {
  const parsed = (await complete(base, model, prompt(text.slice(0, 4000)), GRAMMAR)) as { names?: Name[] };
  return (parsed.names ?? []).filter((n) => typeof n?.name === "string" && KINDS.includes(n.kind));
}

/** The span rule: kept only if the span contains the name exactly as the model wrote it. */
export const spanHolds = (span: string, name: string) => name.trim().length > 1 && span.includes(name.trim());

export type ProposeOptions = {
  /** The museum, for proposals across its records (duplicates, links). */
  dir?: string;
  /** Which kinds to ask for besides names (default: every kind). */
  kinds?: Kind[];
  /** Each run record's title, by input hash, for the catalogue the model reads. */
  titles?: Map<string, string>;
};

/** Proposal items for every span, of every kind. An empty pile, logged, if no model answers. */
export async function propose(spans: Span[], base: string, log: RunLog, opts: ProposeOptions = {}): Promise<Item[]> {
  const reached = await reach(base);
  if ("why" in reached) {
    log.say(`propose: ${reached.why}; the pile is empty`);
    return [];
  }
  const short = modelName(reached.model);
  log.say(`propose: ${short} at ${base}, ${spans.length} spans`);
  const items: Item[] = [];
  let dropped = 0;
  try {
    for (const s of spans) {
      if (!s.text.trim()) continue;
      const seen = new Set<string>();
      for (const n of await namesIn(base, reached.model, s.text)) {
        const name = n.name.trim();
        if (!spanHolds(s.text, name)) {
          dropped++;
          continue;
        }
        if (seen.has(name)) continue;
        seen.add(name);
        const hash = inputHash("name", s.record, s.span, s.text, name, n.kind);
        items.push(nameItem({ hash, record: s.record, span: s.span, name, kind: n.kind, model: short, prov: s.prov }));
      }
    }
  } catch (e) {
    log.say(`propose: the model failed mid-run (${(e as Error).message}); the pile is empty`);
    return [];
  }
  log.say(`propose: ${items.length} names noticed; ${dropped} dropped by the span rule (not in their span as spelled)`);
  const kinds = opts.kinds ?? NEW_KINDS;
  if (!kinds.length) return items;
  try {
    const more = await proposeKinds({ spans, ask: (p, g) => complete(base, reached.model, p, g), model: short, dir: opts.dir, kinds, titles: opts.titles });
    const count = (k: string) => more.items.filter((i) => i.label === `${k} proposal`).length;
    log.say(`propose: ${kinds.map((k) => `${count(k)} ${k}${count(k) === 1 ? "" : "s"}`).join(", ")}; ${more.dropped} dropped by the span rule (a quote not in its span)`);
    return [...items, ...more.items];
  } catch (e) {
    log.say(`propose: the model failed on the other kinds (${(e as Error).message}); only the names are kept`);
    return items;
  }
}
