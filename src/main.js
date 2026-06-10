const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const tauriWindow = window.__TAURI__?.window;

// Platform class — used for platform-specific CSS (topbar padding, etc.)
(function applyPlatform() {
  const ua = navigator.userAgent.toLowerCase();
  const plat = navigator.platform.toLowerCase();
  const isMacOS = plat.includes("mac") || ua.includes("mac os x");
  document.body.classList.add(isMacOS ? "platform-mac" : "platform-linux");
})();

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
let btn, status;
let statWords2, statWpm2, statStreak2, statSessions;
let profileWords;
let historyContainer, historySearchEl, historyCountEl;
let historyItems = [];
let historyQuery = "";
let activeTab = "home";

// Settings tab elements
let modelsEl, langEl, autoPasteEl, settingsStatusEl;
let orKeyEl, orStatusEl, orTestBtn, orChatModelEl;
let activeModeEl, customVocabEl, customModesListEl, addCustomModeBtn, promptPreviewEl;
let smartFormatEl, autostartEl, playSoundsEl, spokenPunctuationEl;
let providerSegEl, cloudSttModelEl;
let livePreviewEl, voiceCommandsEl, inputDeviceEl;
let builtinModesCache = null;
let downloading = new Map();

function setRecording(on) {
  recording = on;
  if (btn) btn.textContent = on ? "Stop and transcribe" : "Start recording";
  const cancel = document.getElementById("cancel-rec");
  if (cancel) cancel.hidden = !on;
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

// ============ Toasts ============

function showToast(message, kind = "info") {
  const host = document.getElementById("toast-host");
  if (!host) return;
  // Dedup: if the newest visible toast says the same thing, don't stack another.
  const newest = host.lastElementChild;
  if (newest && !newest.classList.contains("toast-out") && newest.textContent === message) return;
  // Queue: keep at most 3 — drop the oldest.
  while (host.children.length >= 3) host.firstElementChild.remove();
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  el.textContent = message;
  const dismiss = () => {
    if (!el.isConnected) return;
    el.classList.add("toast-out");
    setTimeout(() => el.remove(), 180);
  };
  el.addEventListener("click", dismiss);
  host.appendChild(el);
  setTimeout(dismiss, 4000);
}

function renderPromptChips(prompt) {
  if (!prompt || !prompt.length) {
    return `<div class="prompt-empty">Nothing learned yet. Dictate a few times and Murmr will pick up your vocabulary.</div>`;
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
        <button class="icon-btn" data-act="copy" title="Copy" aria-label="Copy dictation">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><rect x="4" y="4" width="11" height="11" rx="2"/></svg>
        </button>
        <button class="icon-btn" data-act="flag" title="Flag" aria-label="Flag dictation">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 21V4h12l-2 4 2 4H5"/></svg>
        </button>
        <button class="icon-btn danger" data-act="delete" title="Delete" aria-label="Delete dictation">
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
      showToast("Copied to clipboard.", "success");
    } catch {
      showToast("Couldn't copy to clipboard.", "error");
    }
  } else if (act === "flag") {
    try {
      await invoke("flag_history_item", { id });
      await refreshAll();
    } catch (e) {
      showToast("Couldn't flag item: " + e, "error");
    }
  } else if (act === "delete") {
    if (!confirm("Delete this dictation?")) return;
    try {
      await invoke("delete_history_item", { id });
      await refreshAll();
    } catch (e) {
      showToast("Couldn't delete item: " + e, "error");
    }
  }
}

async function refreshHistory() {
  historyItems = await invoke("list_history", { limit: 200 });
  renderHistory();
}

async function refreshStats() {
  const s = await invoke("get_stats");
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
}

async function refreshSettingsCard() {
  try {
    const s = await invoke("get_settings");
    if (activeModeEl && !activeModeEl.options.length) {
      await populateModeDropdown(s);
    } else if (activeModeEl) {
      activeModeEl.value = s.active_mode || "notes";
    }
  } catch {
    // ignore
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
  if (sizeEl) sizeEl.textContent = `${prompt.length} / 1024`;
  const bar = document.getElementById("prof-bar");
  if (bar) bar.style.width = Math.min(100, Math.round((prompt.length / 1024) * 100)) + "%";

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
      packEl.textContent = "No curated pack for this mode. It uses your vocabulary and auto-learned terms.";
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
      : "Nothing learned yet. Dictate a few times and Murmr will pick up your vocabulary.";
  }
}

let activeStyleSub = "cleanup";
let styleFormsBuilt = false;

const STYLE_VARIANTS = [
  { id: "formal", title: "Formal", sub: "Caps and punctuation" },
  { id: "casual", title: "Casual", sub: "Caps and less punctuation" },
  { id: "excited", title: "Excited", sub: "More exclamations" },
];

// Per-profile preview content per variant.
const STYLE_PREVIEW_CONTENT = {
  personal: {
    kind: "chat",
    name: "John Doe",
    time: "9:45 AM",
    initial: "J",
    body: {
      formal: "Hey, if you're free, let's chat about the great results.",
      casual: "Hey, if you're free, let's chat about the great results",
      excited: "Hey, if you're free, let's chat about the great results!",
    },
  },
  work: {
    kind: "chat",
    name: "John Doe",
    time: "9:45 AM",
    initial: "J",
    body: {
      formal: "Hey, if you're free, let's chat about the great results.",
      casual: "Hey, if you're free, let's chat about the great results",
      excited: "Hey, if you're free, let's chat about the great results!",
    },
  },
  email: {
    kind: "email",
    to: "Alex Doe",
    body: {
      formal: "Hi Alex,\n\nIt was great talking with you today. Looking forward to our next chat.\n\nBest,\nMary",
      casual: "Hi Alex, it was great talking with you today. Looking forward to our next chat.\n\nBest,\nMary",
      excited: "Hi Alex,\n\nIt was great talking with you today. Looking forward to our next chat!\n\nBest,\nMary",
    },
  },
  other: {
    kind: "paragraph",
    body: {
      formal: "So far, I am enjoying the new workout routine.\n\nI am excited for tomorrow's workout, especially after a full night of rest.",
      casual: "So far I am enjoying the new workout routine.\n\nI am excited for tomorrow's workout especially after a full night of rest.",
      excited: "So far, I am enjoying the new workout routine.\n\nI am excited for tomorrow's workout, especially after a full night of rest!",
    },
  },
};

