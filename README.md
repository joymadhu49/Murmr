# MyVoice

Privacy-first voice dictation — Wispr-Flow-style hold-to-talk, anywhere on macOS and Linux. Local Whisper or Groq Cloud transcription, optional AI smart-formatting, auto-paste into any focused window, history, voice profile, system tray.

Tauri 2 + Rust + whisper.cpp + cpal + enigo + Groq Whisper / Groq LLM.

## Features

- **Hold-to-talk hotkey, everywhere:**
  - Linux/Windows/macOS: `Ctrl + Shift + Space`, `Ctrl + Alt + Space`, `Super + Space`, or `F9`
  - macOS (Wispr Flow default): hold **Right Option (⌥)** — bare-modifier, no chord
  - Linux Wayland: kernel-level evdev listener — works on GNOME 42+ where X11 grabs are blocked
- **Floating HUD overlay** — frameless pill bottom-center: recording / transcribing / done states.
- **System tray** — shows tray icon, menu: Toggle recording / Settings / Quit. Close-to-tray keeps the hotkey alive.
- **Autostart on login** — toggle in Settings.
- **Two providers:**
  - **Local Whisper** (offline, private). Tiny / Base / Small × English-only / multilingual. Auto-download.
  - **Groq Cloud** (online, fastest + most accurate). `whisper-large-v3-turbo` / `whisper-large-v3` / `distil-whisper-large-v3-en`.
- **Smart formatting** (optional) — pipes raw transcript through a Groq LLM (`llama-3.1-8b-instant` or `llama-3.3-70b-versatile`) to add punctuation, fix capitalization, drop fillers ("um", "uh"), and split into paragraphs. Mode-aware: email = formal register, code = identifiers stay literal, AI-prompt = verbatim intent. Falls back to the raw transcript on any LLM failure.
- **Voice profile** — top-N words from your history + your custom vocab + your active mode pack are sent as a Whisper context prompt; biases recognition toward your jargon, names, acronyms.
- **History** — every dictation persisted (`history.jsonl`). Per-row copy / flag / delete. Grouped by Today / Yesterday / weekday / date.
- **Stats** — total words, WPM (avg), day streak, sessions.
- **Audio quality** — peak normalize + silence trim + beam search (5) + `suppress_blank` + `no_context` + hallucination filter.

## Hotkey

Hold a hotkey anywhere → record → release → transcribe + auto-paste into the focused app + copy to clipboard.

| Platform | Default |
| --- | --- |
| macOS | Right Option (⌥) — Wispr Flow style |
| Linux X11 | Ctrl + Shift + Space |
| Linux Wayland | Ctrl + Shift + Space (via evdev — needs `input` group) |
| Windows | Ctrl + Shift + Space |

Fallbacks register simultaneously: `Ctrl + Alt + Space`, `Super + Space`, `F9`.

## Build

### macOS

```bash
xcode-select --install
brew install node cmake
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
. "$HOME/.cargo/env"
npm install
npm run tauri build
# output: src-tauri/target/release/bundle/{dmg,macos}/
```

Run dev: `npm run tauri dev`

**First-run permissions** (System Settings → Privacy & Security):
- **Microphone** — required.
- **Accessibility** — required for auto-paste AND for the Right Option global hotkey. Without it, transcripts still hit the clipboard but won't auto-type and the bare-modifier hotkey won't fire (chord hotkeys still work).

Unsigned build: right-click `.app` → Open. Or `xattr -dr com.apple.quarantine /Applications/myvoice.app`.

### Linux (Ubuntu/Debian)

```bash
sudo apt install -y build-essential curl wget file pkg-config cmake clang \
  libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev \
  librsvg2-dev libasound2-dev nodejs npm
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
. "$HOME/.cargo/env"
git clone https://github.com/joymadhu49/MyVoice.git
cd MyVoice
npm install
npm run tauri build
# output: src-tauri/target/release/bundle/{appimage,deb}/
```

Run dev: `npm run tauri dev`

**Wayland hotkey:** the evdev listener needs read access to `/dev/input/event*`. Add yourself to the `input` group once:

```bash
sudo usermod -aG input $USER
# log out + back in (or reboot)
```

Without that, only the userspace `Ctrl + Shift + Space` (and friends) will work on Wayland, and only when no other app has grabbed the chord first.

#### Snap-env gotcha

Running from VS Code's snap terminal poisons env (`GTK_PATH`, `LOCPATH`) → `libpthread.so.0: undefined symbol`. Fix: launch from a non-snap terminal, or:

```bash
env -i HOME="$HOME" PATH="$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin" \
  DISPLAY="$DISPLAY" XAUTHORITY="$XAUTHORITY" \
  WAYLAND_DISPLAY="$WAYLAND_DISPLAY" XDG_RUNTIME_DIR="/run/user/$(id -u)" \
  DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" USER="$USER" \
  npm run tauri dev
```

#### Linux notes

- Auto-paste: Wayland → `wtype` (preferred) or `ydotool`; X11 → `xdotool` via `enigo`. If neither is installed, clipboard still works.
- Title bar is shown (macOS-only Overlay style is ignored on Linux).

### Windows

WebView2 + Visual Studio Build Tools + Rust + Node, then `npm run tauri build`.

## Cloud (Groq) setup

1. Get a free API key at [console.groq.com/keys](https://console.groq.com/keys).
2. Settings → Transcription provider → Groq Cloud.
3. Paste key. Click "Test key". Pick model (`whisper-large-v3-turbo` recommended).

The same key is reused for **Smart formatting** (chat completions). Free tier covers a heavy day of dictation.

API key is stored locally in `settings.json` in the data dir below.

## Data locations

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/myvoice/` |
| Linux | `~/.local/share/myvoice/` |
| Windows | `%APPDATA%\myvoice\` |

Files:
- `settings.json` — provider, language, hotkey, Groq key, smart-format toggle
- `history.jsonl` — append-only dictation log
- `ggml-*.bin` — downloaded Whisper models

## Models (local)

| Model | Size | Notes |
|---|---|---|
| `tiny.en` | 75 MB | Fastest, English-only |
| `base.en` | 142 MB | Default, balanced |
| `small.en` | 466 MB | Most accurate, English-only |
| `tiny` / `base` / `small` | same | Multilingual variants |

## Architecture

- **`src-tauri/src/lib.rs`** — Rust backend. Audio capture (cpal), resample to 16k mono, peak normalize, silence trim, Whisper inference (whisper-rs) or Groq HTTP multipart, optional smart-formatting via Groq chat completions, history persistence, voice profile prompt builder, global hotkey (Tauri shortcut + Linux evdev + macOS rdev), push-to-talk, HUD show/hide, system tray, autostart, model download with progress events.
- **`src/index.html` + `main.js`** — single-window UI: sidebar nav, home (history), stats, voice profile, settings.
- **`src/overlay.html` + `overlay.js`** — frameless transparent always-on-top HUD pill.
- **`src-tauri/tauri.conf.json`** — window config, macOS overlay titleBarStyle, bundle settings.
- **`src-tauri/Info.plist`** — macOS mic + AppleEvents usage strings.

## License

MIT
