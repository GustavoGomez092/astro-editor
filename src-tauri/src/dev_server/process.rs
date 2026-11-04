//! Starting and stopping a project's dev server.
//!
//! The command runs as `/bin/sh -c` with the `PATH` the user's own shell has
//! (`env_path.rs`), so it finds Node from nvm, fnm, Volta or Homebrew even when
//! the app was opened from the Dock, and with an environment cleaned of what
//! the app's launcher left in it. The shell leads its own process group, so
//! stopping signals the group and takes down everything the server started
//! (Astro, Vite, esbuild) instead of only the shell.

use super::detect::{self, Ready};
use super::env_path;
use super::{lock, Config, DevServerState, DevServerStatus, DevServers, Server, StateListener};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// How long a server gets to shut down after SIGTERM before it's killed
const STOP_GRACE: Duration = Duration::from_secs(3);

/// How long to wait for a killed server to be gone
const KILL_WAIT: Duration = Duration::from_secs(1);

/// How long to keep reading output after the process exits, for the lines
/// still in the pipes
const DRAIN_TIMEOUT: Duration = Duration::from_millis(500);

/// Longer output lines are cut to this many bytes
const MAX_LINE_BYTES: usize = 4096;

/// How many output lines an error message ends with
const ERROR_LINES: usize = 10;

impl DevServers {
    /// Starts the project's server (after installing dependencies, if they're
    /// missing or out of date). Returns the new state at once; a server that's
    /// already installing, starting or running is left alone.
    pub fn start(&self, project_path: &str, override_command: Option<&str>) -> DevServerState {
        let server = self
            .shared
            .servers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(project_path.to_string())
            .or_default()
            .clone();
        let listener = self.shared.listener.clone();
        let root = Path::new(project_path);

        let mut inner = lock(&server.inner);
        if inner.is_active() {
            return inner.state.clone();
        }
        inner.run += 1;
        inner.stop_requested = false;
        inner.pgid = None;
        inner.logs.clear();
        inner.parser = detect::OutputParser::default();

        match detect::dev_command(root, override_command) {
            Err(error) => inner.state = error_state(None, error),
            Ok(command) => {
                let pm = detect::detect_package_manager(root);
                let install = (root.join("package.json").is_file()
                    && detect::needs_install(root, pm))
                .then(|| detect::install_command(root, pm));
                let first = install.as_deref().unwrap_or(&command);
                log::info!("Astro Editor [DEV_SERVER] Running `{first}` in {project_path}");

                match spawn(&self.shared.config, root, first) {
                    Err(e) => {
                        inner.state = error_state(
                            Some(command),
                            format!("Couldn't start the dev server: {e}"),
                        )
                    }
                    Ok(child) => {
                        let pid = child.id();
                        inner.pgid = Some(pid);
                        inner.state = DevServerState {
                            status: if install.is_some() {
                                DevServerStatus::Installing
                            } else {
                                DevServerStatus::Starting
                            },
                            url: None,
                            command: Some(command.clone()),
                            pid: Some(pid),
                            error: None,
                        };
                        let monitor = Monitor {
                            server: server.clone(),
                            listener: listener.clone(),
                            config: self.shared.config.clone(),
                            project_path: project_path.to_string(),
                            root: root.to_path_buf(),
                            run: inner.run,
                            pm,
                        };
                        let rx = watch(child);
                        std::thread::spawn(move || monitor.run(rx, install, command));
                    }
                }
            }
        }
        let state = inner.state.clone();
        drop(inner);
        listener(project_path, &state);
        state
    }

    /// Stops the project's server and everything it started: SIGTERM to its
    /// process group, then SIGKILL if it's still there after 3 seconds.
    /// Clears an error or an external server's state too.
    pub fn stop(&self, project_path: &str) -> DevServerState {
        let Some(server) = self.server(project_path) else {
            return DevServerState::stopped();
        };
        let listener = &self.shared.listener;

        let (run, pgid) = {
            let mut inner = lock(&server.inner);
            if !inner.is_active() {
                if inner.state.status == DevServerStatus::Stopped {
                    return inner.state.clone();
                }
                inner.state = stopped_state(&inner.state);
                let state = inner.state.clone();
                drop(inner);
                listener(project_path, &state);
                return state;
            }
            inner.stop_requested = true;
            (inner.run, inner.pgid)
        };

        if let Some(pgid) = pgid {
            log::info!("Astro Editor [DEV_SERVER] Stopping the dev server in {project_path}");
            terminate_group(&server, pgid);
        }

        let mut inner = lock(&server.inner);
        if inner.run == run && inner.state.status != DevServerStatus::Stopped {
            inner.pgid = None;
            inner.state = stopped_state(&inner.state);
            let state = inner.state.clone();
            drop(inner);
            listener(project_path, &state);
            return state;
        }
        inner.state.clone()
    }

