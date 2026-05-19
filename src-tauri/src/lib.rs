use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;
use enigo::{Enigo, Keyboard, Settings as EnigoSettings};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

#[derive(Clone, Serialize)]
struct ModelInfo {
    id: &'static str,
    label: &'static str,
    size_mb: u32,
    url: &'static str,
    lang: &'static str,
}

const MODELS: &[ModelInfo] = &[
    ModelInfo {
        id: "tiny.en",
        label: "Tiny (English) — 75 MB, fastest",
        size_mb: 75,
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin",
        lang: "en",
    },
    ModelInfo {
        id: "base.en",
        label: "Base (English) — 142 MB, balanced",
        size_mb: 142,
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
        lang: "en",
    },
    ModelInfo {
        id: "small.en",
        label: "Small (English) — 466 MB, accurate",
        size_mb: 466,
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin",
        lang: "en",
    },
    ModelInfo {
        id: "tiny",
        label: "Tiny (Multilingual) — 75 MB",
        size_mb: 75,
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
        lang: "multi",
    },
    ModelInfo {
        id: "base",
        label: "Base (Multilingual) — 142 MB",
        size_mb: 142,
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
        lang: "multi",
    },
    ModelInfo {
        id: "small",
        label: "Small (Multilingual) — 466 MB",
        size_mb: 466,
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
        lang: "multi",
    },
];

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct CustomMode {
    id: String,
    name: String,
    terms: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct AppSettings {
    active_model: String,
    language: String,
    auto_paste: bool,
    #[serde(default = "default_provider")]
    provider: String, // "local" | "groq"
    #[serde(default)]
    groq_api_key: String,
    #[serde(default = "default_groq_model")]
    groq_model: String, // e.g. "whisper-large-v3-turbo"
    #[serde(default)]
    custom_vocab: String,
    #[serde(default = "default_active_mode")]
    active_mode: String, // built-in id or custom id
    #[serde(default)]
    custom_modes: Vec<CustomMode>,
}

fn default_provider() -> String {
    "local".into()
}
fn default_groq_model() -> String {
    "whisper-large-v3-turbo".into()
}
fn default_active_mode() -> String {
    "notes".into()
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            active_model: "base.en".into(),
            language: "en".into(),
            auto_paste: true,
            provider: default_provider(),
            groq_api_key: String::new(),
            groq_model: default_groq_model(),
            custom_vocab: String::new(),
            active_mode: default_active_mode(),
            custom_modes: Vec::new(),
        }
    }
}

struct BuiltinMode {
    id: &'static str,
    name: &'static str,
    pack: &'static str,
}

const BUILTIN_MODES: &[BuiltinMode] = &[
    BuiltinMode {
        id: "notes",
        name: "Notes / general",
        pack: "",
    },
    BuiltinMode {
        id: "ai_prompt",
        name: "AI prompt",
        pack: "Common terms: prompt, agent, LLM, model, GPT, Claude, tool call, function call, system prompt, refactor, debug, JSON, API. Phrases: write a function, fix the bug, give me an example, explain this code.",
    },
    BuiltinMode {
        id: "email",
        name: "Email",
        pack: "Common terms: regards, sincerely, hello, dear, thanks, please find attached, forward, follow up, schedule, meeting. Phrases: best regards, looking forward, please let me know, thank you for your email.",
    },
    BuiltinMode {
        id: "code",
        name: "Code / tech",
        pack: "Common terms: function, variable, async, await, const, let, return, import, export, npm, GitHub, commit, branch, pull request, refactor, TypeScript, JavaScript, Rust, Python, JSON, API, endpoint, callback, promise.",
    },
];

const GROQ_MODELS: &[&str] = &[
    "whisper-large-v3-turbo",
    "whisper-large-v3",
    "distil-whisper-large-v3-en",
];

struct Session {
    stop: Arc<AtomicBool>,
    samples: Arc<Mutex<Vec<f32>>>,
    sample_rate: Arc<Mutex<u32>>,
    channels: Arc<Mutex<u16>>,
    handle: Option<thread::JoinHandle<()>>,
    started_at: Instant,
}

#[derive(Default)]
struct AppState {
    session: Mutex<Option<Session>>,
    whisper: Mutex<Option<(String, WhisperContext)>>,
    settings: Mutex<AppSettings>,
    hotkey_held: AtomicBool,
    hotkey_release_seq: std::sync::atomic::AtomicU64,
}

