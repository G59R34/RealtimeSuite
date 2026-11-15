//! Everything the manager does *to* the installation: readiness checks, Python
//! setup, database bootstrap and reset, server supervision, accounts, backups,
//! and the RTLink configuration.

use std::fs;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::core::{health_ok, is_connection_error, parse_trailing_json, pump};
use crate::pg;
use crate::Manager;

impl Manager {
    // ------------------------------------------------------------- readiness

    pub fn probe_database(&self) -> (bool, String) {
        let env = self.read_env();
        let url = env.get("DATABASE_URL").cloned().unwrap_or_default();
        if url.is_empty() {
            return (
                false,
                "DATABASE_URL is not configured. Enter a PostgreSQL URL in Setup.".into(),
            );
        }
        pg::probe(&url)
    }

    pub fn check(self: &Arc<Self>) -> Value {
        let env = self.read_env();
        let settings = self.settings();
        let database_url = env.get("DATABASE_URL").cloned().unwrap_or_default();
        let port = env
            .get("PORT")
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(settings.port);
        let host = env
            .get("HOST")
            .cloned()
            .filter(|value| !value.is_empty())
            .unwrap_or(settings.host);
        let jwt = env.get("JWT_SECRET").cloned().unwrap_or_default();
        let probe = self.probe_database();
        let python = self.detect_python();
        let frontend_dist = self
            .backend_dir
            .parent()
            .map(|parent| parent.join("frontend").join("dist").join("index.html"))
            .unwrap_or_default();
        json!({
            "backendDir": self.backend_dir,
            "databaseProbe": { "ok": probe.0, "detail": probe.1 },
            "lowPortsAllowed": cfg!(target_os = "windows"),
            "backendExists": self.backend_dir.join("app").join("main.py").exists(),
            "frontendBuilt": frontend_dist.exists(),
            "envExists": self.env_file.exists(),
            "venvExists": self.venv_python().exists(),
            "requirementsExists": self.backend_dir.join("requirements.txt").exists(),
            "python": python.map(|(path, version)| json!({ "path": path, "version": version })),
            "config": {
                "databaseUrl": database_url,
                "port": port,
                "host": host,
                "organizationName": env.get("ORGANIZATION_NAME").cloned().unwrap_or_else(|| "RealtimeSuite".into()),
                "adminEmail": env.get("BOOTSTRAP_ADMIN_EMAIL").cloned().unwrap_or_else(|| "admin@realtimesuite.local".into()),
                "opsboardTokenSet": env.get("OPSBOARD_TOKEN").map(|value| !value.is_empty()).unwrap_or(false),
                "jwtSecretSet": !jwt.is_empty() && jwt != "change-me-before-deploying",
                "githubTokenSet": env.get("GITHUB_TOKEN").map(|value| !value.is_empty()).unwrap_or(false),
                "githubRepos": env.get("GITHUB_REPOS").cloned().unwrap_or_default(),
                "githubPollMinutes": env.get("GITHUB_POLL_MINUTES").and_then(|value| value.parse::<u32>().ok()).unwrap_or(5),
                "hostBinding": if host == "0.0.0.0" { "all network interfaces" } else { "this computer only" },
                "portValid": port >= 1
            },
            "rtlink": self.rtlink_config()
        })
    }

    // ----------------------------------------------------------------- python

    pub fn setup_environment(self: &Arc<Self>) -> Result<Value, String> {
        self.ensure_env_file()?;
        let (python, version) = self
            .detect_python()
            .ok_or_else(|| "Python 3.10+ was not found. Install Python from https://python.org and try again.".to_string())?;
        self.log("system", &format!("Using Python {version} at {python}"));
        if !self.venv_python().exists() {
            self.log("system", &format!("Creating virtual environment at {}...", self.venv_dir.display()));
            fs::create_dir_all(&self.venv_dir).ok();
            let (code, _) = self.run_streaming(
                std::path::Path::new(&python),
                &["-m".to_string(), "venv".to_string(), self.venv_dir.to_string_lossy().to_string()],
                &[],
                None,
            )?;
            if code != 0 {
                return Err("Could not create the virtual environment. Check that venv support is installed.".into());
            }
        } else {
            self.log("system", "Virtual environment already exists.");
        }
        self.log("system", "Upgrading pip...");
        let venv = self.venv_python();
        let (code, _) = self.run_streaming(&venv, &["-m".into(), "pip".into(), "install".into(), "--upgrade".into(), "pip".into()], &[], None)?;
        if code != 0 {
            return Err("Could not upgrade pip. Check the log and your network connection.".into());
        }
        self.log("system", "Installing backend dependencies...");
        let (code, _) = self.run_streaming(&venv, &["-m".into(), "pip".into(), "install".into(), "-r".into(), "requirements.txt".into()], &[], None)?;
        if code != 0 {
            return Err("Dependency installation failed. See the log for details.".into());
        }
        self.log("system", "Python environment ready.");
        self.log("system", "Preparing database and initializing schema...");
        self.init_database()?;
        self.log("system", "Environment and database setup complete.");
        Ok(self.check())
    }