function renderPreviewBlock(profileKey, variantId) {
  const pc = STYLE_PREVIEW_CONTENT[profileKey];
  // Compact card: one short preview line instead of a fake chat/email mock.
  const text = (pc.body[variantId] || "").replace(/\s*\n+\s*/g, " ").trim();
  return `<span class="style-card-line">“${escapeHtml(text)}”</span>`;
}

function buildStyleForms() {
  if (styleFormsBuilt) return;
  document.querySelectorAll(".style-card-grid[data-profile]").forEach((host) => {
    const profileKey = host.dataset.profile;
    host.innerHTML = STYLE_VARIANTS.map((v) => `
      <button class="style-card" data-profile="${profileKey}" data-variant="${v.id}">
        <h3 class="style-card-title">${escapeHtml(v.title)}</h3>
        <p class="style-card-sub">${escapeHtml(v.sub)}</p>
        <div class="style-card-preview">${renderPreviewBlock(profileKey, v.id)}</div>
      </button>
    `).join("");
    host.querySelectorAll(".style-card").forEach((card) => {
      card.addEventListener("click", () => onStyleCardClick(profileKey, card.dataset.variant));
    });
  });
  styleFormsBuilt = true;
}

async function onStyleCardClick(profileKey, variantId) {
  const profile = { style: variantId };
  // Optimistic UI: highlight the clicked card immediately so the user gets feedback even if the
  // backend invoke is slow or errors.
  applyStyleSelections({ [profileKey]: profile }, profileKey, /*partial=*/true);
  try {
    await invoke("set_style_profile", { key: profileKey, profile });
    await invoke("set_active_style_profile", { key: profileKey });
  } catch (e) {
    console.error("set_style_profile failed:", e);
  }
}

function applyStyleSelections(profiles, activeKey, partial) {
  document.querySelectorAll(".style-card-grid[data-profile]").forEach((host) => {
    const k = host.dataset.profile;
    if (partial && !(k in profiles)) return;
    const variant = (profiles[k] && profiles[k].style) || "formal";
    host.querySelectorAll(".style-card").forEach((card) => {
      card.classList.toggle("active", card.dataset.variant === variant);
    });
    host.classList.toggle("profile-active", k === activeKey);
  });
}

function setStyleSubTab(name) {
  activeStyleSub = name;
  document.querySelectorAll(".style-tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.styleTab === name);
  });
  document.querySelectorAll(".style-sub").forEach((s) => {
    s.hidden = s.dataset.sub !== name;
  });
}

async function refreshStyleTab() {
  buildStyleForms();
  const [level, profiles, activeKey, settings] = await Promise.all([
    invoke("get_cleanup_level"),
    invoke("get_style_profiles"),
    invoke("get_active_style_profile"),
    invoke("get_settings"),
  ]);
  document.querySelectorAll(".cleanup-card").forEach((card) => {
    card.classList.toggle("active", card.dataset.level === level);
  });
  const noteEl = document.getElementById("style-groq-note");
  if (noteEl) {
    noteEl.hidden = !!(settings.api_key && settings.api_key.trim());
  }
  applyStyleSelections(profiles || {}, activeKey, false);
  setStyleSubTab(activeStyleSub);
}

async function refreshAll() {
  await Promise.all([refreshHistory(), refreshStats(), refreshSettingsCard()]);
}

async function toggle() {
  if (!recording) {
    btn.disabled = true;
    try {
      await invoke("start_recording");
      setRecording(true);
      status.textContent = "Recording… click Stop or press F9.";
    } catch (e) {
      status.textContent = "";
      showToast("Couldn't start recording: " + e, "error");
    }
    btn.disabled = false;
  } else {
    btn.disabled = true;
    status.textContent = "Transcribing…";
    try {
      const text = await invoke("stop_recording");
      status.textContent = `Done. "${text.slice(0, 60)}${text.length > 60 ? "…" : ""}"`;
    } catch (e) {
      status.textContent = "";
      showToast("Couldn't transcribe: " + e, "error");
    }
    btn.disabled = false;
    setRecording(false);
  }
}

async function cancel() {
  try {
    await invoke("cancel_recording");
    setRecording(false);
    status.textContent = "Canceled.";
  } catch (e) {
    status.textContent = "";
    showToast("Couldn't cancel: " + e, "error");
  }
}

function setTab(t) {
  activeTab = t;
  try { localStorage.setItem("activeTab", t); } catch { /* ignore */ }
  document.querySelectorAll(".nav-btn[data-tab]").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === t);
  });
  const setVis = (id, active) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (active) {
      el.style.removeProperty("display");
    } else {
      // !important so it beats any CSS `display: ... !important` rule
      el.style.setProperty("display", "none", "important");
    }
  };
  setVis("home-tab", t === "home");
  setVis("stats-tab", t === "stats");
  setVis("profile-tab", t === "profile");
  setVis("settings-tab", t === "settings");
  setVis("style-tab", t === "style");
  setVis("dictionary-tab", t === "dictionary");
  setVis("snippets-tab", t === "snippets");
  document.querySelector(".main").classList.toggle("full", t !== "home");
  if (t === "profile") refreshProfile();
  if (t === "settings") refreshSettings();
  if (t === "dictionary") refreshDictionary();
  if (t === "snippets") refreshSnippets();
  if (t === "style") {
    setStyleSubTab(activeStyleSub); // sync — no flash before async invoke resolves
    refreshStyleTab();
  }
}

