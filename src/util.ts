import { createHash } from "node:crypto";

/** The input hash: sha256 over a canonical list of the parts that make an input this input. */
export const inputHash = (...parts: (string | number)[]) =>
  "sha256:" + createHash("sha256").update(JSON.stringify(parts)).digest("hex");

export const bytesHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Whitespace collapsed, ends trimmed: the only change made to extracted text. */
export const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

export const clip = (text: string, n: number) =>
  text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text;

/** The run's clock: one instant for every record a run writes. MW_NOW pins it (tests). */
export function runInstant(): string {
  const now = process.env.MW_NOW ? new Date(process.env.MW_NOW) : new Date();
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export const slugify = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "museum";

/** The run log: what the run did, line by line, to stdout. */
export class RunLog {
  lines: string[] = [];
  quiet: boolean;
  constructor(quiet = false) {
    this.quiet = quiet;
  }
  say(line: string) {
    this.lines.push(line);
    if (!this.quiet) console.log(line);
  }
}

/** The kind of an image or document, from its first bytes. */
export function sniff(bytes: Uint8Array): { ext: string; type: "image" | "pdf" } | undefined {
  const b = bytes;
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: "jpg", type: "image" };
  if (b[0] === 0x89 && ascii(1, 4) === "PNG") return { ext: "png", type: "image" };
  if (ascii(0, 4) === "GIF8") return { ext: "gif", type: "image" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return { ext: "webp", type: "image" };
  if (ascii(4, 8) === "ftyp" && /avi[fs]/.test(ascii(8, 12))) return { ext: "avif", type: "image" };
  if (ascii(0, 5) === "%PDF-") return { ext: "pdf", type: "pdf" };
  return undefined;
}

/** An image's pixel size, for the formats sniff knows, if its header says. */
export function imageSize(bytes: Uint8Array): { w: number; h: number } | undefined {
  const b = Buffer.from(bytes);
  const kind = sniff(bytes)?.ext;
  try {
    if (kind === "png") return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (kind === "gif") return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
    if (kind === "webp") {
      const chunk = b.toString("ascii", 12, 16);
      if (chunk === "VP8X") return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
      if (chunk === "VP8 ") return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
      if (chunk === "VP8L") {
        const bits = b.readUInt32LE(21);
        return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
    if (kind === "jpg") {
      let i = 2;
      while (i < b.length) {
        if (b[i] !== 0xff) return undefined;
        const marker = b[i + 1];
        const len = b.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
          return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
        i += 2 + len;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}
