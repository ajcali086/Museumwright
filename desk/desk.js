/**
 * The desk: the curator's side of the museum box. Every screen reads the
 * museum's state from the server; every button that changes something
 * shows the change first (the files, before and after), then writes it,
 * and the museum's own check decides whether it stays. Words from the
 * archive are set as text, never markup.
 */

const view = document.getElementById("view");
const notice = document.getElementById("notice");
let S = null; // the last state read
let queueFilter = "proposed";
let lastLog = null; // the last pull or intake's run log, kept across re-renders

/* ── small things ─────────────────────────────────────────────── */

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) if (c !== undefined && c !== null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

async function call(path, body, { method = body === undefined ? "GET" : "POST" } = {}) {
  const res = await fetch(`/desk/api/${path}`, {
    method,
    headers: method === "GET" ? {} : { "content-type": "application/json", "x-mw-desk": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({ ok: false, refusal: `The server answered ${res.status}.` }));
  // Signed out underneath (a restart, an expired session): back to the gate.
  if (res.status === 401 && path !== "state") {
    S = null;
    refresh();
  }
  return { status: res.status, ...data };
}

function say(result) {
  notice.hidden = false;
  if (result.ok === false || result.refusal) {
    notice.className = "bad";
    notice.textContent = result.refusal ?? "That didn't work.";
  } else {
    notice.className = "ok";
    notice.textContent = [result.summary, result.commit ? `committed ${result.commit}` : ""].filter(Boolean).join(" · ") || "Done.";
  }
  notice.scrollIntoView({ block: "nearest" });
}

const busy = (button, label = "Working…") => {
  const was = button.textContent;
  button.disabled = true;
  button.textContent = label;
  return () => {
    button.disabled = false;
    button.textContent = was;
  };
};

/** The name, marked where the span spells it. */
function highlighted(text, name) {
  if (text === null || text === undefined) return h("span", { class: "quiet" }, "(the span isn't in the museum)");
  if (!text) return h("span", { class: "quiet" }, "(empty)");
  const at = name ? text.indexOf(name) : -1;
  if (at < 0) return text;
  return [text.slice(0, at), h("mark", {}, name), text.slice(at + name.length)];
}

/** Lines added and removed, by the longest common run: what the repository will say. */
function lineDiff(before, after) {
  const a = before === null ? [] : before.split("\n");
  const b = after.split("\n");
  const n = a.length, m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) out.push([" ", a[i++]]), j++;
    else if (L[i + 1][j] >= L[i][j + 1]) out.push(["-", a[i++]]);
    else out.push(["+", b[j++]]);
  }
  while (i < n) out.push(["-", a[i++]]);
  while (j < m) out.push(["+", b[j++]]);
  return out.filter(([, l], k, all) => !(k === all.length - 1 && l === ""));
}

function diffView(diff) {
  return diff.map((d) =>
    h("div", { class: "diff" }, h("div", { class: "path mono" }, d.before === null ? `new file: ${d.path}` : d.path),
      h("pre", {}, lineDiff(d.before, d.after).map(([t, l]) => h("span", { class: `l${t === "+" ? " add" : t === "-" ? " del" : ""}` }, `${t} ${l}`)))),
  );
}

/**
 * Preview, then write: the change is shown in `slot`; "Write it" sends the
 * same request without `preview` and the check has the last word.
 */
async function previewThenWrite(slot, path, body, button) {
  const done = busy(button, "Reading…");
  const p = await call(path, { ...body, preview: true });
  done();
  slot.replaceChildren();
  if (p.ok === false || p.refusal) return slot.append(h("div", { class: "refusal" }, p.refusal));
  const write = h("button", { type: "button", class: "primary", onclick: async () => {
    const d = busy(write, "Writing…");
    const r = await call(path, body);
    d();
    say(r);
    if (r.ok !== false) await refresh();
    else slot.append(h("div", { class: "refusal" }, r.refusal));
  } }, "Write it");
  slot.append(h("p", { class: "meta" }, p.summary), ...diffView(p.diff), h("div", { class: "actions" }, write, h("button", { type: "button", onclick: () => slot.replaceChildren() }, "Cancel")));
}

/* ── the gate ─────────────────────────────────────────────────── */

function gate(configured) {
  document.getElementById("bar").hidden = true;
  const form = h("form", { class: "card" },
    configured
      ? [h("h1", {}, "Sign in to the desk"), h("p", { class: "quiet" }, "Visitors see the museum; the desk is the curator's.")]
      : [h("h1", {}, "Set up the desk"), h("p", { class: "quiet" }, "The server printed a setup code in its console when it started. Type it here once, with the passcode the desk will ask for from now on.")],
    configured ? null : h("label", { class: "field" }, h("span", {}, "Setup code"), h("input", { type: "text", name: "code", autocomplete: "off", required: true })),
    h("label", { class: "field" }, h("span", {}, configured ? "Passcode" : "Choose a passcode (eight characters or more)"), h("input", { type: "password", name: "passcode", autocomplete: configured ? "current-password" : "new-password", required: true })),
    h("label", { class: "field" }, h("span", {}, "Your name (decisions are recorded under it)"), h("input", { type: "text", name: "name", autocomplete: "name", required: true, value: localStorageGet("mw-name") })),
    h("div", { class: "actions" }, h("button", { type: "submit", class: "primary" }, configured ? "Sign in" : "Set up")),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    localStorageSet("mw-name", f.get("name"));
    const r = await call(configured ? "login" : "setup", Object.fromEntries(f));
    if (r.ok === false) return say(r);
    notice.hidden = true;
    await refresh();
  });
  view.className = "narrow";
  view.replaceChildren(form);
}

