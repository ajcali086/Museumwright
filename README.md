# Museumwright starter — `mw`

A converter that writes the folders a museum's admin already edits. Not a
database, not a theme, not a service, not a second admin. **Sveltia
collects. The pipeline validates.** `mw` writes files; `check:model`
refuses bad saves; CI runs the check before merge.

Built to the Starter Spec v2 (2026-10-04). The structure it generates was
learned from [The Spirit of Martinez](https://github.com/ajcali086/spirit-of-martinez)'s
workbench and the Angie pilot.

```bash
npx github:ajcali086/Museumwright- init <name> [--repo owner/name] [--title "..."] [--dir path] [--no-install] [--no-git]
npx github:ajcali086/Museumwright- pull <url>     [--propose] [--model-url URL] [--max-width 3000] [--no-skip-log] [--museum dir]
npx github:ajcali086/Museumwright- batch <folder> [--propose] [--model-url URL] [--no-skip-log] [--museum dir]
```

Installed from git, npm builds `dist/` (plain JavaScript) on install,
because Node won't strip types from files under `node_modules`. In a
checkout, `bin/mw.mjs` runs `src/` directly:

```bash
npm ci
bin/mw.mjs init <name> ...
```

Node 22.6 or later (type stripping). `batch` reads PDFs with poppler
(`pdfinfo`, `pdftotext`, `pdftoppm`).

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

## `--propose`

Writes the names a local model notices, as proposal files **in the
corrections shape**: `kind: name`, `status: proposed`, `target` the span
(`r-0001#p9`, or `plate:r-0004` for a caption), `proposed_text` the name
as spelled. A proposal is not an entity.

The worker is Qwen3-1.7B (Apache 2.0), GGUF Q4_K_M, under llama.cpp:

```bash
llama-server -hf Qwen/Qwen3-1.7B-GGUF:Q4_K_M --port 8080
bin/mw.mjs pull <url> --propose            # or --model-url / MW_MODEL_URL
```

Generation is constrained by a GBNF grammar to the proposal's fields
(`src/propose.ts`), temperature 0 and a fixed seed. **The span rule**: a
name its span doesn't contain, exactly as spelled, is dropped before it is
written, and `check:model` refuses one that reaches the queue anyway. If
no model answers, the run completes with an empty pile and the run log
says so.

In the admin, **kept** means: create the entity, anchored to the record
that spells the name, then mark the proposal `accepted`; the check refuses
a kept name with no entity anchored there. **Held back** is status
`held`: a decision, not a deletion (`delete: false`).

## The generated museum's check

`npm run check:model` in a generated museum refuses, among others: a file
not named for its ID; a held record with nothing held; a record `mw`
wrote whose input hash doesn't claim it; an ID claimed twice or
tombstoned and in use; an entity with no anchor, or with none that
spells its name; an evidence quote not verbatim in its span; a
contradiction no question carries; a name proposal whose span doesn't
contain it; a kept name with no anchored entity; and a public slice that
could read the queue. The public slice (`scripts/lib/public.ts`, written
to `public/data/museum.json` by `npm run build`) reads records,
entities, questions, evidence and the museum record, and nothing else:
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
npm test         # 50 tests, offline
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
