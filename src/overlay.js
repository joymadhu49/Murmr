const { listen } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;

const hud = document.getElementById("hud");
const idlePill = document.getElementById("idle-pill");
const idleKbd = document.getElementById("idle-kbd");
const stopBtn = document.getElementById("stop-btn");
const cancelBtn = document.getElementById("cancel-btn");
const stateLabel = document.getElementById("state-label");
const timerEl = document.getElementById("timer");

function setState(s) {
  hud.dataset.state = s;
}

setState("idle");

// Show the user's actual hotkey in the idle pill if they set one.
(async () => {
  try {
    const s = await invoke("get_settings");
    const custom = (s && s.custom_hotkey || "").trim();
    if (custom) idleKbd.textContent = custom;
  } catch (_) {}
})();

idlePill.addEventListener("click", async () => {
  try { await invoke("start_recording"); } catch (e) { console.error(e); }
});

idlePill.addEventListener("dblclick", async (e) => {
  e.stopPropagation();
  try { await invoke("open_settings"); } catch (e) { console.error(e); }
});

stopBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  try { await invoke("stop_recording"); } catch (err) { console.error(err); }
});

cancelBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  try { await invoke("cancel_recording"); } catch (err) { console.error(err); }
});

// ─── recording timer ─────────────────────────────────────────────────────
let timerStart = 0;
let timerHandle = null;
function fmt(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, "0")}`;
}
function startTimer() {
  timerStart = Date.now();
  timerEl.textContent = "0:00";
  stopTimer();
  timerHandle = setInterval(() => {
    timerEl.textContent = fmt(Date.now() - timerStart);
  }, 250);
}
function stopTimer() {
  if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
}

listen("rec-state", (e) => {
  const s = e.payload;
  if (s === "recording" || s === "transcribing" || s === "done" || s === "idle") {
    setState(s);
    if (s === "recording") {
      stateLabel.textContent = "Listening";
      stateLabel.classList.remove("live");
      startTimer();
    } else if (s === "transcribing") {
      stateLabel.textContent = "Transcribing…";
      stateLabel.classList.remove("live");
      stopTimer();
    } else {
      stopTimer();
    }
  }
});

// Live partial transcript (streaming preview) — show most recent words while recording.
listen("partial-transcript", (e) => {
  if (hud.dataset.state !== "recording") return;
  const text = (e.payload || "").trim();
  if (!text) return;
  const tail = text.length > 64 ? "…" + text.slice(-64) : text;
  stateLabel.textContent = tail;
  stateLabel.classList.add("live");
});