fn data_dir() -> Result<PathBuf> {
    let dir = dirs::data_dir()
        .ok_or_else(|| anyhow!("no data dir"))?
        .join("myvoice");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn settings_path() -> Result<PathBuf> {
    Ok(data_dir()?.join("settings.json"))
}

fn history_path() -> Result<PathBuf> {
    Ok(data_dir()?.join("history.jsonl"))
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct HistoryEntry {
    id: String,
    ts: u64,
    text: String,
    duration_ms: u64,
    provider: String,
    model: String,
    words: u32,
    #[serde(default)]
    flagged: bool,
}

fn append_history(entry: &HistoryEntry) -> Result<()> {
    let p = history_path()?;
    let mut f = fs::OpenOptions::new().create(true).append(true).open(p)?;
    f.write_all(serde_json::to_string(entry)?.as_bytes())?;
    f.write_all(b"\n")?;
    Ok(())
}

fn read_history_all() -> Vec<HistoryEntry> {
    let p = match history_path() {
        Ok(p) => p,
        _ => return vec![],
    };
    let f = match fs::File::open(&p) {
        Ok(f) => f,
        _ => return vec![],
    };
    BufReader::new(f)
        .lines()
        .filter_map(|l| l.ok())
        .filter_map(|l| serde_json::from_str::<HistoryEntry>(&l).ok())
        .collect()
}

fn write_history_all(items: &[HistoryEntry]) -> Result<()> {
    let p = history_path()?;
    let tmp = p.with_extension("part");
    let mut f = fs::File::create(&tmp)?;
    for e in items {
        f.write_all(serde_json::to_string(e)?.as_bytes())?;
        f.write_all(b"\n")?;
    }
    drop(f);
    fs::rename(tmp, p)?;
    Ok(())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn count_words(text: &str) -> u32 {
    text.split_whitespace().count() as u32
}

fn compute_streak(items: &[HistoryEntry]) -> u32 {
    let secs_per_day = 86_400u64;
    let now = now_secs();
    let today = now / secs_per_day;
    let days: HashSet<u64> = items.iter().map(|e| e.ts / secs_per_day).collect();
    let mut streak = 0u32;
    let mut d = today;
    loop {
        if days.contains(&d) {
            streak += 1;
            if d == 0 {
                break;
            }
            d -= 1;
        } else {
            break;
        }
    }
    streak
}

const PROMPT_BUDGET: usize = 880;
const STOPWORDS: &[&str] = &[
    "the", "and", "for", "you", "that", "this", "with", "have", "are", "was", "but", "not",
    "from", "they", "has", "had", "were", "what", "when", "your", "all", "would", "there",
    "their", "can", "will", "just", "like", "get", "got", "one", "out", "about", "into", "some",
    "more", "than", "then", "him", "her", "his", "she", "them", "now", "any", "been", "being",
    "also", "very", "much", "make", "made", "going", "want", "need", "know", "think", "thing",
    "things", "really", "actually", "okay",
];

fn is_stopword(lower: &str) -> bool {
    STOPWORDS.iter().any(|s| *s == lower)
}

fn tokenize(text: &str) -> Vec<&str> {
    text.split(|c: char| !c.is_alphanumeric() && c != '\'')
        .filter(|w| !w.is_empty())
        .collect()
}

fn append_term(out: &mut String, term: &str, budget: usize) -> bool {
    let extra = if out.is_empty() || out.ends_with(' ') || out.ends_with(':') {
        term.len()
    } else {
        term.len() + 2
    };
    if out.len() + extra > budget {
        return false;
    }
    if !(out.is_empty() || out.ends_with(' ') || out.ends_with(':')) {
        out.push_str(", ");
    }
    out.push_str(term);
    true
}

fn finish_section(out: &mut String) {
    let trimmed = out.trim_end_matches(", ").trim_end_matches(':').to_string();
    *out = trimmed;
    if !out.is_empty() && !out.ends_with('.') {
        out.push('.');
    }
}

fn mode_pack(settings: &AppSettings) -> String {
    let id = settings.active_mode.as_str();
    if let Some(m) = BUILTIN_MODES.iter().find(|m| m.id == id) {
        return m.pack.to_string();
    }
    if let Some(cm) = settings.custom_modes.iter().find(|m| m.id == id) {
        let lines: Vec<&str> = cm
            .terms
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .collect();
        if lines.is_empty() {
            return String::new();
        }
        return format!("Common terms: {}.", lines.join(", "));
    }
    String::new()
}

fn voice_profile_prompt(settings: &AppSettings) -> String {
    let mut out = String::new();

    let pack = mode_pack(settings);
    if !pack.is_empty() {
        if out.len() + pack.len() + 1 <= PROMPT_BUDGET {
            out.push_str(&pack);
            if !out.ends_with(' ') {
                out.push(' ');
            }
        }
    }

    let custom: Vec<String> = settings
        .custom_vocab
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    if !custom.is_empty() {
        let prefix = "Vocabulary: ";
        if out.len() + prefix.len() + 4 <= PROMPT_BUDGET {
            out.push_str(prefix);
            for term in &custom {
                if !append_term(&mut out, term, PROMPT_BUDGET) {
                    break;
                }
            }
            finish_section(&mut out);
            if !out.ends_with(' ') {
                out.push(' ');
            }
        }
    }

    let items = read_history_all();
    if items.len() >= 3 {
        let mut word_counts: HashMap<String, u32> = HashMap::new();
        let mut casing: HashMap<String, String> = HashMap::new();
        let mut name_counts: HashMap<String, u32> = HashMap::new();
        let mut bigram_counts: HashMap<String, u32> = HashMap::new();

        for e in items.iter().rev().take(300) {
            let tokens = tokenize(&e.text);
            for (i, w) in tokens.iter().enumerate() {
                let lower = w.to_lowercase();
                let is_acronym =
                    w.len() >= 2 && w.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit());
                let is_capitalized = w
                    .chars()
                    .next()
                    .map(|c| c.is_ascii_uppercase())
                    .unwrap_or(false)
                    && !is_acronym;

                if (w.len() >= 4 || is_acronym) && !is_stopword(&lower) {
                    *word_counts.entry(lower.clone()).or_insert(0) += 1;
                    let prefer = casing.entry(lower.clone()).or_insert_with(|| (*w).to_string());
                    let cur_score = casing_score(prefer);
                    let new_score = casing_score(w);
                    if new_score > cur_score {
                        *prefer = (*w).to_string();
                    }
                }

                if is_capitalized && i > 0 && w.len() >= 3 && !is_stopword(&lower) {
                    *name_counts.entry((*w).to_string()).or_insert(0) += 1;
                }

                if let Some(next) = tokens.get(i + 1) {
                    let nlow = next.to_lowercase();
                    if w.len() >= 3
                        && next.len() >= 3
                        && !is_stopword(&lower)
                        && !is_stopword(&nlow)
                    {
                        let bg = format!("{} {}", lower, nlow);
                        *bigram_counts.entry(bg).or_insert(0) += 1;
                    }
                }
            }
        }

        let mut names: Vec<(String, u32)> = name_counts.into_iter().collect();
        names.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        let names: Vec<String> = names.into_iter().take(20).map(|(w, _)| w).collect();

        let mut bigrams: Vec<(String, u32)> = bigram_counts
            .into_iter()
            .filter(|(_, c)| *c >= 2)
            .collect();
        bigrams.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        let bigrams: Vec<String> = bigrams.into_iter().take(15).map(|(w, _)| w).collect();

        let mut words: Vec<(String, u32)> = word_counts.into_iter().collect();
        words.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        let words: Vec<String> = words
            .into_iter()
            .take(100)
            .map(|(k, _)| casing.get(&k).cloned().unwrap_or(k))
            .collect();

        if !words.is_empty() && out.len() + 16 < PROMPT_BUDGET {
            out.push_str("Common terms: ");
            for w in &words {
                if !append_term(&mut out, w, PROMPT_BUDGET) {
                    break;
                }
            }
            finish_section(&mut out);
            if !out.ends_with(' ') {
                out.push(' ');
            }
        }

        if !names.is_empty() && out.len() + 9 < PROMPT_BUDGET {
            out.push_str("Names: ");
            for n in &names {
                if !append_term(&mut out, n, PROMPT_BUDGET) {
                    break;
                }
            }
            finish_section(&mut out);
            if !out.ends_with(' ') {
                out.push(' ');
            }
        }

        if !bigrams.is_empty() && out.len() + 19 < PROMPT_BUDGET {
            out.push_str("Frequent phrases: ");
            for b in &bigrams {
                if !append_term(&mut out, b, PROMPT_BUDGET) {
                    break;
                }
            }
            finish_section(&mut out);
        }
    }

    out.trim().to_string()
}

const HALLUCINATION_EXACT: &[&str] = &[
    "thanks for watching",
    "thank you for watching",
    "thank you",
    "you",
    "please subscribe",
    "[blank_audio]",
    "(music)",
    "(silence)",
    "[music]",
    "[no audio]",
    "[silence]",
];

fn normalize_for_match(s: &str) -> String {
    s.trim()
        .trim_matches(|c: char| matches!(c, '.' | '!' | '?' | ',' | ' ' | '"' | '\''))
        .to_lowercase()
}

fn is_hallucination_phrase(s: &str) -> bool {
    let n = normalize_for_match(s);
    if n.is_empty() {
        return true;
    }
    if HALLUCINATION_EXACT.iter().any(|h| *h == n) {
        return true;
    }
    if n.starts_with("subtitles by")
        || n.starts_with("subtitles ")
        || n.starts_with("captions by")
    {
        return true;
    }
    false
}

fn filter_hallucinations(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if is_hallucination_phrase(trimmed) {
        return String::new();
    }
    let sentences: Vec<&str> = trimmed
        .split_inclusive(|c: char| matches!(c, '.' | '!' | '?' | '\n'))
        .collect();
    if sentences.len() > 1 {
        let kept: Vec<&str> = sentences
            .iter()
            .copied()
            .filter(|s| !is_hallucination_phrase(s))
            .collect();
        return kept.join("").trim().to_string();
    }
    trimmed.to_string()
}

fn casing_score(w: &str) -> u8 {
    let has_upper = w.chars().any(|c| c.is_ascii_uppercase());
    let has_lower = w.chars().any(|c| c.is_ascii_lowercase());
    if has_upper && has_lower {
        3
    } else if w.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()) && has_upper {
        2
    } else {
        1
    }
}

#[tauri::command]
fn list_history(limit: Option<usize>) -> Vec<HistoryEntry> {
    let mut items = read_history_all();
    items.reverse();
    if let Some(n) = limit {
        items.truncate(n);
    }
    items
}

#[tauri::command]
fn delete_history_item(id: String) -> Result<(), String> {
    let items: Vec<HistoryEntry> = read_history_all()
        .into_iter()
        .filter(|e| e.id != id)
        .collect();
    write_history_all(&items).map_err(|e| e.to_string())
}

#[tauri::command]
fn flag_history_item(id: String) -> Result<(), String> {
    let mut items = read_history_all();
    for e in items.iter_mut() {
        if e.id == id {
            e.flagged = !e.flagged;
        }
    }
    write_history_all(&items).map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_history() -> Result<(), String> {
    write_history_all(&[]).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_stats(state: State<'_, AppState>) -> serde_json::Value {
    let items = read_history_all();
    let total_words: u64 = items.iter().map(|e| e.words as u64).sum();
    let total_ms: u64 = items.iter().map(|e| e.duration_ms).sum();
    let wpm = if total_ms > 0 {
        (total_words as f64 / (total_ms as f64 / 60_000.0)).round() as u64
    } else {
        0
    };
    let settings = state.settings.lock().unwrap().clone();
    serde_json::json!({
        "total_words": total_words,
        "wpm": wpm,
        "streak": compute_streak(&items),
        "sessions": items.len(),
        "voice_profile_size": voice_profile_prompt(&settings).len(),
    })
}

fn load_settings() -> AppSettings {
    settings_path()
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_settings(s: &AppSettings) -> Result<()> {
    let p = settings_path()?;
    fs::write(p, serde_json::to_string_pretty(s)?)?;
    Ok(())
}

fn model_file(id: &str) -> Result<PathBuf> {
    Ok(data_dir()?.join(format!("ggml-{}.bin", id)))
}

fn find_model(id: &str) -> Option<&'static ModelInfo> {
    MODELS.iter().find(|m| m.id == id)
}

fn model_exists(id: &str) -> bool {
    let p = match model_file(id) {
        Ok(p) => p,
        Err(_) => return false,
    };
    let info = match find_model(id) {
        Some(i) => i,
        None => return false,
    };
    fs::metadata(&p)
        .map(|m| m.len() > (info.size_mb as u64).saturating_mul(900_000))
        .unwrap_or(false)
}

#[derive(Clone, Serialize)]
struct ModelStatus {
    id: String,
    label: String,
    size_mb: u32,
    lang: String,
    downloaded: bool,
    active: bool,
}

#[tauri::command]
fn list_models(state: State<'_, AppState>) -> Vec<ModelStatus> {
    let active = state.settings.lock().unwrap().active_model.clone();
    MODELS
        .iter()
        .map(|m| ModelStatus {
            id: m.id.into(),
            label: m.label.into(),
            size_mb: m.size_mb,
            lang: m.lang.into(),
            downloaded: model_exists(m.id),
            active: m.id == active,
        })
        .collect()
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> AppSettings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn update_settings(
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    {
        let mut g = state.settings.lock().unwrap();
        *g = settings.clone();
    }
    save_settings(&settings).map_err(|e| e.to_string())?;
    Ok(settings)
}

#[tauri::command]
async fn set_active_model(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<AppSettings, String> {
    if find_model(&id).is_none() {
        return Err(format!("unknown model: {}", id));
    }
    if !model_exists(&id) {
        return Err(format!("model not downloaded: {}", id));
    }
    let new = {
        let mut g = state.settings.lock().unwrap();
        g.active_model = id;
        g.clone()
    };
    save_settings(&new).map_err(|e| e.to_string())?;
    {
        let mut w = state.whisper.lock().unwrap();
        *w = None;
    }
    let _ = app.emit("settings-changed", &new);
    Ok(new)
}

#[tauri::command]
fn download_model(app: AppHandle, id: String) -> Result<(), String> {
    let info = find_model(&id).ok_or_else(|| format!("unknown model: {}", id))?;
    let path = model_file(&id).map_err(|e| e.to_string())?;
    if model_exists(&id) {
        let _ = app.emit(
            "model-progress",
            serde_json::json!({"id": id, "done": true, "bytes": 0, "total": 0, "error": null}),
        );
        return Ok(());
    }
    let url = info.url;
    let id_clone = id.clone();
    let app_clone = app.clone();
    thread::spawn(move || {
        let do_download = || -> Result<u64, String> {
            let resp = ureq::get(url).call().map_err(|e| e.to_string())?;
            let total: u64 = resp
                .header("Content-Length")
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            let tmp = path.with_extension("part");
            let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
            let mut reader = resp.into_reader();
            let mut buf = vec![0u8; 256 * 1024];
            let mut got: u64 = 0;
            let mut last_emit = Instant::now();
            loop {
                let n = match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(e) => return Err(e.to_string()),
                };
                std::io::Write::write_all(&mut file, &buf[..n]).map_err(|e| e.to_string())?;
                got += n as u64;
                if last_emit.elapsed() > Duration::from_millis(200) {
                    let _ = app_clone.emit(
                        "model-progress",
                        serde_json::json!({
                            "id": id_clone,
                            "bytes": got,
                            "total": total,
                            "done": false,
                            "error": null,
                        }),
                    );
                    last_emit = Instant::now();
                }
            }
            drop(file);
            fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
            Ok(got)
        };
        match do_download() {
            Ok(got) => {
                let _ = app_clone.emit(
                    "model-progress",
                    serde_json::json!({
                        "id": id,
                        "bytes": got,
                        "total": got,
                        "done": true,
                        "error": null,
                    }),
                );
            }
            Err(e) => {
                let _ = app_clone.emit(
                    "model-progress",
                    serde_json::json!({
                        "id": id,
                        "bytes": 0,
                        "total": 0,
                        "done": true,
                        "error": e,
                    }),
                );
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn delete_model(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let active = state.settings.lock().unwrap().active_model.clone();
    if active == id {
        return Err("cannot delete active model".into());
    }
    let p = model_file(&id).map_err(|e| e.to_string())?;
    if p.exists() {
        fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn ensure_active_model(state: &AppState) -> Result<(PathBuf, String)> {
    let id = state.settings.lock().unwrap().active_model.clone();
    let info = find_model(&id).ok_or_else(|| anyhow!("unknown model: {}", id))?;
    let p = model_file(&id)?;
    if !model_exists(&id) {
        let resp = ureq::get(info.url).call()?;
        let mut reader = resp.into_reader();
        let tmp = p.with_extension("part");
        let mut file = fs::File::create(&tmp)?;
        std::io::copy(&mut reader, &mut file)?;
        drop(file);
        fs::rename(&tmp, &p)?;
    }
    Ok((p, id))
}

fn start_inner(state: &AppState) -> Result<(), String> {
    let mut sess = state.session.lock().unwrap();
    if sess.is_some() {
        return Err("already recording".into());
    }
    let stop = Arc::new(AtomicBool::new(false));
    let samples: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
    let sr = Arc::new(Mutex::new(0u32));
    let ch = Arc::new(Mutex::new(0u16));

    let stop_t = stop.clone();
    let samples_t = samples.clone();
    let sr_t = sr.clone();
    let ch_t = ch.clone();

    let handle = thread::spawn(move || {
        let host = cpal::default_host();
        let dev = match host.default_input_device() {
            Some(d) => d,
            None => return,
        };
        let cfg = match dev.default_input_config() {
            Ok(c) => c,
            Err(_) => return,
        };
        *sr_t.lock().unwrap() = cfg.sample_rate().0;
        *ch_t.lock().unwrap() = cfg.channels();
        let fmt = cfg.sample_format();
        let cfg2: cpal::StreamConfig = cfg.into();
        let s2 = samples_t.clone();
        let err_fn = |e| eprintln!("audio err: {}", e);
        let stream = match fmt {
            SampleFormat::F32 => dev.build_input_stream(
                &cfg2,
                move |data: &[f32], _: &_| s2.lock().unwrap().extend_from_slice(data),
                err_fn,
                None,
            ),
            SampleFormat::I16 => dev.build_input_stream(
                &cfg2,
                move |data: &[i16], _: &_| {
                    let mut g = s2.lock().unwrap();
                    g.extend(data.iter().map(|&v| v as f32 / 32768.0));
                },
                err_fn,
                None,
            ),
            SampleFormat::U16 => dev.build_input_stream(
                &cfg2,
                move |data: &[u16], _: &_| {
                    let mut g = s2.lock().unwrap();
                    g.extend(data.iter().map(|&v| (v as f32 - 32768.0) / 32768.0));
                },
                err_fn,
                None,
            ),
            _ => return,
        };
        let stream = match stream {
            Ok(s) => s,
            Err(_) => return,
        };
        if stream.play().is_err() {
            return;
        }
        while !stop_t.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(50));
        }
        drop(stream);
    });

    *sess = Some(Session {
        stop,
        samples,
        sample_rate: sr,
        channels: ch,
        handle: Some(handle),
        started_at: Instant::now(),
    });
    Ok(())
}

fn normalize_peak(samples: &mut [f32]) {
    let peak = samples.iter().fold(0.0_f32, |a, &x| a.max(x.abs()));
    if peak < 0.001 || peak >= 0.95 {
        return;
    }
    let gain = 0.95 / peak;
    let gain = gain.min(8.0); // cap gain to avoid amplifying pure noise
    for s in samples.iter_mut() {
        *s *= gain;
    }
}

fn trim_silence(samples: &[f32], sample_rate: u32) -> Vec<f32> {
    if samples.is_empty() {
        return Vec::new();
    }
    let win = (sample_rate as usize / 50).max(160); // ~20ms window
    let threshold = 0.012_f32;
    let energy = |chunk: &[f32]| -> f32 {
        let sum_sq: f32 = chunk.iter().map(|x| x * x).sum();
        (sum_sq / chunk.len() as f32).sqrt()
    };
    let mut start = 0usize;
    let mut end = samples.len();
    let mut i = 0;
    while i + win <= samples.len() {
        if energy(&samples[i..i + win]) > threshold {
            start = i.saturating_sub(win * 4); // keep ~80ms padding
            break;
        }
        i += win;
    }
    if i + win > samples.len() {
        return samples.to_vec();
    }
    let mut j = samples.len().saturating_sub(win);
    loop {
        if energy(&samples[j..(j + win).min(samples.len())]) > threshold {
            end = (j + win * 4).min(samples.len());
            break;
        }
        if j == 0 {
            break;
        }
        j = j.saturating_sub(win);
    }
    if end <= start {
        return samples.to_vec();
    }
    samples[start..end].to_vec()
}

fn pcm16_wav_bytes(pcm: &[f32], sample_rate: u32) -> Result<Vec<u8>> {
    use std::io::Cursor;
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut buf = Cursor::new(Vec::<u8>::new());
    {
        let mut w = hound::WavWriter::new(&mut buf, spec)?;
        for &s in pcm {
            let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
            w.write_sample(v)?;
        }
        w.finalize()?;
    }
    Ok(buf.into_inner())
}

fn transcribe_groq(
    pcm: &[f32],
    sample_rate: u32,
    api_key: &str,
    model: &str,
    language: &str,
    prompt: &str,
) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("Groq API key not set".into());
    }
    let wav = pcm16_wav_bytes(pcm, sample_rate).map_err(|e| e.to_string())?;
    let boundary = format!("----myvoice{:x}", std::process::id());
    let mut body: Vec<u8> = Vec::with_capacity(wav.len() + 1024);
    body.extend_from_slice(format!("--{}\r\n", boundary).as_bytes());
    body.extend_from_slice(b"Content-Disposition: form-data; name=\"model\"\r\n\r\n");
    body.extend_from_slice(model.as_bytes());
    body.extend_from_slice(b"\r\n");
    if !language.is_empty() && language != "auto" {
        body.extend_from_slice(format!("--{}\r\n", boundary).as_bytes());
        body.extend_from_slice(b"Content-Disposition: form-data; name=\"language\"\r\n\r\n");
        body.extend_from_slice(language.as_bytes());
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{}\r\n", boundary).as_bytes());
    body.extend_from_slice(b"Content-Disposition: form-data; name=\"response_format\"\r\n\r\n");
    body.extend_from_slice(b"json");
    body.extend_from_slice(b"\r\n");
    if !prompt.trim().is_empty() {
        body.extend_from_slice(format!("--{}\r\n", boundary).as_bytes());
        body.extend_from_slice(b"Content-Disposition: form-data; name=\"prompt\"\r\n\r\n");
        body.extend_from_slice(prompt.as_bytes());
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{}\r\n", boundary).as_bytes());
    body.extend_from_slice(b"Content-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\nContent-Type: audio/wav\r\n\r\n");
    body.extend_from_slice(&wav);
    body.extend_from_slice(b"\r\n");
    body.extend_from_slice(format!("--{}--\r\n", boundary).as_bytes());

    let resp = ureq::post("https://api.groq.com/openai/v1/audio/transcriptions")
        .set("Authorization", &format!("Bearer {}", api_key))
        .set(
            "Content-Type",
            &format!("multipart/form-data; boundary={}", boundary),
        )
        .send_bytes(&body)
        .map_err(|e| match e {
            ureq::Error::Status(code, r) => {
                let msg = r.into_string().unwrap_or_default();
                format!("Groq HTTP {}: {}", code, msg)
            }
            ureq::Error::Transport(t) => format!("Groq transport: {}", t),
        })?;
    let text = resp.into_string().map_err(|e| e.to_string())?;
    let val: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(val
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string())
}

fn to_mono_16k(input: &[f32], sample_rate: u32, channels: u16) -> Vec<f32> {
    let mono: Vec<f32> = if channels <= 1 {
        input.to_vec()
    } else {
        input
            .chunks(channels as usize)
            .map(|c| c.iter().sum::<f32>() / c.len() as f32)
            .collect()
    };
    if sample_rate == 16000 || mono.is_empty() {
        return mono;
    }
    let ratio = 16000.0 / sample_rate as f32;
    let out_len = (mono.len() as f32 * ratio) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f32 / ratio;
        let i0 = src.floor() as usize;
        let i1 = (i0 + 1).min(mono.len() - 1);
        let t = src - i0 as f32;
        out.push(mono[i0] * (1.0 - t) + mono[i1] * t);
    }
    out
}

fn stop_inner(state: &AppState) -> Result<(String, u64, String, String), String> {
    let sess = {
        let mut g = state.session.lock().unwrap();
        g.take()
    };
    let mut sess = sess.ok_or_else(|| "not recording".to_string())?;
    sess.stop.store(true, Ordering::Relaxed);
    if let Some(h) = sess.handle.take() {
        let _ = h.join();
    }
    let raw = sess.samples.lock().unwrap().clone();
    let sr = *sess.sample_rate.lock().unwrap();
    let ch = *sess.channels.lock().unwrap();
    let duration_ms = sess.started_at.elapsed().as_millis() as u64;
    if duration_ms < 150 || raw.is_empty() {
        return Err("too short".into());
    }
    let mut pcm = to_mono_16k(&raw, sr, ch);
    normalize_peak(&mut pcm);
    let pcm = trim_silence(&pcm, 16000);
    if pcm.len() < 16000 / 8 {
        return Err("no speech detected".into());
    }

    let (provider, language, groq_key, groq_model, settings_clone) = {
        let s = state.settings.lock().unwrap();
        (
            s.provider.clone(),
            s.language.clone(),
            s.groq_api_key.clone(),
            s.groq_model.clone(),
            s.clone(),
        )
    };

    let voice_prompt = voice_profile_prompt(&settings_clone);

    if provider == "groq" {
        let text = transcribe_groq(
            &pcm, 16000, &groq_key, &groq_model, &language, &voice_prompt,
        )?;
        return Ok((filter_hallucinations(&text), duration_ms, "groq".into(), groq_model));
    }

    let (model_path, model_id) = ensure_active_model(state).map_err(|e| format!("model: {}", e))?;

    let mut wlock = state.whisper.lock().unwrap();
    let need_reload = wlock
        .as_ref()
        .map(|(id, _)| id != &model_id)
        .unwrap_or(true);
    if need_reload {
        let ctx = WhisperContext::new_with_params(
            model_path.to_str().unwrap(),
            WhisperContextParameters::default(),
        )
        .map_err(|e| format!("whisper init: {}", e))?;
        *wlock = Some((model_id.clone(), ctx));
    }
    let ctx = &wlock.as_ref().unwrap().1;
    let mut state_w = ctx.create_state().map_err(|e| e.to_string())?;
    let mut params = FullParams::new(SamplingStrategy::BeamSearch {
        beam_size: 5,
        patience: 1.0,
    });
    params.set_print_progress(false);
    params.set_print_special(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_suppress_blank(true);
    params.set_no_context(true);
    if !voice_prompt.is_empty() {
        params.set_initial_prompt(&voice_prompt);
    }
    let lang_opt = if language.is_empty() || language == "auto" {
        None
    } else {
        Some(language.as_str())
    };
    if find_model(&model_id).map(|m| m.lang == "en").unwrap_or(false) {
        params.set_language(Some("en"));
    } else {
        params.set_language(lang_opt);
    }
    state_w.full(params, &pcm).map_err(|e| e.to_string())?;
    let n = state_w.full_n_segments();
    let mut out = String::new();
    for i in 0..n {
        if let Some(seg) = state_w.get_segment(i) {
            if let Ok(text) = seg.to_str() {
                out.push_str(text);
            }
        }
    }
    Ok((filter_hallucinations(out.trim()), duration_ms, "local".into(), model_id))
}

fn record_history(text: &str, duration_ms: u64, provider: &str, model: &str) {
    if text.trim().is_empty() {
        return;
    }
    let entry = HistoryEntry {
        id: format!("{}-{}", now_secs(), text.len()),
        ts: now_secs(),
        text: text.to_string(),
        duration_ms,
        provider: provider.to_string(),
        model: model.to_string(),
        words: count_words(text),
        flagged: false,
    };
    let _ = append_history(&entry);
}

#[tauri::command]
fn list_groq_models() -> Vec<String> {
    GROQ_MODELS.iter().map(|s| s.to_string()).collect()
}

#[tauri::command]
fn list_builtin_modes() -> Vec<serde_json::Value> {
    BUILTIN_MODES
        .iter()
        .map(|m| serde_json::json!({ "id": m.id, "name": m.name, "pack": m.pack }))
        .collect()
}

#[tauri::command]
fn preview_voice_prompt(state: State<'_, AppState>) -> String {
    let s = state.settings.lock().unwrap().clone();
    voice_profile_prompt(&s)
}

#[tauri::command]
async fn test_groq(api_key: String) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("API key empty".into());
    }
    let resp = ureq::get("https://api.groq.com/openai/v1/models")
        .set("Authorization", &format!("Bearer {}", api_key))
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(code, r) => {
                format!("HTTP {}: {}", code, r.into_string().unwrap_or_default())
            }
            ureq::Error::Transport(t) => format!("transport: {}", t),
        })?;
    let _ = resp.into_string();
    Ok("Groq API key works.".into())
}

fn deliver_text(text: &str, auto_paste: bool) {
    if text.is_empty() {
        return;
    }
    if let Ok(mut cb) = arboard::Clipboard::new() {
        let _ = cb.set_text(text.to_string());
    }
    if !auto_paste {
        return;
    }
    let on_wayland = std::env::var("WAYLAND_DISPLAY").is_ok();
    if on_wayland {
        // wtype: native Wayland typing, no portal permission needed
        if std::process::Command::new("wtype")
            .arg(text)
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        {
            return;
        }
        // ydotool fallback (needs ydotoold daemon)
        if std::process::Command::new("ydotool")
            .args(["type", "--", text])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        {
            return;
        }
    }
    // X11 / last-resort fallback via enigo
    if let Ok(mut enigo) = Enigo::new(&EnigoSettings::default()) {
        let _ = enigo.text(text);
    }
}

fn position_hud(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("hud") {
        let mon = win
            .current_monitor()
            .ok()
            .flatten()
            .or_else(|| app.primary_monitor().ok().flatten())
            .or_else(|| {
                app.available_monitors()
                    .ok()
                    .and_then(|mut v| v.pop())
            });
        if let Some(monitor) = mon {
            let pos = monitor.position();
            let size = monitor.size();
            let scale = monitor.scale_factor();
            let win_w = (360.0 * scale) as i32;
            let win_h = (96.0 * scale) as i32;
            let x = pos.x + (size.width as i32 - win_w) / 2;
            let y = pos.y + size.height as i32 - win_h - (80.0 * scale) as i32;
            let _ = win.set_position(PhysicalPosition::new(x, y));
        }
    }
}

fn show_hud(app: &AppHandle, state: &str) {
    if let Some(win) = app.get_webview_window("hud") {
        position_hud(app);
        let _ = win.show();
        let _ = win.set_always_on_top(true);
    }
    let _ = app.emit("rec-state", state);
}

fn hide_hud(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("hud") {
        let _ = win.hide();
    }
}

#[tauri::command]
fn open_settings(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
    Ok(())
}

#[tauri::command]
fn start_recording(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    start_inner(&state)?;
    show_hud(&app, "recording");
    Ok(())
}

#[tauri::command]
async fn stop_recording(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    let _ = app.emit("rec-state", "transcribing");
    let auto_paste = state.settings.lock().unwrap().auto_paste;
    let res = stop_inner(&state);
    match res {
        Ok((text, dur, provider, model)) => {
            record_history(&text, dur, &provider, &model);
            let _ = app.emit("transcript", &text);
            let _ = app.emit("history-changed", ());
            let _ = app.emit("rec-state", "done");
            let app2 = app.clone();
            let t = text.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(300)); // brief "done" flash
                hide_hud(&app2);
                thread::sleep(Duration::from_millis(500)); // let focus return
                deliver_text(&t, auto_paste);
            });
            Ok(text)
        }
        Err(e) => {
            let _ = app.emit("rec-error", &e);
            let _ = app.emit("rec-state", "idle");
            let app2 = app.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(700));
                hide_hud(&app2);
            });
            Err(e)
        }
    }
}

