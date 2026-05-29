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
function ensureDirs() { [DATA_DIR, CHANGES_DIR, LISTS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true })); }
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
      if (!c || !c.code) return;
      endpoints[c.code] = true;
      codes[c.code] = c.type || "signal";       // remember signal vs command per code
      if (c.type === "command" && /charge/i.test(c.code)) controls[c.code] = true;
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
     - EV battery capacity   -> tractionbattery-nominalcapacity
     - EV battery (SOC)       -> tractionbattery-stateofcharge
     - EV charging status     -> ANY of: charge-ischarging,
                                  charge-detailedchargingstatus,
                                  charge-ischargingcableconnected
     - Location               -> location-preciselocation
     - Odometer               -> odometer-traveleddistance

   MANAGED (control-eligible): has the full tracking set AND BOTH commands
     charge-start AND charge-stop.
   TRACKING: has the full tracking set but is missing start and/or stop.
   Anything missing a required tracking endpoint -> excluded (null).
   A blocklist overlay forces TRACKING even if start/stop are present.
   ------------------------------------------------------------------------- */
const REQUIRED_TRACKING = [
  ["tractionbattery-nominalcapacity", "tractionbattery-range"],                 // battery capacity
  ["tractionbattery-stateofcharge"],                   // battery (SOC)
  ["charge-ischarging"], // charging status (any one)
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
                   years: g.years, sig: g.sig, classification: g.classification };
  });
  return map;
}

/* ---------------------------------------------------------------- diff */
function diff(curSnap, baseSnap) {
  const changes = [];
  for (const k in curSnap) {
    const c = curSnap[k], b = baseSnap[k];
    if (!b) { changes.push({ type: "add", g: c }); continue; }
    if ((c.years || []).join(",") !== (b.years || []).join(",")) changes.push({ type: "year_bump", g: c, b });
    if ((c.sig || "") !== (b.sig || "")) changes.push({ type: "endpoint_change", g: c, b });
  }
  for (const k in baseSnap) if (!curSnap[k]) changes.push({ type: "remove", b: baseSnap[k] });
  return changes;
}

/* ---------------------------------------------------------------- outputs */
function label(g) { return `${g.make} ${g.model} (${g.region}·${g.powertrain})`; }
function cls(c) { return c === "MANAGED" ? "Managed" : c === "TRACKING" ? "Tracking Only" : "excluded"; }

function renderChangesMd(changes, when, counts, staleOverlays) {
  const byType = t => changes.filter(c => c.type === t);
  const lines = [];
  lines.push(`# Changes — ${when.toISOString().replace("T", " ").slice(0, 16)} UTC`, "");
  if (!changes.length) {
    lines.push("**No changes since the last saved version.** The current data matches the baseline.", "");
  } else {
    lines.push(`**${changes.length} change${changes.length > 1 ? "s" : ""} detected** since the last saved version.`, "");
    const sec = (title, arr, fmt) => {
      if (!arr.length) return;
      lines.push(`## ${title} (${arr.length})`, "");
      arr.forEach(c => lines.push("- " + fmt(c)));
      lines.push("");
    };
    sec("Added", byType("add"), c => `**${label(c.g)}** — years \`${yearRange(c.g.years)}\` · ${cls(c.g.classification)}`);
    sec("Year bumps", byType("year_bump"), c => `**${label(c.g)}** — \`${yearRange(c.b.years)}\` → \`${yearRange(c.g.years)}\``);
    sec("Endpoint changes", byType("endpoint_change"), c => {
      const flip = c.b.classification !== c.g.classification ? ` · ${cls(c.b.classification)} → ${cls(c.g.classification)}` : "";
      return `**${label(c.g)}** — capabilities changed${flip}`;
    });
    sec("Removed", byType("remove"), c => `**${label(c.b)}** — was years \`${yearRange(c.b.years)}\`, no longer present`);
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

function listRows(groups, region, classification) {
  return groups
    .filter(g => g.region === region && g.classification === classification)
    .sort((a, b) => a.make.localeCompare(b.make) || a.model.localeCompare(b.model))
    .map(g => ({ make: g.make, model: g.model + (yearRange(g.years) ? " " + yearRange(g.years) : ""),
                 type: classification === "MANAGED" ? "Managed" : "Tracking Only" }));
}
function listHTML(title, recs) {
  return `<!-- ${title} — ${recs.length} rows -->
<table>
  <thead><tr><th>Make</th><th>Model</th><th>Type</th></tr></thead>
  <tbody>
${recs.map(r => `    <tr><td>${esc(r.make)}</td><td>${esc(r.model)}</td><td>${esc(r.type)}</td></tr>`).join("\n")}
  </tbody>
</table>
`;
}
function listMD(title, recs) {
  return `# ${title} (${recs.length})\n\n| Make | Model | Type |\n|---|---|---|\n` +
    recs.map(r => `| ${r.make} | ${r.model} | ${r.type} |`).join("\n") + "\n";
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
  defs.forEach(([id, region, classification, title]) => {
    const recs = listRows(groups, region, classification);
    counts[id] = recs.length;
    const base = id.toLowerCase().replace("_", "-");
    fs.writeFileSync(path.join(LISTS_DIR, base + ".html"), listHTML(title, recs));
    fs.writeFileSync(path.join(LISTS_DIR, base + ".md"), listMD(title, recs));
  });

  // timestamped change log (always written, even "no changes", so runs are auditable)
  const changesFile = path.join(CHANGES_DIR, `${stamp(when)}.md`);
  fs.writeFileSync(changesFile, renderChangesMd(changes, when, counts, staleOverlays));

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
