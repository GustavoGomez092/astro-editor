//! Where previews are kept: `previews/` in the app's local data folder, one
//! screenshot per project (`<project id>.jpg`, taken when the file was
//! written) and a cached thumbnail of its share image
//! (`<project id>.share-<modified>-<size>.jpg`, so a changed image is redone).

use super::{thumb, PreviewKind, ProjectPreview};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub struct Store {
    dir: PathBuf,
}

/// Project IDs are filename-safe already (`project-registry/utils.ts`);
/// anything else is refused so an ID can never name a path
fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn iso_time(time: SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Writes to a temporary file of its own and renames it into place, so a
/// preview is whole or absent, even with two saves at once
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("no folder for the preview")?;
    fs::create_dir_all(dir).map_err(|e| format!("Couldn't save the preview: {e}"))?;
    crate::commands::files::write_atomically(path, bytes)
        .map_err(|e| format!("Couldn't save the preview: {e}"))
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn screenshot_path(&self, id: &str) -> Option<PathBuf> {
        is_safe_id(id).then(|| self.dir.join(format!("{id}.jpg")))
    }

    /// Stores a project's screenshot (a JPEG), replacing the last one
    pub fn save_screenshot(&self, id: &str, jpeg: &[u8]) -> Result<ProjectPreview, String> {
        let path = self
            .screenshot_path(id)
            .ok_or_else(|| format!("Can't store a preview for the project ID {id}"))?;
        write_atomic(&path, jpeg)?;
        self.screenshot(id)
            .ok_or_else(|| "Couldn't read the preview back".to_string())
    }

    /// When the project's screenshot was taken, if it has one
    pub fn taken_at(&self, id: &str) -> Option<SystemTime> {
        fs::metadata(self.screenshot_path(id)?)
            .ok()?
            .modified()
            .ok()
    }

    pub fn screenshot(&self, id: &str) -> Option<ProjectPreview> {
        let path = self.screenshot_path(id)?;
        let jpeg = fs::read(&path).ok()?;
        let taken = fs::metadata(&path).ok()?.modified().ok()?;
        Some(ProjectPreview {
            kind: PreviewKind::Screenshot,
            src: thumb::data_url(&jpeg),
            taken_at: Some(iso_time(taken)),
        })
    }

    /// A thumbnail of the share image at `source`, cached for the project when
    /// it has an ID. The cache is keyed by the image's modified time and size.
    pub fn share_thumbnail(&self, id: Option<&str>, source: &Path) -> Option<ProjectPreview> {
        let metadata = fs::metadata(source).ok()?;
        if metadata.len() > thumb::MAX_FILE_BYTES {
            log::warn!(
                "Astro Editor [PREVIEWS] {} is too big to use",
                source.display()
            );
            return None;
        }
        let preview = |jpeg: &[u8]| ProjectPreview {
            kind: PreviewKind::ShareImage,
            src: thumb::data_url(jpeg),
            taken_at: None,
        };
        let make = || {
            let bytes = fs::read(source).ok()?;
            thumb::thumbnail_jpeg(&bytes)
                .map_err(|e| log::warn!("Astro Editor [PREVIEWS] {}: {e}", source.display()))
                .ok()
        };
        let Some(id) = id.filter(|id| is_safe_id(id)) else {
            return make().map(|jpeg| preview(&jpeg));
        };
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|since| since.as_millis())
            .unwrap_or(0);
        let name = format!("{id}.share-{modified}-{}.jpg", metadata.len());
        let cached = self.dir.join(&name);
        if let Ok(jpeg) = fs::read(&cached) {
            return Some(preview(&jpeg));
        }
        let jpeg = make()?;
        self.remove_matching(|file| file.starts_with(&format!("{id}.share-")) && file != name);
        if let Err(e) = write_atomic(&cached, &jpeg) {
            log::warn!("Astro Editor [PREVIEWS] Couldn't cache {name}: {e}");
        }
        Some(preview(&jpeg))
    }

    /// Removes every preview whose project isn't in `keep`, and returns how
    /// many files went
    pub fn prune(&self, keep: &HashSet<String>) -> usize {
        self.remove_matching(|file| {
            let id = file.trim_start_matches('.').split('.').next().unwrap_or("");
            !keep.contains(id)
        })
    }

    fn remove_matching(&self, matches: impl Fn(&str) -> bool) -> usize {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return 0;
        };
        entries
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
            .filter(|entry| matches(&entry.file_name().to_string_lossy()))
            .filter(|entry| fs::remove_file(entry.path()).is_ok())
            .count()
    }
}

fn read_registry(preferences_dir: &Path) -> Option<serde_json::Value> {
    let text = fs::read_to_string(preferences_dir.join("project-registry.json")).ok()?;
    serde_json::from_str(&text).ok()
}

