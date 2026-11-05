//! Finding a site's share image (the picture social sites show for a link),
//! which stands in for a screenshot until there is one.

use std::path::{Path, PathBuf};

/// The names a share image goes by in `public/`, most likely first
const NAMES: [&str; 4] = ["og", "opengraph-image", "social", "share"];
const EXTENSIONS: [&str; 4] = ["jpg", "jpeg", "png", "webp"];

/// The site's share image in `public/`, if it has one
pub fn find_share_image(project: &Path) -> Option<PathBuf> {
    let public = &project.join("public");
    NAMES
        .iter()
        .flat_map(|name| {
            EXTENSIONS
                .iter()
                .map(move |extension| public.join(format!("{name}.{extension}")))
        })
        .find(|path| path.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn site(files: &[&str]) -> TempDir {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join("public")).unwrap();
        for file in files {
            let path = dir.path().join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"image").unwrap();
        }
        dir
    }

    fn found(dir: &TempDir) -> Option<String> {
        find_share_image(dir.path()).map(|path| {
            path.strip_prefix(dir.path())
                .unwrap()
                .to_string_lossy()
                .into_owned()
        })
    }

    #[test]
    fn finds_nothing_without_a_share_image() {
        assert_eq!(found(&site(&["public/favicon.png", "og.jpg"])), None);
        let empty = TempDir::new().unwrap();
        assert_eq!(find_share_image(empty.path()), None);
    }

    #[test]
    fn finds_each_name_and_extension() {
        for file in [
            "public/og.jpg",
            "public/og.jpeg",
            "public/og.png",
            "public/og.webp",
            "public/opengraph-image.png",
            "public/social.jpg",
            "public/share.webp",
        ] {
            assert_eq!(found(&site(&[file])).as_deref(), Some(file));
        }
    }

    #[test]
    fn prefers_og_then_opengraph_image_then_social_then_share() {
        let dir = site(&[
            "public/share.jpg",
            "public/social.png",
            "public/opengraph-image.webp",
            "public/og.png",
        ]);
        assert_eq!(found(&dir).as_deref(), Some("public/og.png"));
        fs::remove_file(dir.path().join("public/og.png")).unwrap();
        assert_eq!(found(&dir).as_deref(), Some("public/opengraph-image.webp"));
        fs::remove_file(dir.path().join("public/opengraph-image.webp")).unwrap();
        assert_eq!(found(&dir).as_deref(), Some("public/social.png"));
    }

    #[test]
    fn ignores_a_folder_named_like_an_image() {
        let dir = site(&["public/og.jpg/inner.txt", "public/social.jpg"]);
        assert_eq!(found(&dir).as_deref(), Some("public/social.jpg"));
    }
}
