/**
 * Readability-style extraction: the page's content, in order, as passages
 * and images; the chrome (navigation, headers, footers, share bars, ads,
 * comments) dropped, and every piece dropped listed, for the skipped-content
 * log. Text is kept as the page writes it: whitespace collapsed, nothing
 * else changed. A caption or credit is what the page marks as one, or
 * empty: never inferred from nearby text.
 */
import { parseHTML } from "linkedom";
import { clip, normalize } from "./util.ts";

export type Candidate = { url: string; w?: number; x?: number };
export type ImageBlock = {
  kind: "image";
  /** Where to fetch it, best first: the srcset's largest within the cap, then src. */
  urls: string[];
  alt: string;
  caption: string;
  credit: string;
};
export type TextBlock = { kind: "text"; text: string };
export type Block = TextBlock | ImageBlock;
export type Skipped = { where: string; text: string };
export type Extracted = { title: string; author: string; blocks: Block[]; skipped: Skipped[] };

type El = Element;

const SILENT = "script,style,noscript,template,link,meta,svg";
const CHROME_TAGS = new Set(["NAV", "ASIDE", "FORM", "BUTTON", "FOOTER", "HEADER", "IFRAME", "SELECT", "INPUT", "DIALOG", "EMBED", "OBJECT"]);
const CHROME_HINT =
  /(^|[-_\s])(nav|navbar|navigation|menu|share|sharing|social|comments?|related|recommended|advert|advertisement|ads?|sponsored|promo|newsletter|subscribe|signup|sidebar|cookies?|banner|breadcrumbs?|pagination|footer|header|toolbar|popup|modal|widget|tags|post-footer|author-box)([-_\s]|$)/i;
const BLOCK_TAGS = new Set([
  "P", "DIV", "SECTION", "ARTICLE", "MAIN", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI",
  "BLOCKQUOTE", "PRE", "FIGURE", "FIGCAPTION", "TABLE", "THEAD", "TBODY", "TR", "TD", "TH", "DL",
  "DT", "DD", "HR", "HEADER", "FOOTER", "NAV", "ASIDE", "FORM", "IMG", "PICTURE", "ADDRESS",
]);
const PARAGRAPHS = "p,pre,blockquote,li,h2,h3,h4,dd";
const CAPTION_HINT = /caption/i;
const CREDIT_HINT = /credit|copyright|attribution|byline|photographer/i;

const hints = (el: El) =>
  [el.getAttribute("class"), el.getAttribute("id"), el.getAttribute("role"), el.getAttribute("data-hook"), el.getAttribute("itemprop")]
    .filter(Boolean)
    .join(" ");

function describe(el: El): string {
  const cls = (el.getAttribute("class") ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
  const id = el.getAttribute("id");
  return el.tagName.toLowerCase() + (id ? `#${id}` : "") + cls.map((c) => `.${c}`).join("");
}

function isChrome(el: El): boolean {
  if (CHROME_TAGS.has(el.tagName)) return true;
  if (el.getAttribute("role") === "navigation" || el.getAttribute("role") === "banner" || el.getAttribute("role") === "contentinfo") return true;
  if (el.getAttribute("aria-hidden") === "true") return true;
  return CHROME_HINT.test(hints(el));
}

/** A paragraph's weight toward choosing the content: its length, if it reads as prose, not links. */
function weight(p: El): number {
  const text = normalize(p.textContent ?? "");
  if (text.length < 25) return 0;
  const links = [...p.querySelectorAll("a")].reduce((n, a) => n + normalize(a.textContent ?? "").length, 0);
  return links / text.length > 0.5 ? 0 : text.length;
}

/**
 * The content root: the deepest element that holds nearly all of the page's
 * prose. Chrome holds little prose, so it falls outside.
 */
function contentRoot(body: El): El {
  const paragraphs = [...body.querySelectorAll(PARAGRAPHS)].filter((p) => !p.parentElement?.closest(PARAGRAPHS));
  const held = new Map<El, number>();
  let total = 0;
  for (const p of paragraphs) {
    const w = weight(p);
    if (!w || p.closest("nav,footer,aside,form")) continue;
    total += w;
    for (let el: El | null = p.parentElement; el; el = el.parentElement) held.set(el, (held.get(el) ?? 0) + w);
  }
  if (!total) return body;
  let best = body;
  let depth = 0;
  for (const [el, w] of held) {
    if (w < 0.85 * total) continue;
    let d = 0;
    for (let x: El | null = el; x; x = x.parentElement) d++;
    if (d > depth) [best, depth] = [el, d];
  }
  return best;
}

/** srcset, per the HTML parser's rules closely enough: URLs may hold commas, descriptors follow whitespace. */
export function parseSrcset(srcset: string): Candidate[] {
  const out: Candidate[] = [];
  let i = 0;
  const s = srcset;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    let url = "";
    while (i < s.length && !/\s/.test(s[i])) url += s[i++];
    let descriptor = "";
    if (url.endsWith(",")) url = url.replace(/,+$/, "");
    else {
      while (i < s.length && s[i] !== ",") descriptor += s[i++];
    }
    if (!url) continue;
    const d = descriptor.trim();
    const w = /^(\d+)w$/.exec(d);
    const x = /^(\d*\.?\d+)x$/.exec(d);
    out.push({ url, ...(w ? { w: Number(w[1]) } : {}), ...(x ? { x: Number(x[1]) } : { ...(w ? {} : { x: 1 }) }) });
  }
  return out;
}

