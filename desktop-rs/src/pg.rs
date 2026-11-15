//! Bundled PostgreSQL lifecycle plus the SQL used by the Database tab.
//!
//! The manager ships the PostgreSQL 16 runtime that the Electron app used to
//! load from `embedded-postgres`: only `initdb`, `pg_ctl` and `postgres` are
//! present, so the cluster is driven the same way, just without a Node runtime
//! in the middle. Everything else (queries, schema resets) goes through the
//! native driver.

use std::fs;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use postgres::Client;
use serde_json::{json, Map, Value};

/// A connection string split into the parts the manager cares about.
pub struct Dsn {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub password: String,
}

impl Dsn {
    /// `postgresql+psycopg://user:pass@host:port/db?params` → parts.
    pub fn parse(raw: &str) -> Result<Dsn, String> {
        let text = raw.trim();
        if text.is_empty() {
            return Err("DATABASE_URL is not configured. Enter a PostgreSQL URL in Setup.".into());
        }
        let rest = text
            .strip_prefix("postgresql+psycopg://")
            .or_else(|| text.strip_prefix("postgres://"))
            .or_else(|| text.strip_prefix("postgresql://"))
            .ok_or_else(|| "DATABASE_URL must start with postgresql+psycopg://".to_string())?;
        let (authority, tail) = match rest.split_once('/') {
            Some((a, t)) => (a, t),
            None => (rest, ""),
        };
        let tail = tail.split(['?', '#']).next().unwrap_or("");
        let (userinfo, hostport) = match authority.rsplit_once('@') {
            Some((u, h)) => (Some(u), h),
            None => (None, authority),
        };
        let (user, password) = match userinfo {
            Some(info) => match info.split_once(':') {
                Some((u, p)) => (decode(u), decode(p)),
                None => (decode(info), String::new()),
            },
            None => (String::new(), String::new()),
        };
        let (host, port) = if let Some(stripped) = hostport.strip_prefix('[') {
            // IPv6 literal: [::1]:5432
            let (h, rest) = stripped.split_once(']').unwrap_or((stripped, ""));
            (h.to_string(), rest.trim_start_matches(':').to_string())
        } else {
            match hostport.rsplit_once(':') {
                Some((h, p)) => (h.to_string(), p.to_string()),
                None => (hostport.to_string(), String::new()),
            }
        };
        let database = decode(tail);
        if database.is_empty() {
            return Err("DATABASE_URL must include a database name.".into());
        }
        Ok(Dsn {
            host: if host.is_empty() { "127.0.0.1".into() } else { host },
            port: port.parse::<u16>().unwrap_or(5432),
            database,
            user: if user.is_empty() { "postgres".into() } else { user },
            password,
        })
    }

    pub fn is_local(&self) -> bool {
        matches!(self.host.to_ascii_lowercase().as_str(), "localhost" | "127.0.0.1" | "::1")
    }

    /// Node's driver wants `postgresql://`; `+psycopg` is SQLAlchemy-only.
    pub fn url_for_driver(&self) -> String {
        let auth = if self.password.is_empty() {
            self.user.clone()
        } else {
            format!("{}:{}", self.user, self.password)
        };
        format!("postgresql://{}@{}:{}/{}", auth, self.host, self.port, self.database)
    }

    pub fn url_for_postgres_tools(&self) -> String {
        self.url_for_driver()
    }
}

fn decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

// --------------------------------------------------------------- cluster paths

fn platform_package() -> &'static str {
    if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "darwin-arm64"
        } else {
            "darwin-x64"
        }
    } else if cfg!(target_os = "windows") {
        "windows-x64"
    } else if cfg!(target_arch = "aarch64") {
        "linux-arm64"
    } else {
        "linux-x64"
    }
}