// ============ Dictionary tab ============

function vocabLinesFrom(s) {
  return (s.custom_vocab || "").split("\n").map((l) => l.trim()).filter(Boolean);
}

async function refreshDictionary() {
  const s = await invoke("get_settings");
  renderVocabChips(vocabLinesFrom(s));
  renderReplacements(s.replacements ?? []);
}

function renderVocabChips(lines) {
  const host = document.getElementById("dict-vocab-chips");
  if (!host) return;
  if (!lines.length) {
    host.innerHTML = `<div class="hub-empty">No terms yet. Add names, jargon, and acronyms so Murmr spells them right.</div>`;
    return;
  }
  host.innerHTML = lines
    .map((t, i) => `
      <span class="vocab-chip hub-vocab-chip">${escapeHtml(t)}
        <button class="chip-x" data-idx="${i}" type="button" aria-label="Remove ${escapeHtml(t)}">×</button>
      </span>`)
    .join("");
  host.querySelectorAll(".chip-x").forEach((b) => {
    b.addEventListener("click", () => removeVocabTerm(Number(b.dataset.idx)));
  });
}

async function addVocabTerm() {
  const input = document.getElementById("dict-vocab-input");
  if (!input) return;
  const term = input.value.trim();
  if (!term) return;
  try {
    const s = await invoke("get_settings");
    const lines = vocabLinesFrom(s);
    if (lines.some((l) => l.toLowerCase() === term.toLowerCase())) {
      showToast(`"${term}" is already in your vocabulary.`, "info");
      input.value = "";
      return;
    }
    lines.push(term);
    s.custom_vocab = lines.join("\n");
    s.replacements = s.replacements ?? [];
    await invoke("update_settings", { settings: s });
    input.value = "";
    renderVocabChips(lines);
    if (customVocabEl) customVocabEl.value = s.custom_vocab;
  } catch (e) {
    showToast("Couldn't add term: " + e, "error");
  }
}

async function removeVocabTerm(idx) {
  try {
    const s = await invoke("get_settings");
    const lines = vocabLinesFrom(s);
    lines.splice(idx, 1);
    s.custom_vocab = lines.join("\n");
    s.replacements = s.replacements ?? [];
    await invoke("update_settings", { settings: s });
    renderVocabChips(lines);
    if (customVocabEl) customVocabEl.value = s.custom_vocab;
  } catch (e) {
    showToast("Couldn't remove term: " + e, "error");
  }
}

function renderReplacements(reps) {
  const host = document.getElementById("dict-replacements");
  if (!host) return;
  if (!reps.length) {
    host.innerHTML = `<div class="hub-empty">No replacements yet. Fix Murmr's recurring mishears — e.g. "jay" → "Jae".</div>`;
    return;
  }
  host.innerHTML = `
    <div class="hub-repl-head"><span>Heard</span><span></span><span>Replace with</span><span></span></div>
    ${reps.map((r, i) => `
      <div class="hub-repl-row" data-idx="${i}">
        <input class="repl-from" value="${escapeHtml(r.from || "")}" placeholder="What Murmr heard" />
        <span class="repl-arrow">→</span>
        <input class="repl-to" value="${escapeHtml(r.to || "")}" placeholder="What it should write" />
        <button class="icon-btn danger repl-delete" type="button" aria-label="Delete replacement">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2m-9 0v14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V6"/></svg>
        </button>
      </div>`).join("")}
  `;
  host.querySelectorAll(".repl-from, .repl-to").forEach((el) => {
    el.addEventListener("change", saveReplacements);
    el.addEventListener("blur", saveReplacements);
  });
  host.querySelectorAll(".repl-delete").forEach((b) => {
    b.addEventListener("click", async () => {
      const idx = Number(b.closest(".hub-repl-row").dataset.idx);
      try {
        const s = await invoke("get_settings");
        const list = s.replacements ?? [];
        list.splice(idx, 1);
        s.replacements = list;
        await invoke("update_settings", { settings: s });
        renderReplacements(list);
      } catch (e) {
        showToast("Couldn't delete replacement: " + e, "error");
      }
    });
  });
}

async function saveReplacements() {
  const host = document.getElementById("dict-replacements");
  if (!host) return;
  const rows = [...host.querySelectorAll(".hub-repl-row")];
  const reps = rows
    .map((row) => ({
      from: row.querySelector(".repl-from")?.value.trim() || "",
      to: row.querySelector(".repl-to")?.value.trim() || "",
    }))
    .filter((r) => r.from && r.to); // only persist complete rows — half-filled ones stay editable in the DOM
  try {
    const s = await invoke("get_settings");
    s.replacements = reps;
    await invoke("update_settings", { settings: s });
  } catch (e) {
    showToast("Couldn't save replacements: " + e, "error");
  }
}

async function addReplacementRow() {
  try {
    const s = await invoke("get_settings");
    const list = s.replacements ?? [];
    list.push({ from: "", to: "" });
    s.replacements = list;
    await invoke("update_settings", { settings: s });
    renderReplacements(list);
    const host = document.getElementById("dict-replacements");
    const last = host?.querySelector(".hub-repl-row:last-child .repl-from");
    if (last) last.focus();
  } catch (e) {
    showToast("Couldn't add replacement: " + e, "error");
  }
}

// ============ Snippets tab ============

async function refreshSnippets() {
  const s = await invoke("get_settings");
  renderSnippets(s.snippets ?? []);
}

