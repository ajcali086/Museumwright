/**
 * mw batch <folder>: files in. An image is an image record (no caption: a
 * file has none to give); a PDF is a document record, its text layer as
 * passages, its scanned pages as image records found in it; a text or log
 * file is a document record, its paragraphs as passages. Each file is
 * held, copied into public/images/uploads. Anything else is skipped, and
 * the skip is logged. Inputs are keyed by their bytes: a renamed file is
 * the same input.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { readPdf } from "./pdf.ts";
import { documentItem, imageItem, logItem, type Provenance } from "./records.ts";
import { commit, type Item, type Outcome } from "./repo.ts";
import { propose, type Span } from "./propose.ts";
import type { Kind } from "./records.ts";
import { bytesHash, inputHash, normalize, runInstant, sniff, type RunLog } from "./util.ts";

const TEXT = new Set([".txt", ".md", ".log"]);

function walk(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => !f.startsWith("."))
    .sort()
    .flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
}

export type BatchOptions = { skipLog?: boolean; propose?: boolean; modelUrl?: string; kinds?: Kind[] };

export async function batch(dir: string, folder: string, opts: BatchOptions, log: RunLog): Promise<Outcome> {
  const at = runInstant();
  const root = resolve(folder);
  log.say(`batch ${root}`);
  const plan: Item[] = [];
  const spans: Span[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  const titles = new Map<string, string>();

  for (const path of walk(root)) {
    const file = relative(root, path).replace(/\\/g, "/");
    const bytes = new Uint8Array(readFileSync(path));
    const bh = bytesHash(bytes);
    if (seen.has(bh)) {
      skipped.push(`[the same file again] ${file}`);
      continue;
    }
    seen.add(bh);
    const prov: Provenance = { file, extracted_at: at };
    const kind = sniff(bytes);
    const ext = extname(path).toLowerCase();

    if (kind?.type === "image") {
      plan.push(imageItem({ hash: inputHash("file-image", bh), label: file, title: basename(path), caption: "", credit: "", prov, media: { bytes, ext: kind.ext } }));
    } else if (kind?.type === "pdf") {
      const hash = inputHash("file-pdf", bh);
      let pages;
      try {
        pages = readPdf(path);
      } catch (e) {
        skipped.push(`[PDF not read: ${(e as Error).message}] ${file}`);
        continue;
      }
      const passages = pages.flatMap((p) => ("paragraphs" in p ? p.paragraphs.map((text, i) => ({ id: `p${p.page}-${i + 1}`, text })) : []));
      plan.push(documentItem({ hash, label: file, title: basename(path), credit: "", passages, prov, media: { bytes, ext: "pdf" } }));
      titles.set(hash, basename(path));
      spans.push(...passages.map((p) => ({ record: hash, span: p.id, text: p.text, prov })));
      let position = 0;
      for (const p of pages) {
        if (!("scan" in p)) continue;
        position++;
        plan.push(
          imageItem({
            hash: inputHash("file-pdf-scan", bh, p.page),
            label: `${file}, page ${p.page}`,
            title: `${basename(path)}, page ${p.page}`,
            caption: "",
            credit: "",
            parent: hash,
            position,
            prov: { ...prov, page: p.page },
            media: { bytes: p.scan, ext: "png" },
          }),
        );
      }
      log.say(`  ${file}: ${passages.length} passages, ${position} scanned pages as plates`);
    } else if (TEXT.has(ext)) {
      const hash = inputHash("file-text", bh);
      const text = Buffer.from(bytes).toString("utf8");
      const passages = text.split(/\n\s*\n/).map(normalize).filter(Boolean).map((t, i) => ({ id: `p${i + 1}`, text: t }));
      plan.push(documentItem({ hash, label: file, title: basename(path), credit: "", passages, prov, media: { bytes, ext: ext.slice(1) } }));
      titles.set(hash, basename(path));
      spans.push(...passages.map((p) => ({ record: hash, span: p.id, text: p.text, prov })));
    } else {
      skipped.push(`[not a kind this tool reads] ${file}`);
    }
  }

  if (skipped.length && !opts.skipLog)
    plan.push(logItem({ hash: inputHash("batch-log", JSON.stringify(skipped)), title: `What the batch skipped: ${basename(root)}`, lines: skipped, prov: { file: ".", extracted_at: at } }));
  log.say(`  ${plan.length} records planned, ${skipped.length} files skipped`);
  if (opts.propose) plan.push(...(await propose(spans, opts.modelUrl!, log, { dir, kinds: opts.kinds, titles })));
  return commit(dir, plan, log);
}