    /// Stops every project's server at once, for quitting
    pub fn stop_all(&self) {
        let paths: Vec<String> = self
            .shared
            .servers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .keys()
            .cloned()
            .collect();
        let stops: Vec<_> = paths
            .into_iter()
            .map(|path| {
                let servers = self.clone();
                std::thread::spawn(move || servers.stop(&path))
            })
            .collect();
        for stop in stops {
            let _ = stop.join();
        }
    }
}

fn stopped_state(previous: &DevServerState) -> DevServerState {
    DevServerState {
        command: previous.command.clone(),
        ..DevServerState::stopped()
    }
}

fn error_state(command: Option<String>, error: String) -> DevServerState {
    DevServerState {
        status: DevServerStatus::Error,
        command,
        error: Some(error),
        ..DevServerState::stopped()
    }
}

/// Runs `command` in the project folder with `/bin/sh -c`, with the user's
/// `PATH` and a cleaned environment, as the leader of a new process group
fn spawn(config: &Config, root: &Path, command: &str) -> std::io::Result<Child> {
    #[cfg(unix)]
    let mut cmd = {
        use std::os::unix::process::CommandExt;
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg(command).process_group(0);
        cmd
    };
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut cmd = Command::new("cmd");
        cmd.arg("/C")
            .arg(command)
            .creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
        cmd
    };
    let path = config.path.clone().unwrap_or_else(env_path::user_path);
    cmd.current_dir(root)
        .env_clear()
        .envs(server_env(std::env::vars_os(), &config.env))
        .env("PATH", path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
}

/// Variables that change how tools behave depending on how the app was
/// launched: Astro detaches its server when it sees an AI agent's markers
/// (it checks them with `am-i-vibing`), and npm's `npm_*`, `INIT_CWD`,
/// `NODE_ENV`, `PORT`, `HOST` and `NODE_OPTIONS` belong to whatever ran the
/// app, not to this project
const REMOVED_VARIABLES: &[&str] = &[
    "CLAUDECODE",
    "AI_AGENT",
    "AGENT",
    "GEMINI_CLI",
    "CURSOR_AGENT",
    "CURSOR_TRACE_ID",
    "AIDER_API_KEY",
    "AMP_CURRENT_THREAD_ID",
    "ANTIGRAVITY_AGENT",
    "ANTIGRAVITY_PROJECT_ID",
    "AUGMENT_AGENT",
    "CODEIUM_EDITOR_APP_ROOT",
    "CRUSH",
    "OPENCODE",
    "PI_CODING_AGENT",
    "QWEN_CODE",
    "REPL_ID",
    "REPLIT_MODE",
    // Zed's, VS Code's and Warp's agents are told apart by the terminal
    "TERM_PROGRAM",
    "TERM_PROGRAM_VERSION",
    "INIT_CWD",
    "NODE_ENV",
    "PORT",
    "HOST",
    "NODE_OPTIONS",
    "PATH",
    env_path::GUARD_VARIABLE,
];

const REMOVED_PREFIXES: &[&str] = &["CLAUDE_CODE_", "CODEX_", "OPENCODE_", "npm_", "NPM_CONFIG_"];

fn is_removed(name: &str) -> bool {
    REMOVED_VARIABLES.contains(&name) || REMOVED_PREFIXES.iter().any(|p| name.starts_with(p))
}

/// The app's environment plus `extra`, without the removed variables
fn server_env(
    inherited: impl Iterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
    extra: &[(String, String)],
) -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    inherited
        .chain(extra.iter().map(|(k, v)| (k.into(), v.into())))
        .filter(|(name, _)| !name.to_str().is_some_and(is_removed))
        .collect()
}

#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

enum Message {
    Line(String),
    /// One of the two pipes closed
    Eof,
    /// The process exited, with its code (`None` if a signal ended it)
    Exit(Option<i32>),
}

/// Reads the child's output and waits for it to exit, on their own threads
fn watch(mut child: Child) -> Receiver<Message> {
    let (tx, rx) = mpsc::channel();
    if let Some(stdout) = child.stdout.take() {
        read_lines(stdout, tx.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        read_lines(stderr, tx.clone());
    }
    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|status| status.code());
        let _ = tx.send(Message::Exit(code));
    });
    rx
}

fn read_lines(pipe: impl Read + Send + 'static, tx: Sender<Message>) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(pipe);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = cap_line(detect::strip_ansi(&String::from_utf8_lossy(&buf)));
                    if tx.send(Message::Line(line)).is_err() {
                        break;
                    }
                }
            }
        }
        let _ = tx.send(Message::Eof);
    });
}

/// Cuts a line longer than `MAX_LINE_BYTES` (a minified bundle in an error,
/// say), so the kept output stays small
fn cap_line(mut line: String) -> String {
    if line.len() <= MAX_LINE_BYTES {
        return line;
    }
    let mut end = MAX_LINE_BYTES;
    while !line.is_char_boundary(end) {
        end -= 1;
    }
    line.truncate(end);
    line.push('…');
    line
}

