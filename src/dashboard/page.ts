/**
 * The dashboard page: one self-contained HTML document, no build step and no
 * external assets, served by `src/dashboard/server.ts`. Data rendering uses
 * DOM APIs with `textContent` only — task prompts and summaries are data,
 * never markup. Polling pauses while the tab is hidden.
 */
export function dashboardPage(projectLabel: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agents-cron dashboard</title>
<style>
  :root {
    --bg: #0f141a; --panel: #161d26; --panel2: #1c2530; --line: #26313e;
    --text: #dbe4ee; --dim: #8296ab; --accent: #34d399;
    --success: #34d399; --error: #f87171; --missed: #fbbf24; --running: #60a5fa; --skipped: #94a3b8;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
         font: 14px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; }
  header { display: flex; align-items: baseline; gap: 12px; padding: 18px 24px 10px;
           border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  header h1 { margin: 0; font-size: 18px; font-family: var(--mono); letter-spacing: .5px; }
  header h1 .dot { color: var(--accent); }
  header .meta { color: var(--dim); font-size: 12px; font-family: var(--mono); }
  main { padding: 16px 24px 48px; max-width: 1200px; margin: 0 auto; }
  .empty { color: var(--dim); font-family: var(--mono); padding: 24px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: var(--dim); font-weight: 500; font-size: 11px;
       text-transform: uppercase; letter-spacing: .08em; padding: 8px 10px;
       border-bottom: 1px solid var(--line); }
  td { padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  tr.task { cursor: pointer; }
  tr.task:hover td { background: var(--panel); }
  tr.task.selected td { background: var(--panel2); }
  .id { font-family: var(--mono); font-size: 12px; }
  .dim { color: var(--dim); }
  .break { word-break: break-word; }
  .state { font-family: var(--mono); font-size: 11px; padding: 1px 7px; border-radius: 3px;
           border: 1px solid var(--line); }
  .state.on { color: var(--accent); border-color: var(--accent); }
  .state.off { color: var(--dim); }
  .chip { display: inline-block; font-family: var(--mono); font-size: 11px;
          padding: 1px 7px; border-radius: 9px; }
  .chip.success { color: var(--success); background: rgba(52,211,153,.12); }
  .chip.error { color: var(--error); background: rgba(248,113,113,.12); }
  .chip.missed { color: var(--missed); background: rgba(251,191,36,.12); }
  .chip.running { color: var(--running); background: rgba(96,165,250,.12); animation: pulse 1.6s infinite; }
  .chip.skipped { color: var(--skipped); background: rgba(148,163,184,.12); }
  @keyframes pulse { 50% { opacity: .45; } }
  section.detail { margin-top: 22px; }
  section.detail h2 { font-size: 13px; color: var(--dim); text-transform: uppercase;
                      letter-spacing: .08em; margin: 0 0 8px; font-family: var(--mono); }
  ul.runs { list-style: none; margin: 0 0 18px; padding: 0; }
  ul.runs li { padding: 8px 10px; border: 1px solid var(--line); border-bottom: 0;
               cursor: pointer; font-size: 13px; background: var(--panel); }
  ul.runs li:last-child { border-bottom: 1px solid var(--line); }
  ul.runs li:hover { background: var(--panel2); }
  ul.runs li.selected { background: var(--panel2); }
  .run-detail { border: 1px solid var(--line); background: var(--panel); padding: 14px 16px; }
  .kv { display: grid; grid-template-columns: 110px 1fr; gap: 3px 12px; font-size: 13px; margin-bottom: 10px; }
  .kv dt { color: var(--dim); font-family: var(--mono); font-size: 12px; }
  .kv dd { margin: 0; word-break: break-word; }
  pre.record { margin: 8px 0 0; padding: 12px; background: var(--bg); border: 1px solid var(--line);
               border-radius: 4px; overflow: auto; max-height: 420px; font: 12px/1.45 var(--mono);
               color: var(--text); white-space: pre-wrap; }
  .linkish { color: var(--running); cursor: pointer; text-decoration: underline dotted; font-size: 12px; }
  .refresh-note { font-size: 11px; color: var(--dim); font-family: var(--mono); }
</style>
</head>
<body>
<header>
  <h1><span class="dot">◷</span> agents-cron</h1>
  <span class="meta" id="project"></span>
  <span class="meta" id="stamp"></span>
</header>
<main>
  <div id="tasks" class="empty">Loading…</div>
  <section class="detail" id="task-detail" hidden>
    <h2 id="detail-title"></h2>
    <ul class="runs" id="runs"></ul>
    <div class="run-detail" id="run-detail" hidden></div>
  </section>
</main>
<script>
"use strict";
const state = { selectedTask: null, selectedRun: null };
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const rel = (iso) => {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const diff = then - Date.now();
  const abs = Math.abs(diff);
  const units = [[864e5, "d"], [36e5, "h"], [6e4, "m"], [1e3, "s"]];
  let value = abs, unit = "s";
  for (const [ms, name] of units) { if (abs >= ms) { value = Math.floor(abs / ms); unit = name; break; } }
  const short = value + unit + (diff >= 0 ? " from now" : " ago");
  return short;
};
const dur = (a, b) => {
  if (!a || !b) return "—";
  const ms = Date.parse(b) - Date.parse(a);
  if (Number.isNaN(ms) || ms < 0) return "—";
  if (ms < 1000) return ms + "ms";
  if (ms < 6e4) return (ms / 1000).toFixed(1) + "s";
  return Math.round(ms / 6e4) + "m";
};
const scheduleLabel = (s) => {
  if (!s) return "—";
  if (s.kind === "cron") return "cron " + s.expression;
  if (s.kind === "interval") {
    const mins = s.everyMs / 6e4;
    if (mins >= 1440 && mins % 1440 === 0) return "every " + (mins / 1440) + "d";
    if (mins >= 60 && mins % 60 === 0) return "every " + (mins / 60) + "h";
    return "every " + Math.round(mins) + "m";
  }
  return "once";
};

async function refreshOverview() {
  let data;
  try { data = await (await fetch("api/overview")).json(); }
  catch { document.getElementById("stamp").textContent = "connection lost; retrying"; return; }
  document.getElementById("stamp").textContent = "updated " + new Date(data.generatedAt).toLocaleTimeString();
  renderTasks(data.tasks);
}

function renderTasks(tasks) {
  const host = document.getElementById("tasks");
  host.className = "";
  host.textContent = "";
  if (!tasks.length) { host.className = "empty"; host.textContent = "No scheduled tasks."; return; }
  const table = el("table");
  const head = el("tr");
  for (const label of ["", "task", "schedule", "agent", "next run", "last run"]) {
    const th = el("th", label ? undefined : "state-col", label);
    head.appendChild(th);
  }
  const thead = el("thead");
  thead.appendChild(head);
  table.appendChild(thead);
  const tbody = el("tbody");
  for (const task of tasks) {
    const row = el("tr", "task" + (state.selectedTask === task.id ? " selected" : ""));
    row.appendChild(el("td", null, task.enabled ? "●" : "○")).firstChild.className = "dim";
    const nameCell = el("td", "id break");
    nameCell.appendChild(document.createTextNode(task.name || task.id));
    const idLine = el("div", "dim", task.id);
    nameCell.appendChild(idLine);
    if (task.agent) nameCell.appendChild(el("div", "dim", "@" + task.agent));
    row.appendChild(nameCell);
    row.appendChild(el("td", "id", scheduleLabel(task.schedule)));
    row.appendChild(el("td", "id", task.agent || "pi"));
    row.appendChild(el("td", null, rel(task.nextRunAt)));
    const last = el("td");
    if (task.latestRun) {
      last.appendChild(el("span", "chip " + task.latestRun.status, task.latestRun.status));
      last.appendChild(el("div", "dim", rel(task.latestRun.finishedAt || task.latestRun.startedAt)));
    } else last.appendChild(el("span", "dim", "never"));
    row.appendChild(last);
    row.addEventListener("click", () => selectTask(task.id));
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  host.appendChild(table);
}

async function selectTask(taskId) {
  state.selectedTask = taskId;
  state.selectedRun = null;
  document.getElementById("run-detail").hidden = true;
  await refreshOverview();
  await refreshRuns();
}

async function refreshRuns() {
  const section = document.getElementById("task-detail");
  const list = document.getElementById("runs");
  if (!state.selectedTask) { section.hidden = true; return; }
  section.hidden = false;
  document.getElementById("detail-title").textContent = "runs — " + state.selectedTask;
  let data;
  try { data = await (await fetch("api/runs?taskId=" + encodeURIComponent(state.selectedTask))).json(); }
  catch { list.textContent = ""; list.appendChild(el("li", "dim", "failed to load runs")); return; }
  list.textContent = "";
  if (!data.runs.length) { list.appendChild(el("li", "dim", "no runs recorded yet")); return; }
  for (const run of data.runs) {
    const li = el("li", state.selectedRun === run.runId ? "selected" : null);
    li.appendChild(el("span", "chip " + run.status, run.status));
    li.appendChild(document.createTextNode("  " + new Date(run.startedAt).toLocaleString()));
    li.appendChild(el("span", "dim", "  · " + run.trigger + " · " + dur(run.startedAt, run.finishedAt)));
    li.addEventListener("click", () => selectRun(run));
    list.appendChild(li);
  }
}

function selectRun(run) {
  state.selectedRun = run.runId;
  const box = document.getElementById("run-detail");
  box.hidden = false;
  box.textContent = "";
  const kv = el("dl", "kv");
  const add = (key, value) => { kv.appendChild(el("dt", null, key)); kv.appendChild(el("dd", "break", value)); };
  add("run", run.runId);
  add("status", run.status + (run.exitCode !== undefined ? " (exit " + run.exitCode + ")" : ""));
  add("started", new Date(run.startedAt).toLocaleString());
  add("duration", dur(run.startedAt, run.finishedAt));
  add("agent", run.agent || "—");
  if (run.summary) add("summary", run.summary);
  if (run.error) add("error", run.error);
  box.appendChild(kv);
  const link = el("div", "linkish", "load session record");
  const pre = el("pre", "record", "");
  link.addEventListener("click", async () => {
    link.textContent = "loading…";
    try {
      const res = await fetch("api/session/" + encodeURIComponent(run.taskId) + "/" + encodeURIComponent(run.runId));
      link.textContent = res.ok ? "session record" : "session record: none found (" + res.status + ")";
      pre.textContent = res.ok ? await res.text() : "";
    } catch { link.textContent = "session record: fetch failed"; }
    if (pre.textContent && !box.contains(pre)) box.appendChild(pre);
  });
  box.appendChild(link);
}

document.getElementById("project").textContent = "${escapeJs(projectLabel)}";
refreshOverview();
refreshRuns();
setInterval(() => { if (document.visibilityState === "visible") { refreshOverview(); refreshRuns(); } }, 3000);
</script>
</body>
</html>
`;
}

function escapeJs(text: string): string {
  return text.replace(/[\\$"'\n\r<>&]/g, (ch) =>
    ({ "\\": "\\\\", $: "\\$", "'": "\\'", '"': '\\"', "\n": "\\n", "\r": "\\r", "<": "\\u003c", ">": "\\u003e", "&": "\\u0026" })[ch] ?? ch,
  );
}
