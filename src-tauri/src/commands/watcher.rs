use crate::commands::project::discover_collections;
use crate::parser::{project_folder, CollectionFolders};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

/// A project's watcher and the generation that started it. Each start gets a new
/// generation, so an event loop can tell a watcher that was stopped or replaced
/// (its loop should end) from one that died (its loop should rebuild it).
pub struct WatcherEntry {
    generation: u64,
    watcher: RecommendedWatcher,
}

/// A newly built watcher, its event receiver, and whether it watches the
/// generated schemas folder (which doesn't exist until `astro sync` first runs)
struct ProjectWatcher {
    watcher: RecommendedWatcher,
    rx: Receiver<Event>,
    watches_schemas: bool,
    /// The content and collection folders it watches
    folders: Vec<PathBuf>,
}

fn schemas_dir(project_path: &str) -> PathBuf {
    PathBuf::from(project_path)
        .join(".astro")
        .join("collections")
}

// Global watcher storage, keyed by project path
type WatcherMap = Arc<Mutex<HashMap<String, WatcherEntry>>>;

static NEXT_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Debounce window: process buffered events after 500ms of no new events
const DEBOUNCE_DURATION: Duration = Duration::from_millis(500);

/// Periodic rescan interval: emit rescan event every 5 minutes as a safety net
const RESCAN_INTERVAL: Duration = Duration::from_secs(300);

/// The folders to watch: the content directory, and each collection folder
/// outside it (one the writer set, or a glob loader's base). Only folders
/// that exist
pub(crate) fn watched_folders(
    project_root: &Path,
    content_directory: Option<&str>,
    collection_folders: &CollectionFolders,
) -> Vec<PathBuf> {
    let content_path = match content_directory {
        Some(content_dir) => project_folder(project_root, content_dir),
        None => project_root.join("src").join("content"),
    };
    let mut folders = vec![content_path];
    let collections = discover_collections(project_root, content_directory, collection_folders)
        .unwrap_or_default();
    for collection in collections {
        if !folders.iter().any(|f| collection.path.starts_with(f)) {
            folders.push(collection.path);
        }
    }
    folders.retain(|folder| folder.exists());
    folders
}

