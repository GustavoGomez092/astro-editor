//! The `PATH` dev servers run with.
//!
//! An app opened from the Dock gets launchd's bare `PATH`, without nvm, fnm,
//! Volta, bun or Homebrew, and a login shell (`-l`) alone skips `~/.zshrc`,
//! where the nvm, fnm and bun installers put themselves. So the user's shell is
//! asked once, as an interactive login shell, and only its `PATH` is kept. The
//! well-known folders that exist are added after it, which also covers a shell
//! that hangs or fails.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// How long the user's shell gets to print its `PATH`
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(8);

const START_MARKER: &str = "__AE_PATH_START__";
const END_MARKER: &str = "__AE_PATH_END__";

/// Set while the shell runs, so a `.zshrc` can skip slow or interactive setup
pub const GUARD_VARIABLE: &str = "ASTRO_EDITOR_RESOLVING_ENVIRONMENT";

/// The user's `PATH`, resolved on first use and kept for the app's life.
/// Blocks for up to 8 seconds the first time, so call it off the main thread.
pub fn user_path() -> String {
    static USER_PATH: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    USER_PATH
        .get_or_init(|| {
            let current = std::env::var("PATH").unwrap_or_default();
            #[cfg(unix)]
            {
                let shell = std::env::var_os("SHELL")
                    .filter(|s| !s.is_empty())
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from("/bin/zsh"));
                let base = resolve_shell_path(&shell, RESOLVE_TIMEOUT).unwrap_or_else(|| {
                    log::warn!(
                        "Astro Editor [DEV_SERVER] Couldn't read PATH from {}, using the app's own",
                        shell.display()
                    );
                    current
                });
                let home = std::env::var_os("HOME")
                    .map(PathBuf::from)
                    .unwrap_or_default();
                let path = join_path(
                    &base,
                    &well_known_dirs(&home, &|name| std::env::var(name).ok()),
                );
                log::info!("Astro Editor [DEV_SERVER] Dev servers run with PATH={path}");
                path
            }
            #[cfg(not(unix))]
            current
        })
        .clone()
}

/// Starts resolving the user's `PATH` on a thread of its own, the first time
/// it's called, so it's ready (or nearly) by the time a server starts. The
/// dev-server commands call it; nothing does at launch, so the user's shell
/// never runs unless the Preview tools are used.
pub fn warm_up() {
    static STARTED: AtomicBool = AtomicBool::new(false);
    start_once(&STARTED, || {
        user_path();
    });
}

/// Runs `work` on a new thread unless `started` says it already ran. Returns
/// whether it started it.
fn start_once(started: &AtomicBool, work: impl FnOnce() + Send + 'static) -> bool {
    if started.swap(true, Ordering::SeqCst) {
        return false;
    }
    std::thread::spawn(work);
    true
}

/// What the shell printed between the markers. Prompts, greetings and
/// anything else a `.zshrc` prints around it are ignored.
pub fn parse_marked_path(output: &str) -> Option<String> {
    let start = output.rfind(START_MARKER)? + START_MARKER.len();
    let length = output[start..].find(END_MARKER)?;
    let path = output[start..start + length].trim();
    (!path.is_empty()).then(|| path.to_string())
}

/// Runs `<shell> -ilc` to print `PATH`. `None` if it fails, prints nothing
/// usable, or takes longer than `timeout` (its process group is then killed).
#[cfg(unix)]
pub fn resolve_shell_path(shell: &Path, timeout: Duration) -> Option<String> {
    use std::io::Read;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::Instant;

    let mut child = Command::new(shell)
        .arg("-ilc")
        .arg(format!(
            "printf '%s' \"{START_MARKER}${{PATH}}{END_MARKER}\""
        ))
        .env(GUARD_VARIABLE, "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        // Its own group, so a timeout takes down whatever the profile started
        .process_group(0)
        .spawn()
        .ok()?;
    let group = child.id() as libc::pid_t;
    let kill_group = || unsafe {
        libc::kill(-group, libc::SIGKILL);
    };

    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut output = Vec::new();
        let _ = stdout.read_to_end(&mut output);
        let _ = tx.send(output);
    });

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                kill_group();
                let _ = child.wait();
                return None;
            }
        }
    }
    // Something the profile started in the background may hold the pipe open
    let output = rx.recv_timeout(Duration::from_millis(500)).ok();
    kill_group();
    parse_marked_path(&String::from_utf8_lossy(&output?))
}

#[cfg(not(unix))]
pub fn resolve_shell_path(_shell: &Path, _timeout: Duration) -> Option<String> {
    None
}