#[tauri::command]
fn cancel_recording(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.session.lock().unwrap();
    if let Some(mut sess) = guard.take() {
        sess.stop.store(true, Ordering::SeqCst);
        if let Some(h) = sess.handle.take() {
            let _ = h.join();
        }
    }
    let _ = app.emit("rec-state", "idle");
    let app2 = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(150));
        hide_hud(&app2);
    });
    Ok(())
}

#[tauri::command]
fn is_wayland() -> bool {
    std::env::var("XDG_SESSION_TYPE")
        .map(|v| v.eq_ignore_ascii_case("wayland"))
        .unwrap_or(false)
        || std::env::var_os("WAYLAND_DISPLAY").is_some()
}

fn do_stop(app: &AppHandle, state: &AppState) {
    let _ = app.emit("rec-state", "transcribing");
    let auto_paste = state.settings.lock().unwrap().auto_paste;
    match stop_inner(state) {
        Ok((text, dur, provider, model)) => {
            record_history(&text, dur, &provider, &model);
            let _ = app.emit("transcript", &text);
            let _ = app.emit("history-changed", ());
            let _ = app.emit("rec-state", "done");
            let app2 = app.clone();
            let t = text.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(300)); // brief "done" flash
                hide_hud(&app2);
                thread::sleep(Duration::from_millis(500)); // let target window regain focus
                deliver_text(&t, auto_paste);
            });
        }
        Err(e) => {
            let _ = app.emit("rec-error", &e);
            let _ = app.emit("rec-state", "idle");
            let app2 = app.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(700));
                hide_hud(&app2);
            });
        }
    }
}