/// Create a configured file watcher for a project's content directories.
fn create_project_watcher(
    project_path: &str,
    content_directory: Option<&str>,
    collection_folders: &CollectionFolders,
) -> Result<ProjectWatcher, String> {
    let (tx, rx) = mpsc::channel();
    let project_path_log = project_path.to_string();

    let mut watcher =
        notify::recommended_watcher(move |result: Result<Event, notify::Error>| match result {
            Ok(event) => {
                if let Err(e) = tx.send(event) {
                    log::error!("Failed to send file event for {project_path_log}: {e}");
                }
            }
            Err(e) => {
                log::error!("Watch error for {project_path_log}: {e:?}");
            }
        })
        .map_err(|e| format!("Failed to create watcher: {e}"))?;

    let project_root = PathBuf::from(project_path);

    // Watch the content directory (or its override) and collection folders
    let folders = watched_folders(&project_root, content_directory, collection_folders);
    for folder in &folders {
        watcher
            .watch(folder, RecursiveMode::Recursive)
            .map_err(|e| format!("Failed to watch content directory: {e}"))?;
    }

    // Watch for schema changes: src/content/config.ts or src/content.config.ts
    for config_path in [
        project_root.join("src").join("content").join("config.ts"),
        project_root.join("src").join("content.config.ts"),
    ] {
        if config_path.exists() {
            watcher
                .watch(&config_path, RecursiveMode::NonRecursive)
                .map_err(|e| format!("Failed to watch config file: {e}"))?;
        }
    }

    // Watch the generated JSON schemas directory: .astro/collections/. If it
    // doesn't exist yet, the event loop adds it once it appears
    let schemas_path = schemas_dir(project_path);
    let watches_schemas = schemas_path.exists();
    if watches_schemas {
        watcher
            .watch(&schemas_path, RecursiveMode::NonRecursive)
            .map_err(|e| format!("Failed to watch schemas directory: {e}"))?;
    }

    Ok(ProjectWatcher {
        watcher,
        rx,
        watches_schemas,
        folders,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn start_watching_project(app: AppHandle, project_path: String) -> Result<(), String> {
    start_watching_project_with_content_dir(app, project_path, None, None)
        .await
        .map(|_| ())
}

#[tauri::command]
#[specta::specta]
pub async fn start_watching_project_with_content_dir(
    app: AppHandle,
    project_path: String,
    content_directory: Option<String>,
    collection_directories: Option<HashMap<String, String>>,
) -> Result<u32, String> {
    let collection_folders = collection_directories.unwrap_or_default();
    let ProjectWatcher {
        watcher,
        rx,
        watches_schemas,
        folders: watched,
    } = create_project_watcher(
        &project_path,
        content_directory.as_deref(),
        &collection_folders,
    )?;
    let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);

    // Store the watcher so it doesn't get dropped. This replaces (and drops) any
    // earlier watcher for the same path, whose event loop then ends.
    let watcher_map: State<WatcherMap> = app.state();
    watcher_map.lock().unwrap().insert(
        project_path.clone(),
        WatcherEntry {
            generation,
            watcher,
        },
    );

    // Clone the Arc for the spawned task
    let watcher_map_arc = app.state::<WatcherMap>().inner().clone();
    let app_handle = app.clone();

    tokio::spawn(async move {
        run_event_loop(
            app_handle,
            watcher_map_arc,
            rx,
            project_path,
            ContentFolders {
                content_directory,
                collection_folders,
                watched,
            },
            generation,
            watches_schemas,
        )
        .await;
    });

    // Handed back so a stop can name this instance (see `stop_watching_project`)
    Ok(generation as u32)
}

/// Where a project's content is, kept to rebuild its watcher
struct ContentFolders {
    content_directory: Option<String>,
    collection_folders: CollectionFolders,
    /// The folders being watched now
    watched: Vec<PathBuf>,
}

/// Event processing loop with automatic recovery and periodic rescan.
///
/// Uses `recv_timeout` with the debounce duration so that:
/// - Events are buffered and processed after 500ms of quiet
/// - Every 5 minutes, a rescan event is emitted as a safety net for missed changes
/// - If the watcher dies (channel disconnects), it's automatically rebuilt
/// - If it was stopped or replaced by a newer start (which also disconnects the
///   channel), the loop ends
/// - Until `.astro/collections/` exists, each wake checks for it, then watches it
///   and reloads the schemas
async fn run_event_loop(
    app: AppHandle,
    watcher_map: WatcherMap,
    mut rx: Receiver<Event>,
    project_path: String,
    mut folders: ContentFolders,
    generation: u64,
    mut watches_schemas: bool,
) {
    let mut event_buffer: Vec<Event> = Vec::new();
    let mut last_rescan = Instant::now();

    loop {
        match rx.recv_timeout(DEBOUNCE_DURATION) {
            Ok(event) => {
                event_buffer.push(event);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // Debounce timeout — process any buffered events
                if !event_buffer.is_empty() {
                    let schema_changed = process_events(&app, &mut event_buffer).await;
                    event_buffer.clear();
                    // A collection's folder may have moved with the config
                    if schema_changed {
                        rewatch_folders(&watcher_map, &project_path, generation, &mut folders);
                    }
                }

                if !watches_schemas {
                    watches_schemas =
                        watch_new_schemas_dir(&app, &watcher_map, &project_path, generation);
                }

                // Periodic rescan as safety net for missed changes
                if last_rescan.elapsed() >= RESCAN_INTERVAL {
                    log::debug!("Periodic rescan for {project_path}");
                    let _ = app.emit("watcher-rescan", &project_path);
                    last_rescan = Instant::now();
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                // Process remaining events, then rebuild if the watcher died
                if !event_buffer.is_empty() {
                    process_events(&app, &mut event_buffer).await;
                    event_buffer.clear();
                }

                // Stopping or replacing a watcher drops it, which also disconnects
                // the channel, so only rebuild if this loop still owns the entry
                let owns_entry = |watchers: &HashMap<String, WatcherEntry>| {
                    watchers
                        .get(&project_path)
                        .is_some_and(|entry| entry.generation == generation)
                };
                if !owns_entry(&watcher_map.lock().unwrap()) {
                    log::debug!("File watcher for {project_path} was stopped or replaced");
                    break;
                }

                log::warn!("File watcher disconnected for {project_path}, attempting rebuild");

                // Built without holding the lock, so a slow path can't block
                // starting or stopping other projects' watchers
                let rebuilt = match create_project_watcher(
                    &project_path,
                    folders.content_directory.as_deref(),
                    &folders.collection_folders,
                ) {
                    Ok(built) => built,
                    Err(e) => {
                        log::error!("Failed to rebuild file watcher for {project_path}: {e}");
                        let _ = app.emit("watcher-error", &project_path);
                        break;
                    }
                };
                {
                    let mut watchers = watcher_map.lock().unwrap();
                    // A start or stop may have happened while the watcher was built
                    if !owns_entry(&watchers) {
                        log::debug!("File watcher for {project_path} was stopped or replaced");
                        break;
                    }
                    watchers.insert(
                        project_path.clone(),
                        WatcherEntry {
                            generation,
                            watcher: rebuilt.watcher,
                        },
                    );
                }
                rx = rebuilt.rx;
                watches_schemas = rebuilt.watches_schemas;
                folders.watched = rebuilt.folders;
                last_rescan = Instant::now();
                log::info!("File watcher rebuilt for {project_path}");
                let _ = app.emit("watcher-rebuilt", &project_path);
            }
        }
    }
}

/// Watch `.astro/collections/` if it has appeared since the watcher started (a
/// project's first `astro sync`), and reload the schemas it now holds. Returns
/// whether it's watched.
fn watch_new_schemas_dir(
    app: &AppHandle,
    watcher_map: &WatcherMap,
    project_path: &str,
    generation: u64,
) -> bool {
    let schemas_path = schemas_dir(project_path);
    if !schemas_path.exists() {
        return false;
    }

    let mut watchers = watcher_map.lock().unwrap();
    // A stopped or replaced watcher is no longer this loop's to change
    let Some(entry) = watchers
        .get_mut(project_path)
        .filter(|entry| entry.generation == generation)
    else {
        return false;
    };
    if let Err(e) = entry
        .watcher
        .watch(&schemas_path, RecursiveMode::NonRecursive)
    {
        log::warn!("Failed to watch new schemas directory for {project_path}: {e}");
        return false;
    }

    log::info!("Watching new schemas directory for {project_path}");
    let _ = app.emit("schema-changed", ());
    true
}

#[tauri::command]
#[specta::specta]
/// With `watcher_id` (what the start returned) only that instance is stopped: a
/// late stop for a start that was replaced meanwhile (the same site opened
/// again) leaves the newer watcher running. Without it, whatever watches the
/// project is stopped.
pub async fn stop_watching_project(
    app: AppHandle,
    project_path: String,
    watcher_id: Option<u32>,
) -> Result<(), String> {
    let watcher_map: State<WatcherMap> = app.state();
    let mut watchers = watcher_map.lock().unwrap();
    remove_watcher(&mut watchers, &project_path, watcher_id)
}

fn remove_watcher(
    watchers: &mut HashMap<String, WatcherEntry>,
    project_path: &str,
    watcher_id: Option<u32>,
) -> Result<(), String> {
    match (watchers.get(project_path), watcher_id) {
        // That instance is gone already, or was replaced by a newer one
        (None, Some(_)) => Ok(()),
        (Some(entry), Some(id)) if entry.generation as u32 != id => Ok(()),
        (Some(_), _) => {
            watchers.remove(project_path);
            Ok(())
        }
        (None, None) => Err("No watcher found for this project".to_string()),
    }
}

/// The folders in `new` not in `old`, and those in `old` not in `new`
fn folder_changes(old: &[PathBuf], new: &[PathBuf]) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let added = new.iter().filter(|f| !old.contains(f)).cloned().collect();
    let removed = old.iter().filter(|f| !new.contains(f)).cloned().collect();
    (added, removed)
}

/// After the content config changes, watch the collections' folders as they
/// are now: a glob loader's base may have been edited
fn rewatch_folders(
    watcher_map: &WatcherMap,
    project_path: &str,
    generation: u64,
    folders: &mut ContentFolders,
) {
    let now = watched_folders(
        Path::new(project_path),
        folders.content_directory.as_deref(),
        &folders.collection_folders,
    );
    let (added, removed) = folder_changes(&folders.watched, &now);
    if added.is_empty() && removed.is_empty() {
        return;
    }

    let mut watchers = watcher_map.lock().unwrap();
    // A stopped or replaced watcher is no longer this loop's to change
    let Some(entry) = watchers
        .get_mut(project_path)
        .filter(|entry| entry.generation == generation)
    else {
        return;
    };
    let watcher = std::cell::RefCell::new(&mut entry.watcher);
    folders.watched = apply_folder_changes(
        &folders.watched,
        &added,
        &removed,
        |folder| {
            watcher
                .borrow_mut()
                .watch(folder, RecursiveMode::Recursive)
                .map_err(|e| e.to_string())
        },
        |folder| {
            let _ = watcher.borrow_mut().unwatch(folder);
        },
    );
    log::info!("Watching the collection folders of {project_path} again after a config change");
}

/// Stop watching `removed` and start watching `added`, and return the folders
/// watched after: one that fails to be watched isn't counted, so it's tried
/// again after the next config change
fn apply_folder_changes(
    watched: &[PathBuf],
    added: &[PathBuf],
    removed: &[PathBuf],
    mut watch: impl FnMut(&Path) -> Result<(), String>,
    mut unwatch: impl FnMut(&Path),
) -> Vec<PathBuf> {
    for folder in removed {
        unwatch(folder);
    }
    let mut now: Vec<PathBuf> = watched
        .iter()
        .filter(|folder| !removed.contains(folder))
        .cloned()
        .collect();
    for folder in added {
        match watch(folder) {
            Ok(()) => now.push(folder.clone()),
            Err(e) => log::warn!("Failed to watch {}: {e}", folder.display()),
        }
    }
    now
}

/// Tell the frontend about changed files. Whether a schema file changed
async fn process_events(app: &AppHandle, events: &mut [Event]) -> bool {
    let mut schema_changed = false;

    for event in events.iter() {
        match &event.kind {
            EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) => {
                for path in &event.paths {
                    // Check if it's a schema-related file
                    if is_schema_file(path) {
                        schema_changed = true;
                        continue;
                    }

                    // Check if it's a markdown file
                    if let Some(extension) = path.extension() {
                        if matches!(extension.to_str(), Some("md") | Some("mdx")) {
                            // Emit event to frontend with normalized path
                            let normalized_path =
                                crate::utils::path::normalize_path_for_serialization(path);
                            if let Err(e) = app.emit(
                                "file-changed",
                                FileChangeEvent {
                                    path: normalized_path,
                                    kind: format!("{:?}", event.kind),
                                },
                            ) {
                                eprintln!("Failed to emit file change event: {e}");
                            }
                        }
                    }
                }
            }
            // Other event kinds (e.g. Access, Any) are ignored
            _ => {}
        }
    }

    // Emit schema-changed event once if any schema files changed
    if schema_changed {
        if let Err(e) = app.emit("schema-changed", ()) {
            eprintln!("Failed to emit schema change event: {e}");
        }
    }
    schema_changed
}

/// Check if a file path is a schema-related file
fn is_schema_file(path: &std::path::Path) -> bool {
    // Normalize path to forward slashes for consistent cross-platform matching
    let path_str = crate::utils::path::normalize_path_for_serialization(path);

    // Check for content config files
    if path_str.ends_with("src/content/config.ts") || path_str.ends_with("src/content.config.ts") {
        return true;
    }

    // Check for generated JSON schema files
    if path_str.contains(".astro/collections/") && path_str.ends_with(".schema.json") {
        return true;
    }

    false
}

#[derive(serde::Serialize, Clone)]
struct FileChangeEvent {
    path: String,
    kind: String,
}

// Initialize the watcher map when the app starts
pub fn init_watcher_state() -> WatcherMap {
    Arc::new(Mutex::new(HashMap::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(generation: u64) -> WatcherEntry {
        WatcherEntry {
            generation,
            watcher: notify::recommended_watcher(|_| {}).unwrap(),
        }
    }

    #[test]
    fn stopping_names_the_instance_so_a_newer_watcher_survives() {
        let mut watchers = HashMap::new();
        watchers.insert("/s/a".to_string(), entry(7));

        // A late stop for the replaced start (6) leaves the newer one (7)
        assert_eq!(remove_watcher(&mut watchers, "/s/a", Some(6)), Ok(()));
        assert!(watchers.contains_key("/s/a"));

        // Stopping the right instance, or any (None), removes it
        assert_eq!(remove_watcher(&mut watchers, "/s/a", Some(7)), Ok(()));
        assert!(watchers.is_empty());
        watchers.insert("/s/a".to_string(), entry(8));
        assert_eq!(remove_watcher(&mut watchers, "/s/a", None), Ok(()));
        assert!(watchers.is_empty());
    }

    #[test]
    fn stopping_what_is_not_there_is_an_error_only_without_an_instance() {
        let mut watchers = HashMap::new();
        assert!(remove_watcher(&mut watchers, "/s/a", None).is_err());
        assert_eq!(remove_watcher(&mut watchers, "/s/a", Some(3)), Ok(()));
    }

    #[test]
    fn watches_collection_folders_outside_the_content_directory() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        std::fs::create_dir_all(root.join("src/content/blog")).unwrap();
        std::fs::create_dir_all(root.join("src/content/notes")).unwrap();
        std::fs::create_dir_all(root.join("writing")).unwrap();

        let overrides: CollectionFolders = [("blog".to_string(), "writing".to_string())]
            .into_iter()
            .collect();
        let folders = watched_folders(root, None, &overrides);

        assert_eq!(
            folders,
            vec![root.join("src/content"), root.join("writing")]
        );
    }

    #[test]
    fn watches_a_glob_loader_base_outside_the_content_directory() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        std::fs::create_dir_all(root.join("src/content")).unwrap();
        std::fs::create_dir_all(root.join("posts")).unwrap();
        std::fs::write(
            root.join("src/content.config.ts"),
            "const blog = defineCollection({ loader: glob({ base: './posts', pattern: '*.md' }) });\nexport const collections = { blog };\n",
        )
        .unwrap();

        let folders = watched_folders(root, None, &CollectionFolders::new());
        assert_eq!(folders, vec![root.join("src/content"), root.join("posts")]);
    }

    #[test]
    fn folder_changes_lists_folders_to_start_and_stop_watching() {
        let a = PathBuf::from("/site/src/content");
        let b = PathBuf::from("/site/posts");
        let c = PathBuf::from("/site/writing");
        let (added, removed) = folder_changes(&[a.clone(), b.clone()], &[a.clone(), c.clone()]);
        assert_eq!(added, vec![c]);
        assert_eq!(removed, vec![b]);
        assert_eq!(
            folder_changes(std::slice::from_ref(&a), std::slice::from_ref(&a)),
            (vec![], vec![])
        );
    }

    #[test]
    fn a_folder_that_fails_to_be_watched_is_not_recorded_as_watched() {
        let a = PathBuf::from("/site/src/content");
        let b = PathBuf::from("/site/posts");
        let c = PathBuf::from("/site/writing");
        let d = PathBuf::from("/site/gone");

        let watched = apply_folder_changes(
            &[a.clone(), b.clone()],
            &[c.clone(), d.clone()],
            std::slice::from_ref(&b),
            |folder| {
                if folder == d {
                    Err("no such folder".to_string())
                } else {
                    Ok(())
                }
            },
            |_| {},
        );

        assert_eq!(watched, vec![a, c]);
    }

    #[test]
    fn editing_a_loader_base_changes_the_folders_watched() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        std::fs::create_dir_all(root.join("src/content")).unwrap();
        std::fs::create_dir_all(root.join("posts")).unwrap();
        std::fs::create_dir_all(root.join("writing")).unwrap();
        let config = |base: &str| {
            format!(
                "const blog = defineCollection({{ loader: glob({{ base: '{base}', pattern: '*.md' }}) }});\nexport const collections = {{ blog }};\n"
            )
        };
        std::fs::write(root.join("src/content.config.ts"), config("./posts")).unwrap();
        let before = watched_folders(root, None, &CollectionFolders::new());

        std::fs::write(root.join("src/content.config.ts"), config("./writing")).unwrap();
        let after = watched_folders(root, None, &CollectionFolders::new());

        assert_eq!(
            folder_changes(&before, &after),
            (vec![root.join("writing")], vec![root.join("posts")])
        );
    }

    #[test]
    fn watches_only_the_content_directory_without_overrides() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        std::fs::create_dir_all(root.join("src/content/blog")).unwrap();

        let folders = watched_folders(root, None, &CollectionFolders::new());
        assert_eq!(folders, vec![root.join("src/content")]);
    }
}