function localStorageGet(k) {
  try { return localStorage.getItem(k) ?? ""; } catch { return ""; }
}
function localStorageSet(k, v) {
  try { localStorage.setItem(k, v); } catch { /* a private window: fine */ }
}

/* ── creating the museum ──────────────────────────────────────── */

function create() {
  const fresh = h("form", { class: "card" },
    h("h2", {}, "Start a new museum"),
    h("p", { class: "meta" }, "Generated from the Museumwright structure: empty, correct, checked. Its history starts on this box."),
    h("label", { class: "field" }, h("span", {}, "Name"), h("input", { type: "text", name: "name", required: true, placeholder: "The Mill Museum" })),
    h("label", { class: "field" }, h("span", {}, "Title, if different"), h("input", { type: "text", name: "title" })),
    h("label", { class: "field" }, h("span", {}, "GitHub repository for it, if any (owner/name)"), h("input", { type: "text", name: "repo", placeholder: "you/mill-museum" })),
    h("div", { class: "actions" }, h("button", { type: "submit", class: "primary" }, "Create the museum")),
  );
  fresh.addEventListener("submit", async (e) => {
    e.preventDefault();
    const b = e.submitter;
    const done = busy(b, "Creating…");
    const r = await call("create", { mode: "new", ...Object.fromEntries(new FormData(fresh)) });
    done();
    say(r);
    if (r.ok !== false) await refresh();
  });
  const clone = h("form", { class: "card" },
    h("h2", {}, "Bring one from GitHub"),
    h("p", { class: "meta" }, "A museum repository made with mw (needs the web, once)."),
    h("label", { class: "field" }, h("span", {}, "Repository (owner/name, or a git URL)"), h("input", { type: "text", name: "repo", required: true })),
    h("label", { class: "field" }, h("span", {}, "Token, for a private repository or to push later"), h("input", { type: "password", name: "token", autocomplete: "off" })),
    h("div", { class: "actions" }, h("button", { type: "submit" }, "Bring it here")),
  );
  clone.addEventListener("submit", async (e) => {
    e.preventDefault();
    const done = busy(e.submitter, "Cloning…");
    const r = await call("create", { mode: "clone", ...Object.fromEntries(new FormData(clone)) });
    done();
    say(r);
    if (r.ok !== false) await refresh();
  });
  return [h("h1", {}, "No museum here yet"), h("p", { class: "quiet" }, `It will live in ${S.path}.`), h("div", { class: "grid2" }, fresh, clone)];
}

