# MyVoice — Session Summary (last update 2026-05-09)

Privacy-first voice dictation. Tauri 2 + Rust + whisper.cpp + cpal + enigo + Groq. macOS / Linux / Windows. Local Whisper or Groq Cloud. Push-to-talk, HUD overlay, history, voice profile, Wispr Flow inspired light UI.

Repo: https://github.com/joymadhu49/MyVoice — main branch tracks GitHub.

---

## Tag history

| Tag | Date | Headline |
|---|---|---|
| `v0.1.x` (no tag) | 2026-05-06 | Initial Tauri scaffold, local Whisper, single-button UI |
| `v0.2.0` | 2026-05-07 | Wayland fix, push-to-talk debounce, new logo, UI polish |
| `v0.3.0` | 2026-05-07 | Context modes, custom vocab, smarter profile, hallucination filter |
| HEAD `6bd36ff` | 2026-05-09 | Wispr-Flow light UI, collapsible sidebar, edge-to-edge layout |

---

## Architecture

### Backend — `src-tauri/src/lib.rs` (~1500 lines)
- **Audio capture:** cpal default input. Handles F32 / I16 / U16. Mono mix + linear resample to 16 kHz. Peak normalize + RMS-gated silence trim.
- **Push-to-talk:** Tauri global shortcut. Hold = start, release = stop+transcribe+paste. Debounce on hotkey release seq.
- **Hotkeys (in priority order):** `Ctrl+Shift+Space`, `Ctrl+Alt+Space`, `Super+Space`, `F9` (Linux/GNOME fallback because IBus grabs `Ctrl+Shift+Space`).
- **Providers:**
  - **Local Whisper** via `whisper-rs 0.13`. Beam search (5), `suppress_blank`, `no_context`, `initial_prompt = voice_profile_prompt()`. Models: tiny / base / small × en / multilingual.
  - **Groq Cloud:** multipart WAV upload to `https://api.groq.com/openai/v1/audio/transcriptions`. Models: `whisper-large-v3-turbo` (default), `whisper-large-v3`, `distil-whisper-large-v3-en`. Voice profile sent as `prompt` form field.
- **Voice profile prompt:** built from history JSONL — top-N words from last 300 entries + custom vocab + active mode pack (built-ins: `notes` / `ai_prompt` / `email` / `code` plus user-defined custom modes), capped at 220 chars (Whisper prompt token budget).
- **Hallucination filter:** drops common Whisper artefacts.
- **History:** append-only `history.jsonl` at the per-OS data dir. Schema: `{ id, ts, text, duration_ms, provider, model, words, flagged }`.
- **Stats:** total_words, wpm (words / total_ms × 60_000), day streak, sessions.
- **Auto-paste:** `enigo` (uses xdotool on Linux X11). Clipboard fallback via `arboard` always.
- **HUD:** frameless transparent always-on-top window, bottom-center, animated states (idle / recording / transcribing / done).

### Frontend — `src/`
- `index.html` — sidebar + topbar + main column with home / stats / voice profile / settings tabs. Topbar carries stats chips + bell + account/settings shortcut.
- `main.js` — Tauri `invoke` calls, history search/render, settings save, hero collapse, sidebar collapse, model download progress, drag-region fallback (`startDragging()`).
- `overlay.html` / `overlay.css` / `overlay.js` — HUD pill (idle: "Click to dictate F9", recording: animated bars + Listening + stop/cancel buttons, transcribing: pulse + Transcribing label, done: green check + Pasted).
- **CSS layered partials, last wins:**
  - `styles.css` — base structure
  - `styles/drag-fix.css` — `-webkit-app-region` rules + 80px traffic-light cutout
  - `styles/polish-hero.css`, `polish-history.css`, `polish-settings.css` — earlier polish pass
  - `styles/wispr.css` — current top layer; full Wispr Flow inspired light theme

### Tauri config — `src-tauri/tauri.conf.json`
- `main` window: 960×640, `titleBarStyle: Overlay`, `hiddenTitle: true`, `trafficLightPosition: { 16, 18 }`, `macOSPrivateApi: true`.
- `hud` window: frameless, transparent, always-on-top, no taskbar, no shadow, no focus.
- `bundle.macOS.minimumSystemVersion`: 10.15.

### Capabilities — `src-tauri/capabilities/default.json`
- `core:default`, window show/hide/setPosition/setSize/setFocus, `core:window:allow-start-dragging`, `core:window:allow-toggle-maximize`, `core:webview:allow-create-webview-window`, `opener:default`, global-shortcut register/unregister/is-registered.

---

## Wispr Flow design pass (latest)

Pulled the community Figma file `VpvKaQ20NhCyWgM6jWbqP5` via the third-party `figma-developer-mcp` (token stored in `~/.claude.json`). 9 hi-fi PNGs landed in `design-refs/` (gitignored).