/// Follows one run of a server: the install, if any, then the server itself
struct Monitor {
    server: Arc<Server>,
    listener: StateListener,
    config: Config,
    project_path: String,
    root: PathBuf,
    run: u64,
    pm: detect::PackageManager,
}

impl Monitor {
    fn run(self, mut rx: Receiver<Message>, install: Option<String>, command: String) {
        if let Some(install) = install {
            let code = self.follow(&rx, false);
            let mut inner = lock(&self.server.inner);
            if inner.run != self.run {
                return;
            }
            inner.pgid = None;
            if inner.stop_requested {
                inner.state = stopped_state(&inner.state);
            } else if code == Some(0) {
                detect::mark_installed(&self.root, self.pm);
                log::info!(
                    "Astro Editor [DEV_SERVER] Running `{command}` in {}",
                    self.project_path
                );
                // Spawned with the lock held, so a stop either sees this
                // process or stops it from starting
                match spawn(&self.config, &self.root, &command) {
                    Ok(child) => {
                        inner.pgid = Some(child.id());
                        inner.state.status = DevServerStatus::Starting;
                        inner.state.pid = Some(child.id());
                        rx = watch(child);
                    }
                    Err(e) => {
                        inner.state = error_state(
                            Some(command.clone()),
                            format!("Couldn't start the dev server: {e}"),
                        )
                    }
                }
            } else {
                let error = not_found_error(code, &install, &inner.logs).unwrap_or_else(|| {
                    with_last_lines(
                        &format!("Couldn't install the project's dependencies ({install})."),
                        &inner.logs,
                    )
                });
                inner.state = error_state(Some(command.clone()), error);
            }
            let state = inner.state.clone();
            let starting = state.status == DevServerStatus::Starting;
            drop(inner);
            self.notify(&state);
            if !starting {
                return;
            }
        }

        let code = self.follow(&rx, true);
        let mut inner = lock(&self.server.inner);
        if inner.run != self.run {
            return;
        }
        let pgid = inner.pgid.take();
        if inner.stop_requested {
            inner.state = stopped_state(&inner.state);
        } else {
            // Whatever the shell left behind goes with it
            if let Some(pgid) = pgid {
                kill_group(pgid);
            }
            inner.state = match inner.state.status {
                DevServerStatus::External => DevServerState {
                    pid: None,
                    ..inner.state.clone()
                },
                DevServerStatus::Running => error_state(
                    Some(command.clone()),
                    with_last_lines("The dev server stopped unexpectedly.", &inner.logs),
                ),
                _ => error_state(
                    Some(command.clone()),
                    not_found_error(code, &command, &inner.logs).unwrap_or_else(|| {
                        with_last_lines("The dev server stopped before it was ready.", &inner.logs)
                    }),
                ),
            };
        }
        let state = inner.state.clone();
        drop(inner);
        log::info!(
            "Astro Editor [DEV_SERVER] The dev server in {} ended: {:?}",
            self.project_path,
            state.status
        );
        self.notify(&state);
    }

    /// Records output until the process exits and its pipes are read, and
    /// returns its exit code. `server` says whether this is the server, whose
    /// output says when it's ready.
    fn follow(&self, rx: &Receiver<Message>, server: bool) -> Option<i32> {
        let mut eofs = 0;
        let mut exit: Option<(Option<i32>, Instant)> = None;
        loop {
            let message = match exit {
                None => rx.recv().ok(),
                Some((_, at)) => rx
                    .recv_timeout(DRAIN_TIMEOUT.saturating_sub(at.elapsed()))
                    .ok(),
            };
            match message {
                None => break,
                Some(Message::Line(line)) => self.on_line(line, server),
                Some(Message::Eof) => eofs += 1,
                Some(Message::Exit(code)) => exit = Some((code, Instant::now())),
            }
            if exit.is_some() && eofs == 2 {
                break;
            }
        }
        exit.and_then(|(code, _)| code)
    }

    fn on_line(&self, line: String, server: bool) {
        let mut inner = lock(&self.server.inner);
        if inner.run != self.run {
            return;
        }
        let ready = (server && inner.state.status == DevServerStatus::Starting)
            .then(|| inner.parser.feed(&line))
            .flatten();
        inner.push_log(line);
        let Some(ready) = ready else {
            return;
        };
        let (status, url) = match ready {
            Ready::Running(url) => (DevServerStatus::Running, url),
            Ready::External(url) => (DevServerStatus::External, url),
        };
        inner.state.status = status;
        inner.state.url = Some(url);
        let state = inner.state.clone();
        drop(inner);
        self.notify(&state);
    }

    fn notify(&self, state: &DevServerState) {
        (self.listener)(&self.project_path, state);
    }
}

