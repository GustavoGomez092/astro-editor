//! Works out what to run for a project's dev server and reads its output: the
//! package manager its lockfile implies, the dev command, whether dependencies
//! need installing first, and the URL the server prints when it's ready.

use regex::Regex;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::SystemTime;

/// The package manager a project uses, from its lockfile
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackageManager {
    Bun,
    Pnpm,
    Yarn,
    Npm,
}

impl PackageManager {
    pub fn name(self) -> &'static str {
        match self {
            Self::Bun => "bun",
            Self::Pnpm => "pnpm",
            Self::Yarn => "yarn",
            Self::Npm => "npm",
        }
    }

    fn lockfiles(self) -> &'static [&'static str] {
        match self {
            Self::Bun => &["bun.lock", "bun.lockb"],
            Self::Pnpm => &["pnpm-lock.yaml"],
            Self::Yarn => &["yarn.lock"],
            Self::Npm => &["package-lock.json"],
        }
    }

    /// The file inside `node_modules` the package manager rewrites on every
    /// install. Without one, the `node_modules` folder's own time stands in.
    fn install_markers(self) -> &'static [&'static str] {
        match self {
            Self::Bun => &[".bun-tag"],
            Self::Pnpm => &[".modules.yaml"],
            Self::Yarn => &[".yarn-state.yml", ".yarn-integrity"],
            Self::Npm => &[".package-lock.json"],
        }
    }
}

/// Lockfiles in the order they're checked, so a project with two picks the
/// first (bun and pnpm projects sometimes keep a stale `package-lock.json`)
const DETECTION_ORDER: [PackageManager; 4] = [
    PackageManager::Bun,
    PackageManager::Pnpm,
    PackageManager::Yarn,
    PackageManager::Npm,
];

pub fn detect_package_manager(root: &Path) -> PackageManager {
    DETECTION_ORDER
        .into_iter()
        .find(|pm| lockfile(root, *pm).is_some())
        .unwrap_or(PackageManager::Npm)
}

/// The project's lockfile, if it has one
pub fn lockfile(root: &Path, pm: PackageManager) -> Option<PathBuf> {
    pm.lockfiles()
        .iter()
        .map(|name| root.join(name))
        .find(|path| path.is_file())
}

pub const NO_DEV_SCRIPT: &str = "This project's package.json has no \"dev\" script. Add one, or set a Dev command in Project Settings.";

/// The command that starts the dev server: the override from Project Settings
/// if there is one, else the `dev` script through the project's package manager
pub fn dev_command(root: &Path, override_command: Option<&str>) -> Result<String, String> {
    if let Some(command) = override_command.map(str::trim).filter(|c| !c.is_empty()) {
        return Ok(command.to_string());
    }
    if !has_dev_script(root) {
        return Err(NO_DEV_SCRIPT.to_string());
    }
    Ok(format!("{} run dev", detect_package_manager(root).name()))
}

fn has_dev_script(root: &Path) -> bool {
    std::fs::read_to_string(root.join("package.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|json| {
            json.get("scripts")?
                .get("dev")?
                .as_str()
                .map(|s| !s.trim().is_empty())
        })
        .unwrap_or(false)
}

/// The command that installs the project's dependencies
pub fn install_command(root: &Path, pm: PackageManager) -> String {
    match pm {
        // `npm ci` installs exactly what the lockfile says and never rewrites it,
        // so installing doesn't show up as a change to publish
        PackageManager::Npm if lockfile(root, pm).is_some() => "npm ci".to_string(),
        _ => format!("{} install", pm.name()),
    }
}

/// Dependencies need installing when `node_modules` is missing, or the lockfile
/// changed since the last install (a pull brought in new dependencies)
pub fn needs_install(root: &Path, pm: PackageManager) -> bool {
    let node_modules = root.join("node_modules");
    if !node_modules.is_dir() {
        return true;
    }
    let Some(lock_time) = lockfile(root, pm).and_then(|path| modified(&path)) else {
        return false;
    };
    let installed_time = pm
        .install_markers()
        .iter()
        .find_map(|marker| modified(&node_modules.join(marker)))
        .or_else(|| modified(&node_modules));
    installed_time.map_or(true, |installed| lock_time > installed)
}