/* ── the queue: the home screen ───────────────────────────────── */

function queue() {
  const groups = { proposed: (q) => q.status === "proposed", held: (q) => q.status === "held", decided: (q) => !["proposed", "held"].includes(q.status) };
  const rows = S.queue.filter(groups[queueFilter]);
  const tabs = h("div", { class: "tabs" }, Object.keys(groups).map((g) =>
    h("button", { type: "button", "aria-pressed": String(queueFilter === g), onclick: () => { queueFilter = g; render(); } },
      `${g === "proposed" ? "Waiting" : g === "held" ? "Held back" : "Decided"} (${S.queue.filter(groups[g]).length})`)));
  const bulkSlot = h("div");
  const selected = new Set();
  const bulk = h("div", { class: "actions" },
    h("button", { type: "button", onclick: (e) => selected.size && previewThenWrite(bulkSlot, "decide", { ids: [...selected], status: "held" }, e.currentTarget) }, "Hold back selected"),
    h("button", { type: "button", class: "danger", onclick: (e) => selected.size && previewThenWrite(bulkSlot, "decide", { ids: [...selected], status: "rejected" }, e.currentTarget) }, "Reject selected"),
  );
  const list = rows.map((q) => {
    const slot = h("div");
    const box = h("input", { type: "checkbox", "aria-label": `Select ${q.proposed_text}`, onchange: (e) => (e.target.checked ? selected.add(q.id) : selected.delete(q.id)) });
    const open = q.status === "proposed" || q.status === "held";
    const src = q.source ?? {};
    return h("article", { class: "row", id: q.id },
      open ? box : h("span"),
      h("div", {},
        h("div", {}, h("span", { class: "name" }, q.proposed_text), q.entity_kind ? h("span", { class: "chip" }, q.entity_kind) : null, h("span", { class: "chip" }, q.kind ?? "text"),
          h("span", { class: `chip${q.status === "accepted" ? " good" : q.status === "rejected" ? " bad" : ""}` }, q.status), h("span", { class: "meta" }, ` ${q.id}`)),
        h("blockquote", { class: "span" }, highlighted(q.span.text, q.kind === "name" ? q.proposed_text : null)),
        h("div", { class: "meta" }, `${q.span.kind === "caption" ? "Caption of" : "Passage of"} `, h("a", { href: `#/records/${q.span.record}` }, q.span.recordTitle ?? q.span.record), ` (${q.span.key}) · noticed by ${q.proposed_by}${src.model ? ` with ${src.model}` : ""} on ${q.date}`,
          q.decided_by ? ` · ${q.status} by ${q.decided_by} on ${q.decided_on}` : ""),
        q.kind === "name" && !q.holds ? h("div", { class: "refusal" }, `The span rule: ${q.span.key} doesn't contain “${q.proposed_text}”, so it can't be kept.`) : null,
        open && q.kind === "name"
          ? h("div", { class: "actions" },
              h("button", { type: "button", class: "primary", disabled: !q.holds, onclick: () => keepPanel(slot, q) }, "Keep…"),
              q.status === "proposed" ? h("button", { type: "button", onclick: (e) => previewThenWrite(slot, "decide", { ids: [q.id], status: "held" }, e.currentTarget) }, "Hold back") : null,
              h("button", { type: "button", class: "danger", onclick: (e) => previewThenWrite(slot, "decide", { ids: [q.id], status: "rejected" }, e.currentTarget) }, "Reject"))
          : null,
        slot,
      ),
    );
  });
  return [
    h("h1", {}, "Queue"),
    h("p", { class: "quiet" }, "Names the machine noticed, each in the span that spells it. A proposal is not an entity: keep it, hold it back, or reject it. Nothing here reaches the museum's visitors."),
    tabs,
    queueFilter === "decided" || !rows.length ? null : [bulk, bulkSlot],
    rows.length ? list : h("p", { class: "quiet" }, queueFilter === "proposed" ? "Nothing is waiting. Add a page or files, with names proposed, to fill the queue." : "Nothing here."),
  ];
}