/// Where `initdb`/`pg_ctl`/`postgres` live.
///
/// A packaged build keeps the runtime beside the executable resources; running
/// from source reuses the PostgreSQL binaries already unpacked for the Electron
/// build so nothing extra has to be downloaded.
pub fn bin_dir(resources_dir: &Path, backend_dir: &Path) -> Result<PathBuf, String> {
    let package = platform_package();
    let mut candidates: Vec<PathBuf> = Vec::new();
    if !resources_dir.as_os_str().is_empty() {
        candidates.push(resources_dir.join("postgres").join(package).join("native").join("bin"));
        candidates.push(resources_dir.join("postgres").join("native").join("bin"));
    }
    candidates.push(
        backend_dir
            .join("..")
            .join("desktop")
            .join("node_modules")
            .join("@embedded-postgres")
            .join(package)
            .join("native")
            .join("bin"),
    );
    for candidate in candidates {
        if candidate.join(executable("initdb")).exists() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "The bundled PostgreSQL runtime is missing for {package}. Reinstall the Server Manager, or set an external DATABASE_URL."
    ))
}

fn executable(name: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

pub fn data_dir(user_dir: &Path) -> PathBuf {
    user_dir.join("postgres-data")
}

pub fn port_open(host: &str, port: u16) -> bool {
    let target = format!("{}:{}", host, port);
    match target.to_socket_addrs() {
        Ok(mut addrs) => match addrs.next() {
            Some(addr) => TcpStream::connect_timeout(&addr, Duration::from_millis(1200)).is_ok(),
            None => false,
        },
        Err(_) => false,
    }
}

fn run_bin(program: &Path, args: &[&str], log: &dyn Fn(&str)) -> Result<String, String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|error| format!("{} could not run: {error}", program.display()))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    for line in stdout.lines().chain(stderr.lines()) {
        if !line.trim().is_empty() {
            log(line);
        }
    }
    if !output.status.success() {
        let detail = stderr
            .lines()
            .chain(stdout.lines())
            .last()
            .unwrap_or("no output")
            .trim()
            .to_string();
        return Err(format!("{} exited with {detail}", program.display()));
    }
    Ok(stdout)
}

// ------------------------------------------------------------------ lifecycle

pub struct Cluster {
    pub data_dir: PathBuf,
    pub bin_dir: PathBuf,
    pub port: u16,
    pub running: bool,
}

/// Start the local cluster, creating it on first use. Returns the cluster and a
/// human-readable note for the log.
pub fn start(
    backend_dir: &Path,
    user_dir: &Path,
    resources_dir: &Path,
    raw_url: &str,
    log: &dyn Fn(&str, &str),
) -> Result<(Cluster, String), String> {
    let dsn = Dsn::parse(raw_url)?;
    if !dsn.is_local() {
        return Err(format!(
            "Database host {} is remote; the bundled PostgreSQL only manages a local database.",
            dsn.host
        ));
    }
    if dsn.user != "postgres" {
        return Err(
            "The bundled PostgreSQL uses the postgres user. Update DATABASE_URL to use postgres or configure an external database."
                .into(),
        );
    }
    if !dsn.password.is_empty() {
        return Err(
            "The bundled PostgreSQL manages its own local credentials. Remove the password from DATABASE_URL or configure an external database."
                .into(),
        );
    }
    let bin = bin_dir(resources_dir, backend_dir)?;
    let dir = data_dir(user_dir);
    if port_open(&dsn.host, dsn.port) {
        return Ok((
            Cluster { data_dir: dir, bin_dir: bin, port: dsn.port, running: false },
            "A PostgreSQL server is already listening at the configured local address.".into(),
        ));
    }
    fs::create_dir_all(user_dir).map_err(|error| format!("Could not create {}: {error}", user_dir.display()))?;
    let initdb = bin.join(executable("initdb"));
    let pg_ctl = bin.join(executable("pg_ctl"));

    if !dir.join("PG_VERSION").exists() {
        log("system", "Initializing the bundled PostgreSQL database (first launch only)...");
        // `--encoding=UTF8` is not cosmetic: without it initdb inherits the
        // locale of whatever launched the app, and a GUI launch has none, which
        // produces an SQL-ASCII cluster every text column comes back from as
        // bytes.
        let args = vec![
            "-D".to_string(),
            dir.to_string_lossy().to_string(),
            "-U".to_string(),
            "postgres".to_string(),
            "-A".to_string(),
            "trust".to_string(),
            "--encoding=UTF8".to_string(),
            "--locale=C".to_string(),
        ];
        let refs: Vec<&str> = args.iter().map(|a| a.as_str()).collect();
        run_bin(&initdb, &refs, &|line| log("system", &format!("[PostgreSQL] {line}")))?;
    }

    let logfile = dir.join("server.log");
    let options = format!(
        "-p {} -c listen_addresses=127.0.0.1,::1",
        dsn.port
    );
    let args = vec![
        "-D".to_string(),
        dir.to_string_lossy().to_string(),
        "-l".to_string(),
        logfile.to_string_lossy().to_string(),
        "-o".to_string(),
        options,
        "-w".to_string(),
        "-t".to_string(),
        "60".to_string(),
        "start".to_string(),
    ];
    let refs: Vec<&str> = args.iter().map(|a| a.as_str()).collect();
    run_bin(&pg_ctl, &refs, &|line| log("system", &format!("[PostgreSQL] {line}")))?;

    let cluster = Cluster { data_dir: dir, bin_dir: bin, port: dsn.port, running: true };

    let encoding = client_to(&dsn, "postgres")
        .and_then(|mut client| {
            let row = client
                .query_one("select current_setting('server_encoding') as encoding", &[])
                .map_err(|error| error.to_string())?;
            Ok(row.get::<_, String>(0))
        })
        .unwrap_or_default();
    if !encoding.is_empty() && !encoding.eq_ignore_ascii_case("UTF8") {
        stop(&cluster);
        return Err(format!(
            "The bundled PostgreSQL cluster at {} uses {encoding} text encoding. Dump any data you need, quit the manager, delete that folder, and start again so it is re-created as UTF-8.",
            cluster.data_dir.display()
        ));
    }

    if !database_exists(&dsn) {
        let mut admin = client_to(&dsn, "postgres")?;
        let quoted = quote_ident(&dsn.database);
        admin
            .execute(&format!("create database {quoted}"), &[])
            .map_err(|error| format!("Could not create database {}: {error}", dsn.database))?;
        log("system", &format!("Created local database {}.", dsn.database));
    }
    log(
        "system",
        &format!("Bundled PostgreSQL is ready on {}:{}.", dsn.host, dsn.port),
    );
    Ok((cluster, format!("Started bundled PostgreSQL on {}:{}.", dsn.host, dsn.port)))
}