Design tokens distilled into `src/styles/wispr.css`:
- Bg `#FFFFFF` (was `#F5F5F4` — flattened to panel so no warm gaps bleed through), sidebar `#FAFAF8`, cream hero `#FBF8E3` w/ border `#EDE6B0`
- Border `#E8E5DE`, text `#1F1F1F`, muted `#7A7A7A`
- Accent `#8B7CF6`, accent-bg `#EDE9FE`, accent-pill-bg `#C4B5FD`
- Dark CTA `#1A1A1A`

Layout:
- 220px sidebar w/ brand row (mic-pane mark + "MyVoice" + Pro pill clickable to collapse), labelled nav rows, Settings at bottom under divider
- Topbar: stats chips on right (🔥 day streak / 📌 words / ⚡ WPM — custom SVG icons, no emoji), bell w/ red notification dot, account icon → opens Settings tab
- Hero card: cream yellow, serif italic ("*Hold* the hotkey, speak, release."), dark pill CTA + ghost Cancel + kbd hints
- History: white cards, hover lift, row actions on hover (copy / flag / delete) with semantic hover colors
- All settings/profile cards: white panel, dashed dividers, inline forms

Sidebar collapse: brand mark click → sidebar hides → topbar shows accent "MyVoice" pill to expand.

---

## Data locations

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/myvoice/` |
| Linux | `~/.local/share/myvoice/` |
| Windows | `%APPDATA%\myvoice\` |

Files: `settings.json`, `history.jsonl`, `ggml-*.bin`.

---

## Toolchain — currently working environments

### macOS (Apple Silicon)
- Xcode CLT, brew, Node 24.13.1, cmake (brew), Rust 1.95 stable (rustup)
- `. "$HOME/.cargo/env" && npm run tauri dev`
- Build artifacts: `src-tauri/target/release/bundle/{dmg,macos}/`

### Linux (Ubuntu)
- `sudo apt install -y build-essential curl wget file pkg-config cmake clang libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev libasound2-dev nodejs npm`
- Rust via rustup
- Build artifacts: `src-tauri/target/release/bundle/{appimage,deb,rpm}/`

### Snap-env gotcha (Linux only)
VS Code snap terminal pollutes `GTK_PATH` / `LOCPATH` → `libpthread.so.0` GLIBC_PRIVATE error. Workaround in README — launch from a non-snap terminal or `env -i HOME=...` wrapper.

---

## CI

`.github/workflows/build.yml` (currently absent on `main` after `v0.3.0` reset — restore if cross-platform builds are needed again):
- matrix: macos-14 (arm64), macos-13 (x86_64), ubuntu-22.04, windows-latest
- `Swatinem/rust-cache@v2` to keep recompiles cheap
- tagged releases (`v*`) auto-publish via `softprops/action-gh-release`

---

## MCP servers configured (project scope)

- `dune` — analytics (HTTP, healthy)
- `figma` — third-party `figma-developer-mcp` via `npx -y figma-developer-mcp --stdio`, token in env. Used to pull Wispr Flow design refs. Note: the official Anthropic Figma MCP exists too but Starter plan rate-limits caused us to fall back to third-party.

---

## Known limitations / next steps

- Hero "Hold" italic font — `Tiempos Headline` not licensed; falls back to Georgia. Acceptable but not pixel-perfect to Wispr.
- No code signing on macOS bundles → first launch needs `xattr -dr com.apple.quarantine ...` or right-click → Open.
- Wayland HUD transparency varies by compositor (works on most, not all).
- CI workflow file dropped between v0.2.0 and v0.3.0 — restore if you want auto-builds again.
- No tests (still). Smoke-tested manually.
- Notifications bell in topbar is decorative — no notification system wired.
- No onboarding / no account / no cloud sync.

---

## How to resume in a new session

1. Read this file.
2. `cd ~/MyVoice && git pull --rebase`.
3. `pgrep -af myvoice` — relaunch dev with `. "$HOME/.cargo/env" && npm run tauri dev` if not running.
4. Pick from the "Known limitations" list, or check Figma for design updates and re-pull via `mcp__figma__get_figma_data` / `mcp__figma__download_figma_images`.

## Recent commits (most recent first)

- `6bd36ff` fix(ui): hero banner readability + working collapse + edge-to-edge fill
- `c2a875f` feat(ui): Wispr Flow inspired light theme + collapsible sidebar
- `4b7af7e` feat: v0.3.0 — context modes, custom vocab, smarter profile, hallucination filter
- `a55195e` feat(ui): topbar, robust window drag, polished history/settings/hero
- `b03aadc` ci: add cross-platform build workflow (mac arm64/x64, linux, windows)
- `28ed6f4` feat: v0.2.0 — Wayland fix, push-to-talk debounce, new logo, UI polish
- `2727fc3` feat: push-to-talk, Groq cloud, history, voice profile, sidebar UI
- `c282aae` docs: README with build/hotkey/model info
- `0d5415d` Initial commit: MyVoice voice dictation (Tauri + whisper.cpp + global hotkey + auto-type)
