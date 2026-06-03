#!/usr/bin/env node
/* ============================================================================
   EVMatrix — update cycle (runs on a GitHub Actions runner, server-side)
   ----------------------------------------------------------------------------
   1. Fetch the freshest data from the compatibility API (no CORS here — this
      runs on GitHub's servers, not in a browser).
   2. Load the last saved snapshot committed in the repo (data/latest.json).
   3. Apply the user's overlays (data/overlays.json).
   4. Classify + group into the four published lists.
   5. Diff against the last snapshot.
   6. Write: a timestamped changes/<stamp>.md log, refreshed lists/*.html,
      lists/*.md, and an updated data/latest.json (the new baseline).
   The workflow then opens a pull request with whatever changed.
   ============================================================================ */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR    = path.join(ROOT, "data");
const CHANGES_DIR = path.join(ROOT, "changes");
const LISTS_DIR   = path.join(ROOT, "lists");
const DOCS_DIR    = path.join(ROOT, "docs");   // GitHub Pages publish folder
const LATEST      = path.join(DATA_DIR, "latest.json");
const OVERLAYS    = path.join(DATA_DIR, "overlays.json");

const CONFIG = {
  apiUrl: process.env.EVMATRIX_API_URL || "https://compatibility.api.smartcar.com/v3/compatible-vehicles",
  regionsKept: ["US", "CA"],        // PRD: hardcoded US + CA
  powertrainsKept: ["BEV", "PHEV"], // PRD: hardcoded BEV + PHEV
};

