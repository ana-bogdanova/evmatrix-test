# EVMatrix

This repo helps to update the EV compatibility list based on data provided by Smartcar, with the Virtual Peaker requirements applied.

# Instructions

Run this task once a month.

1. To start, navigate to **Actions** → select the **EVMatrix — update lists** workflow → on the right side of the table click **Run workflow**, then the **Run workflow** button again. Once complete, you'll see a green checkmark.
<img width="144" height="51" alt="Screenshot 2026-06-03 at 4 16 01 PM" src="https://github.com/user-attachments/assets/dfdb3a2e-a41b-4c3f-a46a-90508b1f6c5f" />

2. Navigate to the **Pull requests** section. A new pull request appears — click on it.
3. Review the details of the request. If you agree with all the changes, scroll down, click **Merge pull request**, and **Confirm merge** (commit to `main`).
4. Once that is done, the updated version of the table will be available at **[URL to add later]**.

# Change Log

All change data is stored in the linked PR in its description (the review checklist). The CSV file (`lists/evmatrix-export-<date>.csv`) contains the full list as of that run, with overlays applied. A timestamped change log for each run is also saved under `changes/`.

# Our Overwrites

The overlay file — [`data/overlays.csv`](data/overlays.csv) (a readable mirror of `data/overlays.json`) — contains:
- all the **makes and models we don't support** (removed from every list),
- all the **makes we support for data tracking only**, despite their stop/start charging capability (forced to Tracking Only), and
- some **model-year corrections**, since Smartcar doesn't always update them on time.

> `data/overlays.csv` is **read-only** — it's regenerated from `data/overlays.json` on every run, just so the overlays are easy to read at a glance. To actually change an overlay, edit `data/overlays.json` (see below). Editing the CSV does nothing.

## How to add more cars to the overlay file

The easiest path: **ask Claude.ai (or Copilot) to write the entry for you.** Open a chat and say, in plain English, what you want — for example:

- *"In my overlays.json, add an overlay that completely excludes the Fisker brand."*
- *"Add an overlay so Subaru is tracking-only."*
- *"Add a year correction: Smartcar says the Kia EV6 is 2025 but it should be 2026 (US, BEV)."*

Claude will give you the exact line to paste. Then:
1. In the repo, open **`data/overlays.json`** and click the pencil (✏️) icon.
2. Paste the new entry into the list (mind the commas between entries).
3. Commit to `main`.
4. The change takes effect on the next **Run workflow**.

If you'd rather write it by hand, the formats and rules are in **Technical Details → Editing your corrections** below.

---

<details>
<summary><b>Technical Details</b> (click to expand)</summary>

## How it works (the whole idea in 4 sentences)

1. You click **Run workflow** in the repo's **Actions** tab.
2. GitHub fetches the latest data, applies your saved corrections (overlays), computes the four published lists, and compares everything to the last saved version.
3. It opens a **pull request** containing a plain-English change log, the regenerated lists, and the new saved baseline.
4. You read the pull request and **Merge** it to make the update official — or close it if something looks off.

Everything lives in the repo, and Git history is your audit trail.

## What's in the repo

| Path | What it is |
|---|---|
| `.github/workflows/update.yml` | The button. Defines the manual "Run workflow" action. |
| `scripts/update.js` | The logic: fetch, apply overlays, classify, diff, write outputs. |
| `data/overlays.json` | **Your corrections.** You edit this (see below). |
| `data/overlays.csv` | Readable mirror of the overlays, regenerated each run. Do not edit by hand. |
| `data/latest.json` | The last saved snapshot. Created automatically; don't edit by hand. |
| `changes/` | One timestamped change log per run. These accumulate — your monthly history lives here. |
| `lists/` | The four regenerated lists as `.md`, plus a combined dated `evmatrix-export-<date>.csv`. |
| `docs/index.html` | The public web page (all four lists). Served by GitHub Pages at a stable URL; regenerated each run. |

## First-time setup (personal repo trial, then org repo)

GitHub Actions is free on personal repos, so you can prove the whole thing out before touching the org repo.

1. **Create a repo** and add all the files, keeping the folder structure.
2. **Allow the workflow to open pull requests:** Settings → Actions → General → Workflow permissions → **Read and write permissions**, and tick **Allow GitHub Actions to create and approve pull requests**. Save.
3. **Run it** (Actions → EVMatrix — update lists → Run workflow). First run shows everything as new.
4. **Merge** the PR — that becomes your first baseline.
5. **Run again** — it should now say "no changes," which proves the comparison works.

For the **org repo**: same steps, plus confirm with an admin that **GitHub Actions is enabled**, keep the repo **private**, and give the people who run it **Write** access (Settings → Collaborators and teams).

## Editing your corrections (`data/overlays.json`)