/// The program a shell couldn't find, from its message: `sh: npm: command not
/// found`, `zsh:1: command not found: npm`, `env: node: No such file or
/// directory` (a `#!/usr/bin/env node` script), or cmd.exe's "is not recognized"
fn missing_program(line: &str) -> Option<String> {
    static PATTERNS: std::sync::OnceLock<Vec<regex::Regex>> = std::sync::OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        [
            r"command not found: (\S+)",
            r"([^\s:]+): command not found",
            r"([^\s:]+): not found",
            r"env: ([^\s:]+): No such file or directory",
            r"'([^']+)' is not recognized as an internal or external command",
        ]
        .iter()
        .map(|p| regex::Regex::new(p).unwrap())
        .collect()
    });
    patterns
        .iter()
        .find_map(|re| re.captures(line))
        .map(|caps| caps[1].to_string())
}

/// The plain-words error for a shell that couldn't find the command's own
/// program, or Node behind it. A program missing further in (`astro`, when
/// dependencies aren't installed) gets the ordinary error with the output.
fn not_found_error(
    code: Option<i32>,
    command: &str,
    logs: &std::collections::VecDeque<String>,
) -> Option<String> {
    // 127 from a POSIX shell, 9009 from cmd.exe
    if !matches!(code, Some(127) | Some(9009)) {
        return None;
    }
    let first = command.split_whitespace().next()?;
    let missing = logs
        .iter()
        .rev()
        .take(ERROR_LINES)
        .find_map(|line| missing_program(line))?;
    if missing != first && missing != "node" {
        return None;
    }
    let message = match missing.as_str() {
        "node" | "npm" | "npx" | "pnpm" | "yarn" | "corepack" => format!(
            "Couldn't find {missing}. Install Node.js from https://nodejs.org, then try again."
        ),
        "bun" => "Couldn't find bun. Install it from https://bun.sh, then try again.".to_string(),
        _ => format!("Couldn't find {missing}. Check the Dev command in Project Settings."),
    };
    Some(with_last_lines(&message, logs))
}

/// The message, then the last lines of output, which usually say why
fn with_last_lines(message: &str, logs: &std::collections::VecDeque<String>) -> String {
    let mut lines: Vec<&str> = logs
        .iter()
        .rev()
        .filter(|line| !line.trim().is_empty())
        .take(ERROR_LINES)
        .map(String::as_str)
        .collect();
    lines.reverse();
    if lines.is_empty() {
        message.to_string()
    } else {
        format!("{message}\n\n{}", lines.join("\n"))
    }
}

/// SIGTERM, a grace period, then SIGKILL
fn terminate_group(server: &Server, pgid: u32) {
    signal_group(pgid, false);
    if wait_until_gone(server, pgid, STOP_GRACE) {
        return;
    }
    log::warn!("Astro Editor [DEV_SERVER] The dev server didn't stop in time, killing it");
    signal_group(pgid, true);
    wait_until_gone(server, pgid, KILL_WAIT);
}

/// Kills the group without waiting
pub(crate) fn kill_group(pgid: u32) {
    signal_group(pgid, true);
}

#[cfg(unix)]
fn signal_group(pgid: u32, kill: bool) {
    let signal = if kill { libc::SIGKILL } else { libc::SIGTERM };
    // A negative pid signals the whole process group
    unsafe {
        libc::kill(-(pgid as libc::pid_t), signal);
    }
}

#[cfg(windows)]
fn signal_group(pid: u32, kill: bool) {
    use std::os::windows::process::CommandExt;
    // /T takes the whole tree the shell started
    let mut cmd = Command::new("taskkill");
    cmd.args(["/PID", &pid.to_string(), "/T"]);
    if kill {
        cmd.arg("/F");
    }
    let _ = cmd.creation_flags(CREATE_NO_WINDOW).status();
}

/// Waits for every process in the group to exit. Returns whether they did.
fn wait_until_gone(server: &Server, pgid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if !group_alive(server, pgid) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(unix)]
fn group_alive(_server: &Server, pgid: u32) -> bool {
    // Signal 0 only checks; it fails once no process in the group is left.
    // The shell is reaped by its waiter thread, so it doesn't linger as a zombie
    unsafe { libc::kill(-(pgid as libc::pid_t), 0) == 0 }
}

/// Windows has no process groups to ask, so this waits for the shell itself
#[cfg(windows)]
fn group_alive(server: &Server, pid: u32) -> bool {
    let inner = lock(&server.inner);
    inner.pgid == Some(pid) && inner.is_active()
}