function renderSnippets(snips) {
  const host = document.getElementById("snippets-list");
  if (!host) return;
  if (!snips.length) {
    host.innerHTML = `<div class="hub-empty">No snippets yet. Say the trigger phrase while dictating and Murmr pastes the full snippet — great for emails, addresses, and sign-offs.</div>`;
    return;
  }
  host.innerHTML = snips
    .map((sn, i) => `
      <div class="hub-snippet-card" data-idx="${i}">
        <div class="hub-snippet-head">
          <input class="snip-trigger" value="${escapeHtml(sn.trigger || "")}" placeholder="Trigger phrase — e.g. my work address" aria-label="Trigger phrase" />
          <button class="icon-btn danger snip-delete" type="button" aria-label="Delete snippet">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2m-9 0v14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V6"/></svg>
          </button>
        </div>
        <textarea class="snip-expansion" rows="3" placeholder="Expansion — the text Murmr should paste" aria-label="Snippet expansion">${escapeHtml(sn.expansion || "")}</textarea>
      </div>`)
    .join("");
  host.querySelectorAll(".snip-trigger, .snip-expansion").forEach((el) => {
    el.addEventListener("change", saveSnippets);
    el.addEventListener("blur", saveSnippets);
  });
  host.querySelectorAll(".snip-delete").forEach((b) => {
    b.addEventListener("click", async () => {
      const idx = Number(b.closest(".hub-snippet-card").dataset.idx);
      try {
        const s = await invoke("get_settings");
        const list = s.snippets ?? [];
        list.splice(idx, 1);
        s.snippets = list;
        await invoke("update_settings", { settings: s });
        renderSnippets(list);
      } catch (e) {
        showToast("Couldn't delete snippet: " + e, "error");
      }
    });
  });
}

async function saveSnippets() {
  const host = document.getElementById("snippets-list");
  if (!host) return;
  const cards = [...host.querySelectorAll(".hub-snippet-card")];
  const snips = cards
    .map((card) => ({
      trigger: card.querySelector(".snip-trigger")?.value.trim() || "",
      expansion: card.querySelector(".snip-expansion")?.value || "",
    }))
    .filter((sn) => sn.trigger && sn.expansion.trim()); // only persist complete snippets — half-filled ones stay editable in the DOM
  try {
    const s = await invoke("get_settings");
    s.snippets = snips;
    await invoke("update_settings", { settings: s });
  } catch (e) {
    showToast("Couldn't save snippets: " + e, "error");
  }
}

async function addSnippet() {
  try {
    const s = await invoke("get_settings");
    const list = s.snippets ?? [];
    list.push({ trigger: "", expansion: "" });
    s.snippets = list;
    await invoke("update_settings", { settings: s });
    renderSnippets(list);
    const host = document.getElementById("snippets-list");
    const last = host?.querySelector(".hub-snippet-card:last-child .snip-trigger");
    if (last) last.focus();
  } catch (e) {
    showToast("Couldn't add snippet: " + e, "error");
  }
}

// ============ Onboarding ============

let onboardingStep = 0;
let onboardingAwaitingDictation = false;
let onboardingCleanupLevel = "light";

function hotkeyKbdHtml(combo) {
  return combo
    .split("+")
    .map((k) => `<span class="kbd">${escapeHtml(k.trim())}</span>`)
    .join("");
}

function showOnboardingStep(n) {
  onboardingStep = n;
  const overlay = document.getElementById("onboarding");
  if (!overlay) return;
  overlay.querySelectorAll(".onboarding-step").forEach((s) => {
    s.hidden = Number(s.dataset.step) !== n;
  });
  overlay.querySelectorAll("#onboarding-dots .dot").forEach((d, i) => {
    d.classList.toggle("active", i === n);
  });
  const back = document.getElementById("onboarding-back");
  const next = document.getElementById("onboarding-next");
  if (back) back.hidden = n === 0;
  if (next) next.textContent = n === 2 ? "Finish" : "Next";
  onboardingAwaitingDictation = n === 1;
}

async function finishOnboarding() {
  try {
    await invoke("set_cleanup_level", { level: onboardingCleanupLevel });
  } catch (e) {
    showToast("Couldn't save cleanup level: " + e, "error");
  }
  localStorage.setItem("murmr_onboarded", "1");
  onboardingAwaitingDictation = false;
  const overlay = document.getElementById("onboarding");
  if (overlay) overlay.hidden = true;
  showToast("You're all set. Hold the hotkey and speak.", "success");
}

function onboardingDictationSucceeded() {
  if (!onboardingAwaitingDictation || onboardingStep !== 1) return;
  onboardingAwaitingDictation = false;
  const statusEl = document.getElementById("onboarding-try-status");
  if (statusEl) {
    statusEl.textContent = "That's it — your first dictation is in.";
    statusEl.classList.add("success");
  }
  setTimeout(() => showOnboardingStep(2), 900);
}

