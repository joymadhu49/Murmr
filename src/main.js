const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const tauriWindow = window.__TAURI__?.window;

// JS drag fallback — invokes startDragging on mousedown over drag regions.
// Tauri 2's data-tauri-drag-region works natively for most elements but
// can fail with sticky/fixed positioning on macOS. This catches stragglers.
document.addEventListener("mousedown", async (e) => {
  if (e.button !== 0) return;
  const target = e.target;
  if (!(target instanceof Element)) return;
  // Skip if click was on or inside an interactive element
  if (target.closest("button, input, select, textarea, a, .icon-btn, .nav-btn, .topbar-btn, .pill-btn, .hero-collapse, .transcript, [contenteditable]")) {
    return;
  }
  // Only drag from elements marked as drag regions (or topbar/sidebar/main)
  const dragRoot = target.closest("[data-tauri-drag-region], .topbar, .sidebar, .main, .hero-card, .card, .panel");
  if (!dragRoot) return;
  // Don't drag from selectable text content
  if (target.closest(".history-row .text, #profile-words, h1, h2, h3, h4, p")) {
    if (window.getSelection().toString()) return;
  }
  try {
    if (tauriWindow?.getCurrentWindow) {
      await tauriWindow.getCurrentWindow().startDragging();
    }
  } catch (err) {
    // ignore
  }
});

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
let activeModeEl, customVocabEl, customModesListEl, addCustomModeBtn, promptPreviewEl;
let builtinModesCache = null;
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

function renderPromptChips(prompt) {
  if (!prompt || !prompt.length) {
    return `<div class="prompt-empty">(empty — dictate a few times or add custom vocabulary)</div>`;
  }
  const groups = [];
  const re = /([A-Z][A-Za-z ]{2,30}?):\s*([^.]+?)(?=\.\s+[A-Z][A-Za-z ]{2,30}?:|\.?\s*$)/g;
  let m;
  while ((m = re.exec(prompt)) !== null) {
    const label = m[1].trim();
    const items = m[2].split(/[,;]/).map((s) => s.trim().replace(/\.$/, "")).filter(Boolean);
    if (items.length) groups.push({ label, items });
  }
  if (!groups.length) {
    const items = prompt.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    groups.push({ label: "Prompt", items });
  }
  return groups.map((g) => `
    <div class="prompt-group">
      <div class="prompt-group-label">${escapeHtml(g.label)} <span class="muted">${g.items.length}</span></div>
      <div class="chip-row">${g.items.map((t) => `<span class="vocab-chip">${escapeHtml(t)}</span>`).join("")}</div>
    </div>`).join("");
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
  if (statWords) statWords.textContent = fmtNumber(s.total_words);
  if (statWpm) statWpm.textContent = s.wpm;
  if (statStreak) statStreak.textContent = s.streak;
  if (statWords2) statWords2.textContent = s.total_words.toLocaleString();
  if (statWpm2) statWpm2.textContent = s.wpm;
  if (statStreak2) statStreak2.textContent = s.streak;
  if (statSessions) statSessions.textContent = s.sessions;
  // Topbar header chips
  const hdrStreak = document.getElementById("hdr-streak");
  const hdrWords = document.getElementById("hdr-words");
  const hdrWpm = document.getElementById("hdr-wpm");
  if (hdrStreak) hdrStreak.textContent = s.streak;
  if (hdrWords) hdrWords.textContent = fmtNumber(s.total_words);
  if (hdrWpm) hdrWpm.textContent = s.wpm;
  const profSize = s.voice_profile_size || 0;
  const pct = Math.min(100, Math.round((profSize / 880) * 100));
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
    if (providerInfo) providerInfo.textContent = `${prov} · lang=${s.language || "auto"}`;
    if (activeModeEl && !activeModeEl.options.length) {
      await populateModeDropdown(s);
    } else if (activeModeEl) {
      activeModeEl.value = s.active_mode || "notes";
    }
  } catch {
    providerInfo.textContent = "—";
  }
}

const STOPWORDS_JS = new Set([
  "the","and","for","you","that","this","with","have","are","was","but","not",
  "from","they","has","had","were","what","when","your","all","would","there",
  "their","can","will","just","like","get","got","one","out","about","into","some",
  "more","than","then","him","her","his","she","them","now","any","been","being",
  "also","very","much","make","made","going","want","need","know","think","thing",
  "things","really","actually","okay",
]);