function keepPanel(slot, q) {
  const existing = S.entities.slice().sort((a, b) => a.label.localeCompare(b.label));
  const out = h("div");
  const form = h("form", { class: "panel" },
    h("label", { class: "check" }, h("input", { type: "radio", name: "mode", value: "new", checked: true }), "A new entity"),
    h("div", { class: "grid2" },
      h("label", { class: "field" }, h("span", {}, "Name as shown (as the record spells it)"), h("input", { type: "text", name: "label", value: q.proposed_text })),
      h("label", { class: "field" }, h("span", {}, "Kind"), h("select", { name: "kind" }, ["person", "family", "place", "organization", "event"].map((k) => h("option", { value: k, selected: k === (q.entity_kind ?? "person") }, k))))),
    existing.length ? [h("label", { class: "check" }, h("input", { type: "radio", name: "mode", value: "existing" }), "Another name of an entity the museum has"),
      h("label", { class: "field" }, h("select", { name: "entity" }, existing.map((e) => h("option", { value: e.id }, `${e.label} (${e.kind})`))))] : null,
    h("div", { class: "actions" }, h("button", { type: "submit", class: "primary" }, "Show the change"), h("button", { type: "button", onclick: () => slot.replaceChildren() }, "Cancel")),
    out,
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const as = f.get("mode") === "existing" ? { mode: "existing", entity: f.get("entity") } : { mode: "new", label: f.get("label"), kind: f.get("kind") };
    previewThenWrite(out, "keep", { id: q.id, as }, e.submitter);
  });
  slot.replaceChildren(form);
}

/* ── adding to the archive ────────────────────────────────────── */

