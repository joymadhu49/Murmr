const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

let recording = false;
let btn, status, providerInfo;
let statWords, statWpm, statStreak;
let statWords2, statWpm2, statStreak2, statSessions;
let profileWords, profileBar, profileStatus, profileInfo;
let historyContainer, historySearchEl, historyCountEl;
let historyItems = [];
let historyQuery = "";
let activeTab = "home";

// Settings tab elements
let modelsEl, langEl, autoPasteEl, settingsStatusEl;
let providerInputs, groqSection, groqKeyEl, groqModelEl, groqStatusEl, groqTestBtn;
let downloading = new Map();

function setRecording(on) {
  recording = on;
  btn.textContent = on ? "Stop & transcribe" : "Start recording";
}

function fmtNumber(n) {
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return n.toString();
}

function fmtTime(ts) {
  const d = new Date(ts * 1000);
  let h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, "0");
  const am = h < 12 ? "AM" : "PM";
  h = h % 12 || 12;
  return `${h}:${m} ${am}`;
}

function dayLabel(ts) {
  const d = new Date(ts * 1000);
  const now = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (startOf(now) - startOf(d)) / 86400000;
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function rowHtml(e) {
  return `
    <div class="history-row ${e.flagged ? "flagged" : ""}" data-id="${e.id}">
      <div class="time">${fmtTime(e.ts)}</div>
      <div class="text">${escapeHtml(e.text)}</div>
      <div class="actions">
        <button class="icon-btn" data-act="copy" title="Copy">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><rect x="4" y="4" width="11" height="11" rx="2"/></svg>
        </button>
        <button class="icon-btn" data-act="flag" title="Flag">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 21V4h12l-2 4 2 4H5"/></svg>
        </button>
        <button class="icon-btn danger" data-act="delete" title="Delete">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2m-9 0v14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V6"/></svg>
        </button>
      </div>
    </div>
  `;
}

function renderHistory() {
  const all = historyItems;
  const q = historyQuery.trim().toLowerCase();
  const items = q ? all.filter((e) => (e.text || "").toLowerCase().includes(q)) : all;
  if (historyCountEl) {
    historyCountEl.textContent = q
      ? `${items.length} of ${all.length}`
      : (all.length ? `${all.length} dictations` : "");
  }
  if (!all.length) {
    historyContainer.innerHTML = `<div class="empty">No dictations yet. Hold <b>Ctrl + Shift + Space</b> and speak.</div>`;
    return;
  }
  if (!items.length) {
    historyContainer.innerHTML = `<div class="empty">No matches for "${escapeHtml(historyQuery)}".</div>`;
    return;
  }
  const groups = new Map();
  for (const e of items) {
    const k = dayLabel(e.ts);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  let html = "";
  for (const [label, rows] of groups) {
    html += `<div class="section-label">${label}</div>`;
    html += `<div class="history-list">${rows.map(rowHtml).join("")}</div>`;
  }
  historyContainer.innerHTML = html;
  historyContainer.querySelectorAll(".icon-btn").forEach((b) => b.addEventListener("click", onRowAction));
}

async function onRowAction(e) {
  e.stopPropagation();
  const row = e.currentTarget.closest(".history-row");
  const id = row.dataset.id;
  const act = e.currentTarget.dataset.act;
  if (act === "copy") {
    const text = row.querySelector(".text").textContent;
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = "Copied.";
    } catch {
      status.textContent = "Copy failed.";
    }
  } else if (act === "flag") {
    await invoke("flag_history_item", { id });
    await refreshAll();
  } else if (act === "delete") {
    await invoke("delete_history_item", { id });
    await refreshAll();
  }
}

async function refreshHistory() {
  historyItems = await invoke("list_history", { limit: 200 });
  renderHistory();
}

async function refreshStats() {
  const s = await invoke("get_stats");
  statWords.textContent = fmtNumber(s.total_words);
  statWpm.textContent = s.wpm;
  statStreak.textContent = s.streak;
  statWords2.textContent = s.total_words.toLocaleString();
  statWpm2.textContent = s.wpm;
  statStreak2.textContent = s.streak;
  statSessions.textContent = s.sessions;
  const profSize = s.voice_profile_size || 0;
  const pct = Math.min(100, Math.round((profSize / 220) * 100));
  profileBar.style.width = pct + "%";
  profileStatus.textContent = profSize > 0
    ? `Tracking ${profSize} chars of personalized vocabulary`
    : "Keep dictating to build your profile";
  profileInfo.textContent = profSize > 0
    ? "Sent to Whisper as a context prompt to bias recognition."
    : "First few dictations build the profile.";
}

async function refreshSettingsCard() {
  try {
    const s = await invoke("get_settings");
    const prov = s.provider === "groq" ? `Groq · ${s.groq_model}` : `Local · ${s.active_model}`;
    providerInfo.textContent = `${prov} · lang=${s.language || "auto"}`;
  } catch {
    providerInfo.textContent = "—";
  }
}

async function refreshProfile() {
  const items = await invoke("list_history", { limit: 300 });
  if (!items.length) {
    profileWords.textContent = "(empty — dictate a few times to build profile)";
    return;
  }
  const counts = new Map();
  for (const e of items) {
    for (let w of (e.text || "").split(/[^A-Za-z0-9']+/)) {
      w = w.toLowerCase().trim();
      if (w.length < 4) continue;
      counts.set(w, (counts.get(w) || 0) + 1);
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 80);
  profileWords.textContent = top.map(([w, c]) => `${w} (${c})`).join(", ") || "(empty)";
}

async function refreshAll() {
  await Promise.all([refreshHistory(), refreshStats(), refreshSettingsCard()]);
}

async function toggle() {
  if (!recording) {
    try {
      await invoke("start_recording");
      setRecording(true);
      status.textContent = "Recording… click Stop or press F9.";
    } catch (e) {
      status.textContent = "Error: " + e;
    }
  } else {
    btn.disabled = true;
    status.textContent = "Transcribing…";
    try {
      const text = await invoke("stop_recording");
      status.textContent = `Done. "${text.slice(0, 60)}${text.length > 60 ? "…" : ""}"`;
    } catch (e) {
      status.textContent = "Error: " + e;
    }
    btn.disabled = false;
    setRecording(false);
  }
}

async function cancel() {
  try {
    await invoke("cancel_recording");
    setRecording(false);
    status.textContent = "Cancelled.";
  } catch (e) {
    status.textContent = "Error: " + e;
  }
}

function setTab(t) {
  activeTab = t;
  document.querySelectorAll(".nav-btn[data-tab]").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === t);
  });
  document.getElementById("home-tab").style.display = t === "home" ? "" : "none";
  document.getElementById("stats-tab").style.display = t === "stats" ? "" : "none";
  document.getElementById("profile-tab").style.display = t === "profile" ? "" : "none";
  document.getElementById("settings-tab").style.display = t === "settings" ? "" : "none";
  document.querySelector(".main").classList.toggle("full", t !== "home");
  document.getElementById("right-col").style.display = t === "home" ? "" : "none";
  if (t === "profile") refreshProfile();
  if (t === "settings") refreshSettings();
}

// ============ Settings tab logic (was settings.js) ============

function modelRow(m) {
  const dl = downloading.get(m.id);
  const pct = dl && dl.total ? Math.min(100, (dl.bytes / dl.total) * 100) : (dl ? 1 : 0);
  const showProgress = !!dl;
  const actions = [];
  if (m.downloaded) {
    if (m.active) actions.push(`<span class="tag ok">Active</span>`);
    else {
      actions.push(`<button class="btn" data-act="activate" data-id="${m.id}">Use this</button>`);
      actions.push(`<button class="btn danger" data-act="delete" data-id="${m.id}">Delete</button>`);
    }
  } else if (dl) {
    actions.push(`<span class="muted small">Downloading ${pct.toFixed(0)}%</span>`);
  } else {
    actions.push(`<button class="btn primary" data-act="download" data-id="${m.id}">Download</button>`);
  }
  return `
    <div class="model ${m.active ? "active" : ""}">
      <div class="model-head">
        <div>
          <div class="model-title">${m.label}</div>
          <div class="model-meta">${m.lang === "en" ? "English-only" : "Multilingual"} · id: ${m.id}</div>
        </div>
        <div class="row">${actions.join("")}</div>
      </div>
      ${showProgress ? `<div class="progress"><div class="bar" style="width:${pct}%"></div></div>` : ""}
    </div>
  `;
}

async function refreshModels() {
  const models = await invoke("list_models");
  modelsEl.innerHTML = models.map(modelRow).join("");
  modelsEl.querySelectorAll("button[data-act]").forEach((b) => b.addEventListener("click", onModelAction));
}

async function refreshSettings() {
  const s = await invoke("get_settings");
  langEl.value = s.language || "auto";
  autoPasteEl.checked = !!s.auto_paste;
  providerInputs.forEach((r) => (r.checked = r.value === (s.provider || "local")));
  groqKeyEl.value = s.groq_api_key || "";
  if (groqModelEl.options.length === 0) {
    const models = await invoke("list_groq_models");
    groqModelEl.innerHTML = models.map((m) => `<option value="${m}">${m}</option>`).join("");
  }
  groqModelEl.value = s.groq_model || "whisper-large-v3-turbo";
  groqSection.style.display = (s.provider === "groq") ? "block" : "none";
  await refreshModels();
}

async function onModelAction(e) {
  const id = e.currentTarget.dataset.id;
  const act = e.currentTarget.dataset.act;
  try {
    if (act === "download") {
      downloading.set(id, { bytes: 0, total: 0 });
      settingsStatusEl.textContent = `Downloading ${id}…`;
      await invoke("download_model", { id });
      await refreshModels();
    } else if (act === "activate") {
      const s = await invoke("set_active_model", { id });
      settingsStatusEl.textContent = `Active model set to ${s.active_model}.`;
      await refreshModels();
      await refreshSettingsCard();
    } else if (act === "delete") {
      await invoke("delete_model", { id });
      settingsStatusEl.textContent = `Deleted ${id}.`;
      await refreshModels();
    }
  } catch (err) {
    settingsStatusEl.textContent = "Error: " + err;
  }
}

async function saveBehavior() {
  const s = await invoke("get_settings");
  s.language = langEl.value;
  s.auto_paste = autoPasteEl.checked;
  s.provider = [...providerInputs].find((r) => r.checked)?.value || "local";
  s.groq_api_key = groqKeyEl.value.trim();
  s.groq_model = groqModelEl.value;
  await invoke("update_settings", { settings: s });
  groqSection.style.display = (s.provider === "groq") ? "block" : "none";
  settingsStatusEl.textContent = "Settings saved.";
  await refreshSettingsCard();
}

async function testGroq() {
  groqStatusEl.textContent = "Testing…";
  try {
    const msg = await invoke("test_groq", { apiKey: groqKeyEl.value.trim() });
    groqStatusEl.textContent = msg;
    groqStatusEl.style.color = "var(--good)";
  } catch (e) {
    groqStatusEl.textContent = "Failed: " + e;
    groqStatusEl.style.color = "var(--bad)";
  }
}

async function clearHistoryAction() {
  if (!confirm("Clear all dictation history? This also resets your voice profile and stats.")) return;
  await invoke("clear_history");
  await refreshAll();
  settingsStatusEl.textContent = "History cleared.";
}

window.addEventListener("DOMContentLoaded", async () => {
  btn = document.querySelector("#rec");
  status = document.querySelector("#status");
  providerInfo = document.querySelector("#provider-info");
  statWords = document.querySelector("#stat-words");
  statWpm = document.querySelector("#stat-wpm");
  statStreak = document.querySelector("#stat-streak");
  statWords2 = document.querySelector("#stat-words-2");
  statWpm2 = document.querySelector("#stat-wpm-2");
  statStreak2 = document.querySelector("#stat-streak-2");
  statSessions = document.querySelector("#stat-sessions");
  profileWords = document.querySelector("#profile-words");
  profileBar = document.querySelector("#profile-bar");
  profileStatus = document.querySelector("#profile-status");
  profileInfo = document.querySelector("#profile-info");
  historyContainer = document.querySelector("#history-container");
  historySearchEl = document.querySelector("#history-search");
  historyCountEl = document.querySelector("#history-count");
  if (historySearchEl) {
    let searchTimer = null;
    historySearchEl.addEventListener("input", (e) => {
      const v = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        historyQuery = v;
        renderHistory();
      }, 120);
    });
  }

  modelsEl = document.querySelector("#models");
  langEl = document.querySelector("#lang");
  autoPasteEl = document.querySelector("#auto-paste");
  settingsStatusEl = document.querySelector("#settings-status");
  providerInputs = document.querySelectorAll('input[name="provider"]');
  groqSection = document.querySelector("#groq-section");
  groqKeyEl = document.querySelector("#groq-key");
  groqModelEl = document.querySelector("#groq-model");
  groqStatusEl = document.querySelector("#groq-status");
  groqTestBtn = document.querySelector("#groq-test");
  const groqKeyToggle = document.querySelector("#groq-key-toggle");
  if (groqKeyToggle) {
    groqKeyToggle.addEventListener("click", () => {
      const isPwd = groqKeyEl.type === "password";
      groqKeyEl.type = isPwd ? "text" : "password";
      groqKeyToggle.textContent = isPwd ? "Hide" : "Show";
    });
  }

  btn.addEventListener("click", toggle);
  const cancelBtn = document.querySelector("#cancel-rec");
  if (cancelBtn) cancelBtn.addEventListener("click", cancel);

  // Hero collapse toggle
  const hero = document.querySelector("#hero-card");
  const heroToggle = document.querySelector("#hero-toggle");
  const applyHero = (compact) => {
    hero.classList.toggle("compact", compact);
  };
  applyHero(localStorage.getItem("heroCompact") === "1");
  heroToggle.addEventListener("click", () => {
    const next = !hero.classList.contains("compact");
    applyHero(next);
    localStorage.setItem("heroCompact", next ? "1" : "0");
  });

  document.querySelectorAll(".nav-btn[data-tab]").forEach((b) => {
    b.addEventListener("click", () => setTab(b.dataset.tab));
  });

  langEl.addEventListener("change", saveBehavior);
  autoPasteEl.addEventListener("change", saveBehavior);
  providerInputs.forEach((r) => r.addEventListener("change", saveBehavior));
  groqKeyEl.addEventListener("change", saveBehavior);
  groqKeyEl.addEventListener("blur", saveBehavior);
  groqModelEl.addEventListener("change", saveBehavior);
  groqTestBtn.addEventListener("click", testGroq);
  document.querySelector("#clear-history").addEventListener("click", clearHistoryAction);

  await listen("rec-state", (e) => {
    const s = e.payload;
    if (s === "recording") {
      setRecording(true);
      status.textContent = "Recording… click Stop or press F9.";
    } else if (s === "transcribing") {
      status.textContent = "Transcribing…";
    } else if (s === "done") {
      setRecording(false);
      status.textContent = "Done. Pasted + clipboard.";
    } else if (s === "idle") {
      setRecording(false);
    }
  });
  await listen("rec-error", (e) => {
    status.textContent = "Error: " + e.payload;
    setRecording(false);
  });
  await listen("history-changed", () => refreshAll());
  await listen("settings-changed", refreshSettingsCard);
  await listen("model-progress", async (e) => {
    const p = e.payload;
    if (p.error) {
      downloading.delete(p.id);
      settingsStatusEl.textContent = `Download failed (${p.id}): ${p.error}`;
      await refreshModels();
      return;
    }
    if (p.done) {
      downloading.delete(p.id);
      settingsStatusEl.textContent = `Downloaded ${p.id}.`;
      await refreshModels();
      return;
    }
    downloading.set(p.id, { bytes: p.bytes, total: p.total });
    await refreshModels();
  });

  await refreshAll();
});