    pub fn init_database(self: &Arc<Self>) -> Result<String, String> {
        if !self.venv_python().exists() {
            return Err("Set up the Python environment first.".into());
        }
        let env = self.read_env();
        let url = env.get("DATABASE_URL").cloned().unwrap_or_default();
        let dsn = pg::Dsn::parse(&url)?;
        if dsn.is_local() && !pg::port_open(&dsn.host, dsn.port) {
            self.start_embedded(&url, "Preparing PostgreSQL database...")?;
        }
        self.log("system", "Initializing database schema...");
        let output = self.cli(&["init"], None)?;
        self.log("system", "Database initialized.");
        Ok(output)
    }

    /// Start the bundled cluster once, keeping the handle for shutdown.
    fn start_embedded(self: &Arc<Self>, url: &str, note: &str) -> Result<(), String> {
        self.log("system", note);
        let log = |stream: &str, text: &str| self.log(stream, text);
        let (cluster, detail) = pg::start(
            &self.backend_dir,
            &self.user_dir,
            &self.resources_dir,
            url,
            &log,
        )?;
        self.log("system", &detail);
        self.runtime.lock().unwrap().cluster = Some(cluster);
        Ok(())
    }

    fn stop_embedded(&self) {
        if let Some(cluster) = self.runtime.lock().unwrap().cluster.take() {
            pg::stop(&cluster);
            self.log("system", "Bundled PostgreSQL stopped cleanly.");
        }
    }

    // ---------------------------------------------------------------- server