function add() {
  const log = h("pre", { class: "log", hidden: !lastLog }, lastLog ?? "");
  const showLog = (r) => {
    say(r);
    if (r.log?.length) lastLog = r.log.join("\n");
  };
  const pull = h("form", { class: "card" },
    h("h2", {}, "Pull a page from the web"),
    h("p", { class: "meta" }, "The page's text becomes a document record, each image a plate with its caption as written (or none), all unverified. Needs the web."),
    h("label", { class: "field" }, h("span", {}, "Page address"), h("input", { type: "url", name: "url", required: true, placeholder: "https://…" })),
    h("label", { class: "check" }, h("input", { type: "checkbox", name: "propose", checked: true }), "Propose names with the local model"),
    h("label", { class: "field" }, h("span", {}, "Local model (llama.cpp server)"), h("input", { type: "text", name: "modelUrl", value: S.modelUrl })),
    h("div", { class: "actions" }, h("button", { type: "submit", class: "primary" }, "Pull it in")),
  );
  pull.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(pull);
    const done = busy(e.submitter, "Pulling… (a page with many images takes a while)");
    const r = await call("pull", { url: f.get("url"), propose: f.get("propose") === "on", modelUrl: f.get("modelUrl") });
    done();
    showLog(r);
    if (r.ok !== false) await refresh(false);
  });

  const files = h("input", { type: "file", multiple: true, name: "files" });
  const camera = h("input", { type: "file", accept: "image/*", capture: "environment", name: "camera" });
  const picked = h("ul", { class: "files" });
  const notes = new Map();
  const chosen = () => [...files.files, ...camera.files];
  const listPicked = () => picked.replaceChildren(...chosen().map((f) =>
    h("li", {}, h("span", { class: "mono" }, `${f.name} (${Math.ceil(f.size / 1024)} KB)`),
      h("input", { type: "text", placeholder: "What this is (a dated note on its record, not a caption)", value: notes.get(f.name) ?? "", oninput: (e) => notes.set(f.name, e.target.value) }))));
  files.addEventListener("change", listPicked);
  camera.addEventListener("change", listPicked);
  const proposeFiles = h("input", { type: "checkbox", name: "propose" });
  const upload = h("form", { class: "card" },
    h("h2", {}, "Add files, or capture with a phone"),
    h("p", { class: "meta" }, "Images become plates; a PDF's text layer becomes passages and its scanned pages plates, never guessed at; text files become documents. Works offline. On a phone, “Take a photo” opens the camera."),
    h("label", { class: "field" }, h("span", {}, "Files"), files),
    h("label", { class: "field" }, h("span", {}, "Take a photo"), camera),
    picked,
    h("label", { class: "check" }, proposeFiles, "Propose names in their text with the local model"),
    h("div", { class: "actions" }, h("button", { type: "submit", class: "primary" }, "Take them in")),
  );
  upload.addEventListener("submit", async (e) => {
    e.preventDefault();
    const list = chosen();
    if (!list.length) return say({ ok: false, refusal: "Choose a file or take a photo first." });
    const intake = Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(16).padStart(2, "0")).join("");
    const done = busy(e.submitter, "Uploading…");
    for (const [i, f] of list.entries()) {
      e.submitter.textContent = `Uploading ${i + 1} of ${list.length}…`;
      const res = await fetch(`/desk/api/upload?intake=${intake}&name=${encodeURIComponent(f.name)}`, { method: "POST", headers: { "x-mw-desk": "1" }, body: f, credentials: "same-origin" });
      if (!res.ok) {
        done();
        return say(await res.json().catch(() => ({ ok: false, refusal: `Upload failed (${res.status}).` })));
      }
    }
    e.submitter.textContent = "Taking them in…";
    const r = await call("ingest", { intake, propose: proposeFiles.checked, notes: Object.fromEntries(notes) });
    done();
    showLog(r);
    if (r.ok !== false) {
      upload.reset();
      notes.clear();
      picked.replaceChildren();
      await refresh(false);
    }
  });
  return [h("h1", {}, "Add to the archive"), h("div", { class: "grid2" }, pull, upload), log];
}

/* ── records ──────────────────────────────────────────────────── */

function records(id) {
  if (id) return record(id);
  const unanchored = new Set(S.unanchored);
  return [
    h("h1", {}, `Records (${S.records.length})`),
    S.records.length
      ? h("table", { class: "list" }, h("thead", {}, h("tr", {}, ["", "ID", "What", "Status", "Caption"].map((t) => h("th", {}, t)))),
          h("tbody", {}, S.records.map((r) => h("tr", {},
            h("td", {}, (r.media ?? []).find((m) => /\.(jpe?g|png|gif|webp|avif)$/i.test(m)) ? h("img", { class: "thumb", src: r.media.find((m) => /\.(jpe?g|png|gif|webp|avif)$/i.test(m)), alt: "", loading: "lazy" }) : ""),
            h("td", { class: "mono" }, h("a", { href: `#/records/${r.id}` }, r.id)),
            h("td", {}, r.title, h("div", { class: "meta" }, r.kind, r.passageCount ? ` · ${r.passageCount} passages` : "", unanchored.has(r.id) ? " · names nothing yet" : "")),
            h("td", {}, h("span", { class: `chip${r.status === "verified" ? " good" : ""}` }, r.status)),
            h("td", { class: "meta" }, r.kind === "image" ? r.caption || "(no caption)" : "")))))
      : h("p", { class: "quiet" }, "No records yet. Add a page or files."),
  ];
}