/* ---------------------------------------------------------------- utilities */
const norm = s => String(s == null ? "" : s).trim();
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}
function ensureDirs() { [DATA_DIR, CHANGES_DIR, LISTS_DIR, DOCS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true })); }
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
}
function stamp(d) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/* ---------------------------------------------------------------- fetch live */
async function fetchAllVehicles(url) {
  let all = [], next = url, guard = 0;
  while (next && guard++ < 100) {
    const res = await fetch(next, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${next}`);
    const j = await res.json();
    if (Array.isArray(j.data)) all = all.concat(j.data);
    else if (Array.isArray(j)) all = all.concat(j);
    else throw new Error("Unexpected response shape (no 'data' array)");
    next = (j.links && (j.links.next || j.links.Next)) || null;
  }
  return all;
}

/* ---------------------------------------------------------------- normalize */
function canonRegion(v) {
  v = String(v || "").toLowerCase();
  if (/(^|[^a-z])(us|usa|united states|america)/.test(v)) return "US";
  if (/(^|[^a-z])(ca|can|canada)/.test(v)) return "CA";
  if (/(eu|europe)/.test(v)) return "EU";
  return v ? v.toUpperCase().slice(0, 6) : "US";
}
function canonPower(v) {
  v = String(v || "").toLowerCase();
  if (/phev|plug.?in/.test(v)) return "PHEV";
  if (/bev|electric|^ev$|battery/.test(v)) return "BEV";
  if (/ice|gas|petrol|diesel|hybrid/.test(v) && !/plug/.test(v)) return "ICE";
  return v ? v.toUpperCase() : "BEV";
}
function normaliseApi(records) {
  const out = [];
  for (const rec of records || []) {
    const a = (rec && rec.attributes) || rec || {};
    const region = canonRegion(a.region);
    const powertrain = canonPower(a.powertrainType || a.powertrain);
    const start = a.years && a.years.start;
    const end = (a.years && a.years.end) || start;
    const endpoints = {}, controls = {}, codes = {};
    (a.capabilities || []).forEach(c => {
      if (!c) return;
      // The API exposes two id-ish fields: `code` is short PascalCase
      // (e.g. "DetailedChargingStatus") and `capability` is the canonical
      // lowercased "group-name" form (e.g. "charge-detailedchargingstatus").
      // We key off `capability`, since that's the stable id our rules use.
      const id = c.capability || c.code;
      if (!id) return;
      endpoints[id] = true;
      codes[id] = c.type || "signal";       // remember signal vs command per id
      if (c.type === "command" && /charge/i.test(id)) controls[id] = true;
    });
    out.push({ make: norm(a.make), model: norm(a.model), yStart: start || null,
               year: end || null, region, powertrain, endpoints, controls, codes });
  }
  return out;
}

/* ---------------------------------------------------------------- overlays */
function matchTarget(ov, g) {
  if (norm(ov.make).toLowerCase() !== g.make.toLowerCase()) return false;
  if (ov.model && norm(ov.model).toLowerCase() !== g.model.toLowerCase()) return false;
  return true;
}

/* ---------------------------------------------------------------- classify
   REAL RULE (org logic).
   A vehicle must already be a kept powertrain (BEV/PHEV) in a kept region
   (US/CA), else it is excluded.

   Required tracking set — ALL of these must be present for the vehicle to
   appear on ANY list:
     - EV battery capacity   -> tractionbattery-nominalcapacity OR
                                  tractionbattery-range (Tesla and some others
                                  expose range but not nominal capacity)
     - EV battery (SOC)       -> tractionbattery-stateofcharge
     - EV charging status     -> charge-detailedchargingstatus
     - Location               -> location-preciselocation
     - Odometer               -> odometer-traveleddistance

   MANAGED (control-eligible): has the full tracking set AND BOTH commands
     charge-start AND charge-stop.
   TRACKING: has the full tracking set but is missing start and/or stop.
   Anything missing a required tracking endpoint -> excluded (null).
   A blocklist overlay forces TRACKING even if start/stop are present.
   ------------------------------------------------------------------------- */
const REQUIRED_TRACKING = [
  ["tractionbattery-nominalcapacity", "tractionbattery-range"], // battery capacity (nominal capacity OR range)
  ["tractionbattery-stateofcharge"],                   // battery (SOC)
  ["charge-detailedchargingstatus"],                   // charging status
  ["location-preciselocation"],                        // location
  ["odometer-traveleddistance"],                       // odometer
];
const CONTROL_COMMANDS = ["charge-start", "charge-stop"]; // both required, must be type "command"

function hasCode(group, code) { return !!group.endpoints[code]; }
function hasCommand(group, code) { return group.codes[code] === "command"; }

function classifyVehicle(group, ctx) {
  if (!CONFIG.powertrainsKept.includes(group.powertrain)) return null; // drop ICE
  if (!CONFIG.regionsKept.includes(group.region)) return null;         // drop EU etc.

  // must satisfy every required tracking endpoint (each row = "any one of")
  const hasTracking = REQUIRED_TRACKING.every(alts => alts.some(code => hasCode(group, code)));
  if (!hasTracking) return null;                                       // excluded: below the floor

  if (ctx.blocklist.some(b => matchTarget(b, group))) return "TRACKING";

  const controllable = CONTROL_COMMANDS.every(code => hasCommand(group, code));
  return controllable ? "MANAGED" : "TRACKING";
}

/* ---------------------------------------------------------------- merge */
function groupKey(make, model, region, power) {
  return [make, model, region, power].map(x => String(x).toLowerCase().trim()).join("||");
}
function epSig(endpoints) { return Object.keys(endpoints).filter(k => endpoints[k]).sort().join(","); }

function computeMerged(rows, overlays) {
  const overlayStates = {};
  overlays.forEach(o => { overlayStates[o.id || (o.id = Math.random().toString(36).slice(2))] = "active"; });

  let working = rows.map(r => ({ ...r, endpoints: { ...r.endpoints }, controls: { ...r.controls } }));

  // year_correction
  overlays.filter(o => o.type === "year_correction").forEach(o => {
    const from = parseInt(o.from, 10), to = parseInt(o.to, 10);
    let touched = false, sawTo = false, sawOther = false;
    working.forEach(r => {
      if (matchTarget(o, r)) {
        if (r.year === from) { r.year = to; touched = true; }
        else if (r.year === to) sawTo = true;
        else if (r.year != null) sawOther = true;
      }
    });
    if (sawTo && !touched) overlayStates[o.id] = "redundant";
    else if (!touched && sawOther) overlayStates[o.id] = "stale";
  });

  // add_missing
  overlays.filter(o => o.type === "add_missing").forEach(o => {
    const exists = working.some(r => matchTarget(o, r) && (!o.to || r.year === parseInt(o.to, 10)));
    if (exists) overlayStates[o.id] = "redundant";
    else {
      const full = {
        "tractionbattery-nominalcapacity": "signal",
        "tractionbattery-stateofcharge": "signal",
        "charge-ischarging": "signal",
        "location-preciselocation": "signal",
        "odometer-traveleddistance": "signal",
        "charge-start": "command",
        "charge-stop": "command",
      };
      const ep = {}; Object.keys(full).forEach(c => ep[c] = true);
      working.push({
        make: o.make, model: o.model,
        year: parseInt(o.to, 10) || parseInt(o.from, 10) || new Date().getFullYear(),
        region: o.region || "US", powertrain: o.powertrain || "BEV",
        endpoints: ep, controls: { "charge-start": true, "charge-stop": true },
        codes: { ...full }, _added: true,
      });
    }
  });

  const ctx = { blocklist: overlays.filter(o => o.type === "blocklist") };

  const groups = {};
  working.forEach(r => {
    const k = groupKey(r.make, r.model, r.region, r.powertrain);
    if (!groups[k]) groups[k] = { key: k, make: r.make, model: r.model, region: r.region,
                                  powertrain: r.powertrain, years: new Set(), endpoints: {}, controls: {}, codes: {} };
    if (r.year != null) groups[k].years.add(r.year);
    if (r.yStart != null) groups[k].years.add(r.yStart);
    Object.assign(groups[k].endpoints, r.endpoints);
    Object.assign(groups[k].controls, r.controls || {});
    Object.assign(groups[k].codes, r.codes || {});
  });

  const list = Object.values(groups).map(g => {
    g.years = [...g.years].sort((a, b) => a - b);
    g.sig = epSig(g.endpoints);
    g.classification = classifyVehicle(g, ctx);
    return g;
  });
  return { groups: list, overlayStates };
}

function yearRange(years) {
  if (!years || !years.length) return "";
  const mn = years[0], mx = years[years.length - 1];
  return mn === mx ? "" + mn : mn + "–" + mx;
}

/* ---------------------------------------------------------------- snapshot */
// A snapshot is the minimal shape we diff on, keyed by group.
function toSnapshot(groups) {
  const map = {};
  groups.filter(g => g.classification).forEach(g => {
    map[g.key] = { make: g.make, model: g.model, region: g.region, powertrain: g.powertrain,
                   years: g.years, sig: g.sig, classification: g.classification,
                   caps: Object.keys(g.endpoints).filter(k => g.endpoints[k]).sort() };
  });
  return map;
}
// sort: make A→Z, then BEV before PHEV, then model
const PT_ORDER = { BEV: 0, PHEV: 1 };
function bySortKey(a, b) {
  return a.make.localeCompare(b.make)
      || ((PT_ORDER[a.powertrain] ?? 9) - (PT_ORDER[b.powertrain] ?? 9))
      || a.model.localeCompare(b.model);
}

// The only endpoints that matter for classification. "Changed" lines report
// gained/lost strictly within this set; changes to anything else are ignored.
const RELEVANT_ENDPOINTS = new Set([
  "tractionbattery-nominalcapacity",
  "tractionbattery-range",
  "tractionbattery-stateofcharge",
  "charge-detailedchargingstatus",
  "location-preciselocation",
  "odometer-traveleddistance",
  "charge-start",
  "charge-stop",
]);

/* ---------------------------------------------------------------- diff
   Three buckets: add (new model), change (existing model: years and/or
   capabilities moved), remove (gone). A "change" carries the specific deltas. */
function diff(curSnap, baseSnap) {
  const changes = [];
  for (const k in curSnap) {
    const c = curSnap[k], b = baseSnap[k];
    if (!b) { changes.push({ type: "add", g: c }); continue; }
    const deltas = [];
    const cy = (c.years || []).join(","), by = (b.years || []).join(",");
    if (cy !== by) deltas.push({ kind: "years", was: yearRange(b.years), now: yearRange(c.years) });
    if ((c.sig || "") !== (b.sig || "")) {
      const before = new Set(b.caps || []), after = new Set(c.caps || []);
      const gained = [...after].filter(x => !before.has(x) && RELEVANT_ENDPOINTS.has(x)).sort();
      const lost = [...before].filter(x => !after.has(x) && RELEVANT_ENDPOINTS.has(x)).sort();
      // only a meaningful change if a RELEVANT endpoint moved
      if (gained.length || lost.length) {
        deltas.push({ kind: "caps", gained, lost,
                      flip: b.classification !== c.classification ? { from: b.classification, to: c.classification } : null });
      }
    }
    if (deltas.length) changes.push({ type: "change", g: c, b, deltas });
  }
  for (const k in baseSnap) if (!curSnap[k]) changes.push({ type: "remove", b: baseSnap[k] });
  return changes;
}

/* ---------------------------------------------------------------- outputs */
function label(g) { return `${g.make} ${g.model} (${g.region}·${g.powertrain})`; }
function cls(c) { return c === "MANAGED" ? "Managed" : c === "TRACKING" ? "Tracking Only" : "excluded"; }

// Describe one change's detail (used in both the change log and the PR checklist).
function changeDetail(c) {
  if (c.type === "add") return `years \`${yearRange(c.g.years)}\` · ${cls(c.g.classification)}`;
  if (c.type === "remove") return `no longer present`;
  // type === "change": combine all deltas on one line, separated by "; "
  const parts = [];
  c.deltas.forEach(d => {
    if (d.kind === "years") parts.push(`updated years: was \`${d.was}\`, now \`${d.now}\``);
    else if (d.kind === "caps") {
      const bits = [];
      if (d.gained.length) bits.push("gained " + d.gained.map(x => `\`${x}\``).join(", "));
      if (d.lost.length) bits.push("lost " + d.lost.map(x => `\`${x}\``).join(", "));
      let s = bits.join("; ");
      if (d.flip) s += ` (now ${cls(d.flip.to)})`;
      if (s) parts.push(s);
    }
  });
  return parts.join("; ");
}
// the model identity for a change (uses current group, or baseline for removals)
function changeLabel(c) { return label(c.type === "remove" ? c.b : c.g); }
function changeLine(c) { return `**${changeLabel(c)}** — ${changeDetail(c)}`; }

function renderChangesMd(changes, when, counts, staleOverlays) {
  const byType = t => changes.filter(c => c.type === t);
  const lines = [];
  lines.push(`# Changes — ${when.toISOString().replace("T", " ").slice(0, 16)} UTC`, "");
  if (!changes.length) {
    lines.push("**No changes since the last saved version.** The current data matches the baseline.", "");
  } else {
    lines.push(`**${changes.length} change${changes.length > 1 ? "s" : ""} detected** since the last saved version.`, "");
    const sec = (title, arr) => {
      if (!arr.length) return;
      lines.push(`## ${title} (${arr.length})`, "");
      arr.forEach(c => lines.push("- " + changeLine(c)));
      lines.push("");
    };
    sec("Added", byType("add"));
    sec("Changed", byType("change"));
    sec("Removed", byType("remove"));
  }
  if (staleOverlays.length) {
    lines.push(`## ⚠ Stale overlays (${staleOverlays.length})`, "",
      "These overlays no longer match the source (it moved to a value that is neither your `from` nor your `to`). The new value is reflected above rather than hidden — review and update or delete the overlay:", "");
    staleOverlays.forEach(o => lines.push(`- \`${o.type}\` ${o.make} ${o.model || ""} (${o.from || "?"} → ${o.to || "?"})`));
    lines.push("");
  }
  lines.push("## List sizes", "",
    `| List | Rows |`, `|---|---|`,
    `| US · Managed | ${counts.US_MANAGED} |`,
    `| CA · Managed | ${counts.CA_MANAGED} |`,
    `| US · Tracking Only | ${counts.US_TRACKING} |`,
    `| CA · Tracking Only | ${counts.CA_TRACKING} |`, "");
  return lines.join("\n");
}

// PR description body: self-sufficient checklist with full detail + links.
function renderPrBody(changes, when, counts, csvName) {
  const byType = t => changes.filter(c => c.type === t);
  const L = [];
  const branch = `evmatrix/update-${stampForBranch(when)}`;
  const link = (file, text) => `[${text}](../blob/${branch}/${file})`;
  L.push(`### 📌 All Supported Models US and CA`, "",
    link(`lists/us-managed.md`, "US · Managed") + " · " +
    link(`lists/us-tracking.md`, "US · Tracking Only") + " · " +
    link(`lists/ca-managed.md`, "CA · Managed") + " · " +
    link(`lists/ca-tracking.md`, "CA · Tracking Only"), "",
    link(`lists/${csvName}`, `\`${csvName}\``) + " — combined CSV for this run (open, then **Raw → Save As**).", "");
  if (!changes.length) {
    L.push(`### No changes`, "", "The current data matches the last saved version. Nothing to verify.", "");
  } else {
    L.push(`### Review checklist — ${changes.length} change${changes.length > 1 ? "s" : ""}`, "",
      "Tick each item as you confirm it.  ",
      "⚠️ Checkboxes are just visual notes — they do not control what gets saved. To defer a change and keep it appearing next run, see [‘Deferring a change’ in the README](../blob/main/README.md#deferring-a-change).", "");
    const sec = (title, arr) => {
      if (!arr.length) return;
      L.push(`## ${title} (${arr.length})`);
      arr.forEach(c => L.push(`- [ ] ${changeLine(c)}`));
      L.push("");
    };
    sec("Added", byType("add"));
    sec("Changed", byType("change"));
    sec("Removed", byType("remove"));
  }
  L.push(`### List sizes`, "",
    `| List | Rows |`, `|---|---|`,
    `| US · Managed | ${counts.US_MANAGED} |`,
    `| CA · Managed | ${counts.CA_MANAGED} |`,
    `| US · Tracking Only | ${counts.US_TRACKING} |`,
    `| CA · Tracking Only | ${counts.CA_TRACKING} |`, "");
  return L.join("\n");
}
// branch name uses the full timestamp; must match the workflow's branch pattern
function stampForBranch(d) { return stamp(d); }

function listRows(groups, region, classification) {
  return groups
    .filter(g => g.region === region && g.classification === classification)
    .sort(bySortKey)   // make A→Z, BEV before PHEV, then model
    .map(g => ({ make: g.make, model: g.model + (yearRange(g.years) ? " " + yearRange(g.years) : ""),
                 powertrain: g.powertrain }));   // BEV / PHEV
}
function listMD(title, recs, dateStr) {
  return `# ${title} (${recs.length}) - created on ${dateStr}\n\n| Make | Model | Powertrain |\n|---|---|---|\n` +
    recs.map(r => `| ${r.make} | ${r.model} | ${r.powertrain} |`).join("\n") + "\n";
}
// Combined CSV: one flat table across all four lists. Region + Type columns
// distinguish which list each row belongs to (needed once they're merged).
function csvCell(v) {
  v = v == null ? "" : String(v);
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
function buildExportCsv(allRows) {
  const header = ["Region", "Type", "Make", "Model", "Powertrain"];
  const lines = [header.join(",")];
  allRows.forEach(r => lines.push([r.region, r.type, r.make, r.model, r.powertrain].map(csvCell).join(",")));
  return lines.join("\n") + "\n";
}

/* ---------------------------------------------------------------- public page
   A single self-contained HTML page (no external JS) for GitHub Pages.
   All four lists baked in, responsive for any iframe width. Regenerated each
   run and committed to /docs; Pages serves it so the public URL auto-updates. */
function pageTable(recs) {
  if (!recs.length) return `<p class="empty">No vehicles in this list.</p>`;
  return `<table>
<thead><tr><th>Make</th><th>Model</th><th>Powertrain</th></tr></thead>
<tbody>
${recs.map(r => `<tr><td>${esc(r.make)}</td><td>${esc(r.model)}</td><td><span class="pt ${esc(r.powertrain).toLowerCase()}">${esc(r.powertrain)}</span></td></tr>`).join("\n")}
</tbody>
</table>`;
}
function buildPublicPage(sections, dateStr) {
  // sections: [{title, region, kind, recs}]
  const block = s => `<section>
<h2><span class="rg ${s.region === "CA" ? "ca" : "us"}">${s.region}</span> ${esc(s.kind)} <span class="cnt">${s.recs.length}</span></h2>
${pageTable(s.recs)}
</section>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>EV Compatibility — Supported Models (US & CA)</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500&display=swap" rel="stylesheet">
<style>
  :root{
    --paper:#f7f8f6; --card:#fff; --ink:#161a18; --soft:#5a615e; --faint:#9aa19d;
    --line:#e2e6e1; --line-strong:#cfd5cf; --managed:#0c6b58; --tracking:#4b5563;
    --bev:#0c6b58; --bev-bg:#e4f1ec; --phev:#9a6312; --phev-bg:#fbf1de;
    --sans:'IBM Plex Sans',system-ui,-apple-system,sans-serif; --mono:'IBM Plex Mono',ui-monospace,monospace;
  }
  *{box-sizing:border-box}
  html,body{margin:0}
  body{font-family:var(--sans);color:var(--ink);background:var(--paper);font-size:15px;line-height:1.5;padding:24px}
  .wrap{max-width:960px;margin:0 auto}
  header{margin-bottom:8px}
  h1{font-size:22px;margin:0 0 4px;letter-spacing:-.01em}
  .updated{color:var(--soft);font-size:13px}
  .updated b{font-family:var(--mono);font-weight:500;color:var(--ink)}
  section{background:var(--card);border:1px solid var(--line);border-radius:12px;margin-top:18px;overflow:hidden;
    box-shadow:0 1px 2px rgba(20,26,24,.04),0 10px 26px -20px rgba(20,26,24,.3)}
  h2{font-size:15px;margin:0;padding:14px 18px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:9px;background:rgba(0,0,0,.012)}
  .rg{font:600 11px/1 var(--mono);letter-spacing:.04em;padding:4px 7px;border-radius:6px;color:#fff;background:var(--ink)}
  .rg.ca{background:#9a2235}
  .cnt{margin-left:auto;font:500 12px/1 var(--mono);color:var(--faint)}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);font-weight:600;
    padding:10px 18px;border-bottom:1px solid var(--line-strong)}
  td{padding:9px 18px;border-bottom:1px solid var(--line)}
  tr:last-child td{border-bottom:0}
  tbody tr:nth-child(even){background:rgba(12,107,88,.022)}
  .pt{font:500 11px/1 var(--mono);padding:3px 7px;border-radius:5px}
  .pt.bev{color:var(--bev);background:var(--bev-bg)}
  .pt.phev{color:var(--phev);background:var(--phev-bg)}
  .empty{padding:18px;color:var(--faint);font-size:13px;margin:0}
  footer{margin-top:22px;color:var(--faint);font-size:12px;text-align:center}
  @media(max-width:520px){body{padding:14px}th,td{padding:8px 12px}}
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>EV Compatibility — Supported Models</h1>
  <div class="updated">United States &amp; Canada · last updated <b>${dateStr}</b></div>
</header>
${sections.map(block).join("\n")}
<footer>Updated automatically. Managed = remote charge control supported; Tracking Only = monitoring only.</footer>
</div>
</body>
</html>
`;
}

/* ---------------------------------------------------------------- main */
async function main() {
  ensureDirs();
  const when = new Date();
  const overlays = readJSON(OVERLAYS, []);
  const prevSnap = readJSON(LATEST, null); // {snapshot, fetchedAt} or null on first run

  console.log(`Fetching ${CONFIG.apiUrl} ...`);
  const records = await fetchAllVehicles(CONFIG.apiUrl);
  console.log(`Fetched ${records.length} records.`);

  const rows = normaliseApi(records);
  const { groups, overlayStates } = computeMerged(rows, overlays);
  const curSnap = toSnapshot(groups);
  const baseSnap = (prevSnap && prevSnap.snapshot) || {};

  const changes = diff(curSnap, baseSnap);
  const staleOverlays = overlays.filter(o => overlayStates[o.id] === "stale");

  const defs = [
    ["US_MANAGED", "US", "MANAGED", "US · Managed"],
    ["CA_MANAGED", "CA", "MANAGED", "CA · Managed"],
    ["US_TRACKING", "US", "TRACKING", "US · Tracking Only"],
    ["CA_TRACKING", "CA", "TRACKING", "CA · Tracking Only"],
  ];
  const counts = {};
  const dateStr = when.toISOString().slice(0, 10);   // UTC YYYY-MM-DD
  const exportRows = [];
  const pageSections = [];
  defs.forEach(([id, region, classification, title]) => {
    const recs = listRows(groups, region, classification);
    counts[id] = recs.length;
    const base = id.toLowerCase().replace("_", "-");
    fs.writeFileSync(path.join(LISTS_DIR, base + ".md"), listMD(title, recs, dateStr));
    const typeLabel = classification === "MANAGED" ? "Managed" : "Tracking Only";
    recs.forEach(r => exportRows.push({ region, type: typeLabel, make: r.make, model: r.model, powertrain: r.powertrain }));
    pageSections.push({ title, region, kind: typeLabel, recs });
  });

  // single combined CSV for easy one-click download; date in the filename
  const csvName = `evmatrix-export-${dateStr}.csv`;
  fs.writeFileSync(path.join(LISTS_DIR, csvName), buildExportCsv(exportRows));

  // public GitHub Pages page (all four lists, baked in); served at a stable URL
  fs.writeFileSync(path.join(DOCS_DIR, "index.html"), buildPublicPage(pageSections, dateStr));

  // timestamped change log (always written, even "no changes", so runs are auditable)
  const changesFile = path.join(CHANGES_DIR, `${stamp(when)}.md`);
  fs.writeFileSync(changesFile, renderChangesMd(changes, when, counts, staleOverlays));

  // PR description body (self-sufficient checklist + CSV download link).
  // Written to a workspace file the workflow reads into the PR body. Not committed.
  const prBodyFile = path.join(ROOT, ".pr-body.md");
  fs.writeFileSync(prBodyFile, renderPrBody(changes, when, counts, csvName));

  // new baseline snapshot
  fs.writeFileSync(LATEST, JSON.stringify(
    { fetchedAt: when.toISOString(), recordCount: records.length, snapshot: curSnap }, null, 2) + "\n");

  // hand a short summary to the workflow (for the PR title/body) via GITHUB_OUTPUT
  const summary = changes.length
    ? `${changes.length} change${changes.length > 1 ? "s" : ""}`
    : "no changes";
  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    fs.appendFileSync(out, `summary=${summary}\n`);
    fs.appendFileSync(out, `stamp=${stamp(when)}\n`);
    fs.appendFileSync(out, `changed=${changes.length > 0 ? "true" : "false"}\n`);
  }
  console.log(`Done — ${summary}. Wrote ${path.relative(ROOT, changesFile)}.`);
}

main().catch(err => { console.error(err); process.exit(1); });
