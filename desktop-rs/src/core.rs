//! Manager core: paths, `.env` editing, logging, settings, status and the
//! Python/CLI plumbing. Process supervision lives in `server.rs`.

use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

pub const LOG_LIMIT: usize = 800;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub stream: String,
    pub line: String,
    pub at: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub python_path: String,
    pub port: u16,
    pub host: String,
    pub auto_start: bool,
    pub auto_restart: bool,
    pub open_on_start: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            python_path: String::new(),
            port: 8000,
            host: "0.0.0.0".into(),
            auto_start: false,
            auto_restart: true,
            open_on_start: true,
        }
    }
}

/// Live server/PostgreSQL state, guarded by one mutex so the tray, the window
/// and the poller always agree on what is running.
pub struct Runtime {
    pub state: String,
    pub child: Option<Child>,
    pub pid: Option<u32>,
    pub started_at: Option<String>,
    pub last_error: Option<String>,
    pub desired_running: bool,
    pub port: u16,
    pub host: String,
    pub cluster: Option<crate::pg::Cluster>,
    pub watch_generation: u64,
}

impl Default for Runtime {
    fn default() -> Self {
        Runtime {
            state: "stopped".into(),
            child: None,
            pid: None,
            started_at: None,
            last_error: None,
            desired_running: false,
            port: 8000,
            host: "0.0.0.0".into(),
            cluster: None,
            watch_generation: 0,
        }
    }
}

pub struct Manager {
    pub backend_dir: PathBuf,
    pub user_dir: PathBuf,
    pub resources_dir: PathBuf,
    pub env_file: PathBuf,
    pub venv_dir: PathBuf,
    pub rtlink_dir: PathBuf,
    pub settings_file: PathBuf,
    pub log_file: PathBuf,
    pub backup_dir: PathBuf,
    pub logs: Mutex<Vec<LogEntry>>,
    pub settings: Mutex<Settings>,
    pub runtime: Mutex<Runtime>,
    pub app: Mutex<Option<AppHandle>>,
    /// Set the first time the web view asks for its state, so the log records
    /// that the control panel actually booted instead of only the app process.
    pub ui_connected: std::sync::atomic::AtomicBool,
}

impl Manager {
    pub fn new(
        backend_dir: PathBuf,
        user_dir: PathBuf,
        resources_dir: PathBuf,
        env_file: Option<PathBuf>,
    ) -> Arc<Manager> {
        let rtlink_dir = backend_dir
            .parent()
            .map(|parent| parent.join("rtlink"))
            .unwrap_or_else(|| backend_dir.join("rtlink"));
        let log_file = user_dir.join("logs").join("server.log");
        if let Some(parent) = log_file.parent() {
            let _ = fs::create_dir_all(parent);
        }
        Arc::new(Manager {
            env_file: env_file.unwrap_or_else(|| backend_dir.join(".env")),
            venv_dir: backend_dir.join(".venv"),
            settings_file: user_dir.join("settings.json"),
            backup_dir: user_dir.join("backups"),
            logs: Mutex::new(Vec::new()),
            settings: Mutex::new(Settings::default()),
            runtime: Mutex::new(Runtime::default()),
            app: Mutex::new(None),
            ui_connected: std::sync::atomic::AtomicBool::new(false),
            backend_dir,
            user_dir,
            resources_dir,
            rtlink_dir,
            log_file,
        })
    }

    pub fn attach(&self, app: AppHandle) {
        *self.app.lock().unwrap() = Some(app);
        *self.settings.lock().unwrap() = self.read_settings();
    }

    fn emit(&self, event: &str, payload: Value) {
        if let Some(app) = self.app.lock().unwrap().as_ref() {
            let _ = app.emit(event, payload);
        }
    }

    // ------------------------------------------------------------------ logs