function record(id) {
  const r = S.records.find((x) => x.id === id);
  if (!r) return [h("h1", {}, "Not found"), h("p", {}, `No record ${id}.`)];
  const img = (r.media ?? []).find((m) => /\.(jpe?g|png|gif|webp|avif)$/i.test(m));
  const names = S.entities.filter((e) => (e.anchors ?? []).includes(r.id));
  const slot = h("div");
  const statusForm = h("form", { class: "panel" },
    h("label", { class: "field" }, h("span", {}, r.status === "verified" ? "Why it is no longer verified" : "Why the copy is verified: where it came from, who confirmed it"), h("textarea", { name: "note", required: true })),
    h("div", { class: "actions" }, h("button", { type: "submit", class: "primary" }, r.status === "verified" ? "Mark unverified…" : "Mark verified…")),
  );
  statusForm.addEventListener("submit", (e) => {
    e.preventDefault();
    previewThenWrite(slot, "status", { id: r.id, status: r.status === "verified" ? "unverified" : "verified", note: new FormData(statusForm).get("note") }, e.submitter);
  });
  const noteForm = h("form", { class: "panel" },
    h("label", { class: "field" }, h("span", {}, "A dated note on this record"), h("textarea", { name: "note", required: true })),
    h("div", { class: "actions" }, h("button", { type: "submit" }, "Add the note…")),
  );
  noteForm.addEventListener("submit", (e) => {
    e.preventDefault();
    previewThenWrite(slot, "note", { id: r.id, note: new FormData(noteForm).get("note") }, e.submitter);
  });
  const src = r.source ?? {};
  return [
    h("p", { class: "meta" }, h("a", { href: "#/records" }, "Records"), " / ", r.id),
    h("h1", {}, r.title),
    img ? h("img", { class: "big", src: img, alt: r.alt || r.caption || r.title }) : null,
    h("dl", { class: "facts" },
      [["Kind", r.kind], ["Status", r.status], ["Caption", r.kind === "image" ? r.caption || "(none given)" : undefined], ["Credit", r.credit || undefined], ["Found in", r.found_in ? h("a", { href: `#/records/${r.found_in}` }, r.found_in) : undefined],
        ["Passages", r.passageCount || undefined], ["From", src.url ?? src.file], ["Taken", src.extracted_at], ["Files", (r.media ?? []).map((m, i) => [i ? ", " : "", h("a", { href: m, target: "_blank", rel: "noopener" }, m.split("/").pop())])],
        ["Names", names.length ? names.map((e, i) => [i ? ", " : "", h("a", { href: `#/entities/${e.slug}` }, e.label)]) : "nothing yet"]]
        .filter(([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && !v.length))
        .flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])),
    (r.notes ?? []).length ? [h("h2", {}, "Notes"), h("ul", {}, r.notes.map((n) => h("li", {}, h("span", { class: "meta" }, `${n.date} `), n.note)))] : null,
    r.held ? statusForm : null,
    noteForm,
    slot,
  ];
}

/* ── entities ─────────────────────────────────────────────────── */

function entities(slug) {
  const byId = new Map(S.records.map((r) => [r.id, r]));
  if (slug) {
    const e = S.entities.find((x) => x.slug === slug);
    if (!e) return [h("h1", {}, "Not found")];
    return [
      h("p", { class: "meta" }, h("a", { href: "#/entities" }, "Entities"), " / ", e.slug),
      h("h1", {}, e.label, h("span", { class: "chip" }, e.kind)),
      h("dl", { class: "facts" }, h("dt", {}, "ID"), h("dd", { class: "mono" }, e.id), h("dt", {}, "Also named"), h("dd", {}, (e.aliases ?? []).map((a) => a.name).join(", ") || "—")),
      h("h2", {}, "Anchored by"),
      h("ul", {}, (e.anchors ?? []).map((id) => h("li", {}, h("a", { href: `#/records/${id}` }, byId.get(id)?.title ?? id), " ", h("span", { class: "meta mono" }, id)))),
      h("h2", {}, "Kept from"),
      h("ul", {}, S.queue.filter((q) => q.status === "accepted" && (q.proposed_text === e.label || (e.aliases ?? []).some((a) => a.name === q.proposed_text))).map((q) => h("li", {}, `“${q.proposed_text}” in ${q.target}, kept by ${q.decided_by} on ${q.decided_on}`))),
    ];
  }
  return [
    h("h1", {}, `Entities (${S.entities.length})`),
    S.entities.length
      ? h("table", { class: "list" }, h("thead", {}, h("tr", {}, ["Name", "Kind", "Anchored by"].map((t) => h("th", {}, t)))),
          h("tbody", {}, S.entities.slice().sort((a, b) => a.label.localeCompare(b.label)).map((e) => h("tr", {},
            h("td", {}, h("a", { href: `#/entities/${e.slug}` }, e.label)), h("td", {}, e.kind),
            h("td", {}, (e.anchors ?? []).map((id, i) => [i ? ", " : "", h("a", { class: "mono", href: `#/records/${id}` }, id)]))))))
      : h("p", { class: "quiet" }, "None yet. An entity is a name kept from the queue, anchored to the record that spells it."),
    h("h2", {}, `Naming nothing yet (${S.unanchored.length})`),
    h("p", { class: "meta" }, "Records no entity is anchored to: the next work."),
    S.unanchored.length ? h("ul", {}, S.unanchored.map((id) => h("li", {}, h("a", { href: `#/records/${id}` }, byId.get(id)?.title ?? id), " ", h("span", { class: "meta mono" }, id)))) : h("p", { class: "quiet" }, "Every record names something."),
  ];
}