fn handle_hotkey(app: &AppHandle, pressed: bool) {
    let state = app.state::<AppState>();
    if pressed {
        state.hotkey_held.store(true, Ordering::SeqCst);

        // Check if already recording
        let recording_ms = {
            let sess = state.session.lock().unwrap();
            sess.as_ref().map(|s| s.started_at.elapsed().as_millis() as u64)
        };
        if let Some(elapsed_ms) = recording_ms {
            // On Wayland, the compositor may only fire Pressed, never Released.
            // Treat a second press after 500 ms of recording as a toggle stop.
            if elapsed_ms > 200 {
                state.hotkey_held.store(false, Ordering::SeqCst);
                // Invalidate any pending debounce thread from a prior Release event.
                state.hotkey_release_seq.fetch_add(1, Ordering::SeqCst);
                let app2 = app.clone();
                thread::spawn(move || {
                    let st = app2.state::<AppState>();
                    if st.session.lock().unwrap().is_none() {
                        return;
                    }
                    do_stop(&app2, &st);
                });
            }
            return;
        }

        let _ = start_inner(&state);
        show_hud(app, "recording");
    } else {
        state.hotkey_held.store(false, Ordering::SeqCst);
        // X11 key auto-repeat fires Release+Press pairs while a key is physically
        // held. Debounce: if a Press arrives within the window, treat as still held.
        let seq = state
            .hotkey_release_seq
            .fetch_add(1, Ordering::SeqCst)
            .wrapping_add(1);
        if state.session.lock().unwrap().is_none() {
            return;
        }
        let app2 = app.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(90));
            let st = app2.state::<AppState>();
            if st.hotkey_held.load(Ordering::SeqCst) {
                return;
            }
            if st.hotkey_release_seq.load(Ordering::SeqCst) != seq {
                return;
            }
            if st.session.lock().unwrap().is_none() {
                return;
            }
            do_stop(&app2, &st);
        });
    }
}