    pub fn log(&self, stream: &str, text: &str) {
        for line in text.replace("\r\n", "\n").split('\n') {
            if line.is_empty() {
                continue;
            }
            let entry = LogEntry {
                stream: stream.to_string(),
                line: line.to_string(),
                at: crate::now_iso(),
            };
            {
                let mut logs = self.logs.lock().unwrap();
                logs.push(entry.clone());
                if logs.len() > LOG_LIMIT {
                    logs.remove(0);
                }
            }
            self.emit("manager:log", json!(entry));
            if let Ok(mut file) = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.log_file)
            {
                let _ = writeln!(file, "[{}] [{}] {}", entry.at, entry.stream, entry.line);
            }
        }
    }

    pub fn note_ui_connected(&self) {
        if !self
            .ui_connected
            .swap(true, std::sync::atomic::Ordering::Relaxed)
        {
            self.log("system", "Control panel connected to the manager.");
        }
    }

    pub fn get_logs(&self) -> Vec<LogEntry> {
        self.logs.lock().unwrap().clone()
    }

    pub fn clear_logs(&self) {
        self.logs.lock().unwrap().clear();
        self.emit("manager:logs-cleared", json!(null));
    }

    // -------------------------------------------------------------- settings

    pub fn read_settings(&self) -> Settings {
        match fs::read_to_string(&self.settings_file) {
            Ok(raw) => serde_json::from_str::<Settings>(&raw).unwrap_or_default(),
            Err(_) => Settings::default(),
        }
    }

    pub fn settings(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }

    pub fn save_settings(&self, patch: &Value) -> Result<Settings, String> {
        let mut next = self.settings();
        if let Some(port) = patch.get("port") {
            let value = port.as_u64().unwrap_or(0);
            if value < 1 || value > 65535 {
                return Err("Port must be between 1 and 65535.".into());
            }
            next.port = value as u16;
        }
        if let Some(host) = patch.get("host").and_then(Value::as_str) {
            next.host = host.to_string();
        }
        if let Some(value) = patch.get("autoStart").and_then(Value::as_bool) {
            next.auto_start = value;
        }
        if let Some(value) = patch.get("autoRestart").and_then(Value::as_bool) {
            next.auto_restart = value;
        }
        if let Some(value) = patch.get("openOnStart").and_then(Value::as_bool) {
            next.open_on_start = value;
        }
        if let Some(value) = patch.get("pythonPath").and_then(Value::as_str) {
            next.python_path = value.to_string();
        }
        fs::create_dir_all(&self.user_dir).map_err(|error| format!("Could not create {}: {error}", self.user_dir.display()))?;
        fs::write(
            &self.settings_file,
            serde_json::to_string_pretty(&next).unwrap_or_default(),
        )
        .map_err(|error| format!("Could not save settings: {error}"))?;
        *self.settings.lock().unwrap() = next.clone();
        // A saved port has to reach `.env`, because uvicorn and the CLI both
        // read it there rather than from the manager's own settings file.
        self.apply_env(&[("PORT".to_string(), next.port.to_string())])
            .ok();
        self.emit_status();
        Ok(next)
    }

    // ------------------------------------------------------------------- env

    pub fn read_env_text(&self) -> String {
        fs::read_to_string(&self.env_file).unwrap_or_default()
    }

    pub fn read_env(&self) -> BTreeMap<String, String> {
        parse_env(&self.read_env_text())
    }

    pub fn ensure_env_file(&self) -> Result<(), String> {
        if let Some(parent) = self.env_file.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        if self.env_file.exists() {
            return Ok(());
        }
        let example = self.backend_dir.join(".env.example");
        let text = fs::read_to_string(example).unwrap_or_else(|_| {
            [
                "DATABASE_URL=postgresql+psycopg://postgres@127.0.0.1:55432/suite",
                "JWT_SECRET=change-me-before-deploying",
                "HOST=0.0.0.0",
                "PORT=8000",
                "ORGANIZATION_NAME=RealtimeSuite",
            ]
            .join("\n")
        });
        fs::write(&self.env_file, format!("{}\n", text.trim_end()))
            .map_err(|error| format!("Could not write {}: {error}", self.env_file.display()))
    }

    pub fn apply_env(&self, updates: &[(String, String)]) -> Result<(), String> {
        self.ensure_env_file()?;
        let current = self.read_env_text();
        let next = upsert_env(&current, updates);
        fs::write(&self.env_file, next)
            .map_err(|error| format!("Could not save {}: {error}", self.env_file.display()))
    }

    // ---------------------------------------------------------------- python

    pub fn venv_python(&self) -> PathBuf {
        if cfg!(target_os = "windows") {
            self.venv_dir.join("Scripts").join("python.exe")
        } else {
            self.venv_dir.join("bin").join("python")
        }
    }

    pub fn detect_python(&self) -> Option<(String, String)> {
        let configured = self.settings().python_path;
        if !configured.is_empty() {
            if let Some(version) = self.python_version(&configured) {
                return Some((configured, version));
            }
        }
        let mut candidates: Vec<String> = Vec::new();
        if cfg!(target_os = "windows") {
            if let Ok(local) = std::env::var("LOCALAPPDATA") {
                for minor in [312, 311, 310] {
                    candidates.push(format!("{local}\\Programs\\Python\\Python{minor}\\python.exe"));
                }
            }
            candidates.extend(["py".into(), "python".into(), "python3".into()]);
        } else if cfg!(target_os = "macos") {
            candidates.extend([
                "/opt/homebrew/bin/python3".to_string(),
                "/usr/local/bin/python3".to_string(),
                "/usr/bin/python3".to_string(),
                "python3".to_string(),
                "python3.13".to_string(),
                "python3.12".to_string(),
                "python3.11".to_string(),
                "python3.10".to_string(),
            ]);
        } else {
            candidates.extend([
                "/usr/bin/python3".to_string(),
                "/usr/local/bin/python3".to_string(),
                "python3".to_string(),
            ]);
        }
        for candidate in candidates {
            if let Some(version) = self.python_version(&candidate) {
                if version_at_least(&version, 3, 10) {
                    return Some((candidate, version));
                }
            }
        }
        None
    }

    pub fn python_version(&self, command: &str) -> Option<String> {
        let output = Command::new(command)
            .arg("-c")
            .arg("import sys; print('.'.join(map(str, sys.version_info[:3])))")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let version = text.trim().to_string();
        if version.split('.').count() >= 2 {
            Some(version)
        } else {
            None
        }
    }

    // -------------------------------------------------------------- commands

    /// Run a child process, streaming both pipes into the log.
    pub fn run_streaming(
        self: &Arc<Self>,
        program: &Path,
        args: &[String],
        envs: &[(String, String)],
        input: Option<&str>,
    ) -> Result<(i32, String), String> {
        let mut command = Command::new(program);
        command
            .args(args)
            .current_dir(&self.backend_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .env("PIP_DISABLE_PIP_VERSION_CHECK", "1");
        for (key, value) in self.read_env() {
            command.env(key, value);
        }
        for (key, value) in envs {
            command.env(key, value);
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("{} could not run: {error}", program.display()))?;
        if let Some(text) = input {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(text.as_bytes());
            }
        }
        let collected = Arc::new(Mutex::new(String::new()));
        let mut readers = Vec::new();
        if let Some(stdout) = child.stdout.take() {
            readers.push(pump(Arc::clone(self), stdout, "stdout", Arc::clone(&collected)));
        }
        if let Some(stderr) = child.stderr.take() {
            readers.push(pump(Arc::clone(self), stderr, "stderr", Arc::clone(&collected)));
        }
        let status = child.wait().map_err(|error| error.to_string())?;
        for reader in readers {
            let _ = reader.join();
        }
        let output = collected.lock().unwrap().clone();
        Ok((status.code().unwrap_or(-1), output))
    }

    pub fn cli(self: &Arc<Self>, args: &[&str], input: Option<&str>) -> Result<String, String> {
        let python = self.venv_python();
        if !python.exists() {
            return Err("Set up the Python environment on the Setup tab first.".into());
        }
        let owned: Vec<String> = std::iter::once("app.cli".to_string())
            .chain(args.iter().map(|arg| arg.to_string()))
            .collect();
        let mut full = vec!["-m".to_string()];
        full.extend(owned);
        let (code, output) = self.run_streaming(&python, &full, &[], input)?;
        if code != 0 {
            return Err(cli_failure_message(&output, &format!("{} failed. Check the log for details.", args.first().unwrap_or(&"command"))));
        }
        Ok(output)
    }

    // ---------------------------------------------------------------- status

    pub fn emit_status(&self) {
        self.emit("manager:status", self.status());
    }

    pub fn status(&self) -> Value {
        let settings = self.settings();
        let runtime = self.runtime.lock().unwrap();
        let port = runtime.port;
        let base = format!("http://127.0.0.1:{port}");
        json!({
            "state": runtime.state,
            "pid": runtime.pid,
            "port": port,
            "startedAt": runtime.started_at,
            "lastError": runtime.last_error,
            "url": format!("{base}/"),
            "boardUrl": format!("{base}/opsboard.html"),
            "lanUrls": lan_urls(port),
            "autoRestart": settings.auto_restart
        })
    }

    pub fn port_free(&self, port: u16) -> bool {
        TcpListener::bind(("0.0.0.0", port)).is_ok()
    }
}

