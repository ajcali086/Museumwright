/**
 * mw pull <url>: a page in. The page is one document record, its text as
 * passages; each image it shows is one image record, its caption and credit
 * verbatim or empty, its file fetched into public/images/uploads; what the
 * extraction dropped is a log record. All status unverified.
 */
import { extract, type ImageBlock } from "./extract.ts";
import { fetchBytes, fetchText } from "./fetch.ts";
import { documentItem, imageItem, logItem, type Provenance } from "./records.ts";
import { commit, type Item, type Outcome } from "./repo.ts";
import { propose, type Span } from "./propose.ts";
import type { Kind } from "./records.ts";
import { bytesHash, imageSize, inputHash, runInstant, sniff, type RunLog } from "./util.ts";

export type PullOptions = {
  maxWidth?: number;
  skipLog?: boolean;
  propose?: boolean;
  modelUrl?: string;
  /** Which kinds besides names to propose (default: every kind). */
  kinds?: Kind[];
  /** Images smaller than this on both sides are decoration (icons, spacers, tracking pixels). */
  minSide?: number;
};

export async function pull(dir: string, url: string, opts: PullOptions, log: RunLog): Promise<Outcome> {
  const at = runInstant();
  log.say(`pull ${url}`);
  const page = await fetchText(url);
  const ex = extract(page.text, page.url, { maxWidth: opts.maxWidth });
  const prov: Provenance = { url: page.url, extracted_at: at };

  const passages: { id: string; text: string }[] = [];
  const plates: { block: ImageBlock; follows?: string }[] = [];
  for (const b of ex.blocks) {
    if (b.kind === "text") passages.push({ id: `p${passages.length + 1}`, text: b.text });
    else plates.push({ block: b, follows: passages.at(-1)?.id });
  }
  const docHash = inputHash("page", page.url, JSON.stringify(passages));
  const plan: Item[] = [
    documentItem({ hash: docHash, label: `page "${ex.title}"`, title: ex.title || page.url, credit: ex.author, passages, prov }),
  ];
  const spans: Span[] = passages.map((p) => ({ record: docHash, span: p.id, text: p.text, prov }));
  const titles = new Map([[docHash, ex.title || page.url]]);
  const skipped = ex.skipped.map((s) => `[${s.where}] ${s.text}`);

  const seenBytes = new Set<string>();
  let position = 0;
  for (const { block, follows } of plates) {
    let got: { bytes: Uint8Array; url: string } | undefined;
    for (const u of block.urls) {
      try {
        got = { bytes: await fetchBytes(u), url: u };
        break;
      } catch (e) {
        log.say(`  could not fetch ${u}: ${(e as Error).message}`);
      }
    }
    if (!got) {
      skipped.push(`[image not fetched] ${block.urls[0]}${block.caption ? ` — caption: ${block.caption}` : ""}`);
      continue;
    }
    const kind = sniff(got.bytes);
    if (kind?.type !== "image") {
      skipped.push(`[not an image this tool keeps] ${got.url}`);
      continue;
    }
    const size = imageSize(got.bytes);
    const min = opts.minSide ?? 64;
    if (size && size.w < min && size.h < min) {
      skipped.push(`[decoration, ${size.w}×${size.h}] ${got.url}`);
      continue;
    }
    const bh = bytesHash(got.bytes);
    if (seenBytes.has(bh)) {
      skipped.push(`[the same image again] ${got.url}${block.caption ? ` — caption: ${block.caption}` : ""}`);
      continue;
    }
    seenBytes.add(bh);
    position++;
    const hash = inputHash("page-image", page.url, bh, block.caption, block.credit);
    plan.push(
      imageItem({
        hash,
        label: `plate ${position}`,
        title: `Plate ${position}`,
        caption: block.caption,
        credit: block.credit,
        alt: block.alt,
        parent: docHash,
        position,
        follows,
        prov: { ...prov, file_url: got.url },
        media: { bytes: got.bytes, ext: kind.ext },
      }),
    );
    if (block.caption) spans.push({ record: hash, span: "caption", text: block.caption, prov });
    titles.set(hash, `Plate ${position}`);
  }

  if (skipped.length && !opts.skipLog)
    plan.push(logItem({ hash: inputHash("page-log", docHash), title: `What the pull skipped: ${ex.title || page.url}`, parent: docHash, lines: skipped, prov }));
  log.say(`  ${passages.length} passages, ${position} plates, ${skipped.length} pieces skipped${opts.skipLog ? " (not logged: --no-skip-log)" : ""}`);

  if (opts.propose) plan.push(...(await propose(spans, opts.modelUrl!, log, { dir, kinds: opts.kinds, titles })));
  return commit(dir, plan, log);
}
