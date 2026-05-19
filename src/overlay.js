const { listen } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;

const hud = document.getElementById("hud");
const idlePill = document.getElementById("idle-pill");
const stopBtn = document.getElementById("stop-btn");
const cancelBtn = document.getElementById("cancel-btn");

function setState(s) {
  hud.dataset.state = s;
}

setState("idle");

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

const stateLabel = document.getElementById("state-label");

listen("rec-state", (e) => {
  const s = e.payload;
  if (s === "recording" || s === "transcribing" || s === "done" || s === "idle") {
    setState(s);
    if (s === "recording") stateLabel.textContent = "Listening";
    else if (s === "transcribing") stateLabel.textContent = "Transcribing";
  }
});