async function initOnboarding() {
  if (localStorage.getItem("murmr_onboarded")) return;
  const overlay = document.getElementById("onboarding");
  if (!overlay) return;

  // Show the active hotkey (same source as the hero card: settings.custom_hotkey or the
  // platform default — on macOS the backend default is hold Right Option).
  try {
    const s = await invoke("get_settings");
    const platformDefault = navigator.userAgent.includes("Mac")
      ? "Right ⌥ Option (hold)"
      : "Ctrl+Shift+Space";
    const combo = (s.custom_hotkey || "").trim() || platformDefault;
    const hk = document.getElementById("onboarding-hotkey");
    if (hk) hk.innerHTML = hotkeyKbdHtml(combo);
  } catch {
    // keep the default markup
  }

  const isMac = document.body.classList.contains("platform-mac");
  const axRow = document.getElementById("onboarding-perm-ax");
  if (axRow && !isMac) axRow.style.display = "none";

  document.getElementById("onboarding-next")?.addEventListener("click", () => {
    if (onboardingStep === 2) finishOnboarding();
    else showOnboardingStep(onboardingStep + 1);
  });
  document.getElementById("onboarding-back")?.addEventListener("click", () => {
    if (onboardingStep > 0) showOnboardingStep(onboardingStep - 1);
  });
  document.getElementById("onboarding-skip-try")?.addEventListener("click", () => {
    showOnboardingStep(2);
  });
  overlay.querySelectorAll(".ob-cleanup-card").forEach((card) => {
    card.addEventListener("click", () => {
      onboardingCleanupLevel = card.dataset.level;
      overlay.querySelectorAll(".ob-cleanup-card").forEach((c) => {
        c.classList.toggle("active", c === card);
      });
    });
  });

  // Escape skips the rest of onboarding.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.hidden) finishOnboarding();
  });

  overlay.hidden = false;
  showOnboardingStep(0);
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
  if (m.downloaded && m.active) {
    actions.length = 0;
    actions.push(
      `<span class="tag ok sp-active-tag"><svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M2.5 8.5l3.5 3.5 7.5-8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>Active</span>`
    );
  }
  const recommended = m.id === "large-v3-turbo-q5" ? ` <span class="tag rec-badge">Recommended</span>` : "";
  const name = (m.label || m.id).split("—")[0].trim();
  const tail = ((m.label || "").split(",").slice(1).join(",") || "").trim();
  const note = tail ? tail[0].toUpperCase() + tail.slice(1) : (m.lang === "en" ? "English-only" : "Multilingual");
  return `
    <div class="model ${m.active ? "active" : ""}">
      <div class="model-head">
        <div class="model-text">
          <div class="model-title">${name}${recommended}</div>
          <div class="model-meta">${m.size_mb ? m.size_mb + " MB · " : ""}${note}${tail && m.lang === "en" ? " · English-only" : ""}</div>
        </div>
        <div class="row model-actions">${actions.join("")}</div>
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

// Update the provider chooser cards + reveal only the relevant sub-panel.
function reflectProvider(provider, hasKey) {
  if (!providerSegEl) return;
  providerSegEl.querySelectorAll(".seg-btn").forEach((b) => {
    const on = b.dataset.provider === provider;
    b.classList.toggle("active", on);
    b.setAttribute("aria-checked", on ? "true" : "false");
  });
  const localPanel = document.getElementById("local-panel");
  const cloudPanel = document.getElementById("cloud-panel");
  if (localPanel) localPanel.classList.toggle("open", provider !== "cloud");
  if (cloudPanel) cloudPanel.classList.toggle("open", provider === "cloud");
  const warn = document.getElementById("cloud-key-warning");
  if (warn) warn.hidden = !(provider === "cloud" && !hasKey);
}

async function setProvider(provider) {
  const s = await invoke("get_settings");
  if (s.transcription_provider === provider) {
    reflectProvider(provider, (s.api_key || "").trim().length > 0);
    return;
  }
  s.transcription_provider = provider;
  if (cloudSttModelEl && cloudSttModelEl.value.trim()) {
    s.cloud_stt_model = cloudSttModelEl.value.trim();
  }
  try {
    await invoke("update_settings", { settings: s });
  } catch (e) {
    showToast("Couldn't switch provider: " + e, "error");
    return;
  }
  reflectProvider(provider, (s.api_key || "").trim().length > 0);
  showToast(
    provider === "cloud" ? "Cloud transcription enabled. Audio is sent to your provider." : "On-device transcription enabled. Audio never leaves your Mac.",
    "success"
  );
  await refreshSettingsCard();
}

// Brief "Saved" tick in the page header — quieter than a toast for routine saves.
let savedTickTimer = null;
function flashSaved() {
  const tick = document.getElementById("settings-saved-tick");
  if (!tick) return;
  tick.hidden = false;
  tick.classList.add("show");
  clearTimeout(savedTickTimer);
  savedTickTimer = setTimeout(() => {
    tick.classList.remove("show");
    savedTickTimer = setTimeout(() => { tick.hidden = true; }, 250);
  }, 1400);
}

// Current hotkey rendered as keycap chips.
function renderHotkeyChips(customHotkey) {
  const chips = document.getElementById("hotkey-chips");
  if (!chips) return;
  const combo = (customHotkey || "").trim();
  if (combo) {
    chips.innerHTML = combo.split("+").map((k) => `<span class="kbd">${escapeHtml(k.trim())}</span>`).join("");
  } else {
    chips.innerHTML =
      `<span class="kbd">Ctrl</span><span class="kbd">Shift</span><span class="kbd">Space</span>` +
      `<span class="sp-chip-or">or</span><span class="kbd">F9</span>`;
  }
}

let inputDevicesLoaded = false;
async function populateInputDevices(selected) {
  const sel = document.getElementById("input-device");
  if (!sel) return;
  if (!inputDevicesLoaded) {
    try {
      const devices = await invoke("list_input_devices");
      sel.innerHTML =
        `<option value="">System default</option>` +
        devices.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");
      inputDevicesLoaded = true;
    } catch {
      /* keep the "System default" option */
    }
  }
  if (selected && ![...sel.options].some((o) => o.value === selected)) {
    sel.insertAdjacentHTML("beforeend", `<option value="${escapeHtml(selected)}">${escapeHtml(selected)} (unavailable)</option>`);
  }
  sel.value = selected || "";
}

async function refreshSettings() {
  const s = await invoke("get_settings");
  langEl.value = s.language || "auto";
  autoPasteEl.checked = !!s.auto_paste;
  orKeyEl.value = s.api_key || s.openrouter_api_key || "";
  orChatModelEl.value = s.chat_model || s.active_chat_model || "meta-llama/llama-3.1-8b-instruct";

  if (customVocabEl) customVocabEl.value = s.custom_vocab || "";
  if (smartFormatEl) smartFormatEl.checked = !!s.smart_format;
  if (playSoundsEl) playSoundsEl.checked = s.play_sounds ?? true;
  if (spokenPunctuationEl) spokenPunctuationEl.checked = s.spoken_punctuation ?? true;
  if (livePreviewEl) livePreviewEl.checked = s.live_preview ?? true;
  if (voiceCommandsEl) voiceCommandsEl.checked = s.voice_commands ?? true;
  if (cloudSttModelEl) cloudSttModelEl.value = s.cloud_stt_model || "openai/whisper-large-v3-turbo";
  reflectProvider(s.transcription_provider || "local", (s.api_key || "").trim().length > 0);
  renderHotkeyChips(s.custom_hotkey);
  await populateInputDevices(s.input_device || "");
  if (autostartEl) {
    try {
      const actual = await invoke("get_autostart");
      autostartEl.checked = !!actual;
    } catch {
      autostartEl.checked = !!s.autostart;
    }
  }
  await populateModeDropdown(s);
  renderCustomModes(s.custom_modes || []);
  await refreshPromptPreview();

  await refreshModels();

  const macRow = document.getElementById("mac-hotkey-inline");
  if (macRow) {
    const isMac = navigator.platform.toLowerCase().includes("mac") || navigator.userAgent.toLowerCase().includes("mac");
    macRow.style.display = isMac ? "" : "none";
  }
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
    promptPreviewEl.textContent = p && p.length ? p : "Nothing learned yet. Dictate a few times and Murmr will pick up your vocabulary.";
  } catch {
    promptPreviewEl.textContent = "Couldn't load";
  }
}

async function onModelAction(e) {
  const id = e.currentTarget.dataset.id;
  const act = e.currentTarget.dataset.act;
  try {
    if (act === "download") {
      downloading.set(id, { bytes: 0, total: 0 });
      settingsStatusEl.textContent = "Downloading model…";
      await invoke("download_model", { id });
      showToast('Model downloaded. Click "Use this" to switch to it.', "success");
      await refreshModels();
    } else if (act === "activate") {
      await invoke("set_active_model", { id });
      settingsStatusEl.textContent = "Model activated.";
      await refreshModels();
      await refreshSettingsCard();
    } else if (act === "delete") {
      const models = await invoke("list_models");
      if (models.some((m) => m.id === id && m.active)) {
        showToast("Can't delete the active model — switch models first.", "error");
        return;
      }
      await invoke("delete_model", { id });
      settingsStatusEl.textContent = "Model deleted.";
      await refreshModels();
    }
  } catch (err) {
    settingsStatusEl.textContent = "";
    showToast(`Couldn't ${act} model: ${err}`, "error");
  }
}

