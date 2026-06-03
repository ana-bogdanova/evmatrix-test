# EVMatrix

Keeps your EV compatibility lists up to date using **GitHub itself** — no website to host, nothing to install, no command line. You press one button in GitHub, and it fetches the freshest vehicle data, compares it to the last saved version, and opens a pull request showing exactly what changed.

---

## How it works (the whole idea in 4 sentences)

1. You click **Run workflow** in the repo's **Actions** tab.
2. GitHub fetches the latest data, applies your saved corrections, computes the four published lists, and compares everything to the last saved version.
3. It opens a **pull request** containing a plain-English change log, the regenerated lists, and the new saved baseline.
4. You read the pull request and **Merge** it to make the update official — or close it if something looks off.

That's it. Everything lives in the repo, and Git history is your audit trail.

---

## What's in the repo

| Path | What it is |
|---|---|
| `.github/workflows/update.yml` | The button. Defines the manual "Run workflow" action. |
| `scripts/update.js` | The logic: fetch, apply overlays, classify, diff, write outputs. |
| `data/overlays.json` | **Your corrections.** You edit this (see below). |
| `data/latest.json` | The last saved snapshot. Created automatically; don't edit by hand. |
| `changes/` | One timestamped change log per run, e.g. `changes/2026-05-29-143055.md`. These accumulate — your monthly history lives here. |
| `lists/` | The four regenerated lists as `.md`, plus a combined dated `evmatrix-export-<date>.csv`. |
| `docs/index.html` | The public web page (all four lists). Served by GitHub Pages at a stable URL; regenerated each run. |

---

## Part 1 — Try it in your personal repo first (recommended)

GitHub Actions is free on personal repos, so you can prove the whole thing out before touching the org repo. About 10 minutes, all in the browser.

1. **Create a repo.** On GitHub, click **New**. Name it `evmatrix-test`. Public or private both work for the trial. Create it.
2. **Add the files.** Click **Add file → Upload files** and upload everything from this project, keeping the folders (`.github/workflows/`, `scripts/`, `data/`, `changes/`, `lists/`). Commit.
   - *Tip:* dragging the whole folder tree in at once preserves the structure. If the upload flattens folders, create the files via **Add file → Create new file** and type the path including slashes (e.g. `scripts/update.js`) — GitHub makes the folders for you.
