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
import { inputHash, type RunLog } from "./util.ts";
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

/** The model's name, if a llama.cpp server answers at `base`. */
export async function reach(base: string): Promise<{ model: string } | { why: string }> {
  try {
    const health = (await getJson(`${base}/health`, 3000)) as { status?: string };
    if (health?.status !== "ok") return { why: `${base}/health says ${JSON.stringify(health)}` };
    const props = (await getJson(`${base}/props`, 3000).catch(() => ({}))) as { model_path?: string; model_alias?: string };
    const path = props.model_alias || props.model_path || "unknown model";
    return { model: path.split(/[\\/]/).pop()!.replace(/\.gguf$/i, "") };
  } catch (e) {
    return { why: `no model reachable at ${base} (${(e as Error).message})` };
  }
}

export async function namesIn(base: string, text: string): Promise<Name[]> {
  const res = await fetch(`${base}/completion`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({
      prompt: prompt(text.slice(0, 4000)),
      grammar: GRAMMAR,
      temperature: 0,
      seed: 42,
      n_predict: 768,
      cache_prompt: true,
    }),
  });
  if (!res.ok) throw new Error(`/completion: ${res.status}`);
  const { content } = (await res.json()) as { content: string };
  const parsed = JSON.parse(content) as { names: Name[] };
  return parsed.names.filter((n) => typeof n?.name === "string" && KINDS.includes(n.kind));
}

/** The span rule: kept only if the span contains the name exactly as the model wrote it. */
export const spanHolds = (span: string, name: string) => name.trim().length > 1 && span.includes(name.trim());

/** Proposal items for every span. An empty pile, logged, if no model answers. */
export async function propose(spans: Span[], base: string, log: RunLog): Promise<Item[]> {
  const reached = await reach(base);
  if ("why" in reached) {
    log.say(`propose: ${reached.why}; the pile is empty`);
    return [];
  }
  log.say(`propose: ${reached.model} at ${base}, ${spans.length} spans`);
  const items: Item[] = [];
  let dropped = 0;
  try {
    for (const s of spans) {
      if (!s.text.trim()) continue;
      const seen = new Set<string>();
      for (const n of await namesIn(base, s.text)) {
        const name = n.name.trim();
        if (!spanHolds(s.text, name)) {
          dropped++;
          continue;
        }
        if (seen.has(name)) continue;
        seen.add(name);
        const hash = inputHash("name", s.record, s.span, s.text, name, n.kind);
        items.push(nameItem({ hash, record: s.record, span: s.span, name, kind: n.kind, model: reached.model, prov: s.prov }));
      }
    }
  } catch (e) {
    log.say(`propose: the model failed mid-run (${(e as Error).message}); the pile is empty`);
    return [];
  }
  log.say(`propose: ${items.length} names noticed; ${dropped} dropped by the span rule (not in their span as spelled)`);
  return items;
}