fn modified(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// Records an install in `node_modules`' own time, for package managers that
/// left no marker file, so the next start doesn't install again
pub fn mark_installed(root: &Path, pm: PackageManager) {
    let node_modules = root.join("node_modules");
    if pm
        .install_markers()
        .iter()
        .any(|marker| node_modules.join(marker).exists())
    {
        return;
    }
    // Best effort: if it fails, the next start installs again
    let _ = filetime::set_file_mtime(&node_modules, filetime::FileTime::now());
}

/// Removes terminal colour and cursor codes
pub fn strip_ansi(line: &str) -> String {
    static ANSI: OnceLock<Regex> = OnceLock::new();
    let ansi = ANSI.get_or_init(|| {
        // CSI sequences (colours, cursor moves) and OSC sequences (titles, links)
        Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]")
            .unwrap()
    });
    let stripped = ansi.replace_all(line, "");
    let stripped = stripped.trim_end_matches(['\r', '\n']);
    // A progress line redraws itself after a carriage return; keep what's shown last
    stripped.rsplit('\r').next().unwrap_or("").to_string()
}

/// A URL on this machine: what dev servers print as "Local"
fn find_local_url(line: &str) -> Option<String> {
    static LOCAL_URL: OnceLock<Regex> = OnceLock::new();
    let local_url = LOCAL_URL.get_or_init(|| {
        Regex::new(r"https?://(?:localhost|127\.0\.0\.1|\[::1\]):\d+[^\s\x22'<>]*").unwrap()
    });
    let url = local_url.find(line)?.as_str();
    Some(url.trim_end_matches(['.', ',', ';', ')']).to_string())
}

/// What a line of server output says about the server
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ready {
    /// This server is listening at the URL
    Running(String),
    /// Another server for the project is already running at the URL
    External(String),
}

/// Reads server output line by line for the moment it's ready
#[derive(Debug, Default)]
pub struct OutputParser {
    saw_already_running: bool,
}

impl OutputParser {
    /// Takes a line with colour codes already removed
    pub fn feed(&mut self, line: &str) -> Option<Ready> {
        // Astro refuses to start a second server for a project and says where
        // the first one is, a few lines later
        if line.contains("Another astro dev server is already running") {
            self.saw_already_running = true;
        }
        let url = find_local_url(line)?;
        // Astro's background mode says "Dev server already running at <url>"
        if self.saw_already_running || line.contains("already running at") {
            Some(Ready::External(url))
        } else {
            Some(Ready::Running(url))
        }
    }
}