pub fn stop(cluster: &Cluster) {
    if !cluster.running {
        return;
    }
    let pg_ctl = cluster.bin_dir.join(executable("pg_ctl"));
    let args = vec![
        "-D".to_string(),
        cluster.data_dir.to_string_lossy().to_string(),
        "-m".to_string(),
        "fast".to_string(),
        "stop".to_string(),
    ];
    let refs: Vec<&str> = args.iter().map(|a| a.as_str()).collect();
    let _ = run_bin(&pg_ctl, &refs, &|_: &str| {});
}

fn database_exists(dsn: &Dsn) -> bool {
    client_to(dsn, "postgres")
        .and_then(|mut client| {
            let row = client
                .query_one("select 1 from pg_database where datname = $1", &[&dsn.database])
                .map_err(|error| error.to_string())?;
            Ok(row.get::<_, i32>(0))
        })
        .is_ok()
}

pub fn client_to(dsn: &Dsn, database: &str) -> Result<Client, String> {
    let url = format!(
        "postgresql://{}@{}:{}/{}",
        dsn.user, dsn.host, dsn.port, database
    );
    let mut client = Client::connect(&url, postgres::NoTls)
        .map_err(|error| format!("could not connect to {database}: {error}"))?;
    client
        .simple_query("set statement_timeout = '20s'")
        .map_err(|error| error.to_string())?;
    Ok(client)
}

pub fn connect(dsn: &Dsn) -> Result<Client, String> {
    let mut client = Client::connect(&dsn.url_for_driver(), postgres::NoTls)
        .map_err(|error| format!("could not connect: {error}"))?;
    client
        .simple_query("set statement_timeout = '20s'")
        .map_err(|error| error.to_string())?;
    Ok(client)
}