async function refreshProfile() {
  const [items, settings, builtins, prompt, stats] = await Promise.all([
    invoke("list_history", { limit: 300 }),
    invoke("get_settings"),
    builtinModesCache ? Promise.resolve(builtinModesCache) : invoke("list_builtin_modes"),
    invoke("preview_voice_prompt"),
    invoke("get_stats"),
  ]);
  builtinModesCache = builtins;

  const promptEl = document.getElementById("profile-prompt");
  if (promptEl) {
    promptEl.innerHTML = renderPromptChips(prompt);
  }

  const sizeEl = document.getElementById("prof-stat-size");
  if (sizeEl) sizeEl.textContent = `${prompt.length} / 880`;
  const bar = document.getElementById("prof-bar");
  if (bar) bar.style.width = Math.min(100, Math.round((prompt.length / 880) * 100)) + "%";

  const vocabLines = (settings.custom_vocab || "")
    .split("\n").map((l) => l.trim()).filter(Boolean);
  const vocabStat = document.getElementById("prof-stat-vocab");
  if (vocabStat) vocabStat.textContent = vocabLines.length;

  const sessEl = document.getElementById("prof-stat-sessions");
  if (sessEl) sessEl.textContent = stats.sessions || 0;

  const modeSel = document.getElementById("profile-active-mode");
  if (modeSel) {
    const builtinOpts = builtins
      .map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join("");
    const customs = settings.custom_modes || [];
    const customOpts = customs.length
      ? `<optgroup label="Custom">${customs
          .map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`)
          .join("")}</optgroup>`
      : "";
    modeSel.innerHTML = builtinOpts + customOpts;
    modeSel.value = settings.active_mode || "notes";
    if (!modeSel.dataset.wired) {
      modeSel.dataset.wired = "1";
      modeSel.addEventListener("change", async () => {
        const s = await invoke("get_settings");
        s.active_mode = modeSel.value || "notes";
        await invoke("update_settings", { settings: s });
        if (activeModeEl) activeModeEl.value = modeSel.value;
        await refreshProfile();
        await refreshStats();
        await refreshPromptPreview();
      });
    }
  }

  const packEl = document.getElementById("profile-mode-pack");
  if (packEl) {
    const activeId = settings.active_mode || "notes";
    const builtin = builtins.find((m) => m.id === activeId);
    const custom = (settings.custom_modes || []).find((m) => m.id === activeId);
    if (builtin && builtin.pack) {
      packEl.textContent = builtin.pack;
    } else if (custom && custom.terms.trim()) {
      packEl.textContent = custom.terms;
    } else {
      packEl.textContent = "(this mode has no curated pack — relies on custom vocab + auto)";
    }
  }

  const vocabListEl = document.getElementById("profile-vocab-list");
  if (vocabListEl) {
    vocabListEl.innerHTML = vocabLines.length
      ? vocabLines.map((t) => `<span class="vocab-chip">${escapeHtml(t)}</span>`).join(" ")
      : "No custom terms yet. Add some in Settings → Voice profile.";
  }
  const editLink = document.getElementById("profile-vocab-edit");
  if (editLink && !editLink.dataset.wired) {
    editLink.dataset.wired = "1";
    editLink.addEventListener("click", () => setTab("settings"));
  }

  const counts = new Map();
  const casing = new Map();
  let autoTotal = 0;
  for (const e of items) {
    for (const raw of (e.text || "").split(/[^A-Za-z0-9']+/)) {
      const w = raw.trim();
      const low = w.toLowerCase();
      const isAcr = w.length >= 2 && /^[A-Z0-9]+$/.test(w);
      if (!w) continue;
      if (!(w.length >= 4 || isAcr)) continue;
      if (STOPWORDS_JS.has(low)) continue;
      counts.set(low, (counts.get(low) || 0) + 1);
      const prev = casing.get(low);
      if (!prev || (/[A-Z]/.test(w) && /[a-z]/.test(w) && !(/[A-Z]/.test(prev) && /[a-z]/.test(prev)))) {
        casing.set(low, w);
      }
      autoTotal++;
    }
  }
  const autoStat = document.getElementById("prof-stat-auto");
  if (autoStat) autoStat.textContent = counts.size;

  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60);
  if (profileWords) {
    profileWords.innerHTML = top.length
      ? top.map(([w, c]) => `<span class="vocab-chip">${escapeHtml(casing.get(w) || w)} <span class="muted">${c}</span></span>`).join(" ")
      : "(empty — dictate a few times)";
  }
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

  if (customVocabEl) customVocabEl.value = s.custom_vocab || "";
  await populateModeDropdown(s);
  renderCustomModes(s.custom_modes || []);
  await refreshPromptPreview();

  await refreshModels();
}

async function populateModeDropdown(s) {
  if (!activeModeEl) return;
  if (!builtinModesCache) {
    builtinModesCache = await invoke("list_builtin_modes");
  }
  const builtinOpts = builtinModesCache
    .map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`)
    .join("");
  const custom = s.custom_modes || [];
  const customOpts = custom.length
    ? `<optgroup label="Custom">${custom
        .map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`)
        .join("")}</optgroup>`
    : "";
  activeModeEl.innerHTML = builtinOpts + customOpts;
  activeModeEl.value = s.active_mode || "notes";
}

function renderCustomModes(modes) {
  if (!customModesListEl) return;
  if (!modes.length) {
    customModesListEl.innerHTML =
      '<div class="muted small" style="padding:10px 0;">No custom modes yet.</div>';
    return;
  }
  customModesListEl.innerHTML = modes
    .map(
      (m) => `
    <div class="custom-mode-row" data-id="${escapeHtml(m.id)}" style="border:1px solid var(--border);border-radius:10px;padding:10px;margin-bottom:8px;">
      <div class="row" style="gap:8px;align-items:center;">
        <input class="cm-name" value="${escapeHtml(m.name)}" placeholder="Mode name" style="flex:1;font-weight:600;" />
        <button class="btn cm-delete" data-id="${escapeHtml(m.id)}" type="button" title="Delete">×</button>
      </div>
      <textarea class="cm-terms" rows="3" placeholder="Terms (one per line, or comma separated)" style="margin-top:8px;width:100%;font-family:ui-monospace,Menlo,monospace;font-size:12px;">${escapeHtml(m.terms)}</textarea>
    </div>`
    )
    .join("");
  customModesListEl.querySelectorAll(".cm-delete").forEach((b) => {
    b.addEventListener("click", () => deleteCustomMode(b.dataset.id));
  });
  customModesListEl.querySelectorAll(".cm-name, .cm-terms").forEach((el) => {
    el.addEventListener("change", saveBehavior);
    el.addEventListener("blur", saveBehavior);
  });
}

async function addCustomMode() {
  const s = await invoke("get_settings");
  const id = "cm_" + Date.now().toString(36);
  s.custom_modes = [...(s.custom_modes || []), { id, name: "New mode", terms: "" }];
  await invoke("update_settings", { settings: s });
  await refreshSettings();
}

async function deleteCustomMode(id) {
  const s = await invoke("get_settings");
  s.custom_modes = (s.custom_modes || []).filter((m) => m.id !== id);
  if (s.active_mode === id) s.active_mode = "notes";
  await invoke("update_settings", { settings: s });
  await refreshSettings();
  await refreshStats();
}

async function refreshPromptPreview() {
  if (!promptPreviewEl) return;
  try {
    const p = await invoke("preview_voice_prompt");
    promptPreviewEl.textContent = p && p.length ? p : "(empty — dictate a few times to build profile)";
  } catch {
    promptPreviewEl.textContent = "(error)";
  }
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
  if (customVocabEl) s.custom_vocab = customVocabEl.value;
  if (activeModeEl) s.active_mode = activeModeEl.value || "notes";
  if (customModesListEl) {
    const rows = customModesListEl.querySelectorAll(".custom-mode-row");
    s.custom_modes = [...rows].map((row) => ({
      id: row.dataset.id,
      name: row.querySelector(".cm-name")?.value.trim() || "Untitled",
      terms: row.querySelector(".cm-terms")?.value || "",
    }));
  }
  await invoke("update_settings", { settings: s });
  groqSection.style.display = (s.provider === "groq") ? "block" : "none";
  if (settingsStatusEl) settingsStatusEl.textContent = "Settings saved.";
  await refreshSettingsCard();
  await refreshStats();
  await refreshPromptPreview();
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
  activeModeEl = document.querySelector("#active-mode");
  customVocabEl = document.querySelector("#custom-vocab");
  customModesListEl = document.querySelector("#custom-modes-list");
  addCustomModeBtn = document.querySelector("#add-custom-mode");
  promptPreviewEl = document.querySelector("#prompt-preview");
  if (activeModeEl) {
    activeModeEl.addEventListener("change", saveBehavior);
  }
  if (customVocabEl) {
    customVocabEl.addEventListener("change", saveBehavior);
    customVocabEl.addEventListener("blur", saveBehavior);
  }
  if (addCustomModeBtn) {
    addCustomModeBtn.addEventListener("click", addCustomMode);
  }
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

  const setCollapsed = (on) => {
    document.body.classList.toggle("sidebar-collapsed", on);
    const expandBtn = document.getElementById("sidebar-expand");
    if (expandBtn) expandBtn.hidden = !on;
  };
  const sidebarCollapse = document.getElementById("sidebar-collapse");
  if (sidebarCollapse) {
    sidebarCollapse.addEventListener("click", () => setCollapsed(true));
  }
  const sidebarExpand = document.getElementById("sidebar-expand");
  if (sidebarExpand) {
    sidebarExpand.addEventListener("click", () => setCollapsed(false));
  }
  const topbarSettings = document.getElementById("topbar-settings");
  if (topbarSettings) {
    topbarSettings.addEventListener("click", () => setTab("settings"));
  }

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