async function saveBehavior() {
  try {
    const s = await invoke("get_settings");
    s.language = langEl.value;
    s.auto_paste = autoPasteEl.checked;
    s.api_key = orKeyEl.value.trim();
    s.chat_model = orChatModelEl.value.trim() || "meta-llama/llama-3.1-8b-instruct";
    if (customVocabEl) s.custom_vocab = customVocabEl.value;
    if (activeModeEl) s.active_mode = activeModeEl.value || "notes";
    if (smartFormatEl) s.smart_format = smartFormatEl.checked;
    if (cloudSttModelEl) s.cloud_stt_model = cloudSttModelEl.value.trim() || "openai/whisper-large-v3-turbo";
    s.play_sounds = playSoundsEl ? playSoundsEl.checked : (s.play_sounds ?? true);
    s.spoken_punctuation = spokenPunctuationEl ? spokenPunctuationEl.checked : (s.spoken_punctuation ?? true);
    s.live_preview = livePreviewEl ? livePreviewEl.checked : (s.live_preview ?? true);
    s.voice_commands = voiceCommandsEl ? voiceCommandsEl.checked : (s.voice_commands ?? true);
    if (inputDeviceEl) s.input_device = inputDeviceEl.value || "";
    s.replacements = s.replacements ?? [];
    s.snippets = s.snippets ?? [];
    if (customModesListEl) {
      const rows = customModesListEl.querySelectorAll(".custom-mode-row");
      s.custom_modes = [...rows].map((row) => ({
        id: row.dataset.id,
        name: row.querySelector(".cm-name")?.value.trim() || "Untitled",
        terms: row.querySelector(".cm-terms")?.value || "",
      }));
    }
    await invoke("update_settings", { settings: s });
    flashSaved();
    const warn = document.getElementById("cloud-key-warning");
    if (warn) warn.hidden = !(s.transcription_provider === "cloud" && !s.api_key.trim());
  } catch (e) {
    showToast("Couldn't save settings: " + e, "error");
    return;
  }
  await refreshSettingsCard();
  await refreshStats();
  await refreshPromptPreview();
}

async function onAutostartToggle() {
  if (!autostartEl) return;
  try {
    const enabled = await invoke("set_autostart", { enable: autostartEl.checked });
    autostartEl.checked = !!enabled;
    flashSaved();
  } catch (e) {
    autostartEl.checked = !autostartEl.checked;
    showToast("Couldn't change launch on login: " + e, "error");
  }
}

async function testOpenRouter() {
  if (!orStatusEl) return;
  if (!orKeyEl.value.trim()) {
    orStatusEl.textContent = "Enter your API key first.";
    orStatusEl.className = "sp-test-status err";
    orKeyEl.focus();
    return;
  }
  orStatusEl.innerHTML = `<span class="sp-spinner" aria-hidden="true"></span>Testing…`;
  orStatusEl.className = "sp-test-status busy";
  if (orTestBtn) orTestBtn.disabled = true;
  try {
    const msg = await invoke("test_openrouter", { apiKey: orKeyEl.value.trim() });
    orStatusEl.textContent = "✓ " + (msg || "Key verified");
    orStatusEl.className = "sp-test-status ok";
    showToast("Key verified.", "success");
  } catch (e) {
    orStatusEl.textContent = "✗ " + e;
    orStatusEl.className = "sp-test-status err";
    showToast("Couldn't verify key: " + e, "error");
  } finally {
    if (orTestBtn) orTestBtn.disabled = false;
  }
}