3. **Allow the workflow to open pull requests.** Go to **Settings → Actions → General**. Scroll to **Workflow permissions**, choose **Read and write permissions**, and tick **Allow GitHub Actions to create and approve pull requests**. Save. *(One-time setup; this is what lets the run commit a branch and open the PR.)*
4. **Run it.** Go to the **Actions** tab. Click **EVMatrix — update lists** in the left list, then the **Run workflow** button on the right, then the green **Run workflow** confirm. Wait ~30–60 seconds and refresh.
5. **See the result.** Go to the **Pull requests** tab. There's a new PR titled something like *"EVMatrix update — 2026-05-29-143055 (… changes)"*. Open it, click **Files changed** to see the new `changes/…md`, the regenerated `lists/…`, and `data/latest.json`. This first run shows everything as new (there's no prior baseline yet).
6. **Merge it.** Click **Merge pull request**. The repo now holds your first baseline.
7. **Run it again.** Hit **Run workflow** once more. This time the PR should say **"no changes"** (the data hasn't moved since you just saved it) — which is exactly right, and proves the comparison works.

If those steps work, you're done validating. The org repo is the same files plus the same one-time permission toggle.

---

## Part 2 — Moving to the org repo

Identical to the trial, with two things to confirm with whoever administers the org:

- **GitHub Actions must be enabled** for the repo. Most orgs allow it; some restrict it. If the **Actions** tab is missing or says Actions are disabled, that's the blocker — ask an org admin to enable it.
- **Make the repo private.** This keeps the code (including the classification rule) and the data out of public view.

Then: upload the files, do the **Workflow permissions** toggle (Part 1, step 3), and give the people who'll run it **Write** access to the repo (Settings → Collaborators and teams). Write access is what lets them press **Run workflow** and merge the PRs.

---

## Editing your corrections (`data/overlays.json`)

Overlays are fixes that get re-applied on every run, so you never redo them. Edit the file right in GitHub: open `data/overlays.json`, click the pencil (✏️) icon, make changes, commit. *(Copilot is good at this — e.g. "add an overlay that blocklists Fisker.")*

The file is a list of overlay objects. Three types:

**Year correction** — the source shows the wrong model year:
```json
{ "id": "kia-ev6-year", "type": "year_correction", "make": "Kia", "model": "EV6",
  "region": "US", "powertrain": "BEV", "from": "2025", "to": "2026" }
```
`from` is what the source currently says; `to` is the correct value.

**Add missing** — a model the source doesn't list yet but you support:
```json
{ "id": "add-foo", "type": "add_missing", "make": "Lucid", "model": "Gravity",
  "region": "US", "powertrain": "BEV", "to": "2025" }
```

**Blocklist** — never treat a make/model as controllable (it'll always be Tracking-Only):
```json
{ "id": "block-acme", "type": "blocklist", "make": "Acme" }
```

Rules: every overlay needs a unique `id` and a `type`. `make` is required; `model` is optional (omit it to match a whole brand). Keep it valid JSON — a list `[ ... ]` of objects separated by commas. To start clean, set the file to `[]`.

**Overlay states** appear in each run's change log:
- *active* — being applied.
- *redundant* — the source caught up to your `to`; safe to delete the overlay.
- *stale* — the source moved to a value that's neither your `from` nor your `to`. EVMatrix does **not** hide this; the new value shows up in the change log and the overlay is flagged so you can fix or remove it.

---

## Deferring a change

The checkboxes in the pull request are **only visual notes** — ticking or unticking one changes nothing. When you merge a PR, **every** change in it is accepted into the saved baseline, regardless of the checkboxes. So a checkbox cannot hold a change back.

To actually defer a change — keep a model *out* of Managed for now, while still seeing it resurface in future runs until you're ready — use a **blocklist overlay**.

**Example:** the source now reports that the BMW 330e supports start/stop charge commands, so this run wants to move it to Managed. You're not ready to manage it yet.

1. **Do not merge the PR yet.**
2. Open `data/overlays.json`, add:
   ```json
   { "id": "defer-bmw-330e", "type": "blocklist", "make": "BMW", "model": "330e" }
   ```
   Commit.
3. **Re-run the workflow.** The 330e now stays Tracking-Only — the overlay overrides the new commands. Merge that PR when it looks right.
4. Because the source genuinely still reports start/stop, the change keeps appearing in future runs, so it won't get lost.
5. **When you're ready to manage it:** delete that overlay entry from `data/overlays.json`, commit, re-run. The 330e then flows into the Managed list.

This works for the Managed-vs-Tracking case (the start/stop example above). It is the supported way to say "not yet" to a change without losing track of it.

---

## Reading a change log

Each run writes `changes/<timestamp>.md`. It lists, in plain English:
- **Added** — new models, with year range and Managed/Tracking type.
- **Changed** — existing models whose **relevant** endpoints or model years moved. The line spells out exactly what changed (e.g. *updated years: was `2023–2025`, now `2023–2026`* or *gained `charge-start`, lost `charge-stop`*). Only the endpoints that affect classification are reported; unrelated capability changes are ignored.
- **Removed** — no longer present in the source.
- **Stale overlays** — corrections that need your attention.
- **List sizes** — row counts for the four lists.

Because every run commits its snapshot, GitHub's own commit/PR diff view *also* shows the raw before/after — the Markdown log is just the friendly version.

---

## Publishing the lists

You have three ways to use the output, in increasing order of "hands-off":

**1. Read / download from the repo.** Open any `lists/*.md` (renders as a table on GitHub), or `lists/evmatrix-export-<date>.csv` → **Raw → Save As** for Excel/Sheets.

**2. The public page (recommended for the Help Center).** Each run regenerates `docs/index.html` — a clean, public web page showing all four lists with the last-updated date. Published via GitHub Pages, it lives at a **stable URL** and updates itself every time you merge a PR. No copy-paste per cycle.

**3. Embed it in your Help Center article.** Put the public URL in an `<iframe>` in the article once; it then reflects every future update automatically.

### One-time GitHub Pages setup

1. Make sure at least one run has merged (so `docs/index.html` exists on `main`).
2. Repo **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **Deploy from a branch**.
4. Set branch to **main** and folder to **/docs**, then **Save**.
5. Wait ~1 minute, refresh — the page URL appears at the top, like
   `https://ana-bogdanova.github.io/evmatrix-test/`.

> **Note:** A GitHub Pages site is **publicly accessible on the internet** even though the repo stays private. That's intended here — these lists are meant to be public (clients may even embed them). Only `docs/index.html` is published; the rest of the repo (script, overlays, history) is not.

### Embed in the Help Center article

In the article editor, add an embed/iframe and use:

```html
<iframe src="https://ana-bogdanova.github.io/evmatrix-test/"
        style="width:100%;border:0;height:1400px" title="EV Compatibility"></iframe>
```

Adjust `height` to suit. After this, every merged update changes what the iframe shows — no further edits to the article. (Clients can embed the same URL on their own sites the same way.)

---

## Notes & limits

- **Manual trigger only.** Nothing runs on its own. (A monthly auto-run can be added later if you ever want it.)
- **Classification rule.** A vehicle must first be a BEV or PHEV in US or CA (Europe and ICE are filtered out). Then it must expose the full **tracking set** — battery capacity (nominal capacity *or* range), battery state-of-charge, detailed charging status, location, and odometer — to appear on any list. Of those:
  - **Managed** (control-eligible) — has the full tracking set **and** both the *start charge* and *stop charge* commands.
  - **Tracking Only** — has the full tracking set but is missing start and/or stop.
  - A vehicle missing any tracking endpoint is excluded entirely.

  This lives in `classifyVehicle()` in `scripts/update.js`, with the exact capability codes in `RELEVANT_ENDPOINTS` just above it. In a private repo it's visible only to people with repo access.
- **Regions/powertrains.** Hardcoded to keep US + CA and BEV + PHEV; Europe and ICE are filtered out. Change `regionsKept` / `powertrainsKept` near the top of `scripts/update.js` if that ever needs to shift.
- **No secrets or tokens needed.** The workflow uses GitHub's built-in permission to open the PR; the data API needs no key.
