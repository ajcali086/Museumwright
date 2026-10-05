# Museumwright starter — `mw`

A converter that writes the folders a museum's admin already edits. Not a
database, not a theme, not a service, not a second admin. **Sveltia
collects. The pipeline validates.** `mw` writes files; `check:model`
refuses bad saves; CI runs the check before merge.

Built to the Starter Spec v2 (2026-10-04). The structure it generates was
learned from [The Spirit of Martinez](https://github.com/ajcali086/spirit-of-martinez)'s
workbench and the Angie pilot.

## Install, and the five commands

```bash
npm install -g github:ajcali086/Museumwright-     # puts mw on the PATH
mw doctor                                        # first: is this box ready?
```

```
mw new            start a museum (asks a few questions)
mw pull <url>     bring in a web page
mw add <folder>   bring in files: photos, PDFs, text
mw desk           open the curator's desk on this box's network
mw sync           trade commits with GitHub

mw doctor         check this box has what mw needs
```

No flags are needed: each has a default, and `mw <command> --help` shows
examples first. A refusal is said in plain words, with what to do next;
`--verbose` shows the rest. `npx github:ajcali086/Museumwright- <command>`
works without installing.

- **`mw new`** asks the museum's name, title and GitHub repository, lists
  every file it will write, and asks before writing them. It then runs
  init's steps and ends with the check green. Passing a name, `--repo` and
  `--yes` skips the questions, for scripts.
- **`mw pull`** proposes names on its own when a local model answers at
  `MW_MODEL_URL` (default `http://127.0.0.1:8080`). With no model it says
  so in one line and goes on (`--no-propose` to skip asking).
- **`mw pull` and `mw add`, in a museum with a git history,** commit what
  the check lets stand, as the desk does. If the check refuses, nothing is
  kept.
- **`mw desk`** serves this folder's museum, or creates one at `./museum`
  from the desk. It prints the network addresses and, on first run, the
  setup code, and stays up until Ctrl+C.
- **`mw sync`** only fast-forwards, and says which happened: sent, took,
  already in step, or "both sides moved", with the commands that settle
  it.
- **`mw doctor`** checks Node.js (22.6+), git, poppler, the local model,
  free disk and the museum here (its check, its GitHub remote). For
  anything missing, it prints the command that fixes it.

The older names still work for scripts: `init`, `batch`, `serve`. In a
checkout of this repository, run `npm ci` and then `bin/mw.mjs …`.

Node 22.6 or later (type stripping). `batch` reads PDFs with poppler
(`pdfinfo`, `pdftotext`, `pdftoppm`).

## `mw serve`: the museum box

One server for a museum that runs on its own box on a LAN, with or
without the web:

```bash
npx github:ajcali086/Museumwright- serve --museum ./museum --port 8080
```

- **`/`, for visitors:** the museum's viewer over its public slice, and the
  files it shows. Read-only, no sign-in. Before a museum exists, a page
  saying one is being set up.
- **`/desk/`, for the curator:** the museum's own admin, with no GitHub
  and no Sveltia needed. It builds the archive from nothing, in three
  stages.
  1. **Collection.** Create a museum (the same `mw init`, verified the
     same way), or bring one in from GitHub. Then add to it:
     - a page from the web (`mw pull`, with names proposed by the local
       model if one is running);
     - files from the box or a phone's camera (`mw batch`). An optional
       "what this is" becomes a dated note, never a caption.
  2. **Archival work.** Every collection, edited at the desk:
     - **Queue** (the home screen): proposed names, each marked in the span
       that spells it. Keep one as a new entity or as another name of an
       existing one, hold it back, or reject it, singly or in bulk. Text
       corrections are accepted, then applied.
     - **Records:** catalogue one by hand (something the museum knows of,
       its ID from the sequence). Edit a title or rights holder. Propose a
       correction to any passage or caption. Change a status with a dated
       note. Retire a record: its ID goes on the tombstones, its files go,
       and the check refuses while anything still points at it.
     - **Entities:** make or edit one, with its anchors and the other names
       it goes by, each with the records that write it so. Also listed:
       the records that name nothing yet.
     - **Questions:** open or edit one. It closes only on evidence.
     - **Evidence:** link a claim to a record. The quote must be in its
       span word for word, and links are appended, never rewritten.
     - **Check:** `check:model` in plain lines.
  3. **Site.** What visitors see now, beside what only the desk sees.
     Also here: GitHub, which is optional, and IDs & export.

  A source's words (a pulled record's caption, credit and passages) are
  never edited in place. They change only by a correction that is
  proposed, accepted and applied. An applied correction keeps the words it
  replaced, and the check holds that the span then reads as corrected.