// ---------------------------------------------------------------- env helpers

pub fn parse_env(text: &str) -> BTreeMap<String, String> {
    let mut values = BTreeMap::new();
    for raw in text.split('\n') {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(index) = line.find('=') else { continue };
        if index == 0 {
            continue;
        }
        let key = line[..index].trim().to_string();
        let mut value = line[index + 1..].trim();
        if value.len() >= 2 {
            let bytes = value.as_bytes();
            let quoted = (bytes[0] == b'"' && bytes[value.len() - 1] == b'"')
                || (bytes[0] == b'\'' && bytes[value.len() - 1] == b'\'');
            if quoted {
                value = &value[1..value.len() - 1];
            }
        }
        values.insert(key, value.to_string());
    }
    values
}

pub fn upsert_env(text: &str, updates: &[(String, String)]) -> String {
    let mut lines: Vec<String> = if text.is_empty() {
        Vec::new()
    } else {
        text.split('\n').map(|line| line.to_string()).collect()
    };
    let mut pending: BTreeMap<&str, &str> = updates
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect();
    for line in lines.iter_mut() {
        let trimmed = line.trim_start();
        let Some(index) = trimmed.find('=') else { continue };
        let key = trimmed[..index].trim();
        if key.is_empty() || !key.chars().all(|c| c.is_alphanumeric() || c == '_') {
            continue;
        }
        if let Some(value) = pending.remove(key) {
            *line = format!("{key}={value}");
        }
    }
    if !pending.is_empty() {
        if lines.last().map(|line| !line.trim().is_empty()).unwrap_or(false) {
            lines.push(String::new());
        }
        for (key, value) in pending {
            lines.push(format!("{key}={value}"));
        }
    }
    format!("{}\n", lines.join("\n").trim_end_matches('\n'))
}

