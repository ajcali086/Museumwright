/**
 * The viewer: renders the public slice (/data/museum.json) as plain pages,
 * routed by the address's hash:
 *
 *   #/                    records: each page or document with its plates
 *   #/records/<id>        one record: a document's text with its plates in
 *                         place, or a plate with its caption and credit
 *   #/entities[/<slug>]   entities and the records that anchor them
 *   #/questions[/<id>]    open questions
 *   #/both-stand          disagreements the museum lets stand, both claims quoted
 *   #/evidence            claims linked to records
 *
 * Every word comes from the slice and is set as text, never as markup: a
 * pulled page's words can't run as code here. An empty caption says so.
 */

const view = document.getElementById("view");
let slice;

/** An element, its attributes, and its children (strings become text). */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? "" : String(v));
  for (const c of children.flat()) if (c !== undefined && c !== null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

/** A link only for web addresses: a source URL is the page's to give, not ours to run. */
const safeHref = (url) => (/^https?:\/\//i.test(url ?? "") ? url : undefined);
/** A held file's address, relative to the page: public/images/uploads/x.jpg is served at images/uploads/x.jpg, so the museum works in a sub-folder too. */
const mediaUrl = (path) => String(path).replace(/^public\//, "");
const isImage = (path) => /\.(jpe?g|png|gif|webp|avif)$/i.test(path);
const byId = (id) => slice.records.find((r) => r.id === id);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function statusBadge(r) {
  if (r.status === "verified") return h("span", { class: "badge ok" }, "Verified");
  if (r.status === "not-held") return h("span", { class: "badge" }, "Not held");
  return h("span", { class: "badge", title: "Held, but where the copy came from isn't confirmed yet." }, "Unverified copy");
}

function captionOf(r) {
  return r.caption ? r.caption : h("span", { class: "quiet" }, "No caption given.");
}

function plateFigure(r, { link = true } = {}) {
  const file = (r.media ?? []).find(isImage);
  const img = file ? h("img", { src: mediaUrl(file), alt: r.alt || r.caption || r.title, loading: "lazy" }) : h("p", { class: "quiet" }, "No file held.");
  return h(
    "figure",
    { class: "plate", id: r.id },
    link ? h("a", { href: `#/records/${r.id}` }, img) : img,
    h("figcaption", {}, captionOf(r), r.credit ? h("div", { class: "meta" }, r.credit) : null, h("div", { class: "meta" }, link ? h("a", { href: `#/records/${r.id}` }, r.title) : r.title, " ", statusBadge(r))),
  );
}

function facts(rows) {
  return h("dl", { class: "facts" }, rows.filter(([, v]) => v !== undefined && v !== null && v !== "").flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]));
}

function sourceFacts(r) {
  const s = r.source ?? {};
  const url = safeHref(s.url);
  const fileUrl = safeHref(s.file_url);
  return facts([
    ["ID", r.id],
    ["Status", statusBadge(r)],
    ["Rights holder", r.rights_holder],
    ["From", url ? h("a", { href: url, rel: "noopener noreferrer" }, s.url) : s.url ?? s.file],
    ["File as fetched", fileUrl ? h("a", { href: fileUrl, rel: "noopener noreferrer" }, s.file_url) : undefined],
    ["Page", s.page],
    ["Taken in", s.extracted_at ? s.extracted_at.replace("T", " ").replace("Z", " UTC") : undefined],
  ]);
}

/** The quiet doors: records a kept link joins to this one, and what they share. */
function also(id) {
  const doors = (slice.links ?? []).filter((l) => l.from === id || l.to === id);
  if (!doors.length) return [];
  return [h("h2", {}, "Also"), h("ul", { class: "list" }, doors.map((l) => {
    const other = l.from === id ? l.to : l.from;
    return h("li", {}, h("a", { href: `#/records/${other}` }, byId(other)?.title ?? other), " ", h("span", { class: "meta" }, l.basis));
  }))];
}

/** A claim's words, where they are said. */
function claim(c) {
  const rid = String(c?.span ?? "").replace(/^plate:/, "").split("#")[0];
  return h("div", { class: "claim" }, h("blockquote", {}, `“${c?.quote ?? ""}”`), h("p", { class: "meta" }, "— ", h("a", { href: `#/records/${rid}` }, byId(rid)?.title ?? rid)));
}

function bothStandPage() {
  const entries = slice.bothStand ?? [];
  return [
    h("h1", {}, "Both stand"),
    h("p", { class: "meta" }, "Where the records disagree, the museum keeps both: each claim in its own words, neither corrected to fit the other."),
    entries.length
      ? h("ul", { class: "list" }, entries.map((b) => h("li", {}, h("p", { class: "kicker" }, b.status === "settled" ? "Settled" : "Both stand"), h("strong", {}, b.title), claim(b.claim_a), claim(b.claim_b), b.status === "settled" && b.settled_note ? h("p", {}, b.settled_note) : null)))
      : h("p", { class: "quiet" }, "No disagreements are recorded yet."),
  ];
}

function anchoredBy(id) {
  const ents = slice.entities.filter((e) => (e.anchors ?? []).includes(id));
  return ents.length ? [h("h2", {}, "Names it"), h("ul", { class: "list" }, ents.map((e) => h("li", {}, h("a", { href: `#/entities/${e.slug}` }, e.label), " ", h("span", { class: "meta" }, e.kind))))] : [];
}

function recordsHome() {
  const { records } = slice;
  if (!records.length) return [h("h1", {}, "Records"), h("p", { class: "quiet" }, "This museum has no records yet.")];
  const docs = records.filter((r) => r.kind === "document");
  const inDoc = new Set(docs.map((d) => d.id));
  const loose = records.filter((r) => r.kind !== "document" && r.kind !== "log" && !inDoc.has(r.found_in));
  const logs = records.filter((r) => r.kind === "log");
  return [
    h("h1", {}, "Records"),
    h("p", { class: "meta" }, `${plural(records.length, "record")}. Each is shown as its source gives it; an unverified copy is marked.`),
    h(
      "ul",
      { class: "list" },
      docs.map((d) => {
        const plates = records.filter((r) => r.found_in === d.id && r.kind === "image").sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
        return h(
          "li",
          {},
          h("p", { class: "kicker" }, "Document"),
          h("a", { class: "title", href: `#/records/${d.id}` }, d.title),
          " ",
          statusBadge(d),
          h("div", { class: "meta" }, [d.credit, plural((d.passages ?? []).length, "passage"), plural(plates.length, "plate")].filter(Boolean).join(" · ")),
          plates.length ? h("div", { class: "thumbs" }, plates.map((p) => { const f = (p.media ?? []).find(isImage); return h("a", { href: `#/records/${p.id}`, title: p.caption || p.title }, f ? h("img", { src: mediaUrl(f), alt: p.alt || p.caption || p.title, loading: "lazy" }) : p.title); })) : null,
        );
      }),
      loose.map((r) => h("li", {}, h("p", { class: "kicker" }, r.kind), h("a", { class: "title", href: `#/records/${r.id}` }, r.title), " ", statusBadge(r), r.caption ? h("div", {}, r.caption) : null)),
    ),
    logs.length ? [h("h2", {}, "Logs"), h("ul", { class: "list" }, logs.map((r) => h("li", {}, h("a", { href: `#/records/${r.id}` }, r.title), " ", h("span", { class: "meta" }, plural((r.passages ?? []).length, "entry", "entries")))))] : [],
  ];
}

function recordPage(id) {
  const r = byId(id);
  if (!r) return notFound(`No record ${id}.`);
  const parent = r.found_in ? byId(r.found_in) : undefined;
  const back = parent ? h("p", { class: "meta" }, "Found in ", h("a", { href: `#/records/${parent.id}` }, parent.title), r.position ? `, plate ${r.position}` : "") : null;
  if (r.kind === "image") return [back, h("h1", {}, r.title), plateFigure(r, { link: false }), sourceFacts(r), ...anchoredBy(r.id), ...also(r.id)];
  if (r.kind === "log")
    return [back, h("p", { class: "kicker" }, "Log"), h("h1", {}, r.title), h("ul", { class: "list" }, (r.passages ?? []).map((p) => h("li", { class: "meta" }, p.text))), sourceFacts(r)];

  // A document: its passages in order, each plate placed after the passage it follows.
  const plates = slice.records.filter((x) => x.found_in === r.id && x.kind === "image").sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const after = new Map();
  for (const p of plates) after.set(p.follows ?? "", [...(after.get(p.follows ?? "") ?? []), p]);
  const body = [...(after.get("") ?? []).map((p) => plateFigure(p))];
  // A page's own heading is its first passage too; the title above already says it.
  const passages = (r.passages ?? []).filter((p, i) => !(i === 0 && p.text === r.title));
  for (const p of passages) body.push(h("p", { class: "passage", id: `${r.id}-${p.id}` }, p.text), ...(after.get(p.id) ?? []).map((x) => plateFigure(x)));
  const files = (r.media ?? []).filter((m) => !isImage(m));
  return [
    back,
    h("p", { class: "kicker" }, r.kind),
    h("h1", {}, r.title),
    h("p", { class: "meta" }, r.credit ? `${r.credit} · ` : "", statusBadge(r)),
    body.length ? body : h("p", { class: "quiet" }, "No text held."),
    files.length ? h("p", { class: "meta" }, "Files held: ", files.map((f, i) => [i ? ", " : "", h("a", { href: mediaUrl(f) }, f.split("/").pop())])) : null,
    sourceFacts(r),
    ...anchoredBy(r.id),
    ...also(r.id),
  ];
}

function entitiesPage(slug) {
  if (!slug) {
    if (!slice.entities.length) return [h("h1", {}, "Entities"), h("p", { class: "quiet" }, "No entities yet. A name becomes one when the curator keeps it, anchored to the record that spells it.")];
    const kinds = [...new Set(slice.entities.map((e) => e.kind))];
    return [h("h1", {}, "Entities"), kinds.map((k) => [h("h2", {}, k), h("ul", { class: "list" }, slice.entities.filter((e) => e.kind === k).sort((a, b) => a.label.localeCompare(b.label)).map((e) => h("li", {}, h("a", { class: "title", href: `#/entities/${e.slug}` }, e.label), h("div", { class: "meta" }, plural((e.anchors ?? []).length, "record")))))])];
  }
  const e = slice.entities.find((x) => x.slug === slug);
  if (!e) return notFound(`No entity ${slug}.`);
  return [
    h("p", { class: "kicker" }, e.kind),
    h("h1", {}, e.label),
    (e.aliases ?? []).length ? [h("h2", {}, "Also named"), h("ul", { class: "list" }, e.aliases.map((a) => h("li", {}, a.name, (a.sources ?? []).length ? h("div", { class: "meta" }, "as written in ", a.sources.map((id, i) => [i ? ", " : "", h("a", { href: `#/records/${id}` }, byId(id)?.title ?? id)])) : null)))] : [],
    h("h2", {}, "Records that name it"),
    h("ul", { class: "list" }, (e.anchors ?? []).map((id) => { const r = byId(id); return h("li", {}, h("a", { href: `#/records/${id}` }, r?.title ?? id), r ? [" ", statusBadge(r)] : null); })),
    (slice.questions ?? []).some((q) => (q.entities ?? []).includes(e.id)) ? [h("h2", {}, "Questions"), h("ul", { class: "list" }, slice.questions.filter((q) => (q.entities ?? []).includes(e.id)).map((q) => h("li", {}, h("a", { href: `#/questions/${q.id}` }, q.title))))] : [],
  ];
}

function questionsPage(id) {
  const qs = slice.questions ?? [];
  if (!id) return [h("h1", {}, "Open questions"), qs.length ? h("ul", { class: "list" }, qs.map((q) => h("li", {}, h("a", { class: "title", href: `#/questions/${q.id}` }, q.title), h("div", { class: "meta" }, q.status)))) : h("p", { class: "quiet" }, "No questions yet.")];
  const q = qs.find((x) => x.id === id);
  if (!q) return notFound(`No question ${id}.`);
  const section = (title, text) => (text ? [h("h2", {}, title), h("p", {}, text)] : []);
  return [
    h("p", { class: "kicker" }, q.status === "answered" ? "Answered" : "Open"),
    h("h1", {}, q.title),
    ...section("What we know", q.what_we_know),
    ...section("What we don't", q.what_we_dont),
    ...section("What might answer it", q.what_might_answer_it),
    ...section("Evidence needed", q.evidence_needed),
    (q.last_known_source ?? []).length ? [h("h2", {}, "Rests on"), h("ul", { class: "list" }, q.last_known_source.map((rid) => h("li", {}, h("a", { href: `#/records/${rid}` }, byId(rid)?.title ?? rid))))] : [],
  ];
}

function evidencePage() {
  const ev = slice.evidence ?? [];
  if (!ev.length) return [h("h1", {}, "Evidence"), h("p", { class: "quiet" }, "No evidence links yet. A link is the curator's act.")];
  return [
    h("h1", {}, "Evidence"),
    h("ul", { class: "list" }, ev.map((l) => {
      const [rid] = String(l.claim?.span ?? "").replace(/^plate:/, "").split("#");
      return h("li", {}, h("blockquote", {}, l.claim?.quote ?? ""), h("div", { class: "meta" }, `${l.type} · `, h("a", { href: `#/records/${l.record}` }, byId(l.record)?.title ?? l.record), rid ? [" · quoted from ", h("a", { href: `#/records/${rid}` }, byId(rid)?.title ?? rid)] : null), l.note ? h("p", {}, l.note) : null);
    })),
  ];
}

function notFound(msg) {
  return [h("h1", {}, "Not found"), h("p", { class: "quiet" }, msg), h("p", {}, h("a", { href: "#/" }, "All records"))];
}

function route() {
  const [, section = "", id] = location.hash.replace(/^#/, "").split("/").map(decodeURIComponent);
  const nodes =
    section === "" ? recordsHome()
    : section === "records" ? recordPage(id)
    : section === "entities" ? entitiesPage(id)
    : section === "questions" ? questionsPage(id)
    : section === "both-stand" ? bothStandPage()
    : section === "evidence" ? evidencePage()
    : notFound("No such page.");
  view.replaceChildren(...[nodes].flat(Infinity).filter(Boolean));
  for (const a of document.querySelectorAll("nav a")) {
    const here = a.getAttribute("href") === `#/${section === "records" ? "" : section}`;
    here ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current");
  }
  const title = view.querySelector("h1")?.textContent;
  document.title = [title, slice.museum?.title].filter(Boolean).join(" · ");
  window.scrollTo(0, 0);
}

try {
  const res = await fetch("data/museum.json", { cache: "no-store" });
  if (!res.ok) throw new Error(String(res.status));
  slice = await res.json();
  window.addEventListener("hashchange", route);
  route();
} catch {
  view.replaceChildren(h("h1", {}, "Nothing to show yet"), h("p", { class: "quiet" }, "The public slice isn't built. Run ", h("code", {}, "npm run build"), " (or ", h("code", {}, "npm run dev"), ")."));
}
