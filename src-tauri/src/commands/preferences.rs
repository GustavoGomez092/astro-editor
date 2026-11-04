use tauri::{path::BaseDirectory, Manager};

/// Opens the preferences folder in the system's default file manager
#[tauri::command]
#[specta::specta]
pub async fn open_preferences_folder(app: tauri::AppHandle) -> Result<(), String> {
    let app_data_dir = app
        .path()
        .resolve("", BaseDirectory::AppLocalData)
        .map_err(|e| format!("Failed to resolve app data directory: {e}"))?;

    // Ensure the directory exists
    if !app_data_dir.exists() {
        std::fs::create_dir_all(&app_data_dir)
            .map_err(|e| format!("Failed to create app data directory: {e}"))?;
    }

    // Use the opener plugin to open the folder
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        Command::new("open")
            .arg(&app_data_dir)
            .spawn()
            .map_err(|e| format!("Failed to open preferences folder: {e}"))?;
    }

    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        Command::new("explorer")
            .arg(&app_data_dir)
            .spawn()
            .map_err(|e| format!("Failed to open preferences folder: {e}"))?;
    }

    #[cfg(target_os = "linux")]
    {
        use std::process::Command;
        Command::new("xdg-open")
            .arg(&app_data_dir)
            .spawn()
            .map_err(|e| format!("Failed to open preferences folder: {e}"))?;
    }

    Ok(())
}

/// Resets all preferences by deleting the app data directory and restarting the app
#[tauri::command]
#[specta::specta]
#[allow(unreachable_code)]
pub async fn reset_all_preferences(
    app: tauri::AppHandle,
    window: tauri::Window,
) -> Result<(), String> {
    use log::info;

    let app_data_dir = app
        .path()
        .resolve("", BaseDirectory::AppLocalData)
        .map_err(|e| format!("Failed to resolve app data directory: {e}"))?;

    info!(
        "Astro Editor [PREFERENCES] Resetting all preferences - deleting: {}",
        app_data_dir.display()
    );

    // Delete the entire app data directory
    if app_data_dir.exists() {
        std::fs::remove_dir_all(&app_data_dir)
            .map_err(|e| format!("Failed to delete preferences: {e}"))?;

        info!("Astro Editor [PREFERENCES] All preferences deleted successfully");
    } else {
        info!("Astro Editor [PREFERENCES] No preferences directory found to delete");
    }

    // Restart the application
    info!("Astro Editor [PREFERENCES] Restarting application");

    // Close all windows first
    let _ = window.close();

    // Then restart the app - this will never return
    app.restart();

    // This line is unreachable but required for the function signature
    Ok(())
}

/// Resolves the folder for the user's colour theme files, creating it if needed
fn themes_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .resolve("themes", BaseDirectory::AppLocalData)
        .map_err(|e| format!("Failed to resolve themes directory: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create themes folder: {e}"))?;
    Ok(dir)
}

/// The biggest theme file we'll read. Real themes are a few KB.
const MAX_THEME_FILE_BYTES: u64 = 256 * 1024;

/// A `.json` file in the themes folder. `problem` is set when the file must not
/// be read, and says why in plain words.
#[derive(serde::Serialize, serde::Deserialize, specta::Type)]
pub struct ThemeFileEntry {
    pub name: String,
    pub problem: Option<String>,
}

/// Lists the `.json` files in a themes folder, sorted by name, checking each
/// before anything reads it: a link that leads outside the folder, or a file
/// over the size limit, comes back with a `problem` instead of being read.
fn scan_theme_dir(dir: &std::path::Path) -> Result<Vec<ThemeFileEntry>, String> {
    let canonical_dir = dir
        .canonicalize()
        .map_err(|e| format!("Failed to read themes folder: {e}"))?;
    let mut entries: Vec<ThemeFileEntry> = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| format!("Failed to read themes folder: {e}"))? {
        let Ok(entry) = entry else { continue };
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if !name.to_lowercase().ends_with(".json") || name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let problem = match path.canonicalize() {
            Err(_) => Some("The file can't be opened (a broken link?).".to_string()),
            Ok(real) if !real.starts_with(&canonical_dir) => {
                Some("The file links to a file outside the themes folder.".to_string())
            }
            Ok(real) => match std::fs::metadata(&real) {
                Ok(meta) if !meta.is_file() => continue,
                Ok(meta) if meta.len() > MAX_THEME_FILE_BYTES => Some(format!(
                    "The file is too large to be a theme (over {} KB).",
                    MAX_THEME_FILE_BYTES / 1024
                )),
                Ok(_) => None,
                Err(_) => Some("The file can't be opened.".to_string()),
            },
        };
        entries.push(ThemeFileEntry { name, problem });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

/// Lists the `.json` files in the themes folder
#[tauri::command]
#[specta::specta]
pub async fn list_theme_files(app: tauri::AppHandle) -> Result<Vec<ThemeFileEntry>, String> {
    scan_theme_dir(&themes_dir(&app)?)
}

/// Opens the themes folder in the system's file manager
#[tauri::command]
#[specta::specta]
pub async fn open_themes_folder(app: tauri::AppHandle) -> Result<(), String> {
    let dir = themes_dir(&app)?;

    #[cfg(target_os = "macos")]
    let opener = "open";
    #[cfg(target_os = "windows")]
    let opener = "explorer";
    #[cfg(target_os = "linux")]
    let opener = "xdg-open";

    std::process::Command::new(opener)
        .arg(&dir)
        .spawn()
        .map_err(|e| format!("Failed to open themes folder: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_json_files_sorted_and_skips_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("b.json"), "{}").unwrap();
        std::fs::write(dir.path().join("a.JSON"), "{}").unwrap();
        std::fs::write(dir.path().join("notes.txt"), "x").unwrap();
        std::fs::write(dir.path().join(".hidden.json"), "{}").unwrap();
        std::fs::create_dir(dir.path().join("folder.json")).unwrap();
        let names: Vec<_> = scan_theme_dir(dir.path())
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(names, vec!["a.JSON", "b.json"]);
    }

    #[test]
    fn flags_a_file_over_the_size_limit_without_reading_it() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("ok.json"), "{}").unwrap();
        std::fs::write(
            dir.path().join("big.json"),
            vec![b' '; MAX_THEME_FILE_BYTES as usize + 1],
        )
        .unwrap();
        let entries = scan_theme_dir(dir.path()).unwrap();
        assert!(entries[0].problem.as_ref().unwrap().contains("too large"));
        assert!(entries[1].problem.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn flags_a_link_to_a_file_outside_the_folder() {
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("secret.json");
        std::fs::write(&target, "{}").unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(&target, dir.path().join("link.json")).unwrap();
        std::fs::write(dir.path().join("real.json"), "{}").unwrap();
        std::os::unix::fs::symlink(dir.path().join("real.json"), dir.path().join("inside.json"))
            .unwrap();
        let entries = scan_theme_dir(dir.path()).unwrap();
        let by_name = |n: &str| entries.iter().find(|e| e.name == n).unwrap();
        assert!(by_name("link.json")
            .problem
            .as_ref()
            .unwrap()
            .contains("outside the themes folder"));
        assert!(by_name("inside.json").problem.is_none());
    }
}