/// Spawn a kernel-level evdev hotkey listener that works on any compositor,
/// including Wayland (where X11 key grabs are blocked by GNOME 42+).
#[cfg(target_os = "linux")]
fn spawn_evdev_hotkey(app: AppHandle) {
    use evdev::{Device, EventType, Key};

    thread::spawn(move || {
        // Find keyboard devices: must have Ctrl, Shift, and Space keys
        let keyboards: Vec<Device> = evdev::enumerate()
            .map(|(_, d)| d)
            .filter(|d| {
                d.supported_keys()
                    .map(|k| k.contains(Key::KEY_LEFTCTRL) && k.contains(Key::KEY_SPACE))
                    .unwrap_or(false)
            })
            .collect();

        if keyboards.is_empty() {
            eprintln!("evdev: no keyboard found (is user in 'input' group?)");
            return;
        }

        // Spawn one listener thread per keyboard device (handles multiple keyboards)
        let mut handles = vec![];
        for mut dev in keyboards {
            let app2 = app.clone();
            handles.push(thread::spawn(move || {
                let mut ctrl = false;
                let mut shift = false;
                let mut hotkey_down = false;

                loop {
                    let events = match dev.fetch_events() {
                        Ok(e) => e,
                        Err(_) => {
                            thread::sleep(Duration::from_millis(200));
                            continue;
                        }
                    };
                    for ev in events {
                        if ev.event_type() != EventType::KEY {
                            continue;
                        }
                        let key = Key::new(ev.code());
                        let val = ev.value(); // 1=press, 0=release, 2=repeat

                        match key {
                            Key::KEY_LEFTCTRL | Key::KEY_RIGHTCTRL => ctrl = val != 0,
                            Key::KEY_LEFTSHIFT | Key::KEY_RIGHTSHIFT => shift = val != 0,
                            Key::KEY_SPACE if ctrl && shift => {
                                if val == 1 && !hotkey_down {
                                    hotkey_down = true;
                                    handle_hotkey(&app2, true);
                                } else if val == 0 && hotkey_down {
                                    hotkey_down = false;
                                    handle_hotkey(&app2, false);
                                }
                            }
                            Key::KEY_F9 => {
                                if val == 1 && !hotkey_down {
                                    hotkey_down = true;
                                    handle_hotkey(&app2, true);
                                } else if val == 0 && hotkey_down {
                                    hotkey_down = false;
                                    handle_hotkey(&app2, false);
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }));
        }
        for h in handles {
            let _ = h.join();
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial = load_settings();
    let state = AppState {
        settings: Mutex::new(initial),
        ..Default::default()
    };

    tauri::Builder::default()
        .manage(state)
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    let primary =
                        shortcut.matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::Space);
                    let alt = shortcut.matches(Modifiers::CONTROL | Modifiers::ALT, Code::Space);
                    let super_space =
                        shortcut.matches(Modifiers::SUPER, Code::Space);
                    let f9 = shortcut.matches(Modifiers::empty(), Code::F9);
                    if primary || alt || super_space || f9 {
                        match event.state {
                            ShortcutState::Pressed => handle_hotkey(app, true),
                            ShortcutState::Released => handle_hotkey(app, false),
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            // Register multiple bindings so at least one survives desktop-environment grabs.
            // Ubuntu/GNOME's IBus often steals Ctrl+Shift+Space (input-method switcher).
            let bindings: &[(&str, Shortcut)] = &[
                (
                    "Ctrl+Shift+Space",
                    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space),
                ),
                (
                    "Ctrl+Alt+Space",
                    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space),
                ),
                (
                    "Super+Space",
                    Shortcut::new(Some(Modifiers::SUPER), Code::Space),
                ),
                ("F9", Shortcut::new(None, Code::F9)),
            ];
            for (label, sc) in bindings {
                if let Err(e) = app.global_shortcut().register(sc.clone()) {
                    eprintln!("hotkey {label} register failed: {e}");
                }
            }
            if let Some(hud) = app.get_webview_window("hud") {
                let _ = hud.hide();
            }
            // Evdev-based global hotkey — works on Wayland regardless of compositor
            #[cfg(target_os = "linux")]
            spawn_evdev_hotkey(app.handle().clone());
            // Close → hide so background hotkey keeps working
            if let Some(win) = app.get_webview_window("main") {
                let win2 = win.clone();
                win.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = win2.hide();
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_recording,
            stop_recording,
            cancel_recording,
            is_wayland,
            list_models,
            download_model,
            delete_model,
            set_active_model,
            get_settings,
            update_settings,
            open_settings,
            list_groq_models,
            list_builtin_modes,
            preview_voice_prompt,
            test_groq,
            list_history,
            delete_history_item,
            flag_history_item,
            clear_history,
            get_stats,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