Every change at the desk is shown first: the files it will write, before
and after. Then it is written, and the museum's own `check:model` decides.
If the check refuses, the files are put back and the refusal is the
answer. If it passes, the public slice is rebuilt and the change is one
git commit on the box, in the curator's name. The span rule holds at the
desk too: a name its span doesn't contain can't be kept, and the refusal
quotes the span.

**Offline and online.** The box keeps the museum's history in git, so
nothing waits on the web. When the web is there, Sync sends the box's
commits to GitHub and takes GitHub's (Sveltia's saves, say). It only ever
fast-forwards: if both sides have moved on, it says so and merges
nothing. Publishing is the curator's act; nothing is sent on its own. A
token, if given, is kept in the state directory and passed to git per
command, never written into the repository.

**Who gets in.** On first start the server prints a one-time setup code
to its own console. Whoever can read that console sets the desk's
passcode, so the first person to reach the box over the LAN can't claim
it. The passcode is kept as a scrypt hash in a state directory outside the
museum's repository (`--state`, default
`~/.local/state/museumwright/<id>/`). Sign-in is a session cookie
(HttpOnly, SameSite=Strict, 12 hours, gone on restart), and each decision
records the name typed at sign-in. Desk writes must carry a header no
cross-site form can send. Missed passcodes slow down the next attempt.

**On the box:** Node 22.6+, git, poppler-utils for PDFs, and, for proposed
names, llama.cpp's `llama-server` with Qwen3-1.7B (`--model-url`,
default `http://127.0.0.1:8080`). Run `serve` on another port, for example
`--port 80`. To keep it running, use a systemd unit or similar, with
`WorkingDirectory` set to where the museum should live.