/// Every project ID in the registry, or `None` if it can't be read (then
/// nothing should be pruned)
pub fn registry_ids(preferences_dir: &Path) -> Option<HashSet<String>> {
    let registry = read_registry(preferences_dir)?;
    let projects = registry.get("projects")?.as_object()?;
    Some(
        projects
            .values()
            .filter_map(|project| project.get("id")?.as_str().map(str::to_string))
            .collect(),
    )
}

/// The registry's ID for the project at `project_path`
pub fn project_id(preferences_dir: &Path, project_path: &str) -> Option<String> {
    let wanted = project_path.trim_end_matches('/');
    read_registry(preferences_dir)?
        .get("projects")?
        .as_object()?
        .values()
        .find(|project| {
            project
                .get("path")
                .and_then(|path| path.as_str())
                .is_some_and(|path| path.trim_end_matches('/') == wanted)
        })?
        .get("id")?
        .as_str()
        .map(str::to_string)
}

/// The project's screenshot if it has one, else its share image, else `None`
pub fn lookup(store: &Store, preferences_dir: &Path, project_path: &str) -> Option<ProjectPreview> {
    let id = project_id(preferences_dir, project_path);
    if let Some(screenshot) = id.as_deref().and_then(|id| store.screenshot(id)) {
        return Some(screenshot);
    }
    let source = super::share::find_share_image(Path::new(project_path))?;
    store.share_thumbnail(id.as_deref(), &source)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageFormat, RgbImage};
    use std::io::Cursor;
    use tempfile::TempDir;

    struct Fixture {
        _root: TempDir,
        store: Store,
        store_dir: PathBuf,
        preferences: PathBuf,
        site: PathBuf,
    }

    fn png(width: u32, height: u32) -> Vec<u8> {
        let image =
            DynamicImage::ImageRgb8(RgbImage::from_pixel(width, height, image::Rgb([1, 2, 3])));
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, ImageFormat::Png).unwrap();
        bytes.into_inner()
    }

    fn fixture(registered: &[(&str, &str)]) -> Fixture {
        let root = TempDir::new().unwrap();
        let preferences = root.path().join("preferences");
        let store_dir = root.path().join("previews");
        let site = root.path().join("site");
        fs::create_dir_all(&preferences).unwrap();
        fs::create_dir_all(site.join("public")).unwrap();
        let projects: serde_json::Map<String, serde_json::Value> = registered
            .iter()
            .map(|(id, path)| {
                let path = path.replace("<site>", &site.to_string_lossy());
                (
                    id.to_string(),
                    serde_json::json!({ "id": id, "path": path, "name": id }),
                )
            })
            .collect();
        fs::write(
            preferences.join("project-registry.json"),
            serde_json::json!({ "projects": projects, "lastOpenedProject": null }).to_string(),
        )
        .unwrap();
        Fixture {
            store: Store::new(store_dir.clone()),
            _root: root,
            store_dir,
            preferences,
            site,
        }
    }

    fn files(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    #[test]
    fn stores_and_reads_back_a_screenshot_with_its_time() {
        let f = fixture(&[]);
        assert!(f.store.screenshot("blog").is_none());
        assert!(f.store.taken_at("blog").is_none());
        let saved = f
            .store
            .save_screenshot("blog", &[0xff, 0xd8, 0xff])
            .unwrap();
        assert_eq!(saved.kind, PreviewKind::Screenshot);
        assert_eq!(saved.src, "data:image/jpeg;base64,/9j/");
        let taken = saved.taken_at.unwrap();
        assert!(taken.ends_with('Z') && taken.contains('T'), "{taken}");
        assert!(
            f.store
                .taken_at("blog")
                .unwrap()
                .elapsed()
                .unwrap()
                .as_secs()
                < 60
        );
        assert_eq!(files(&f.store_dir), ["blog.jpg"]);
    }

    #[test]
    fn saves_at_the_same_time_never_clash() {
        let f = fixture(&[]);
        let contents: Vec<Vec<u8>> = (0..8u8).map(|n| vec![n; 2000 + usize::from(n) * 100]).collect();
        std::thread::scope(|scope| {
            for content in &contents {
                let store = &f.store;
                scope.spawn(move || {
                    for _ in 0..40 {
                        store.save_screenshot("blog", content).unwrap();
                    }
                });
            }
        });
        let saved = fs::read(f.store_dir.join("blog.jpg")).unwrap();
        assert!(contents.contains(&saved), "a whole file, not a mix");
        assert_eq!(files(&f.store_dir), ["blog.jpg"], "no temporary files left");
    }

    #[test]
    fn refuses_ids_that_could_name_a_path() {
        let f = fixture(&[]);
        for id in ["", "../x", "a/b", "a.b"] {
            assert!(f.store.save_screenshot(id, b"x").is_err(), "{id}");
        }
        assert!(files(&f.store_dir).is_empty());
    }

    #[test]
    fn finds_project_ids_by_path() {
        let f = fixture(&[("blog", "/Users/k/blog/"), ("notes", "/Users/k/notes")]);
        assert_eq!(
            project_id(&f.preferences, "/Users/k/blog").as_deref(),
            Some("blog")
        );
        assert_eq!(
            project_id(&f.preferences, "/Users/k/notes/").as_deref(),
            Some("notes")
        );
        assert_eq!(project_id(&f.preferences, "/Users/k/other"), None);
        assert_eq!(project_id(Path::new("/nowhere"), "/Users/k/blog"), None);
    }

    #[test]
    fn caches_the_share_thumbnail_until_the_image_changes() {
        let f = fixture(&[]);
        let source = f.site.join("public/og.png");
        fs::write(&source, png(1200, 630)).unwrap();
        let first = f.store.share_thumbnail(Some("blog"), &source).unwrap();
        assert_eq!(first.kind, PreviewKind::ShareImage);
        assert_eq!(first.taken_at, None);
        let cached = files(&f.store_dir);
        assert_eq!(cached.len(), 1);
        assert!(cached[0].starts_with("blog.share-"), "{cached:?}");

        // Same file: served from the cache
        assert_eq!(f.store.share_thumbnail(Some("blog"), &source), Some(first));
        assert_eq!(files(&f.store_dir), cached);

        // A new image replaces the old thumbnail
        fs::write(&source, png(1600, 900)).unwrap();
        filetime::set_file_mtime(
            &source,
            filetime::FileTime::from_unix_time(2_000_000_000, 0),
        )
        .unwrap();
        f.store.share_thumbnail(Some("blog"), &source).unwrap();
        let replaced = files(&f.store_dir);
        assert_eq!(replaced.len(), 1);
        assert_ne!(replaced, cached);
    }

    #[test]
    fn a_project_without_an_id_gets_its_share_image_uncached() {
        let f = fixture(&[]);
        let source = f.site.join("public/og.png");
        fs::write(&source, png(100, 50)).unwrap();
        assert!(f.store.share_thumbnail(None, &source).is_some());
        assert!(files(&f.store_dir).is_empty());
    }

    #[test]
    fn a_huge_share_image_file_is_never_read() {
        let f = fixture(&[]);
        let source = f.site.join("public/og.png");
        let file = fs::File::create(&source).unwrap();
        file.set_len(thumb::MAX_FILE_BYTES + 1).unwrap();
        assert_eq!(f.store.share_thumbnail(Some("blog"), &source), None);
        assert!(files(&f.store_dir).is_empty());
    }

    #[test]
    fn a_broken_share_image_gives_no_preview() {
        let f = fixture(&[]);
        let source = f.site.join("public/og.jpg");
        fs::write(&source, b"not really a jpeg").unwrap();
        assert_eq!(f.store.share_thumbnail(Some("blog"), &source), None);
        assert!(files(&f.store_dir).is_empty());
    }

    #[test]
    fn looks_up_the_screenshot_then_the_share_image() {
        let f = fixture(&[("blog", "<site>")]);
        let site = f.site.to_string_lossy().into_owned();
        assert_eq!(lookup(&f.store, &f.preferences, &site), None);

        fs::write(f.site.join("public/og.png"), png(1200, 630)).unwrap();
        let share = lookup(&f.store, &f.preferences, &site).unwrap();
        assert_eq!(share.kind, PreviewKind::ShareImage);

        f.store
            .save_screenshot("blog", &[0xff, 0xd8, 0xff])
            .unwrap();
        let screenshot = lookup(&f.store, &f.preferences, &site).unwrap();
        assert_eq!(screenshot.kind, PreviewKind::Screenshot);
    }

    #[test]
    fn prunes_previews_of_projects_no_longer_registered() {
        let f = fixture(&[("blog", "/a"), ("notes", "/b")]);
        for name in [
            "blog.jpg",
            "blog.share-1-2.jpg",
            "notes.jpg",
            "gone.jpg",
            "gone.share-1-2.jpg",
            ".gone.jpg.tmp",
        ] {
            fs::create_dir_all(&f.store_dir).unwrap();
            fs::write(f.store_dir.join(name), b"x").unwrap();
        }
        let keep = registry_ids(&f.preferences).unwrap();
        assert_eq!(f.store.prune(&keep), 3);
        assert_eq!(
            files(&f.store_dir),
            ["blog.jpg", "blog.share-1-2.jpg", "notes.jpg"]
        );
    }

    #[test]
    fn an_unreadable_registry_prunes_nothing() {
        let f = fixture(&[]);
        fs::write(f.preferences.join("project-registry.json"), "{ broken").unwrap();
        assert_eq!(registry_ids(&f.preferences), None);
        assert_eq!(registry_ids(Path::new("/nowhere")), None);
    }
}