/// Reachability probe that never needs a Python interpreter.
pub fn probe(raw_url: &str) -> (bool, String) {
    let dsn = match Dsn::parse(raw_url) {
        Ok(dsn) => dsn,
        Err(message) => return (false, message),
    };
    if !port_open(&dsn.host, dsn.port) {
        return (
            false,
            format!(
                "Cannot reach PostgreSQL at {}:{}. Start the PostgreSQL service and confirm that it listens on this address and port.",
                dsn.host, dsn.port
            ),
        );
    }
    match connect(&dsn) {
        Ok(mut client) => match client.simple_query("select 1") {
            Ok(_) => (
                true,
                format!("Connected to database {} at {}:{}.", dsn.database, dsn.host, dsn.port),
            ),
            Err(error) => (
                false,
                format!(
                    "PostgreSQL is reachable at {}:{}, but the connection check failed: {error}",
                    dsn.host, dsn.port
                ),
            ),
        },
        Err(error) => (
            false,
            format!(
                "PostgreSQL is reachable at {}:{}, but authentication or database selection failed: {error}",
                dsn.host, dsn.port
            ),
        ),
    }
}

// ------------------------------------------------------------------ SQL helpers

pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

pub fn tables(client: &mut Client) -> Result<Vec<Value>, String> {
    let rows = client
        .query(
            "select c.relname as name
               from pg_class c
               join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relkind in ('r', 'p')
              order by c.relname",
            &[],
        )
        .map_err(|error| error.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let name: String = row.get(0);
        let counted = client
            .query_one(
                &format!("select count(*)::bigint as total from public.{}", quote_ident(&name)),
                &[],
            )
            .map(|row| row.get::<_, i64>(0))
            .ok();
        out.push(json!({ "name": name, "rows": counted }));
    }
    Ok(out)
}

pub struct Column {
    pub name: String,
    pub kind: String,
    pub required: bool,
}

pub struct Table {
    pub name: String,
    pub columns: Vec<Column>,
    pub primary_key: Vec<String>,
}

pub fn describe(client: &mut Client, table: &str) -> Result<Table, String> {
    let name = table.trim();
    if name.is_empty() {
        return Err("Choose a table first.".into());
    }
    let reference = format!("public.{}", quote_ident(name));
    let columns = client
        .query(
            "select a.attname as name,
                    format_type(a.atttypid, a.atttypmod) as type,
                    a.attnotnull as required
               from pg_attribute a
              where a.attrelid = to_regclass($1) and a.attnum > 0 and not a.attisdropped
              order by a.attnum",
            &[&reference],
        )
        .map_err(|error| error.to_string())?;
    if columns.is_empty() {
        return Err(format!("Table \"{name}\" does not exist in the public schema."));
    }
    let primary = client
        .query(
            "select a.attname as name
               from pg_index i
               join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
              where i.indrelid = to_regclass($1) and i.indisprimary
              order by array_position(i.indkey::int2[], a.attnum)",
            &[&reference],
        )
        .map_err(|error| error.to_string())?;
    Ok(Table {
        name: name.to_string(),
        columns: columns
            .iter()
            .map(|row| Column {
                name: row.get(0),
                kind: row.get(1),
                required: row.get(2),
            })
            .collect(),
        primary_key: primary.iter().map(|row| row.get(0)).collect(),
    })
}