/// Finds a project's Dev command override in the preferences folder: the
/// registry maps the path to the project's ID, and the project's file holds
/// `settings.devCommand`
pub fn read_dev_command_override(preferences_dir: &Path, project_path: &str) -> Option<String> {
    let read_json = |path: PathBuf| -> Option<serde_json::Value> {
        serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
    };
    let wanted = project_path.trim_end_matches('/');
    let registry = read_json(preferences_dir.join("project-registry.json"))?;
    let id = registry
        .get("projects")?
        .as_object()?
        .values()
        .find(|project| {
            project
                .get("path")
                .and_then(|p| p.as_str())
                .is_some_and(|p| p.trim_end_matches('/') == wanted)
        })?
        .get("id")?
        .as_str()?
        .to_string();
    let project = read_json(preferences_dir.join("projects").join(format!("{id}.json")))?;
    let command = project.get("settings")?.get("devCommand")?.as_str()?.trim();
    (!command.is_empty()).then(|| command.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::Duration;
    use tempfile::TempDir;

    fn project(files: &[&str]) -> TempDir {
        let dir = TempDir::new().unwrap();
        fs::write(
            dir.path().join("package.json"),
            r#"{ "name": "site", "scripts": { "dev": "astro dev" } }"#,
        )
        .unwrap();
        for file in files {
            let path = dir.path().join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "").unwrap();
        }
        dir
    }

    fn set_mtime(path: &Path, time: SystemTime) {
        filetime::set_file_mtime(path, filetime::FileTime::from_system_time(time)).unwrap();
    }

    #[test]
    fn package_manager_from_lockfile() {
        let cases = [
            ("bun.lock", PackageManager::Bun),
            ("bun.lockb", PackageManager::Bun),
            ("pnpm-lock.yaml", PackageManager::Pnpm),
            ("yarn.lock", PackageManager::Yarn),
            ("package-lock.json", PackageManager::Npm),
        ];
        for (lockfile, expected) in cases {
            let dir = project(&[lockfile]);
            assert_eq!(detect_package_manager(dir.path()), expected, "{lockfile}");
        }
    }

    #[test]
    fn package_manager_defaults_to_npm() {
        let dir = project(&[]);
        assert_eq!(detect_package_manager(dir.path()), PackageManager::Npm);
    }

    #[test]
    fn command_runs_dev_script_through_package_manager() {
        let dir = project(&["pnpm-lock.yaml"]);
        assert_eq!(dev_command(dir.path(), None).unwrap(), "pnpm run dev");
        let dir = project(&[]);
        assert_eq!(dev_command(dir.path(), None).unwrap(), "npm run dev");
    }

    #[test]
    fn command_override_wins() {
        let dir = project(&["bun.lock"]);
        assert_eq!(
            dev_command(dir.path(), Some("  astro dev --port 3000 ")).unwrap(),
            "astro dev --port 3000"
        );
        // An empty override means none
        assert_eq!(dev_command(dir.path(), Some(" ")).unwrap(), "bun run dev");
    }

    #[test]
    fn command_without_dev_script_explains() {
        let dir = TempDir::new().unwrap();
        fs::write(
            dir.path().join("package.json"),
            r#"{ "scripts": { "build": "astro build" } }"#,
        )
        .unwrap();
        assert_eq!(dev_command(dir.path(), None).unwrap_err(), NO_DEV_SCRIPT);
        // No package.json at all
        let empty = TempDir::new().unwrap();
        assert_eq!(dev_command(empty.path(), None).unwrap_err(), NO_DEV_SCRIPT);
        // An override doesn't need the script
        assert!(dev_command(dir.path(), Some("astro dev")).is_ok());
    }

    #[test]
    fn install_commands() {
        let dir = project(&["package-lock.json"]);
        assert_eq!(install_command(dir.path(), PackageManager::Npm), "npm ci");
        let dir = project(&[]);
        assert_eq!(
            install_command(dir.path(), PackageManager::Npm),
            "npm install"
        );
        assert_eq!(
            install_command(dir.path(), PackageManager::Bun),
            "bun install"
        );
        assert_eq!(
            install_command(dir.path(), PackageManager::Pnpm),
            "pnpm install"
        );
        assert_eq!(
            install_command(dir.path(), PackageManager::Yarn),
            "yarn install"
        );
    }

    #[test]
    fn needs_install_without_node_modules() {
        let dir = project(&["package-lock.json"]);
        assert!(needs_install(dir.path(), PackageManager::Npm));
    }

    #[test]
    fn needs_install_when_lockfile_newer_than_marker() {
        let now = SystemTime::now();
        let earlier = now - Duration::from_secs(60);
        let markers = [
            (
                PackageManager::Npm,
                "package-lock.json",
                "node_modules/.package-lock.json",
            ),
            (
                PackageManager::Yarn,
                "yarn.lock",
                "node_modules/.yarn-state.yml",
            ),
            (
                PackageManager::Pnpm,
                "pnpm-lock.yaml",
                "node_modules/.modules.yaml",
            ),
            (PackageManager::Bun, "bun.lock", "node_modules/.bun-tag"),
        ];
        for (pm, lock, marker) in markers {
            let dir = project(&[lock, marker]);
            set_mtime(&dir.path().join(marker), earlier);
            set_mtime(&dir.path().join(lock), now);
            assert!(needs_install(dir.path(), pm), "{lock} newer than {marker}");

            set_mtime(&dir.path().join(lock), earlier - Duration::from_secs(60));
            assert!(!needs_install(dir.path(), pm), "{lock} older than {marker}");
        }
    }

    #[test]
    fn needs_install_falls_back_to_node_modules_time() {
        let now = SystemTime::now();
        let dir = project(&["bun.lockb", "node_modules/astro/package.json"]);
        let node_modules = dir.path().join("node_modules");
        set_mtime(&node_modules, now - Duration::from_secs(60));
        set_mtime(&dir.path().join("bun.lockb"), now);
        assert!(needs_install(dir.path(), PackageManager::Bun));

        // An install records itself in the folder's time
        mark_installed(dir.path(), PackageManager::Bun);
        assert!(!needs_install(dir.path(), PackageManager::Bun));
    }

    #[test]
    fn no_lockfile_needs_install_only_without_node_modules() {
        let dir = project(&["node_modules/astro/package.json"]);
        assert!(!needs_install(dir.path(), PackageManager::Npm));
    }

    #[test]
    fn strips_ansi_codes() {
        assert_eq!(
            strip_ansi("\u{1b}[32m┃\u{1b}[39m Local    \u{1b}[1m\u{1b}[36mhttp://localhost:4321/\u{1b}[39m\u{1b}[22m"),
            "┃ Local    http://localhost:4321/"
        );
        assert_eq!(strip_ansi("\u{1b}[2K\u{1b}[1Gdone\r"), "done");
    }

    #[test]
    fn url_from_astro_line() {
        let mut parser = OutputParser::default();
        assert_eq!(parser.feed(" astro  v7.4.2 ready in 312 ms"), None);
        assert_eq!(parser.feed("┃ Network  use --host to expose"), None);
        assert_eq!(
            parser.feed(&strip_ansi(
                "\u{1b}[32m┃\u{1b}[39m Local    \u{1b}[1m\u{1b}[36mhttp://localhost:4321/\u{1b}[39m\u{1b}[22m"
            )),
            Some(Ready::Running("http://localhost:4321/".into()))
        );
    }

    #[test]
    fn url_from_vite_line() {
        let mut parser = OutputParser::default();
        assert_eq!(
            parser.feed("  ➜  Local:   http://127.0.0.1:5173/docs/"),
            Some(Ready::Running("http://127.0.0.1:5173/docs/".into()))
        );
    }

    #[test]
    fn ignores_other_urls() {
        let mut parser = OutputParser::default();
        assert_eq!(parser.feed("See https://docs.astro.build/en/guides/"), None);
        assert_eq!(parser.feed("┃ Network  http://192.168.1.4:4321/"), None);
    }

    #[test]
    fn already_running_is_external() {
        let mut parser = OutputParser::default();
        let lines = [
            "error   Another astro dev server is already running.",
            "",
            "  URL:  http://localhost:4321/",
            "  PID:  4242",
        ];
        let results: Vec<_> = lines.iter().filter_map(|line| parser.feed(line)).collect();
        assert_eq!(results, [Ready::External("http://localhost:4321/".into())]);
    }

    #[test]
    fn dev_command_override_from_preferences() {
        let prefs = TempDir::new().unwrap();
        fs::create_dir_all(prefs.path().join("projects")).unwrap();
        fs::write(
            prefs.path().join("project-registry.json"),
            r#"{ "projects": {
                "site": { "id": "site", "name": "site", "path": "/Users/k/site" },
                "other": { "id": "other", "name": "other", "path": "/Users/k/other" }
            }, "lastOpenedProject": "site", "version": 2 }"#,
        )
        .unwrap();
        fs::write(
            prefs.path().join("projects/site.json"),
            r#"{ "settings": { "devCommand": "npm run start" }, "version": 2 }"#,
        )
        .unwrap();
        fs::write(
            prefs.path().join("projects/other.json"),
            r#"{ "settings": { "devCommand": null }, "version": 2 }"#,
        )
        .unwrap();

        assert_eq!(
            read_dev_command_override(prefs.path(), "/Users/k/site").as_deref(),
            Some("npm run start")
        );
        assert_eq!(
            read_dev_command_override(prefs.path(), "/Users/k/other"),
            None
        );
        assert_eq!(
            read_dev_command_override(prefs.path(), "/Users/k/unknown"),
            None
        );
        let empty = TempDir::new().unwrap();
        assert_eq!(
            read_dev_command_override(empty.path(), "/Users/k/site"),
            None
        );
    }
}
