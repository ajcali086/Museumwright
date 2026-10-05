/**
 * The Angie page, reconstructed for the test (see README.md): the
 * transcript's text and captions, verbatim, in a blog page's markup.
 */
import { readFileSync } from "node:fs";

const dir = new URL("./", import.meta.url);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** The transcript's emphasis, as the page's markup: the words stay as they are. */
const inline = (s: string) =>
  esc(s)
    .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
/** The words a reader sees, emphasis markers gone. */
export const plain = (s: string) => s.replace(/\*+/g, "").replace(/\s+/g, " ").trim();

export type Fixture = {
  html: string;
  files: Map<string, Uint8Array>;
  title: string;
  author: string;
  captions: string[];
  paragraphs: string[];
};

export function angiePage(): Fixture {
  const md = readFileSync(new URL("article-excerpt.md", dir), "utf8").split("\n");
  const files = new Map<string, Uint8Array>();
  const plate = (n: number) => new Uint8Array(readFileSync(new URL(`plate-0${n}.jpg`, dir)));
  const captions: string[] = [];
  const paragraphs: string[] = [];
  let title = "";
  const body: string[] = [];
  let n = 0;
  for (const line of md) {
    if (!line.trim() || line.startsWith("---") || line.startsWith("**Source:**") || line.startsWith("**URL:**") || line.startsWith("**About the author:**") || line.startsWith("**Extracted:**")) continue;
    if (line.startsWith("# ")) {
      title = line.slice(2).trim();
      body.push(`<h1 class="post-title">${inline(title)}</h1>`);
      paragraphs.push(plain(title));
    } else if (line.startsWith("## ")) {
      body.push(`<h2>${inline(line.slice(3))}</h2>`);
      paragraphs.push(plain(line.slice(3)));
    } else if (line.startsWith("[Image: ")) {
      n++;
      const caption = line.slice(8, -1);
      captions.push(caption);
      files.set(`/media/plate-${n}.jpg`, plate(n));
      if (n === 2) {
        // A lazy image: a placeholder src, the real files in data-srcset, largest within the cap wins.
        files.set(`/media/plate-${n}-w300.jpg`, plate(9));
        files.set(`/media/plate-${n}-w9000.jpg`, plate(9));
        body.push(
          `<figure class="post-image"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-srcset="/media/plate-${n}-w300.jpg 300w, /media/plate-${n}.jpg 1480w, /media/plate-${n}-w9000.jpg 9000w" alt="plate-${n}"><figcaption>${inline(caption)}</figcaption></figure>`,
        );
      } else body.push(`<figure class="post-image"><img src="/media/plate-${n}.jpg" alt=""><figcaption>${inline(caption)}</figcaption></figure>`);
      if (n === 4) {
        // A tracking pixel in the content, and an image with no caption at all.
        files.set("/px.gif", new Uint8Array(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64")));
        body.push(`<p><img src="/px.gif" width="1" height="1" alt=""></p>`);
        files.set("/media/uncaptioned.jpg", plate(9));
        body.push(`<div class="image-wrapper"><img src="/media/uncaptioned.jpg" alt=""></div>`);
      }
    } else if (line.startsWith("> ")) {
      const text = line.slice(2);
      body.push(`<blockquote><p>${inline(text)}</p></blockquote>`);
      paragraphs.push(plain(text));
    } else {
      body.push(`<p>${inline(line)}</p>`);
      paragraphs.push(plain(line));
    }
  }
  // The first image again, as a blog's "share" card repeats it: one record, not two.
  body.push(`<figure class="post-image"><img src="/media/plate-1-again.jpg" alt=""><figcaption>${inline(captions[0])}</figcaption></figure>`);
  files.set("/media/plate-1-again.jpg", plate(1));
  files.set("/media/logo.jpg", plate(9));

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>${esc(title)} | History Blog</title>
<meta name="author" content="Michael Dykhorst">
<meta property="og:title" content="${esc(title)}">
<script>window.analytics = { track() {} };</script>
<style>body { font-family: serif }</style>
</head><body>
<header class="site-header"><img src="/media/logo.jpg" alt="Site logo"><nav><a href="/">Home</a> <a href="/about">About</a> <a href="/blog">Blog</a> <a href="/contact">Contact</a></nav></header>
<div id="SITE_CONTAINER"><div class="page">
<div class="ad-slot ad">Advertisement: Visit the gift shop on Main Street</div>
<main><div class="blog-post">
<div class="post-meta"><span>Michael Dykhorst</span></div>
<article><div class="post-content">
${body.join("\n")}
</div>
<div class="share-buttons"><button>Share on Facebook</button><button>Share on X</button><a href="#">Copy link</a></div>
</article>
<section class="comments"><h3>Comments</h3><p>Write a comment... Log in to leave a comment on this post, it only takes a minute.</p></section>
<div class="newsletter subscribe"><p>Subscribe to the newsletter for new posts every month, straight to your inbox.</p><form><input type="email"><button>Subscribe</button></form></div>
</div></main>
<aside class="sidebar"><h3>Recent posts</h3><ul><li><a href="/post/1">Another madam of Main Street, a story for another day</a></li></ul></aside>
</div></div>
<footer class="site-footer"><p>© 2026 History Blog. All rights reserved. Proudly created with a website builder.</p></footer>
</body></html>`;
  return { html, files, title: plain(title), author: "Michael Dykhorst", captions: captions.map(plain), paragraphs };
}