/** The best candidate: the widest within the cap (or the narrowest, if all exceed it), else the densest. */
export function bestCandidate(cands: Candidate[], maxWidth: number): Candidate | undefined {
  const usable = cands.filter((c) => !c.url.startsWith("data:"));
  const widths = usable.filter((c) => c.w);
  if (widths.length) {
    const within = widths.filter((c) => c.w! <= maxWidth).sort((a, b) => b.w! - a.w!);
    return within[0] ?? widths.sort((a, b) => a.w! - b.w!)[0];
  }
  return usable.sort((a, b) => (b.x ?? 1) - (a.x ?? 1))[0];
}

function imageUrls(img: El, base: string, maxWidth: number): string[] {
  const sets = [img.getAttribute("srcset"), img.getAttribute("data-srcset")];
  const picture = img.parentElement?.tagName === "PICTURE" ? img.parentElement : null;
  for (const source of picture ? [...picture.querySelectorAll("source")] : []) sets.push(source.getAttribute("srcset"));
  const cands = sets.filter(Boolean).flatMap((s) => parseSrcset(s!));
  const best = bestCandidate(cands, maxWidth);
  const srcs = ["data-src", "data-lazy-src", "data-original", "src"].map((a) => img.getAttribute(a)).filter((u): u is string => !!u && !u.startsWith("data:"));
  const urls = [best?.url, ...srcs].filter((u): u is string => !!u);
  const resolved = urls.flatMap((u) => {
    try {
      return [new URL(u, base).href];
    } catch {
      return [];
    }
  });
  return [...new Set(resolved)];
}

/** A caption element's caption and credit: the credit is whatever it marks as one; the caption is the rest. */
function captionAndCredit(cap: El | null | undefined): { caption: string; credit: string } {
  if (!cap) return { caption: "", credit: "" };
  const copy = cap.cloneNode(true) as El;
  const credits = [...copy.querySelectorAll("*")].filter((x) => x.tagName === "CITE" || x.tagName === "SMALL" || CREDIT_HINT.test(hints(x)));
  const outer = credits.filter((c) => !credits.some((o) => o !== c && o.contains(c)));
  const credit = outer.map((c) => normalize(c.textContent ?? "")).filter(Boolean).join(" ");
  for (const c of outer) c.remove();
  return { caption: normalize(copy.textContent ?? ""), credit };
}

const isCaption = (el: El | null | undefined): el is El =>
  !!el && (el.tagName === "FIGCAPTION" || CAPTION_HINT.test(hints(el)));