#[cfg(test)]
mod tests {
    use super::super::*;
    use super::{missing_program, MAX_LINE_BYTES};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};
    use tempfile::TempDir;

    /// A fake server project, the servers that run it, and every state they reported
    struct Fixture {
        dir: TempDir,
        servers: DevServers,
        states: Arc<Mutex<Vec<DevServerState>>>,
    }

    impl Fixture {
        /// `package_json` of `None` leaves it out
        fn new(package_json: Option<&str>) -> Self {
            Self::with_env(package_json, &[])
        }

        /// With extra variables in the environment the servers start from
        fn with_env(package_json: Option<&str>, env: &[(&str, &str)]) -> Self {
            let dir = TempDir::new().unwrap();
            if let Some(json) = package_json {
                fs::write(dir.path().join("package.json"), json).unwrap();
            }
            // The tests set PATH rather than resolve the user's
            let bin = dir.path().join("bin");
            fs::create_dir(&bin).unwrap();
            let path = format!("{}:/usr/bin:/bin", bin.display());

            let states = Arc::new(Mutex::new(Vec::new()));
            let recorded = states.clone();
            let servers = DevServers::with_config(
                Arc::new(move |_, state| recorded.lock().unwrap().push(state.clone())),
                Config {
                    path: Some(path),
                    env: env
                        .iter()
                        .map(|(k, v)| (k.to_string(), v.to_string()))
                        .collect(),
                },
            );
            Self {
                dir,
                servers,
                states,
            }
        }

        fn path(&self) -> &str {
            self.dir.path().to_str().unwrap()
        }

        /// Writes a script into the project and returns the command that runs it
        fn script(&self, name: &str, body: &str) -> String {
            fs::write(self.dir.path().join(name), format!("#!/bin/sh\n{body}\n")).unwrap();
            format!("sh ./{name}")
        }

        /// Puts an executable on the servers' PATH
        fn bin(&self, name: &str, body: &str) {
            let path = self.dir.path().join("bin").join(name);
            fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            make_executable(&path);
        }

        fn start(&self, command: Option<&str>) -> DevServerState {
            self.servers.start(self.path(), command)
        }

        fn wait_for(&self, status: DevServerStatus) -> DevServerState {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let state = self.servers.state(self.path());
                if state.status == status {
                    return state;
                }
                assert!(
                    Instant::now() < deadline,
                    "still {:?} waiting for {status:?}; logs: {:?}",
                    state,
                    self.servers.logs(self.path())
                );
                std::thread::sleep(Duration::from_millis(20));
            }
        }

        fn read_pid(&self, name: &str) -> i32 {
            let file = self.dir.path().join(name);
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                if let Some(pid) = fs::read_to_string(&file)
                    .ok()
                    .and_then(|s| s.trim().parse().ok())
                {
                    return pid;
                }
                assert!(Instant::now() < deadline, "{name} never written");
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.servers.stop_all();
        }
    }

    fn make_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn is_alive(pid: i32) -> bool {
        // Signal 0 checks the process exists without signalling it
        unsafe { libc::kill(pid, 0) == 0 }
    }

    /// Whether the process is gone within a moment. A killed process the
    /// tests don't own lingers as a zombie until launchd reaps it, which
    /// signal 0 still finds
    fn is_gone(pid: i32) -> bool {
        let deadline = Instant::now() + Duration::from_secs(2);
        while is_alive(pid) {
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        true
    }

    const DEV_PACKAGE: &str = r#"{ "scripts": { "dev": "astro dev" } }"#;

    #[test]
    fn start_reaches_running_on_url_line() {
        let fx = Fixture::new(None);
        let command = fx.script(
            "server.sh",
            r"echo ' astro  v7.4.2 ready in 312 ms'
sleep 0.2
printf '\033[32m┃\033[39m Local    \033[1m\033[36mhttp://localhost:4321/\033[39m\033[22m\n'
sleep 30",
        );
        let started = fx.start(Some(&command));
        assert_eq!(started.status, DevServerStatus::Starting);
        assert_eq!(started.command.as_deref(), Some(command.as_str()));

        let running = fx.wait_for(DevServerStatus::Running);
        assert_eq!(running.url.as_deref(), Some("http://localhost:4321/"));
        assert!(running.pid.is_some());
        let statuses: Vec<_> = fx.states.lock().unwrap().iter().map(|s| s.status).collect();
        assert_eq!(
            statuses,
            [DevServerStatus::Starting, DevServerStatus::Running]
        );

        let stopped = fx.servers.stop(fx.path());
        assert_eq!(stopped.status, DevServerStatus::Stopped);
        assert_eq!(stopped.url, None);
        assert_eq!(stopped.pid, None);
    }

    #[test]
    fn starting_twice_keeps_one_server() {
        let fx = Fixture::new(None);
        let command = fx.script(
            "server.sh",
            "echo $$ >> pids\necho http://localhost:4321/\nsleep 30",
        );
        fx.start(Some(&command));
        fx.wait_for(DevServerStatus::Running);
        assert_eq!(fx.start(Some(&command)).status, DevServerStatus::Running);
        std::thread::sleep(Duration::from_millis(200));
        let pids = fs::read_to_string(fx.dir.path().join("pids")).unwrap();
        assert_eq!(pids.lines().count(), 1);
    }

    #[test]
    fn exit_before_ready_is_error_with_last_lines() {
        let fx = Fixture::new(None);
        let command = fx.script(
            "server.sh",
            "echo 'Loading config'\necho 'Error: Cannot find module vite' >&2\necho '    at load (index.js:1)' >&2\nexit 1",
        );
        fx.start(Some(&command));
        let state = fx.wait_for(DevServerStatus::Error);
        let error = state.error.unwrap();
        assert!(
            error.starts_with("The dev server stopped before it was ready."),
            "{error}"
        );
        assert!(error.contains("Error: Cannot find module vite"), "{error}");
        assert!(error.contains("at load (index.js:1)"), "{error}");
        assert_eq!(state.pid, None);
        // Start is available again
        assert_eq!(fx.start(Some(&command)).status, DevServerStatus::Starting);
    }

    #[test]
    fn crash_after_start_is_error() {
        let fx = Fixture::new(None);
        let command = fx.script(
            "server.sh",
            "echo http://localhost:4321/\nsleep 0.3\necho 'Segmentation fault' >&2\nexit 139",
        );
        fx.start(Some(&command));
        fx.wait_for(DevServerStatus::Running);
        let error = fx.wait_for(DevServerStatus::Error).error.unwrap();
        assert!(
            error.starts_with("The dev server stopped unexpectedly."),
            "{error}"
        );
        assert!(error.contains("Segmentation fault"), "{error}");
    }

    #[test]
    fn missing_dev_script_is_readable_error() {
        let fx = Fixture::new(Some(r#"{ "scripts": { "build": "astro build" } }"#));
        let state = fx.start(None);
        assert_eq!(state.status, DevServerStatus::Error);
        assert_eq!(state.error.as_deref(), Some(detect::NO_DEV_SCRIPT));
        assert_eq!(state.pid, None);
        assert_eq!(fx.servers.state(fx.path()), state);
    }

    #[test]
    fn node_not_found_message() {
        let fx = Fixture::new(Some(DEV_PACKAGE));
        // No npm on PATH (node_modules exists, so nothing to install)
        fs::create_dir(fx.dir.path().join("node_modules")).unwrap();
        fx.start(None);
        let error = fx.wait_for(DevServerStatus::Error).error.unwrap();
        assert!(
            error.starts_with(
                "Couldn't find npm. Install Node.js from https://nodejs.org, then try again."
            ),
            "{error}"
        );
    }

    #[test]
    fn bun_not_found_links_bun_sh() {
        let fx = Fixture::new(Some(DEV_PACKAGE));
        fs::write(fx.dir.path().join("bun.lock"), "").unwrap();
        fs::create_dir(fx.dir.path().join("node_modules")).unwrap();
        fs::write(fx.dir.path().join("node_modules/.bun-tag"), "").unwrap();
        fx.start(None);
        let error = fx.wait_for(DevServerStatus::Error).error.unwrap();
        assert!(
            error.starts_with("Couldn't find bun. Install it from https://bun.sh, then try again."),
            "{error}"
        );
    }

    #[test]
    fn missing_node_behind_env_is_node_message() {
        let fx = Fixture::new(None);
        // What a `#!/usr/bin/env node` script says without Node
        fx.start(Some("env node server.js"));
        let error = fx.wait_for(DevServerStatus::Error).error.unwrap();
        assert!(
            error.starts_with(
                "Couldn't find node. Install Node.js from https://nodejs.org, then try again."
            ),
            "{error}"
        );
    }

    #[test]
    fn other_command_not_found_points_to_settings() {
        let fx = Fixture::new(None);
        fx.start(Some("astro-nope dev"));
        let error = fx.wait_for(DevServerStatus::Error).error.unwrap();
        assert!(
            error.starts_with(
                "Couldn't find astro-nope. Check the Dev command in Project Settings."
            ),
            "{error}"
        );
    }

    #[test]
    fn missing_program_from_shell_messages() {
        let cases = [
            ("sh: npm: command not found", "npm"),
            ("sh: line 1: bun: command not found", "bun"),
            ("/bin/sh: 1: pnpm: not found", "pnpm"),
            ("zsh:1: command not found: yarn", "yarn"),
            ("env: node: No such file or directory", "node"),
            (
                "'npx' is not recognized as an internal or external command,",
                "npx",
            ),
        ];
        for (line, program) in cases {
            assert_eq!(missing_program(line).as_deref(), Some(program), "{line}");
        }
        assert_eq!(missing_program("Error: page not found"), None);
    }

    #[test]
    fn child_environment_is_cleaned() {
        let fx = Fixture::with_env(
            None,
            &[
                ("CLAUDECODE", "1"),
                ("CLAUDE_CODE_ENTRYPOINT", "cli"),
                ("AI_AGENT", "claude-code"),
                ("CODEX_THREAD_ID", "t1"),
                ("GEMINI_CLI", "1"),
                ("npm_config_x", "1"),
                ("npm_lifecycle_event", "dev"),
                ("INIT_CWD", "/elsewhere"),
                ("NODE_ENV", "production"),
                ("PORT", "9999"),
                ("HOST", "0.0.0.0"),
                ("NODE_OPTIONS", "--inspect"),
                ("KEEP_ME", "yes"),
            ],
        );
        let command = fx.script(
            "server.sh",
            "env > env.txt\necho http://localhost:4321/\nsleep 30",
        );
        fx.start(Some(&command));
        fx.wait_for(DevServerStatus::Running);
        let env = fs::read_to_string(fx.dir.path().join("env.txt")).unwrap();
        let names: Vec<&str> = env.lines().filter_map(|l| l.split('=').next()).collect();
        for removed in [
            "CLAUDECODE",
            "CLAUDE_CODE_ENTRYPOINT",
            "AI_AGENT",
            "CODEX_THREAD_ID",
            "GEMINI_CLI",
            "npm_config_x",
            "npm_lifecycle_event",
            "INIT_CWD",
            "NODE_ENV",
            "PORT",
            "HOST",
            "NODE_OPTIONS",
        ] {
            assert!(!names.contains(&removed), "{removed} reached the server");
        }
        assert!(env.lines().any(|l| l == "KEEP_ME=yes"), "{env}");
        let bin = fx.dir.path().join("bin");
        assert!(
            env.lines()
                .any(|l| l == format!("PATH={}:/usr/bin:/bin", bin.display())),
            "{env}"
        );
    }

    #[test]
    fn long_lines_are_capped() {
        let fx = Fixture::new(None);
        let command = fx.script(
            "server.sh",
            "head -c 10000 /dev/zero | tr '\\0' x\necho\necho http://localhost:4321/\nsleep 30",
        );
        fx.start(Some(&command));
        fx.wait_for(DevServerStatus::Running);
        let logs = fx.servers.logs(fx.path());
        assert!(logs[0].starts_with("xxxx"), "{:?}", &logs[0][..10]);
        assert!(
            logs[0].len() <= MAX_LINE_BYTES + '…'.len_utf8(),
            "{}",
            logs[0].len()
        );
        assert!(logs[0].ends_with('…'));
    }

    #[test]
    fn poisoned_lock_is_recovered() {
        let fx = Fixture::new(None);
        let command = fx.script("server.sh", "echo http://localhost:4321/\nsleep 30");
        fx.start(Some(&command));
        fx.wait_for(DevServerStatus::Running);
        let server = fx.servers.server(fx.path()).unwrap();
        // A thread that panics holding the lock poisons it
        let _ = std::thread::spawn(move || {
            let _guard = server.inner.lock().unwrap();
            panic!("poison");
        })
        .join();
        assert_eq!(fx.servers.state(fx.path()).status, DevServerStatus::Running);
        assert_eq!(fx.servers.stop(fx.path()).status, DevServerStatus::Stopped);
    }

    #[test]
    fn installs_dependencies_first() {
        let fx = Fixture::new(Some(DEV_PACKAGE));
        fs::write(fx.dir.path().join("package-lock.json"), "{}").unwrap();
        fx.bin(
            "npm",
            r#"case "$1" in
  ci) echo installing; sleep 0.3; mkdir -p node_modules; touch node_modules/.package-lock.json ;;
  run) echo http://localhost:4321/; sleep 30 ;;
esac"#,
        );
        let state = fx.start(None);
        assert_eq!(state.status, DevServerStatus::Installing);
        assert_eq!(state.command.as_deref(), Some("npm run dev"));
        fx.wait_for(DevServerStatus::Running);
        let logs = fx.servers.logs(fx.path());
        assert!(logs.iter().any(|l| l == "installing"), "{logs:?}");
        let statuses: Vec<_> = fx.states.lock().unwrap().iter().map(|s| s.status).collect();
        assert_eq!(
            statuses,
            [
                DevServerStatus::Installing,
                DevServerStatus::Starting,
                DevServerStatus::Running
            ]
        );
    }

    #[test]
    fn failed_install_is_error() {
        let fx = Fixture::new(Some(DEV_PACKAGE));
        fx.bin("npm", "echo 'npm ERR! network unreachable' >&2\nexit 1");
        fx.start(None);
        let error = fx.wait_for(DevServerStatus::Error).error.unwrap();
        assert!(
            error.starts_with("Couldn't install the project's dependencies (npm install)."),
            "{error}"
        );
        assert!(error.contains("npm ERR! network unreachable"), "{error}");
    }

    #[test]
    fn already_running_elsewhere_is_external() {
        let fx = Fixture::new(None);
        let command = fx.script(
            "server.sh",
            "echo 'error   Another astro dev server is already running.' >&2\necho '' >&2\necho '  URL:  http://localhost:4321/' >&2\nexit 1",
        );
        fx.start(Some(&command));
        let state = fx.wait_for(DevServerStatus::External);
        assert_eq!(state.url.as_deref(), Some("http://localhost:4321/"));
        // It stays external after the process exits
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(
            fx.servers.state(fx.path()).status,
            DevServerStatus::External
        );
        assert_eq!(fx.servers.stop(fx.path()).status, DevServerStatus::Stopped);
    }

    #[test]
    fn logs_capped_at_200_lines() {
        let fx = Fixture::new(None);
        let command = fx.script(
            "server.sh",
            "i=1\nwhile [ $i -le 250 ]; do echo \"line $i\"; i=$((i+1)); done\necho http://localhost:4321/\nsleep 30",
        );
        fx.start(Some(&command));
        fx.wait_for(DevServerStatus::Running);
        let logs = fx.servers.logs(fx.path());
        assert_eq!(logs.len(), LOG_LIMIT);
        assert_eq!(logs[0], "line 52");
        assert_eq!(logs.last().unwrap(), "http://localhost:4321/");
    }

    #[test]
    fn stop_kills_process_group() {
        let fx = Fixture::new(None);
        let command = fx.script(
            "server.sh",
            "echo $$ > server.pid\nsleep 60 &\necho $! > child.pid\necho http://localhost:4321/\nwait",
        );
        fx.start(Some(&command));
        let running = fx.wait_for(DevServerStatus::Running);
        let shell = running.pid.unwrap() as i32;
        let server = fx.read_pid("server.pid");
        let child = fx.read_pid("child.pid");
        assert!(is_alive(shell) && is_alive(server) && is_alive(child));

        let started = Instant::now();
        assert_eq!(fx.servers.stop(fx.path()).status, DevServerStatus::Stopped);
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "SIGTERM was enough"
        );
        assert!(is_gone(shell), "shell still running");
        assert!(is_gone(server), "server still running");
        assert!(is_gone(child), "server's child still running");
    }

    #[test]
    fn stop_escalates_to_sigkill_after_3s() {
        let fx = Fixture::new(None);
        let command = fx.script(
            "server.sh",
            "trap '' TERM\necho $$ > server.pid\necho http://localhost:4321/\nwhile true; do sleep 0.1; done",
        );
        fx.start(Some(&command));
        fx.wait_for(DevServerStatus::Running);
        let server = fx.read_pid("server.pid");

        let started = Instant::now();
        assert_eq!(fx.servers.stop(fx.path()).status, DevServerStatus::Stopped);
        let took = started.elapsed();
        assert!(took >= Duration::from_secs(3), "killed after {took:?}");
        assert!(took < Duration::from_secs(6), "killed after {took:?}");
        assert!(is_gone(server));
    }

    #[test]
    fn stop_while_installing_stops_the_install() {
        let fx = Fixture::new(Some(DEV_PACKAGE));
        fx.bin(
            "npm",
            r#"case "$1" in
  install) echo $$ > install.pid; sleep 60 ;;
  run) echo $$ > dev.pid; echo http://localhost:4321/; sleep 60 ;;