/* ── check, sync, IDs ─────────────────────────────────────────── */

function checkDesk() {
  const run = h("button", { type: "button", class: "primary", onclick: async () => {
    const done = busy(run, "Checking…");
    await refresh(false);
    done();
  } }, "Run the check again");
  return [
    h("h1", {}, "Check"),
    h("p", { class: "quiet" }, "The museum's own check:model, the same refusal CI runs. Every desk write passes it or is taken back."),
    S.check.ok ? h("p", { class: "card" }, "✓ The model check passes.") : [h("p", { class: "refusal" }, `The check finds ${S.check.problems.length} problem${S.check.problems.length === 1 ? "" : "s"}:`), h("ul", {}, S.check.problems.map((p) => h("li", {}, p)))],
    h("div", { class: "actions" }, run),
  ];
}

function sync() {
  const g = S.git;
  const remote = h("form", { class: "card" },
    h("h2", {}, "GitHub"),
    h("label", { class: "field" }, h("span", {}, "Repository (owner/name, or a git URL)"), h("input", { type: "text", name: "repo", value: g.repo ?? "", required: true })),
    h("label", { class: "field" }, h("span", {}, g.token ? "Token (one is saved; leave empty to keep it)" : "Token (repo scope)"), h("input", { type: "password", name: "token", autocomplete: "off" })),
    h("div", { class: "actions" }, h("button", { type: "submit" }, "Save")),
  );
  remote.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(remote));
    if (!f.token) delete f.token;
    const r = await call("remote", f);
    say(r);
    await refresh(false);
  });
  const act = (action, label) => h("button", { type: "button", class: action === "push" ? "primary" : "", disabled: !g.repo, onclick: async (e) => {
    const done = busy(e.currentTarget, action === "push" ? "Sending…" : "Taking…");
    const r = await call("sync", { action });
    done();
    say(r);
    await refresh(false);
  } }, label);
  const discard = h("button", { type: "button", class: "danger", onclick: async (e) => {
    if (!confirm("Throw away every change no commit holds?")) return;
    const r = await call("discard", {});
    say(r);
    await refresh(false);
  } }, "Discard them");
  return [
    h("h1", {}, "Sync"),
    h("p", { class: "quiet" }, "Every desk write is a commit on this box, web or no web. When the web is here, the box and GitHub trade commits. Publishing is yours to do: nothing is sent on its own."),
    h("div", { class: "grid2" },
      remote,
      h("div", { class: "card" }, h("h2", {}, "The box and GitHub"),
        h("p", {}, g.remote ? [h("span", { class: "mono" }, g.remote), h("br"), g.ahead === null ? "Not compared yet: take GitHub's commits once." : `${g.ahead} to send · ${g.behind} to take`] : "No GitHub repository yet."),
        h("div", { class: "actions" }, act("pull", "Take GitHub's commits"), act("push", "Send the box's commits")))),
    g.dirty.length ? [h("h2", {}, "Changes no commit holds"), h("pre", { class: "log" }, g.dirty.join("\n")), discard] : null,
    h("h2", {}, "History"),
    h("table", { class: "list" }, h("tbody", {}, g.log.map((c) => h("tr", {}, h("td", { class: "mono" }, c.hash), h("td", {}, c.subject), h("td", { class: "meta" }, `${c.author} · ${c.date.slice(0, 16).replace("T", " ")}`))))),
  ];
}