export function extract(html: string, pageUrl: string, opts: { maxWidth?: number } = {}): Extracted {
  const maxWidth = opts.maxWidth ?? 3000;
  const { document } = parseHTML(html);
  const base = document.querySelector("base[href]")?.getAttribute("href") ?? pageUrl;
  const baseUrl = (() => {
    try {
      return new URL(base, pageUrl).href;
    } catch {
      return pageUrl;
    }
  })();
  const meta = (sel: string) => document.querySelector(sel)?.getAttribute("content")?.trim() ?? "";
  const author =
    meta('meta[name="author"]') ||
    meta('meta[property="article:author"]').replace(/^https?:\/\/\S+$/, "") ||
    normalize(document.querySelector('[rel="author"], [itemprop="author"]')?.textContent ?? "");
  const ogTitle = meta('meta[property="og:title"]');
  const docTitle = normalize(document.querySelector("title")?.textContent ?? "");

  for (const el of [...document.querySelectorAll(SILENT)]) el.remove();
  for (const br of [...document.querySelectorAll("br")]) br.replaceWith(document.createTextNode(" "));

  const body = (document.body ?? document.documentElement) as El;
  const root = contentRoot(body);
  const h1 = root.querySelector("h1") ?? document.querySelector("h1");
  const title = normalize(h1?.textContent ?? "") || ogTitle || docTitle;

  const skipped: Skipped[] = [];
  /** For the log only: each piece of text apart, so buttons and links don't run together. */
  const spaced = (el: El): string => {
    const parts: string[] = [];
    const walk = (n: Node) => (n.nodeType === 3 ? parts.push(n.textContent ?? "") : n.childNodes.forEach(walk));
    walk(el);
    return normalize(parts.join(" "));
  };
  const skip = (el: El, why: string) => {
    const text = spaced(el);
    const imgs = [...(el.tagName === "IMG" ? [el] : el.querySelectorAll("img"))].map((i) => i.getAttribute("src") ?? "").filter((s) => s && !s.startsWith("data:"));
    if (!text && !imgs.length) return;
    const parts = [text && clip(text, 400), ...imgs.map((s) => `[image ${s}]`)].filter(Boolean);
    skipped.push({ where: `${why}: ${describe(el)}`, text: parts.join(" ") });
  };

  // Outside the content: everything that doesn't hold the root.
  const outside = (el: El) => {
    for (const child of [...el.children]) {
      if (child === root) continue;
      if (child.contains(root)) outside(child);
      else skip(child, "outside the content");
    }
  };
  if (root !== body) outside(body);

  const blocks: Block[] = [];
  const consumed = new Set<El>();
  const pushText = (text: string) => {
    const t = normalize(text);
    if (t) blocks.push({ kind: "text", text: t });
  };
  const pushImage = (img: El, cap?: El | null) => {
    const urls = imageUrls(img, baseUrl, maxWidth);
    if (!urls.length) return;
    blocks.push({ kind: "image", urls, alt: normalize(img.getAttribute("alt") ?? ""), ...captionAndCredit(cap) });
  };
  /** The caption the page puts right after an image (or after the wrapper that holds only it). */
  const captionAfter = (node: El): El | undefined => {
    for (let el: El | null = node, i = 0; el && el !== root && i < 4; el = el.parentElement, i++) {
      const next = el.nextElementSibling;
      if (isCaption(next)) return next;
      if (next || normalize(el.parentElement?.textContent ?? "") !== normalize(el.textContent ?? "")) break;
    }
    return undefined;
  };

  const hasBlocks = (el: El) => [...el.querySelectorAll("*")].some((x) => BLOCK_TAGS.has(x.tagName));

  const visit = (el: El) => {
    if (consumed.has(el)) return;
    if (el !== root && isChrome(el)) return skip(el, "chrome in the content");
    if (el.tagName === "H1" && el === h1) return pushText(el.textContent ?? "");
    if (el.tagName === "FIGURE") {
      const cap = [...el.querySelectorAll("figcaption")].find(Boolean) ?? [...el.querySelectorAll("*")].find(isCaption);
      const imgs = [...el.querySelectorAll("img")];
      if (!imgs.length) return pushText(el.textContent ?? "");
      imgs.forEach((img, i) => pushImage(img, i === imgs.length - 1 ? cap : null));
      return;
    }
    if (el.tagName === "IMG") {
      const cap = captionAfter(el);
      if (cap) consumed.add(cap);
      return pushImage(el, cap);
    }
    if (el.tagName === "PICTURE") {
      const img = el.querySelector("img");
      if (!img) return;
      const cap = captionAfter(el);
      if (cap) consumed.add(cap);
      return pushImage(img, cap);
    }
    if (isCaption(el) && !el.querySelector("img")) return skip(el, "a caption with no image");
    if (!hasBlocks(el)) {
      pushText(el.textContent ?? "");
      return;
    }
    let run = "";
    for (const node of [...el.childNodes]) {
      if (node.nodeType === 3) run += node.textContent;
      else if (node.nodeType === 1) {
        const child = node as El;
        if (BLOCK_TAGS.has(child.tagName) || hasBlocks(child)) {
          pushText(run);
          run = "";
          visit(child);
        } else run += child.textContent;
      }
    }
    pushText(run);
  };
  visit(root);

  return { title, author, blocks, skipped };
}