/// The version managers' and package managers' folders that exist, in the
/// order they're added to `PATH`
pub fn well_known_dirs(home: &Path, var: &dyn Fn(&str) -> Option<String>) -> Vec<PathBuf> {
    let from_var = |name: &str, fallback: PathBuf| -> PathBuf {
        var(name)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or(fallback)
    };
    let nvm_dir = from_var("NVM_DIR", home.join(".nvm"));
    let mut candidates: Vec<PathBuf> = Vec::new();
    candidates.extend(nvm_default_bin(&nvm_dir));
    candidates.push(from_var("VOLTA_HOME", home.join(".volta")).join("bin"));
    for fnm in [
        var("FNM_DIR").filter(|v| !v.is_empty()).map(PathBuf::from),
        Some(home.join(".local/share/fnm")),
        Some(home.join("Library/Application Support/fnm")),
        Some(home.join(".fnm")),
    ]
    .into_iter()
    .flatten()
    {
        candidates.push(fnm.join("aliases/default/bin"));
    }
    candidates.push(from_var("BUN_INSTALL", home.join(".bun")).join("bin"));
    candidates.push(from_var("PNPM_HOME", home.join("Library/pnpm")));
    candidates.push(from_var("ASDF_DATA_DIR", home.join(".asdf")).join("shims"));
    candidates.push(from_var("MISE_DATA_DIR", home.join(".local/share/mise")).join("shims"));
    candidates.push(PathBuf::from("/opt/homebrew/bin"));
    candidates.push(PathBuf::from("/usr/local/bin"));
    candidates.into_iter().filter(|dir| dir.is_dir()).collect()
}

/// The `bin` folder of the Node version nvm's `default` alias points to.
/// The alias holds a version (`v20.11.1`), a prefix (`20`), another alias
/// (`lts/iron`), or `node`/`stable`/`lts/*` for the newest.
fn nvm_default_bin(nvm_dir: &Path) -> Option<PathBuf> {
    let versions_dir = nvm_dir.join("versions/node");
    let mut alias = std::fs::read_to_string(nvm_dir.join("alias/default"))
        .ok()?
        .trim()
        .to_string();
    // Follow aliases of aliases, a few deep
    for _ in 0..3 {
        match std::fs::read_to_string(nvm_dir.join("alias").join(&alias)) {
            Ok(next) if !next.trim().is_empty() => alias = next.trim().to_string(),
            _ => break,
        }
    }
    let wanted = alias.trim_start_matches('v');
    let newest = matches!(alias.as_str(), "node" | "stable") || alias.starts_with("lts/");
    let installed = std::fs::read_dir(&versions_dir).ok()?;
    installed
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter(|name| {
            let version = name.trim_start_matches('v');
            newest || version == wanted || version.starts_with(&format!("{wanted}."))
        })
        .max_by_key(|name| version_key(name))
        .map(|name| versions_dir.join(name).join("bin"))
}

fn version_key(name: &str) -> Vec<u64> {
    name.trim_start_matches('v')
        .split('.')
        .map(|part| part.parse().unwrap_or(0))
        .collect()
}