function ids() {
  const { record, correction, claims, tombstones } = S.ids;
  return [
    h("h1", {}, "IDs & export"),
    h("dl", { class: "facts" },
      h("dt", {}, "Next record ID"), h("dd", { class: "mono" }, record ? `${record.prefix}${String(record.next).padStart(record.width ?? 4, "0")}` : "—"),
      h("dt", {}, "Next proposal ID"), h("dd", { class: "mono" }, correction ? `${correction.prefix}${String(correction.next).padStart(correction.width ?? 4, "0")}` : "—"),
      h("dt", {}, "Inputs claimed"), h("dd", {}, String(claims)),
      h("dt", {}, "Questions · evidence links"), h("dd", {}, `${S.questions} · ${S.evidence}`)),
    h("h2", {}, `Tombstones (${tombstones.length})`),
    tombstones.length ? h("ul", {}, tombstones.map((t) => h("li", {}, h("span", { class: "mono" }, t.id), ` · ${t.date} · ${t.reason}`))) : h("p", { class: "quiet" }, "No ID has been retired."),
    h("h2", {}, "Export"),
    h("p", { class: "quiet" }, "The museum as committed, every file, as one archive: the preservation copy."),
    h("a", { href: "/desk/api/export", download: true }, h("button", { type: "button", class: "primary" }, "Download the export (.tar.gz)")),
  ];
}

/* ── routing ──────────────────────────────────────────────────── */

async function refresh(go = true) {
  const s = await call("session");
  if (!s.who) {
    S = null;
    return gate(s.configured);
  }
  const st = await call("state");
  if (st.status === 401) {
    S = null;
    return gate(true);
  }
  S = st;
  if (go) await route();
  else render();
}

function render() {
  if (!S) return;
  document.getElementById("bar").hidden = !S.museum;
  view.className = "";
  if (!S.museum) {
    view.replaceChildren(...[create()].flat(Infinity).filter(Boolean));
    return;
  }
  const [, tab = "queue", arg] = location.hash.replace(/^#/, "").split("/").map(decodeURIComponent);
  document.getElementById("museum-title").textContent = S.museum.title;
  document.getElementById("who").textContent = S.who;
  document.getElementById("queue-count").textContent = String(S.queue.filter((q) => q.status === "proposed").length || "");
  const dot = document.getElementById("check-dot");
  dot.className = `dot ${S.check.ok ? "ok" : "bad"}`;
  dot.title = S.check.ok ? "The check passes" : "The check finds problems";
  for (const a of document.querySelectorAll("#nav a")) a.dataset.tab === tab ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current");
  const screens = { queue, add, records, entities, check: checkDesk, sync, ids };
  const nodes = (screens[tab] ?? queue)(arg);
  view.replaceChildren(...[nodes].flat(Infinity).filter(Boolean));
  document.title = `${tab[0].toUpperCase()}${tab.slice(1)} · ${S.museum.title} · Desk`;
}

async function route() {
  if (!S) return refresh();
  render();
}

document.getElementById("sign-out").addEventListener("click", async () => {
  await call("logout", {});
  S = null;
  notice.hidden = true;
  await refresh();
});
window.addEventListener("hashchange", () => {
  notice.hidden = true;
  render();
});
refresh();