pub fn read_rows(client: &mut Client, info: &Table, limit: i64, offset: i64) -> Result<Value, String> {
    let size = limit.clamp(1, 200);
    let start = offset.max(0);
    let total: i64 = client
        .query_one(
            &format!("select count(*)::bigint from public.{}", quote_ident(&info.name)),
            &[],
        )
        .map_err(|error| error.to_string())?
        .get(0);
    // Every column is cast to text so one code path covers uuid, jsonb, enums,
    // arrays, timestamps and bytea without a type table of its own.
    let projection = info
        .columns
        .iter()
        .map(|column| {
            format!(
                "{}::text as {}",
                quote_ident(&column.name),
                quote_ident(&column.name)
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    let order = if info.primary_key.is_empty() {
        info.columns
            .iter()
            .map(|column| quote_ident(&column.name))
            .collect::<Vec<_>>()
    } else {
        info.primary_key.iter().map(|column| quote_ident(column)).collect()
    }
    .join(", ");
    let sql = format!(
        "select {projection} from public.{} order by {order} limit $1 offset $2",
        quote_ident(&info.name)
    );
    let rows = client
        .query(&sql, &[&size, &start])
        .map_err(|error| error.to_string())?;
    let records: Vec<Value> = rows
        .iter()
        .map(|row| {
            let mut object = Map::new();
            for (index, column) in info.columns.iter().enumerate() {
                let value: Option<String> = row.get(index);
                object.insert(
                    column.name.clone(),
                    value.map(Value::String).unwrap_or(Value::Null),
                );
            }
            Value::Object(object)
        })
        .collect();
    Ok(json!({
        "name": info.name,
        "columns": info.columns.iter().map(|column| json!({
            "name": column.name,
            "type": column.kind,
            "required": column.required
        })).collect::<Vec<_>>(),
        "primaryKey": info.primary_key,
        "total": total,
        "limit": size,
        "offset": start,
        "rows": records
    }))
}

pub fn update_row(
    client: &mut Client,
    info: &Table,
    key: &Map<String, Value>,
    changes: &Map<String, Value>,
) -> Result<Value, String> {
    if info.primary_key.is_empty() {
        return Err(format!(
            "Table \"{}\" has no primary key, so rows cannot be edited safely from the manager.",
            info.name
        ));
    }
    if changes.is_empty() {
        return Err("Change at least one value before saving.".into());
    }
    let mut values: Vec<Option<String>> = Vec::new();
    let mut assignments = Vec::new();
    for (column, raw) in changes {
        if !info.columns.iter().any(|c| &c.name == column) {
            return Err(format!("Column \"{column}\" does not exist on {}.", info.name));
        }
        values.push(json_text(raw));
        assignments.push(format!(
            "{} = cast(${} as {})",
            quote_ident(column),
            values.len(),
            column_kind(info, column)
        ));
    }
    let mut where_parts = Vec::new();
    for column in &info.primary_key {
        let raw = key
            .get(column)
            .ok_or_else(|| format!("Missing primary key value for {column}. Reload the table and try again."))?;
        values.push(json_text(raw));
        where_parts.push(format!(
            "{} = cast(${} as {})",
            quote_ident(column),
            values.len(),
            column_kind(info, column)
        ));
    }
    let params: Vec<&(dyn postgres::types::ToSql + Sync)> =
        values.iter().map(|value| value as &(dyn postgres::types::ToSql + Sync)).collect();
    let sql = format!(
        "update public.{} set {} where {}",
        quote_ident(&info.name),
        assignments.join(", "),
        where_parts.join(" and ")
    );
    let affected = client.execute(&sql, &params).map_err(|error| error.to_string())?;
    if affected == 0 {
        return Err("No row matched that primary key. Reload the table and try again.".into());
    }
    Ok(json!(format!(
        "Saved {} column{} in {}.",
        changes.len(),
        if changes.len() == 1 { "" } else { "s" },
        info.name
    )))
}

pub fn delete_row(client: &mut Client, info: &Table, key: &Map<String, Value>) -> Result<String, String> {
    if info.primary_key.is_empty() {
        return Err(format!(
            "Table \"{}\" has no primary key, so rows cannot be deleted safely from the manager.",
            info.name
        ));
    }
    let mut values: Vec<Option<String>> = Vec::new();
    let mut where_parts = Vec::new();
    for column in &info.primary_key {
        let raw = key
            .get(column)
            .ok_or_else(|| format!("Missing primary key value for {column}. Reload the table and try again."))?;
        values.push(json_text(raw));
        where_parts.push(format!(
            "{} = cast(${} as {})",
            quote_ident(column),
            values.len(),
            column_kind(info, column)
        ));
    }
    let params: Vec<&(dyn postgres::types::ToSql + Sync)> =
        values.iter().map(|value| value as &(dyn postgres::types::ToSql + Sync)).collect();
    let sql = format!(
        "delete from public.{} where {}",
        quote_ident(&info.name),
        where_parts.join(" and ")
    );
    let affected = client.execute(&sql, &params).map_err(|error| error.to_string())?;
    if affected == 0 {
        return Err("No row matched that primary key. Reload the table and try again.".into());
    }
    Ok(format!("Deleted 1 row from {}.", info.name))
}

fn column_kind<'a>(info: &'a Table, name: &str) -> &'a str {
    info.columns
        .iter()
        .find(|column| column.name == name)
        .map(|column| column.kind.as_str())
        .unwrap_or("text")
}

fn json_text(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) if text == "NULL" => None,
        Value::String(text) => Some(text.clone()),
        other => Some(other.to_string()),
    }
}

