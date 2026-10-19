// SegDown popup (4.4): a "Toggle panel" button for the active tab (with a
// default_popup, chrome.action.onClicked never fires) and the jobs: this tab's
// (jobs:<tabId>) and the app's other recent ones. Talks only to the hub
// (background.js, "Popup" in its protocol), never to the app; the hub sends
// summaries without URLs or headers. Polls `jobs` every POLL_MS while a listed
// job is queued or running. DOM is built with createElement/textContent only.

"use strict";

(() => {
  const POLL_MS = 1000;
  const STATE_LABEL = {
    queued: "Queued", running: "Running", done: "Done", failed: "Failed", cancelled: "Cancelled", unknown: "Unknown",
  };
  const ERROR_TEXT = {
    "unknown-job": "That job is gone.",
    "no-reply": "SegDown's background page did not answer.",
  };

  const ui = {
    toggle: document.getElementById("toggle"),
    error: document.getElementById("error"),
    tabJobs: document.getElementById("tab-jobs"),
    recentJobs: document.getElementById("recent-jobs"),
  };
  let tabId = null;
  let timer = null;
  let gen = 0;
  let appError = "";
  let actionError = ""; // the last failed Toggle / Cancel, until the next one

  function ask(msg) {
    try {
      return chrome.runtime.sendMessage(msg).then(
        (r) => r || { ok: false, error: "no-reply" },
        () => ({ ok: false, error: "no-reply" })
      );
    } catch {
      return Promise.resolve({ ok: false, error: "no-reply" });
    }
  }

  const errorText = (r) =>
    (typeof r.message === "string" && r.message) || ERROR_TEXT[r.error] || `Failed (${String(r.error || "unknown")}).`;

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else e.setAttribute(k, v);
    }
    for (const c of children) e.append(c);
    return e;
  }

  const isActive = (j) => j.state === "queued" || j.state === "running";
  const isJob = (j) => j && typeof j === "object" && typeof j.id === "string";
  const jobList = (list) => (Array.isArray(list) ? list.filter(isJob) : []);

  // "Segment 2/5 · 37%"; a queued job shows its segment count.
  function progressText(j) {
    const n = Number.isInteger(j.segmentCount) ? j.segmentCount : 0;
    if (!n) return "";
    if (j.state === "queued") return `${n} segment${n === 1 ? "" : "s"}`;
    const i = Number.isInteger(j.segmentIndex) ? Math.min(j.segmentIndex + 1, n) : 1;
    const pct = Math.round(Math.max(0, Math.min(1, Number(j.fraction) || 0)) * 100);
    return `Segment ${i}/${n} · ${pct}%`;
  }

  // One row per job id, reused across polls so a Cancel click is not lost to a rebuild.
  const rows = new Map();

  function jobRow(id) {
    let row = rows.get(id);
    if (row) return row;
    row = {
      title: el("span", { class: "jtitle" }),
      state: el("span", { class: "jstate" }),
      cancel: el("button", { class: "jcancel", type: "button", text: "Cancel" }),
      fill: el("div", { class: "fill" }),
      info: el("div", { class: "jinfo" }),
      msg: el("div", { class: "jmsg" }),
      outputs: el("div", { class: "outputs" }),
    };
    row.cancel.addEventListener("click", () => cancel(id, row.cancel));
    row.li = el(
      "li",
      { class: "job" },
      el("div", { class: "jhead" }, row.title, row.state, row.cancel),
      el("div", { class: "bar" }, row.fill),
      row.info,
      row.msg,
      row.outputs
    );
    rows.set(id, row);
    return row;
  }

  function updateRow(j) {
    const row = jobRow(j.id);
    const title = String(j.title || "");
    row.title.textContent = title;
    row.title.title = title;
    const known = Object.hasOwn(STATE_LABEL, j.state);
    row.state.textContent = known ? STATE_LABEL[j.state] : String(j.state);
    row.state.className = `jstate ${known ? j.state : ""}`;
    row.cancel.hidden = !isActive(j);
    const frac = Math.max(0, Math.min(1, Number(j.fraction) || 0));
    row.fill.style.setProperty("width", `${(frac * 100).toFixed(1)}%`);
    row.info.textContent = progressText(j);
    const msg = typeof j.message === "string" ? j.message : "";
    row.msg.textContent = msg;
    row.msg.hidden = !msg;
    row.msg.classList.toggle("warn", j.state === "failed");
    const names = j.state === "done" && Array.isArray(j.outputs) ? j.outputs.filter((o) => typeof o === "string") : [];
    const sig = JSON.stringify(names);
    if (row.outputsSig !== sig) {
      row.outputsSig = sig;
      const lines = names.map((name) => el("div", { text: name, title: name }));
      if (names.length) lines.push(el("div", { class: "note", text: "Open them from the SegDown menu bar." }));
      row.outputs.replaceChildren(...lines);
    }
    row.outputs.hidden = !names.length;
    return row.li;
  }

  function renderList(ul, jobs, emptyText) {
    const lis = jobs.map(updateRow);
    if (!lis.length) lis.push(el("li", { class: "empty", text: emptyText }));
    const same = lis.length === ul.children.length && lis.every((li, i) => ul.children[i] === li);
    if (!same) ul.replaceChildren(...lis);
  }

  function render(tabJobs, recent) {
    renderList(ui.tabJobs, tabJobs, tabId === null ? "No tab." : "No jobs from this tab.");
    renderList(ui.recentJobs, recent, "No other recent jobs.");
    const shown = new Set(tabJobs.concat(recent).map((j) => j.id));
    for (const id of rows.keys()) if (!shown.has(id)) rows.delete(id);
    const err = [appError, actionError].filter(Boolean).join(" ");
    ui.error.textContent = err;
    ui.error.hidden = !err;
  }

  // Asks the hub once, then again every POLL_MS while a listed job is active.
  async function refresh() {
    clearTimeout(timer);
    timer = null;
    const my = ++gen;
    const r = await ask({ type: "jobs", tabId });
    if (my !== gen) return;
    if (!r.ok) {
      appError = errorText(r);
      render([], []);
      return;
    }
    const tabJobs = jobList(r.jobs);
    const recent = jobList(r.recent);
    appError = typeof r.appError === "string" ? r.appError : "";
    render(tabJobs, recent);
    if (tabJobs.some(isActive) || recent.some(isActive)) timer = setTimeout(refresh, POLL_MS);
  }

  async function cancel(id, button) {
    button.disabled = true;
    const r = await ask({ type: "cancel", id });
    actionError = r.ok ? "" : errorText(r);
    button.disabled = false;
    refresh();
  }

  async function toggle() {
    if (tabId === null) return;
    const r = await ask({ type: "togglePanel", tabId });
    if (r.ok) {
      window.close();
      return;
    }
    actionError = errorText(r);
    refresh();
  }

  // The active tab's id only: chrome.tabs.query returns ids without the tabs permission.
  async function activeTabId() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab && Number.isInteger(tab.id) && tab.id >= 0 ? tab.id : null;
    } catch {
      return null;
    }
  }

  ui.toggle.addEventListener("click", toggle);

  activeTabId().then((id) => {
    tabId = id;
    ui.toggle.disabled = tabId === null;
    refresh();
  });
})();
