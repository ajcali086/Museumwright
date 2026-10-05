/**
 * PDFs, through poppler's command-line tools (pdfinfo, pdftotext, pdftoppm):
 * a page with a text layer gives passages; a page without one (a scan) is
 * rendered to an image and becomes a plate. No OCR: a scan's words are not
 * guessed.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalize } from "./util.ts";

export type PdfPage = { page: number; paragraphs: string[] } | { page: number; scan: Uint8Array };

const run = (cmd: string, args: string[]) => {
  try {
    return execFileSync(cmd, args, { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`${cmd} not found: install poppler (poppler-utils) to read PDFs`);
    throw e;
  }
};

export function readPdf(file: string, dpi = 150): PdfPage[] {
  const info = run("pdfinfo", [file]).toString("utf8");
  const pages = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1] ?? 0);
  const out: PdfPage[] = [];
  const tmp = mkdtempSync(join(tmpdir(), "mw-pdf-"));
  try {
    for (let n = 1; n <= pages; n++) {
      const text = run("pdftotext", ["-f", String(n), "-l", String(n), "-enc", "UTF-8", file, "-"]).toString("utf8");
      const paragraphs = text.split(/\n\s*\n/).map(normalize).filter(Boolean);
      if (paragraphs.join("").replace(/\W/g, "").length >= 3) out.push({ page: n, paragraphs });
      else {
        const prefix = join(tmp, `page-${n}`);
        run("pdftoppm", ["-f", String(n), "-l", String(n), "-r", String(dpi), "-png", "-singlefile", file, prefix]);
        out.push({ page: n, scan: new Uint8Array(readFileSync(`${prefix}.png`)) });
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return out;
}