pub fn cli_failure_message(output: &str, fallback: &str) -> String {
    output
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .last()
        .map(|line| line.trim_start_matches("SystemExit:").trim().to_string())
        .filter(|line| !line.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

pub fn parse_trailing_json(output: &str) -> Option<Value> {
    for line in output.lines().rev() {
        let trimmed = line.trim();
        if !trimmed.starts_with('{') && !trimmed.starts_with('[') {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
            return Some(value);
        }
    }
    None
}

fn version_parts(value: &str) -> Vec<u64> {
    value
        .trim()
        .split('.')
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect()
}

pub fn version_at_least(value: &str, major: u64, minor: u64) -> bool {
    let parts = version_parts(value);
    let a = *parts.first().unwrap_or(&0);
    let b = *parts.get(1).unwrap_or(&0);
    a > major || (a == major && b >= minor)
}

/// Every address a phone on the same LAN can type in.
pub fn lan_urls(port: u16) -> Vec<String> {
    let mut urls = Vec::new();
    if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(local) = socket.local_addr() {
                if !local.ip().is_loopback() {
                    urls.push(format!("http://{}:{}", local.ip(), port));
                }
            }
        }
    }
    urls.push(format!("http://127.0.0.1:{port}"));
    urls.dedup();
    urls
}