/// `base`, then each of `extra` that isn't in it already
pub fn join_path(base: &str, extra: &[PathBuf]) -> String {
    let mut parts: Vec<String> = base
        .split(':')
        .filter(|p| !p.is_empty())
        .map(String::from)
        .collect();
    for dir in extra {
        let dir = dir.to_string_lossy().to_string();
        if !parts.contains(&dir) {
            parts.push(dir);
        }
    }
    parts.join(":")
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;
    use std::time::Instant;
    use tempfile::TempDir;

    fn no_vars(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn warm_up_work_starts_only_once() {
        let started = AtomicBool::new(false);
        let (tx, rx) = std::sync::mpsc::channel();
        let first = tx.clone();
        assert!(start_once(&started, move || first.send(1).unwrap()));
        assert!(!start_once(&started, move || tx.send(2).unwrap()));
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), 1);
        assert!(rx.recv_timeout(Duration::from_millis(100)).is_err());
    }

    #[test]
    fn parses_path_between_markers() {
        let output = format!(
            "Last login: Tue\n\u{1b}[32m➜\u{1b}[0m welcome!\n{START_MARKER}/a/bin:/usr/bin{END_MARKER}\n% bye\n"
        );
        assert_eq!(
            parse_marked_path(&output).as_deref(),
            Some("/a/bin:/usr/bin")
        );
    }

    #[test]
    fn missing_or_empty_markers_are_none() {
        assert_eq!(parse_marked_path("PATH=/usr/bin"), None);
        assert_eq!(parse_marked_path(&format!("{START_MARKER}/usr/bin")), None);
        assert_eq!(
            parse_marked_path(&format!("{START_MARKER}{END_MARKER}")),
            None
        );
    }

    fn fake_shell(dir: &Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let shell = dir.join("shell");
        fs::write(&shell, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&shell, fs::Permissions::from_mode(0o755)).unwrap();
        shell
    }

    #[test]
    fn asks_the_shell_with_the_guard_set() {
        let dir = TempDir::new().unwrap();
        // Prints noise, then runs the command it's given, like zsh -ilc would
        let shell = fake_shell(
            dir.path(),
            &format!(
                "echo 'Welcome'\n[ \"${GUARD_VARIABLE}\" = 1 ] || exit 3\n[ \"$1\" = -ilc ] || exit 4\nPATH=/from/zshrc:/usr/bin:/bin\nexport PATH\neval \"$2\"\necho done"
            ),
        );
        assert_eq!(
            resolve_shell_path(&shell, Duration::from_secs(5)).as_deref(),
            Some("/from/zshrc:/usr/bin:/bin")
        );
    }

    #[test]
    fn slow_shell_times_out() {
        let dir = TempDir::new().unwrap();
        let pid_file = dir.path().join("sleep.pid");
        let shell = fake_shell(
            dir.path(),
            &format!("sleep 30 &\necho $! > '{}'\nwait", pid_file.display()),
        );
        let started = Instant::now();
        // Long enough for the fake shell to start under a busy parallel test run
        assert_eq!(resolve_shell_path(&shell, Duration::from_secs(2)), None);
        assert!(started.elapsed() < Duration::from_secs(6));
        // The whole group went, including what the shell started
        let pid: i32 = fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        std::thread::sleep(Duration::from_millis(200));
        assert!(unsafe { libc::kill(pid, 0) } != 0, "sleep {pid} survived");
    }

    #[test]
    fn failing_shell_is_none() {
        let dir = TempDir::new().unwrap();
        let shell = fake_shell(dir.path(), "exit 1");
        assert_eq!(resolve_shell_path(&shell, Duration::from_secs(5)), None);
        assert_eq!(
            resolve_shell_path(&dir.path().join("no-such-shell"), Duration::from_secs(5)),
            None
        );
    }

    #[test]
    fn nvm_default_alias_is_found() {
        let home = TempDir::new().unwrap();
        let nvm = home.path().join(".nvm");
        for version in ["v18.20.0", "v20.11.1", "v20.9.0"] {
            fs::create_dir_all(nvm.join("versions/node").join(version).join("bin")).unwrap();
        }
        fs::create_dir_all(nvm.join("alias")).unwrap();
        // nvm writes a version prefix, `lts/*` or an exact version
        fs::write(nvm.join("alias/default"), "20\n").unwrap();
        let dirs = well_known_dirs(home.path(), &no_vars);
        assert!(
            dirs.contains(&nvm.join("versions/node/v20.11.1/bin")),
            "{dirs:?}"
        );

        fs::write(nvm.join("alias/default"), "v18.20.0").unwrap();
        let dirs = well_known_dirs(home.path(), &no_vars);
        assert!(
            dirs.contains(&nvm.join("versions/node/v18.20.0/bin")),
            "{dirs:?}"
        );
    }

    #[test]
    fn nvm_dir_variable_is_used() {
        let home = TempDir::new().unwrap();
        let nvm = home.path().join("custom-nvm");
        fs::create_dir_all(nvm.join("versions/node/v22.1.0/bin")).unwrap();
        fs::create_dir_all(nvm.join("alias")).unwrap();
        fs::write(nvm.join("alias/default"), "node").unwrap();
        let nvm_dir = nvm.to_str().unwrap().to_string();
        let var = move |name: &str| (name == "NVM_DIR").then(|| nvm_dir.clone());
        let dirs = well_known_dirs(home.path(), &var);
        assert!(
            dirs.contains(&nvm.join("versions/node/v22.1.0/bin")),
            "{dirs:?}"
        );
    }

    #[test]
    fn other_managers_only_when_they_exist() {
        let home = TempDir::new().unwrap();
        for dir in [
            ".volta/bin",
            ".bun/bin",
            ".asdf/shims",
            ".local/share/mise/shims",
        ] {
            fs::create_dir_all(home.path().join(dir)).unwrap();
        }
        let pnpm = home.path().join("pnpm-home");
        fs::create_dir_all(&pnpm).unwrap();
        let pnpm_home = pnpm.to_str().unwrap().to_string();
        let var = move |name: &str| (name == "PNPM_HOME").then(|| pnpm_home.clone());
        let dirs = well_known_dirs(home.path(), &var);
        for dir in [
            ".volta/bin",
            ".bun/bin",
            ".asdf/shims",
            ".local/share/mise/shims",
        ] {
            assert!(dirs.contains(&home.path().join(dir)), "{dir} in {dirs:?}");
        }
        assert!(dirs.contains(&pnpm));
        assert!(!dirs.iter().any(|d| d.starts_with(home.path().join(".nvm"))));
        assert!(!dirs.contains(&home.path().join(".local/share/fnm/aliases/default/bin")));
    }

    #[test]
    fn fnm_default_is_found() {
        let home = TempDir::new().unwrap();
        let fnm = home.path().join(".local/share/fnm/aliases/default/bin");
        fs::create_dir_all(&fnm).unwrap();
        assert!(well_known_dirs(home.path(), &no_vars).contains(&fnm));
    }

    #[test]
    fn joins_without_duplicates() {
        let extra = [
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/home/k/.bun/bin"),
            PathBuf::from("/home/k/.bun/bin"),
        ];
        assert_eq!(
            join_path("/opt/homebrew/bin:/usr/bin", &extra),
            "/opt/homebrew/bin:/usr/bin:/home/k/.bun/bin"
        );
        assert_eq!(join_path("", &extra[1..]), "/home/k/.bun/bin");
    }
}