    pub fn start(self: &Arc<Self>) -> Result<Value, String> {
        if self.runtime.lock().unwrap().child.is_some() {
            return Ok(self.status());
        }
        self.ensure_env_file()?;
        if !self.venv_python().exists() {
            return Err("Set up the Python environment first.".into());
        }
        let env = self.read_env();
        let settings = self.settings();
        let port = env
            .get("PORT")
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(settings.port);
        let host = env
            .get("HOST")
            .cloned()
            .filter(|value| !value.is_empty())
            .unwrap_or(settings.host);
        if port < 1024 && !cfg!(target_os = "windows") {
            return Err(format!(
                "Port {port} is privileged on this system. Use a port above 1024 or run the manager with administrator rights."
            ));
        }
        if !self.port_free(port) {
            return Err(format!(
                "Port {port} is already in use. Change the port in Settings or stop the other process."
            ));
        }

        {
            let mut runtime = self.runtime.lock().unwrap();
            runtime.desired_running = true;
            runtime.state = "starting".into();
            runtime.last_error = None;
            runtime.port = port;
            runtime.host = host.clone();
        }
        self.emit_status();
        self.log("system", &format!("Starting RealtimeSuite on {host}:{port}..."));

        let mut probe = self.probe_database();
        if !probe.0 && is_connection_error(&probe.1) {
            let url = env.get("DATABASE_URL").cloned().unwrap_or_default();
            if let Err(error) = self.start_embedded(&url, "Database is not answering. Starting the bundled PostgreSQL service...") {
                probe.1 = format!("{} Bundled PostgreSQL could not start: {error}", probe.1);
            }
            if self.runtime.lock().unwrap().cluster.is_some() {
                probe = self.probe_database();
            }
        }
        if !probe.0 {
            {
                let mut runtime = self.runtime.lock().unwrap();
                runtime.state = "error".into();
                runtime.last_error = Some(probe.1.clone());
                runtime.desired_running = false;
            }
            self.stop_embedded();
            self.emit_status();
            self.log("stderr", &format!("Startup blocked: {}", probe.1));
            return Err(probe.1);
        }

        let frontend_dist = self
            .backend_dir
            .parent()
            .map(|parent| parent.join("frontend").join("dist"))
            .unwrap_or_default();
        let mut command = Command::new(self.venv_python());
        command
            .args([
                "-m",
                "uvicorn",
                "app.main:app",
                "--host",
                &host,
                "--port",
                &port.to_string(),
            ])
            .current_dir(&self.backend_dir)
            .envs(env.iter().map(|(key, value)| (key.clone(), value.clone())))
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .env("UPLOAD_DIR", self.user_dir.join("uploads"))
            .env("FRONTEND_DIST", frontend_dist)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|error| format!("uvicorn could not start: {error}"))?;
        let pid = child.id();
        if let Some(stdout) = child.stdout.take() {
            pump(Arc::clone(self), stdout, "stdout", Arc::new(std::sync::Mutex::new(String::new())));
        }
        if let Some(stderr) = child.stderr.take() {
            pump(Arc::clone(self), stderr, "stderr", Arc::new(std::sync::Mutex::new(String::new())));
        }
        let generation = {
            let mut runtime = self.runtime.lock().unwrap();
            runtime.child = Some(child);
            runtime.pid = Some(pid);
            runtime.started_at = Some(crate::now_iso());
            runtime.watch_generation += 1;
            runtime.watch_generation
        };
        self.emit_status();
        self.spawn_watcher(generation);
        Ok(self.status())
    }

    fn spawn_watcher(self: &Arc<Self>, generation: u64) {
        let manager = Arc::clone(self);
        thread::spawn(move || loop {
            thread::sleep(Duration::from_millis(2000));
            let auto_restart = manager.settings().auto_restart;
            let (exited, desired, port) = {
                let mut runtime = manager.runtime.lock().unwrap();
                if runtime.watch_generation != generation {
                    return;
                }
                let mut exit_code: Option<Option<i32>> = None;
                if let Some(child) = runtime.child.as_mut() {
                    if let Ok(Some(status)) = child.try_wait() {
                        exit_code = Some(status.code());
                    }
                }
                if let Some(code) = exit_code {
                    runtime.child = None;
                    runtime.pid = None;
                    runtime.started_at = None;
                    if runtime.desired_running {
                        runtime.state = "error".into();
                        runtime.last_error = Some(format!(
                            "Server stopped unexpectedly (code {}).",
                            code.map(|value| value.to_string()).unwrap_or_else(|| "unknown".into())
                        ));
                    } else {
                        runtime.state = "stopped".into();
                    }
                }
                (exit_code, runtime.desired_running, runtime.port)
            };
            if exited.is_some() {
                manager.log("system", "Server process ended.");
                manager.emit_status();
                if auto_restart && desired {
                    manager.log("system", "Auto-restart is enabled. Restarting in 3 seconds...");
                    thread::sleep(Duration::from_secs(3));
                    if let Err(error) = manager.start() {
                        manager.log("stderr", &error);
                    }
                }
                return;
            }
            if health_ok(port) {
                let mut runtime = manager.runtime.lock().unwrap();
                if runtime.state != "running" && runtime.child.is_some() {
                    runtime.state = "running".into();
                    runtime.last_error = None;
                    drop(runtime);
                    manager.emit_status();
                }
            }
        });
    }

    pub fn stop(self: &Arc<Self>) -> Result<(), String> {
        {
            let mut runtime = self.runtime.lock().unwrap();
            runtime.desired_running = false;
        }
        let child = self.runtime.lock().unwrap().child.take();
        let Some(mut child) = child else {
            {
                let mut runtime = self.runtime.lock().unwrap();
                runtime.state = "stopped".into();
                runtime.pid = None;
                runtime.started_at = None;
            }
            self.emit_status();
            self.stop_embedded();
            return Ok(());
        };
        {
            let mut runtime = self.runtime.lock().unwrap();
            runtime.state = "stopping".into();
        }
        self.emit_status();
        self.log("system", "Stopping server...");
        terminate(&mut child);
        for _ in 0..60 {
            if child.try_wait().ok().flatten().is_some() {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
        let _ = child.kill();
        let _ = child.wait();
        {
            let mut runtime = self.runtime.lock().unwrap();
            runtime.child = None;
            runtime.pid = None;
            runtime.started_at = None;
            runtime.state = "stopped".into();
            runtime.watch_generation += 1;
        }
        self.emit_status();
        self.stop_embedded();
        Ok(())
    }

    pub fn restart(self: &Arc<Self>) -> Result<Value, String> {
        self.stop()?;
        self.start()
    }

    // ------------------------------------------------------------------ admin

    pub fn create_admin(self: &Arc<Self>, email: &str, password: &str, name: &str) -> Result<String, String> {
        if email.is_empty() || password.is_empty() {
            return Err("Email and password are required.".into());
        }
        if password.len() < 8 {
            return Err("Password must be at least 8 characters.".into());
        }
        let output = self.cli(
            &[
                "create-admin",
                "--email",
                email,
                "--password",
                password,
                "--name",
                if name.is_empty() { "Administrator" } else { name },
            ],
            None,
        )?;
        Ok(output.trim().to_string())
    }

    pub fn reset_password(self: &Arc<Self>, email: &str, password: &str) -> Result<(String, Value), String> {
        if email.is_empty() || password.is_empty() {
            return Err("Email and password are required.".into());
        }
        let output = self.cli(&["reset-password", "--email", email, "--password", password], None)?;
        let rtlink = self.sync_rtlink_credentials(email, password, None);
        Ok((output.trim().to_string(), rtlink))
    }

    pub fn list_users(self: &Arc<Self>) -> Result<Vec<Value>, String> {
        let output = self.cli(&["list-users", "--json"], None)?;
        match parse_trailing_json(&output) {
            Some(Value::Array(users)) => Ok(users),
            _ => Err("Could not read the account list.".into()),
        }
    }

    pub fn create_user(self: &Arc<Self>, email: &str, name: &str, password: &str) -> Result<(Vec<Value>, Value), String> {
        let email = email.trim().to_lowercase();
        let name = name.trim();
        if !email.contains('@') {
            return Err("Enter a valid email address.".into());
        }
        if name.is_empty() {
            return Err("Enter the person's name.".into());
        }
        if password.len() < 8 {
            return Err("Password must be at least 8 characters.".into());
        }
        if password.contains('\n') || password.contains('\r') {
            return Err("Password cannot contain line breaks.".into());
        }
        self.cli(
            &[
                "create-user",
                "--email",
                &email,
                "--name",
                name,
                "--role",
                "employee",
                "--password-stdin",
            ],
            Some(&format!("{password}\n")),
        )?;
        let users = self.list_users()?;
        let rtlink = self.sync_rtlink_credentials(&email, password, Some(name));
        Ok((users, rtlink))
    }

    pub fn delete_user(self: &Arc<Self>, email: &str) -> Result<Vec<Value>, String> {
        let email = email.trim().to_lowercase();
        if email.is_empty() {
            return Err("Choose an account to delete.".into());
        }
        self.cli(&["delete-user", "--email", &email], None)?;
        self.list_users()
    }

    pub fn set_organization_name(self: &Arc<Self>, name: &str) -> Result<String, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("Enter an organization name.".into());
        }
        if name.chars().count() > 120 {
            return Err("Organization name must be 120 characters or fewer.".into());
        }
        let output = self.cli(&["set-org-name", "--name", name], None)?;
        Ok(parse_trailing_json(&output)
            .and_then(|value| value.get("name").and_then(Value::as_str).map(|text| text.to_string()))
            .unwrap_or_else(|| name.to_string()))
    }

    pub fn feature_schema(self: &Arc<Self>) -> Result<Value, String> {
        let output = self.cli(&["feature-schema"], None)?;
        parse_trailing_json(&output).ok_or_else(|| "Could not read the feature schema.".to_string())
    }

    pub fn get_features(self: &Arc<Self>) -> Result<Value, String> {
        let output = self.cli(&["get-features", "--json"], None)?;
        parse_trailing_json(&output).ok_or_else(|| "Could not read feature flags.".to_string())
    }

    pub fn rtlink_configured(&self) -> bool {
        let config = self.rtlink_config();
        config.get("configured").and_then(Value::as_bool).unwrap_or(false)
    }

    /// Mirror a known password into Supabase Auth so RTLink accepts the account.
    pub fn sync_rtlink_credentials(self: &Arc<Self>, email: &str, password: &str, name: Option<&str>) -> Value {
        if !self.rtlink_configured() {
            return json!({ "skipped": true });
        }
        let mut args: Vec<String> = vec![
            "rtlink-auth-user".into(),
            "--email".into(),
            email.to_string(),
        ];
        if let Some(name) = name {
            args.push("--name".into());
            args.push(name.to_string());
        }
        args.push("--password-stdin".into());
        let refs: Vec<&str> = args.iter().map(|arg| arg.as_str()).collect();
        match self.cli(&refs, Some(&format!("{password}\n"))) {
            Ok(_) => {
                self.log("system", &format!("RTLink sign-in ready for {email}."));
                json!({ "ok": true })
            }
            Err(error) => {
                self.log("system", &format!("RTLink sign-in for {email} not synced: {error}"));
                json!({ "ok": false, "error": error })
            }
        }
    }

    // ---------------------------------------------------------------- RTLink

    fn read_rtlink_env_file(&self) -> (std::path::PathBuf, Option<String>, String, bool) {
        for name in [".env", ".env.example"] {
            let file = self.rtlink_dir.join(name);
            let Ok(text) = fs::read_to_string(&file) else { continue };
            let values = crate::core::parse_env(&text);
            let url = values
                .get("VITE_SUPABASE_URL")
                .map(|value| value.trim().trim_end_matches('/').to_string())
                .unwrap_or_default();
            let anon = values
                .get("VITE_SUPABASE_ANON_KEY")
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false);
            if url.is_empty() && !anon {
                continue;
            }
            let placeholder = url.contains("your-project") || url.contains("xxxx") || url.contains("example.com");
            if placeholder {
                continue;
            }
            return (file, Some(name.to_string()), url, anon);
        }
        (
            self.rtlink_dir.join(".env"),
            None,
            String::new(),
            false,
        )
    }

    pub fn rtlink_config(&self) -> Value {
        let env = self.read_env();
        let (path, source, project_url, anon) = self.read_rtlink_env_file();
        let env_url = env.get("RTLINK_SUPABASE_URL").cloned().unwrap_or_default();
        let supabase_url = if env_url.trim().is_empty() {
            project_url.clone()
        } else {
            env_url.trim().to_string()
        };
        let matches = if !project_url.is_empty() && !env_url.trim().is_empty() {
            json!(env_url.trim() == project_url)
        } else {
            Value::Null
        };
        let service = env.get("RTLINK_SUPABASE_SERVICE_ROLE_KEY").map(|value| !value.is_empty()).unwrap_or(false);
        let site_id = env.get("RTLINK_SITE_ID").cloned().unwrap_or_default();
        json!({
            "rtlinkDir": self.rtlink_dir,
            "envPath": path,
            "envSource": source,
            "supabaseUrl": supabase_url,
            "projectSupabaseUrl": project_url,
            "anonKeySet": anon,
            "urlMatchesProject": matches,
            "siteId": site_id,
            "orgCode": env.get("RTLINK_ORG_CODE").cloned().unwrap_or_default(),
            "siteName": env.get("RTLINK_SITE_NAME").cloned().unwrap_or_default(),
            "serviceKeySet": service,
            "syncMinutes": env.get("RTLINK_SYNC_MINUTES").and_then(|value| value.parse::<u32>().ok()).unwrap_or(5),
            "pollSeconds": env.get("RTLINK_POLL_SECONDS").and_then(|value| value.parse::<u32>().ok()).unwrap_or(15),
            "configured": !supabase_url.is_empty() && service && !site_id.is_empty()
        })
    }

    pub fn save_rtlink(self: &Arc<Self>, org_code: &str, site_name: &str, service_key: &str) -> Result<Value, String> {
        let (_, _, project_url, _) = self.read_rtlink_env_file();
        if project_url.is_empty() {
            return Err(format!(
                "Add VITE_SUPABASE_URL to {} before connecting RTLink.",
                self.rtlink_dir.join(".env").display()
            ));
        }
        let code = org_code.trim().to_uppercase();
        let valid = code.len() >= 2
            && code.len() <= 32
            && code.chars().next().map(|c| c.is_ascii_alphanumeric()).unwrap_or(false)
            && code.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        if !valid {
            return Err("Organization code must be 2-32 characters: letters, numbers, hyphen or underscore.".into());
        }
        let env = self.read_env();
        let key = if service_key.trim().is_empty() {
            env.get("RTLINK_SUPABASE_SERVICE_ROLE_KEY").cloned().unwrap_or_default()
        } else {
            service_key.trim().to_string()
        };
        if key.is_empty() {
            return Err("Paste the Supabase service_role key once. It is saved in backend/.env and never sent to a browser.".into());
        }
        let site_id = env
            .get("RTLINK_SITE_ID")
            .cloned()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let fallback_name = env
            .get("RTLINK_SITE_NAME")
            .cloned()
            .or_else(|| env.get("ORGANIZATION_NAME").cloned())
            .unwrap_or_else(|| "RealtimeSuite site".into());
        let site = if site_name.trim().is_empty() { fallback_name } else { site_name.trim().to_string() };
        self.apply_env(&[
            ("RTLINK_SUPABASE_URL".into(), project_url.clone()),
            ("RTLINK_SUPABASE_SERVICE_ROLE_KEY".into(), key),
            ("RTLINK_SITE_ID".into(), site_id.clone()),
            ("RTLINK_SITE_NAME".into(), site),
            ("RTLINK_ORG_CODE".into(), code.clone()),
        ])?;
        self.log("system", &format!("RTLink connected for organization code {code} (site {site_id})."));
        Ok(self.rtlink_config())
    }

    // --------------------------------------------------------------- backups

    pub fn list_backups(&self) -> Vec<Value> {
        let mut out = Vec::new();
        let Ok(entries) = fs::read_dir(&self.backup_dir) else { return out };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with("realtimesuite-") || !name.ends_with(".dump") {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            let created = meta
                .modified()
                .ok()
                .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339())
                .unwrap_or_default();
            out.push(json!({ "name": name, "size": meta.len(), "createdAt": created }));
        }
        out.sort_by(|a, b| {
            b["createdAt"].as_str().unwrap_or("").cmp(a["createdAt"].as_str().unwrap_or(""))
        });
        out
    }

    pub fn create_backup(self: &Arc<Self>) -> Result<Value, String> {
        let url = self.read_env().get("DATABASE_URL").cloned().unwrap_or_default();
        let dsn = pg::Dsn::parse(&url)?;
        fs::create_dir_all(&self.backup_dir).ok();
        let stamp = chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S%.3f").to_string().replace('.', "-");
        let name = format!("realtimesuite-{stamp}.dump");
        let path = self.backup_dir.join(&name);
        self.log("system", &format!("Creating database backup {name}..."));
        let size = pg::write_dump(&path, &dsn.database, &dsn)?;
        let created = chrono::Utc::now().to_rfc3339();
        self.log("system", &format!("Database backup created ({name}, {size} bytes)."));
        Ok(json!({ "name": name, "size": size, "createdAt": created }))
    }

    pub fn restore_backup(self: &Arc<Self>, name: &str, confirmed: bool) -> Result<(), String> {
        if !confirmed {
            return Err("Restore requires explicit confirmation.".into());
        }
        if self.runtime.lock().unwrap().child.is_some() {
            return Err("Stop the application server before restoring a database backup.".into());
        }
        let safe = name.starts_with("realtimesuite-")
            && name.ends_with(".dump")
            && !name.contains('/')
            && !name.contains('\\')
            && std::path::Path::new(name).file_name().map(|value| value.to_string_lossy() == name).unwrap_or(false);
        if !safe {
            return Err("Choose a valid backup from the backup list.".into());
        }
        let path = self.backup_dir.join(name);
        let meta = fs::metadata(&path).map_err(|_| "That backup does not exist or is empty.".to_string())?;
        if meta.len() == 0 {
            return Err("That backup does not exist or is empty.".into());
        }
        let url = self.read_env().get("DATABASE_URL").cloned().unwrap_or_default();
        let dsn = pg::Dsn::parse(&url)?;
        self.log("system", &format!("Restoring database from {name}..."));
        pg::restore_dump(&path, &dsn.database, &dsn)?;
        self.log("system", &format!("Restored {name}."));
        Ok(())
    }

    // -------------------------------------------------------------- database

    pub fn database_client(&self) -> Result<(pg::Dsn, postgres::Client), String> {
        let url = self.read_env().get("DATABASE_URL").cloned().unwrap_or_default();
        let dsn = pg::Dsn::parse(&url)?;
        if dsn.is_local() && !pg::port_open(&dsn.host, dsn.port) {
            return Err(format!(
                "Cannot reach PostgreSQL at {}:{}. Start the server (or the bundled database) first.",
                dsn.host, dsn.port
            ));
        }
        let client = pg::connect(&dsn)?;
        Ok((dsn, client))
    }

    pub fn list_tables(&self) -> Result<Vec<Value>, String> {
        let (_, mut client) = self.database_client()?;
        pg::tables(&mut client)
    }

    pub fn read_rows(&self, table: &str, limit: i64, offset: i64) -> Result<Value, String> {
        let (_, mut client) = self.database_client()?;
        let info = pg::describe(&mut client, table)?;
        pg::read_rows(&mut client, &info, limit, offset)
    }

    pub fn update_row(self: &Arc<Self>, table: &str, key: &Map<String, Value>, changes: &Map<String, Value>) -> Result<String, String> {
        let (_, mut client) = self.database_client()?;
        let info = pg::describe(&mut client, table)?;
        let message = pg::update_row(&mut client, &info, key, changes)?;
        self.log("system", &format!("Updated a row in public.{}.", info.name));
        Ok(message.as_str().unwrap_or("Row saved.").to_string())
    }

    pub fn delete_row(self: &Arc<Self>, table: &str, key: &Map<String, Value>) -> Result<String, String> {
        let (_, mut client) = self.database_client()?;
        let info = pg::describe(&mut client, table)?;
        let message = pg::delete_row(&mut client, &info, key)?;
        self.log("system", &format!("Deleted a row from public.{}.", info.name));
        Ok(message)
    }

    pub fn reset_database(self: &Arc<Self>, confirmed: bool) -> Result<Value, String> {
        if !confirmed {
            return Err("Resetting the database requires explicit confirmation.".into());
        }
        if self.runtime.lock().unwrap().child.is_some() {
            return Err("Stop the application server before resetting the database.".into());
        }
        if !self.venv_python().exists() {
            return Err("Create the Python environment first; the reset reapplies the schema with the backend CLI.".into());
        }
        let url = self.read_env().get("DATABASE_URL").cloned().unwrap_or_default();
        let dsn = pg::Dsn::parse(&url)?;
        if dsn.is_local() && !pg::port_open(&dsn.host, dsn.port) {
            self.start_embedded(&url, "Starting the bundled database for the reset...")?;
        }
        let backup_note = match self.create_backup() {
            Ok(backup) => format!(
                "A safety backup was saved as {}.",
                backup["name"].as_str().unwrap_or("backup")
            ),
            Err(error) => {
                self.log("stderr", &format!("Safety backup before reset failed: {error}"));
                format!("No safety backup was created: {error}")
            }
        };
        self.log("system", &format!("Resetting database {}: clearing the public schema...", dsn.database));
        pg::clear_schema(&dsn)?;
        self.log("system", "Schema cleared. Rebuilding tables, organization and work areas...");
        self.init_database()
            .map_err(|error| format!("Database was cleared but the schema could not be rebuilt: {error} {backup_note}"))?;
        self.log("system", "Database reset complete.");
        Ok(json!({
            "database": dsn.database,
            "backupNote": backup_note,
            "message": format!("Database {} was reset. {backup_note}", dsn.database)
        }))
    }

    pub fn save_env(self: &Arc<Self>, values: &Map<String, Value>) -> Result<(), String> {
        let updates: Vec<(String, String)> = values
            .iter()
            .map(|(key, value)| {
                (
                    key.clone(),
                    match value {
                        Value::String(text) => text.clone(),
                        other => other.to_string(),
                    },
                )
            })
            .collect();
        if updates.is_empty() {
            return Err("Nothing to save.".into());
        }
        self.apply_env(&updates)?;
        Ok(())
    }

    /// Copy the project URL out of `rtlink/.env` so the backend stays in step.
    pub fn sync_rtlink_env(self: &Arc<Self>) {
        let (_, _, project_url, _) = self.read_rtlink_env_file();
        if project_url.is_empty() {
            return;
        }
        let current = self.read_env().get("RTLINK_SUPABASE_URL").cloned().unwrap_or_default();
        if current.trim() == project_url {
            return;
        }
        if self
            .apply_env(&[("RTLINK_SUPABASE_URL".into(), project_url.clone())])
            .is_ok()
        {
            self.log("system", &format!("RTLink Supabase URL read from rtlink/.env: {project_url}"));
        }
    }
}

fn terminate(child: &mut std::process::Child) {
    if cfg!(target_os = "windows") {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    } else {
        let _ = Command::new("kill")
            .args(["-TERM", &child.id().to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