/// `drop schema public cascade` + rebuild, used by the Database tab's reset.
pub fn clear_schema(dsn: &Dsn) -> Result<(), String> {
    let mut client = connect(dsn)?;
    client
        .batch_execute(
            "drop schema if exists public cascade; create schema public; grant usage, create on schema public to public;",
        )
        .map_err(|error| format!("Could not clear the public schema: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dsn_parses_the_sqlalchemy_prefix_and_credentials() {
        let dsn = Dsn::parse("postgresql+psycopg://postgres@127.0.0.1:55432/suite").unwrap();
        assert_eq!(dsn.host, "127.0.0.1");
        assert_eq!(dsn.port, 55432);
        assert_eq!(dsn.database, "suite");
        assert_eq!(dsn.user, "postgres");
        assert!(dsn.is_local());

        let remote = Dsn::parse("postgresql+psycopg://admin:secret@db.example:6543/ops?sslmode=require").unwrap();
        assert_eq!(remote.user, "admin");
        assert_eq!(remote.password, "secret");
        assert_eq!(remote.port, 6543);
        assert_eq!(remote.database, "ops");
        assert!(!remote.is_local());
        assert_eq!(remote.url_for_driver(), "postgresql://admin:secret@db.example:6543/ops");
    }

    #[test]
    fn dsn_rejects_missing_urls_and_database_names() {
        assert!(Dsn::parse("  ").is_err());
        assert!(Dsn::parse("mysql://root@localhost/db").is_err());
        assert!(Dsn::parse("postgresql://postgres@localhost:5432").is_err());
    }

    #[test]
    fn identifiers_are_quoted() {
        assert_eq!(quote_ident("shift_breaks"), "\"shift_breaks\"");
        assert_eq!(quote_ident("we\"ird"), "\"we\"\"ird\"");
    }
}

pub fn write_dump(path: &Path, database: &str, dsn: &Dsn) -> Result<u64, String> {
    let mut command = Command::new("pg_dump");
    command
        .arg("--format=custom")
        .arg("--no-owner")
        .arg("--no-acl")
        .arg("--file")
        .arg(path)
        .arg("--dbname")
        .arg(database);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ok();
    }
    // Password only reaches the process environment, never a command line.
    if !dsn.password.is_empty() {
        command.env("PGPASSWORD", &dsn.password);
    }
    let output = command
        .output()
        .map_err(|error| format!("pg_dump could not run: {error}. Install PostgreSQL client tools and retry."))?;
    if !output.status.success() {
        let text = String::from_utf8_lossy(&output.stderr).to_string();
        let detail = text.lines().last().unwrap_or("pg_dump failed").trim().to_string();
        let _ = fs::remove_file(path);
        return Err(format!("Database backup failed: {detail}"));
    }
    let size = fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    if size == 0 {
        let _ = fs::remove_file(path);
        return Err("pg_dump produced an empty backup file.".into());
    }
    Ok(size)
}

pub fn restore_dump(path: &Path, database: &str, dsn: &Dsn) -> Result<(), String> {
    let mut command = Command::new("pg_restore");
    command
        .arg("--clean")
        .arg("--if-exists")
        .arg("--no-owner")
        .arg("--no-acl")
        .arg("--dbname")
        .arg(database)
        .arg(path);
    if !dsn.password.is_empty() {
        command.env("PGPASSWORD", &dsn.password);
    }
    let output = command
        .output()
        .map_err(|error| format!("pg_restore could not run: {error}. Install PostgreSQL client tools and retry."))?;
    if !output.status.success() {
        let text = String::from_utf8_lossy(&output.stderr).to_string();
        let detail = text.lines().last().unwrap_or("pg_restore failed").trim().to_string();
        return Err(format!("Restore failed: {detail}"));
    }
    Ok(())
}