Overlays are fixes re-applied on every run. Edit `data/overlays.json` in GitHub (pencil icon). It's a list of overlay objects; every overlay needs a unique `id` and a `type`. `make` is required; `model` is optional (omit it to match a whole brand). Keep it valid JSON — a list `[ ... ]` of objects separated by commas. To start clean, set it to `[]`.

**Exclude** — remove a make/model from **all** lists entirely:
```json
{ "id": "ex-brand",  "type": "exclude", "make": "BMW" }
{ "id": "ex-model",  "type": "exclude", "make": "Nissan", "model": "Leaf" }
{ "id": "ex-phev",   "type": "exclude", "make": "Volkswagen", "model": "Tiguan", "powertrain": "PHEV" }
{ "id": "ex-family", "type": "exclude", "make": "Mercedes-Benz", "modelPrefix": "EQ" }
```
`modelPrefix` matches any model starting with that text (e.g. all Mercedes EQ models), and auto-catches future models in that family.

**Blocklist** — never treat a make/model as controllable (always Tracking-Only):
```json
{ "id": "block-acme", "type": "blocklist", "make": "Acme" }
```

**Year correction** — the source shows the wrong model year:
```json
{ "id": "kia-ev6-year", "type": "year_correction", "make": "Kia", "model": "EV6",
  "region": "US", "powertrain": "BEV", "from": "2025", "to": "2026" }
```
`from` = what the source says; `to` = the correct value.

**Add missing** — a model the source doesn't list yet but you support:
```json
{ "id": "add-foo", "type": "add_missing", "make": "Lucid", "model": "Gravity",
  "region": "US", "powertrain": "BEV", "to": "2025" }
```

**Overlay states** appear in each run's change log:
- *active* — being applied.
- *redundant* — the source caught up to your `to`; safe to delete the overlay.
- *stale* — the source moved to a value that's neither your `from` nor your `to`. The new value shows up in the change log and the overlay is flagged so you can fix or remove it.

## Deferring a change

The checkboxes in the pull request are **only visual notes** — ticking one changes nothing. Merging a PR accepts **every** change in it. To defer a change — keep a model *out* of Managed for now while still seeing it resurface in future runs — use a **blocklist overlay**:

1. **Don't merge the PR yet.**
2. Add `{ "id": "defer-bmw-330e", "type": "blocklist", "make": "BMW", "model": "330e" }` to `data/overlays.json`, commit.
3. **Re-run** — the model stays Tracking-Only. Merge that PR.
4. It keeps appearing in future runs (the source still reports start/stop), so it won't get lost.
5. **When ready:** delete that overlay, commit, re-run — it flows into Managed.

## Reading a change log

Each run writes `changes/<timestamp>.md`:
- **Added** — new models, with year range and Managed/Tracking type.
- **Changed** — existing models whose **relevant** endpoints or model years moved, spelled out (e.g. *updated years: was `2023–2025`, now `2023–2026`* or *gained `charge-start`, lost `charge-stop`*). Only classification-relevant endpoints are reported.
- **Removed** — no longer present in the source.
- **Stale overlays** — corrections that need attention.
- **List sizes** — row counts for the four lists.

## Publishing the lists

1. **Read/download from the repo:** any `lists/*.md`, or `lists/evmatrix-export-<date>.csv` (Raw → Save As).
2. **The public page:** each run regenerates `docs/index.html`, served by GitHub Pages at a stable URL that updates on every merge.
3. **Embed in the Help Center:** put the public URL in an `<iframe>` once.

### One-time GitHub Pages setup
1. Make sure at least one run has merged (so `docs/index.html` exists on `main`).
2. Settings → Pages → Source: **Deploy from a branch** → branch **main**, folder **/docs** → Save.
3. Wait ~1 minute; the URL appears at the top.

> A GitHub Pages site is **publicly accessible** even though the repo stays private. Only `docs/index.html` is published; the script, overlays, and history are not.

### Embed snippet
```html
<iframe src="https://ana-bogdanova.github.io/evmatrix-test/"
        style="width:100%;border:0;height:1400px" title="EV Compatibility"></iframe>
```
Adjust `height` to suit. After this, every merged update changes what the iframe shows.

## Notes & limits

- **Manual trigger only.** Nothing runs on its own.
- **Classification rule.** A vehicle must be a BEV or PHEV in US or CA (Europe and ICE filtered out), and expose the full **tracking set** — battery capacity (nominal capacity *or* range), state-of-charge, detailed charging status, location, odometer — to appear at all. **Managed** = tracking set **and** both start + stop charge commands; **Tracking Only** = tracking set but missing start and/or stop. Lives in `classifyVehicle()` in `scripts/update.js` (`RELEVANT_ENDPOINTS` just above it).
- **Regions/powertrains.** Hardcoded to US + CA and BEV + PHEV; change `regionsKept` / `powertrainsKept` near the top of `scripts/update.js`.
- **No secrets or tokens needed.** The workflow uses GitHub's built-in permission; the data API needs no key.

</details>