esac"#,
        );
        assert_eq!(fx.start(None).status, DevServerStatus::Installing);
        let install = fx.read_pid("install.pid");
        assert_eq!(fx.servers.stop(fx.path()).status, DevServerStatus::Stopped);
        assert!(is_gone(install));
        std::thread::sleep(Duration::from_millis(300));
        assert!(
            !fx.dir.path().join("dev.pid").exists(),
            "dev server started after stop"
        );
        assert_eq!(fx.servers.state(fx.path()).status, DevServerStatus::Stopped);
    }

    #[test]
    fn stop_all_stops_every_project() {
        let first = Fixture::new(None);
        let command = first.script(
            "server.sh",
            "echo $$ > server.pid\necho http://localhost:4321/\nsleep 60",
        );
        // A second project on the same servers
        let other = TempDir::new().unwrap();
        fs::copy(
            first.dir.path().join("server.sh"),
            other.path().join("server.sh"),
        )
        .unwrap();
        let other_path = other.path().to_str().unwrap().to_string();

        first.start(Some(&command));
        first.servers.start(&other_path, Some(&command));
        first.wait_for(DevServerStatus::Running);
        let deadline = Instant::now() + Duration::from_secs(10);
        while first.servers.state(&other_path).status != DevServerStatus::Running {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(20));
        }
        let pids: Vec<i32> = [first.dir.path().to_path_buf(), PathBuf::from(&other_path)]
            .iter()
            .map(|dir| {
                fs::read_to_string(dir.join("server.pid"))
                    .unwrap()
                    .trim()
                    .parse()
                    .unwrap()
            })
            .collect();

        first.servers.stop_all();
        assert!(pids.iter().all(|pid| is_gone(*pid)));
        assert_eq!(
            first.servers.state(&other_path).status,
            DevServerStatus::Stopped
        );
    }
}