async function clearHistoryAction() {
  if (!confirm("Clear all dictation history? This also resets your voice profile and stats.")) return;
  try {
    await invoke("clear_history");
    await refreshAll();
    showToast("History cleared.", "success");
  } catch (e) {
    showToast("Couldn't clear history: " + e, "error");
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  btn = document.querySelector("#rec");
  status = document.querySelector("#status");
  statWords2 = document.querySelector("#stat-words-2");
  statWpm2 = document.querySelector("#stat-wpm-2");
  statStreak2 = document.querySelector("#stat-streak-2");
  statSessions = document.querySelector("#stat-sessions");
  profileWords = document.querySelector("#profile-words");
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
  orKeyEl = document.querySelector("#or-key");
  orStatusEl = document.querySelector("#or-status");
  orTestBtn = document.querySelector("#or-test");
  orChatModelEl = document.querySelector("#or-chat-model");
  activeModeEl = document.querySelector("#active-mode");
  customVocabEl = document.querySelector("#custom-vocab");
  customModesListEl = document.querySelector("#custom-modes-list");
  addCustomModeBtn = document.querySelector("#add-custom-mode");
  promptPreviewEl = document.querySelector("#prompt-preview");
  smartFormatEl = document.querySelector("#smart-format");
  autostartEl = document.querySelector("#autostart");
  playSoundsEl = document.querySelector("#play-sounds");
  spokenPunctuationEl = document.querySelector("#spoken-punctuation");
  providerSegEl = document.querySelector("#provider-seg");
  cloudSttModelEl = document.querySelector("#cloud-stt-model");
  livePreviewEl = document.querySelector("#live-preview");
  voiceCommandsEl = document.querySelector("#voice-commands");
  inputDeviceEl = document.querySelector("#input-device");
  if (providerSegEl) {
    providerSegEl.querySelectorAll(".seg-btn").forEach((b) => {
      b.addEventListener("click", () => setProvider(b.dataset.provider));
    });
  }
  if (cloudSttModelEl) cloudSttModelEl.addEventListener("change", saveBehavior);
  if (livePreviewEl) livePreviewEl.addEventListener("change", saveBehavior);
  if (voiceCommandsEl) voiceCommandsEl.addEventListener("change", saveBehavior);
  if (inputDeviceEl) inputDeviceEl.addEventListener("change", saveBehavior);
  const hotkeyChangeBtn = document.querySelector("#hotkey-change");
  const hotkeyEditor = document.querySelector("#hotkey-editor");
  if (hotkeyChangeBtn && hotkeyEditor) {
    hotkeyChangeBtn.addEventListener("click", () => {
      const open = hotkeyEditor.classList.toggle("open");
      hotkeyChangeBtn.setAttribute("aria-expanded", open ? "true" : "false");
      hotkeyChangeBtn.textContent = open ? "Done" : "Change";
      if (open) document.querySelector("#custom-hotkey")?.focus();
    });
  }
  const customHotkeyEl = document.querySelector("#custom-hotkey");
  const customHotkeyCapture = document.querySelector("#custom-hotkey-capture");
  const customHotkeyClear = document.querySelector("#custom-hotkey-clear");
  const customHotkeyStatus = document.querySelector("#custom-hotkey-status");
  if (customHotkeyEl) {
    invoke("get_settings").then((s) => { customHotkeyEl.value = s.custom_hotkey || ""; });
    const save = async () => {
      try {
        const s = await invoke("get_settings");
        s.custom_hotkey = customHotkeyEl.value.trim();
        await invoke("update_settings", { settings: s });
        if (customHotkeyStatus) customHotkeyStatus.textContent = s.custom_hotkey
          ? `Saved: ${s.custom_hotkey} — restart Murmr for the new hotkey to take effect.`
          : "Custom hotkey cleared — restart Murmr.";
        renderHotkeyChips(s.custom_hotkey);
        flashSaved();
      } catch (e) {
        showToast("Couldn't save hotkey: " + e, "error");
      }
    };
    customHotkeyEl.addEventListener("change", save);
    customHotkeyEl.addEventListener("blur", save);
    if (customHotkeyCapture) {
      customHotkeyCapture.addEventListener("click", () => {
        customHotkeyEl.focus();
        const prevStatusText = customHotkeyStatus ? customHotkeyStatus.textContent : "";
        if (customHotkeyStatus) customHotkeyStatus.textContent = "Hold modifiers (Ctrl/Shift/Alt/Cmd) then press a key — or just release modifiers to capture a modifier-only combo (macOS hold-to-talk). Press Esc to cancel.";
        const isMac = navigator.platform.toLowerCase().includes("mac");
        const modParts = (ctrl, shift, alt, meta) => {
          const p = [];
          if (ctrl) p.push("Ctrl");
          if (shift) p.push("Shift");
          if (alt) p.push(isMac ? "Option" : "Alt");
          if (meta) p.push(isMac ? "Cmd" : "Super");
          return p;
        };
        let modSnapshot = { ctrl: false, shift: false, alt: false, meta: false };
        let sawMod = false;
        const teardown = () => {
          document.removeEventListener("keydown", onKey, true);
          document.removeEventListener("keyup", onKeyUp, true);
        };
        const finish = (value) => {
          customHotkeyEl.value = value;
          teardown();
          save();
        };
        const onKey = (e) => {
          if (e.key === "Escape") {
            // Escape hatch — abandon capture without changing the combo.
            e.preventDefault();
            teardown();
            if (customHotkeyStatus) customHotkeyStatus.textContent = prevStatusText;
            return;
          }
          const isModKey = !e.code || e.code.startsWith("Meta") || e.code.startsWith("Shift")
            || e.code.startsWith("Control") || e.code.startsWith("Alt");
          if (isModKey) {
            modSnapshot = { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey };
            sawMod = sawMod || e.ctrlKey || e.shiftKey || e.altKey || e.metaKey;
            return;
          }
          e.preventDefault();
          const parts = modParts(e.ctrlKey, e.shiftKey, e.altKey, e.metaKey);
          let k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
          const map = { " ": "Space", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right" };
          if (map[k]) k = map[k];
          parts.push(k);
          finish(parts.join("+"));
        };
        const onKeyUp = (e) => {
          // Modifier released — if no normal key was ever pressed, capture as modifier-only combo.
          const isModKey = !e.code || e.code.startsWith("Meta") || e.code.startsWith("Shift")
            || e.code.startsWith("Control") || e.code.startsWith("Alt");
          if (!isModKey) return;
          if (!sawMod) return;
          const parts = modParts(modSnapshot.ctrl, modSnapshot.shift, modSnapshot.alt, modSnapshot.meta);
          if (parts.length === 0) return;
          finish(parts.join("+"));
        };
        document.addEventListener("keydown", onKey, true);
        document.addEventListener("keyup", onKeyUp, true);
      });
    }
    if (customHotkeyClear) {
      customHotkeyClear.addEventListener("click", () => {
        customHotkeyEl.value = "";
        save();
      });
    }
  }
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
  const orKeyToggle = document.querySelector("#or-key-toggle");
  if (orKeyToggle) {
    orKeyToggle.addEventListener("click", () => {
      const reveal = orKeyEl.type === "password";
      orKeyEl.type = reveal ? "text" : "password";
      orKeyToggle.setAttribute("aria-pressed", reveal ? "true" : "false");
      orKeyToggle.setAttribute("aria-label", reveal ? "Hide key" : "Show key");
      const open = orKeyToggle.querySelector(".sp-eye-open");
      const closed = orKeyToggle.querySelector(".sp-eye-closed");
      if (open && closed) {
        open.hidden = reveal;
        closed.hidden = !reveal;
      }
    });
  }
  if (orTestBtn) orTestBtn.addEventListener("click", testOpenRouter);
  [orKeyEl, orChatModelEl].forEach((el) => {
    if (!el) return;
    el.addEventListener("change", saveBehavior);
    el.addEventListener("blur", saveBehavior);
  });

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

  // Style tab — cleanup level card selection
  document.querySelectorAll(".cleanup-card").forEach((card) => {
    card.addEventListener("click", async () => {
      const level = card.dataset.level;
      await invoke("set_cleanup_level", { level });
      document.querySelectorAll(".cleanup-card").forEach((c) => {
        c.classList.toggle("active", c.dataset.level === level);
      });
    });
  });

  // Style tab — sub-tab nav (Personal / Work / Email / Other / Auto Cleanup)
  document.querySelectorAll(".style-tab-btn").forEach((b) => {
    b.addEventListener("click", () => setStyleSubTab(b.dataset.styleTab));
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
  if (smartFormatEl) smartFormatEl.addEventListener("change", saveBehavior);
  if (playSoundsEl) playSoundsEl.addEventListener("change", saveBehavior);
  if (spokenPunctuationEl) spokenPunctuationEl.addEventListener("change", saveBehavior);
  if (autostartEl) autostartEl.addEventListener("change", onAutostartToggle);
  document.querySelector("#clear-history").addEventListener("click", clearHistoryAction);

  // Dictionary tab wiring
  const vocabAddBtn = document.getElementById("dict-vocab-add");
  if (vocabAddBtn) vocabAddBtn.addEventListener("click", addVocabTerm);
  const vocabInput = document.getElementById("dict-vocab-input");
  if (vocabInput) {
    vocabInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addVocabTerm();
      }
    });
  }
  const replAddBtn = document.getElementById("dict-replacement-add");
  if (replAddBtn) replAddBtn.addEventListener("click", addReplacementRow);

  // Snippets tab wiring
  const snippetAddBtn = document.getElementById("snippet-add");
  if (snippetAddBtn) snippetAddBtn.addEventListener("click", addSnippet);

  await listen("rec-state", (e) => {
    const s = e.payload;
    if (s === "recording") {
      setRecording(true);
      status.textContent = "Recording… click Stop or press F9.";
    } else if (s === "transcribing") {
      status.textContent = "Transcribing…";
    } else if (s === "done") {
      setRecording(false);
      status.textContent = "Pasted and copied to your clipboard.";
    } else if (s === "idle") {
      setRecording(false);
      status.textContent = "";
    }
  });
  await listen("rec-error", (e) => {
    // Toast is the single error channel — reset the status line to idle.
    status.textContent = "";
    showToast("Couldn't complete dictation: " + e.payload, "error");
    setRecording(false);
  });
  await listen("provider-fallback", (e) => {
    showToast(e.payload || "Cloud transcription unavailable — fell back to local.", "info");
  });
  await listen("history-changed", () => {
    onboardingDictationSucceeded();
    return refreshAll();
  });
  await listen("settings-changed", refreshSettingsCard);
  await listen("model-progress", async (e) => {
    const p = e.payload;
    if (p.error) {
      downloading.delete(p.id);
      settingsStatusEl.textContent = "";
      showToast(`Couldn't download model: ${p.error}`, "error");
      await refreshModels();
      return;
    }
    if (p.done) {
      downloading.delete(p.id);
      settingsStatusEl.textContent = "Model downloaded.";
      await refreshModels();
      return;
    }
    downloading.set(p.id, { bytes: p.bytes, total: p.total });
    await refreshModels();
  });

  let savedTab = "home";
  try { savedTab = localStorage.getItem("activeTab") || "home"; } catch { /* ignore */ }
  setTab(savedTab);
  await refreshAll();
  await initOnboarding();
});