This is the "box track" the App Spec v1 deferred ("no local-git backend
in v1"): Sveltia can't run without GitHub and unpkg, so on an offline box
the desk is the editor. Sveltia at `/admin` still works for the same
repository on GitHub, and the two never disagree: there is one set of
folders, and Sync carries commits both ways.

## `mw init`: generated, not stripped

The new repository is written bottom-up from [`structure/`](structure),
the structure definition, never by forking a museum and deleting its
content. Each step is verified before the next, and init stops at the
first that fails:

1. **folders**: `src/model/{records,entities,questions}`, `evidence.json`,
   `src/data/corrections`, `public/images/uploads`, `meta/`; empty.
2. **config**: `src/cms/config.yml` with the universal collections only:
   corrections, records, entities, questions, evidence.
3. **workbench**: `public/admin` (Sveltia 0.227.2, pinned, as Spirit's),
   `scripts/cms-build.ts`, `scripts/lib/cms.ts`, `scripts/check-model.ts`,
   CI; the backend is GitHub, token auth, branch `main`, at `--repo`.
4. **sequences**: `meta/sequences.json`, `meta/tombstones.json`.
5. **verify**: `check:model` passes on the empty museum.
6. **purity**: a grep for the content markers of the museums this was
   learned from (`src/purity.ts`) over every file written. The new
   museum's own name, title and repository are taken out first, since the
   person typed them. The tests run the same grep over `structure/`.

Then `npm install` (and the CMS build, to show the config builds) and a
first commit on `main`, unless `--no-install` / `--no-git`.

## What `pull` and `batch` write

| Collection  | Folder                  | Writes                                                      |
|-------------|-------------------------|-------------------------------------------------------------|
| Records     | `src/model/records`     | One per image or document, status `unverified`. Caption and credit verbatim, or empty |
| Entities    | `src/model/entities`    | Nothing                                                      |
| Questions   | `src/model/questions`   | Nothing                                                      |
| Evidence    | `src/model/evidence.json` | Nothing                                                    |
| Corrections | `src/data/corrections`  | Nothing, unless `--propose`                                  |
| Media       | `public/images/uploads` | The files fetched, named for their record                   |

- **pull**: the page is a `document` record, its text as passages
  (`p1`, `p2`, …); each image it shows is an `image` record, `found_in`
  the page, with its position and the passage it follows. Extraction is
  readability-style (`src/extract.ts`): the content root is the deepest
  element holding nearly all the page's prose; navigation, headers,
  footers, share bars, ads, newsletter boxes and comments fall away. A
  caption is what the page marks as one (`figcaption`, or a caption
  element right after the image); a credit is what the caption marks as
  one (`cite`, `small`, a `credit` class). Otherwise each is empty. A
  `srcset` is followed to its widest file within `--max-width` (default
  3000). Tracking pixels and repeats are left out.
- **The skipped-content log** is kept as a `log` record: every piece
  dropped, where it was, its text. `--no-skip-log` makes it silent (the
  open question in §9).
- **batch**: images are `image` records; a PDF is a `document` record
  with its text layer as passages (`p<page>-<n>`), and each page without
  one is rendered and becomes an `image` record found in it, never OCR'd;
  `.txt`, `.md` and `.log` files are documents. Each file is held. Anything
  else is logged as skipped.

### IDs

Claimed once, from `meta/sequences.json`, at the end of the run, after
everything is planned (`src/repo.ts`). Each input is keyed by a hash of
what makes it that input (the page URL and its text; an image's bytes and
caption; a file's bytes), and `claims` maps that hash to its ID, so:

- a re-run over the same input claims nothing and rewrites nothing, even
  a record the curator has since edited;
- the same input in a fresh museum gets the same IDs;
- a tombstoned ID (`meta/tombstones.json`) is never reissued, and its
  input is not re-created.

## What the machine may propose

Proposal Kinds Spec v1. **The machine proposes, the human disposes.** The
local model writes nothing but proposals in the queue
(`src/data/corrections`, status `proposed`), and the curator keeps each
one or holds it back.

Every proposal cites its spans: the words it stands on, quoted.
**No citation, no acceptance.** A proposal whose quote isn't in its span,
word for word, is dropped before it is written; `check:model` refuses one
that reaches the queue anyway, and the desk refuses to keep it, quoting
the span.

| Kind | What it says | Kept, it becomes | Held back, it means |
|---|---|---|---|
| `name` | a name, as a span spells it | an entity anchored to that record | not an entity (yet) |
| `contradiction` | two claims in conflict, each cited | a **Both Stand** entry: both claims, neither resolved | a considered non-conflict |
| `question` | something missing, raised by a record | an open question; it closes only on evidence | not asked |
| `gap` | a hole in a chain: both ends cited, what's missing between | an open question against the record | not asked |
| `duplicate` | two records that may be one thing twice | a merge pending at the desk. The merge itself is the curator's act: one record retired, a dated note on the other | the two are distinct |
| `link` | a shared name, place or date, cited on both sides | a quiet door ("Also") between the two records | never rendered |
| `text` | a correction, the span as it should read | accepted, then applied; the old words kept | unchanged |

No kind proposes a deletion, a merge, a publication or a change to the
config.

**The worker** is Qwen3-1.7B (Apache 2.0), GGUF Q4_K_M, under llama.cpp:

```bash
llama-server -hf Qwen/Qwen3-1.7B-GGUF:Q4_K_M --port 8080
mw pull <url>        # proposes on its own when the model answers (MW_MODEL_URL, --model-url)
```

Each kind has its own prompt and a GBNF grammar that allows only that
kind's fields (`src/propose.ts`, `src/kinds.ts`), at temperature 0 with a
fixed seed. Names are asked per span. Contradictions are asked over all
the spans a run brings in. Questions and gaps are asked per record.
Duplicates and links are asked over a catalogue of the museum's records,
and each pair must include one from this run. If no model answers, the
run completes with an empty pile and the log says so.

**The Both Stand register** (`src/model/both-stand/`) holds what the
museum lets stand. An entry is settled only with a note saying how.
**Links** (`src/model/links.json`) are the doors between records. Both
reach the public slice, without the ID of the proposal they came from.

## The generated museum's check

`npm run check:model` in a generated museum refuses, among others: a file
not named for its ID; a held record with nothing held; a record `mw`
wrote whose input hash doesn't claim it; an ID claimed twice or
tombstoned and in use; an entity with no anchor, or with none that
spells its name; an evidence quote not verbatim in its span; a
contradiction no question carries; any proposal citing words its span doesn't hold; a kept name with no
anchored entity, a kept contradiction with no Both Stand entry, a kept
question, gap or link with nothing opened from it; a merged duplicate
with neither record retired; a Both Stand entry settled with no note; and a public slice that
could read the queue. The public slice (`scripts/lib/public.ts`, written
to `public/data/museum.json` by `npm run build`) reads records,
entities, questions, evidence, Both Stand, links and the museum record,
and nothing else:
the check holds that file to its list, so a proposal has no path to the
public render.

## The generated museum's viewer

Every generated museum has a plain viewer at `/` (`structure/public/index.html`,
`viewer.js`, `viewer.css`): no framework, no build beyond the public slice
it reads. Records first, each document with its plate thumbnails; a
document's page shows its passages with each plate after the passage it
follows; a plate's page shows the image, the caption (or "No caption
given."), the credit, the status and where it came from; then entities,
open questions and evidence. Words from a pulled page are set as text,
never markup. It reads only `/data/museum.json`, so nothing in the queue
reaches it. Not a theme (spec §7); a museum replaces it when it has one.

## Tests

```bash
npm test         # 122 tests, offline
npm run typecheck
```

- `test/admin.test.ts` opens a generated museum's `/admin` in Chromium:
  the pinned Sveltia (served from the `@sveltia/cms` npm package of the
  same version, in place of unpkg) loads the generated config, signs in
  with a token, and lists what is committed, once for an empty museum and
  once after `mw pull --propose`, down to a plate's caption in the editor.
  GitHub is [a stand-in](test/admin/github.ts) answered from the
  museum's own git repository; any request it can't answer fails the
  test. Chromium comes from `MW_CHROMIUM`, `/opt/pw-browsers/chromium`, or
  `npx playwright-core install chromium`; without one, the test is skipped
  outside CI.
- `test/viewer.test.ts` opens the viewer over an empty museum, an
  unbuilt one, and one after a pull with a kept name: plates in place,
  captions verbatim, a held file loading, hostile text staying text, the
  queue never showing on any page, and no sideways scroll on a phone.
- `test/serve.test.ts` drives `mw serve` through its API from nothing: the
  setup code and passcode, refusing writes from elsewhere, creating a
  museum, a pull with proposals, keep (previewed first), the span rule and
  a relabel refused, hold back (public slice unchanged), status with a
  note, a refused write taken back, uploads with a note, sync against a
  bare repository (push, take, refuse a divergence), export, a restart,
  and bringing a museum in by clone.
- `test/local-admin.test.ts` builds and edits a museum through the API
  with no remote: a record by hand, entities, questions, evidence, a
  correction proposed, accepted and applied, a record retired, each
  refusal where the rules say no.
- `test/local-desk.test.ts` does the same in Chromium, from Collection to
  Site.
- `test/desk.test.ts` builds a museum from nothing through the desk in
  Chromium, from the setup code to the viewer showing the kept name.
- `test/kinds.test.ts` and `test/kinds-desk.test.ts` cover proposal kinds.
  A stand-in model proposes one of each kind on the Angie page, plus some
  with quotes their spans don't hold. The tests check generation and the
  span rule, then each kind kept or held back at the desk (a Both Stand
  entry, questions, a link, a merge) and in Chromium.
- `test/shell.test.ts` drives the five commands and the doctor as a
  curator would: the overview, help, plain refusals, `mw new`, pull and
  add committing, sync (sent, took, in step, both moved), the desk's
  printout, and the old names.
- `test/install.test.ts` packs the package, installs it into a scratch
  project, and runs `mw init` from `node_modules`.

`test/angie.test.ts` is §8, the Angie test, against
[a local reconstruction of the Angie page](test/fixtures/angie/README.md)
and a stand-in for llama-server that also "notices" a name the passage
doesn't hold, which the span rule must drop. The build that wrote this
could reach neither sheridanwyominghistory.com nor huggingface.co, so the
live page and the real model are still to be run.

## Not in v1

No fork of Sveltia, no local-git backend, no theme, no accounts beyond
token auth, no chatbot, no auto-publishing, no vision captioning, no OCR.

## License

GPL-3.0: see [LICENSE](LICENSE).