/// `GET /api/health` without pulling in an HTTP client.
pub fn health_ok(port: u16) -> bool {
    let address = format!("127.0.0.1:{port}");
    let mut stream = match TcpStream::connect(address) {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    let request = "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut buffer = [0u8; 64];
    match std::io::Read::read(&mut stream, &mut buffer) {
        Ok(size) => {
            let head = String::from_utf8_lossy(&buffer[..size]);
            head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200")
        }
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_env_skips_comments_and_strips_quotes() {
        let values = parse_env("# note\nPORT=8000\nNAME=\"Quoted value\"\nEMPTY=\n");
        assert_eq!(values.get("PORT").map(String::as_str), Some("8000"));
        assert_eq!(values.get("NAME").map(String::as_str), Some("Quoted value"));
        assert_eq!(values.get("EMPTY").map(String::as_str), Some(""));
        assert!(!values.contains_key("# note"));
    }

    #[test]
    fn upsert_env_updates_in_place_and_appends_missing_keys() {
        let out = upsert_env(
            "PORT=8000\nJWT_SECRET=old\n",
            &[
                ("PORT".to_string(), "8010".to_string()),
                ("HOST".to_string(), "127.0.0.1".to_string()),
            ],
        );
        assert!(out.contains("PORT=8010"));
        assert!(out.contains("JWT_SECRET=old"));
        assert!(out.trim_end().ends_with("HOST=127.0.0.1"));
        assert_eq!(out.matches("PORT=").count(), 1);
    }

    #[test]
    fn version_at_least_enforces_python_310() {
        assert!(version_at_least("3.10.2", 3, 10));
        assert!(!version_at_least("3.9.18", 3, 10));
        assert!(version_at_least("4.0.0", 3, 10));
    }

    #[test]
    fn cli_failure_message_prefers_the_last_line() {
        assert_eq!(
            cli_failure_message("Traceback\nboot\nSystemExit: invalid login", "fallback"),
            "invalid login"
        );
        assert_eq!(cli_failure_message("", "fallback"), "fallback");
    }

    #[test]
    fn trailing_json_reads_the_last_json_line() {
        let value = parse_trailing_json("log line\n{\"ok\": true}\n").unwrap();
        assert_eq!(value.get("ok").and_then(Value::as_bool), Some(true));
        assert!(parse_trailing_json("nothing here").is_none());
    }
}

pub fn is_connection_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("cannot reach")
        || lower.contains("connection refused")
        || lower.contains("timed out")
        || lower.contains("could not connect")
}

pub(crate) fn pump<R: std::io::Read + Send + 'static>(
    manager: Arc<Manager>,
    pipe: R,
    stream: &'static str,
    sink: Arc<Mutex<String>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let reader = BufReader::new(pipe);
        for line in reader.lines().map_while(Result::ok) {
            if line.is_empty() {
                continue;
            }
            {
                let mut out = sink.lock().unwrap();
                out.push_str(&line);
                out.push('\n');
            }
            manager.log(stream, &line);
        }
    })
}
