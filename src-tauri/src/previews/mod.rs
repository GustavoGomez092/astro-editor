//! Site previews for the Home screen: a screenshot of the site's home page as
//! it runs locally, or the site's share image until there is one. See
//! `docs/developer/site-previews.md`.

use serde::{Deserialize, Serialize};

/// The event sent with a `ProjectPreviewUpdated` whenever a stored preview changes
#[allow(dead_code)] // Emitted once the engine lands
pub const UPDATED_EVENT: &str = "project-preview-updated";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum PreviewKind {
    /// A screenshot of the site's home page
    Screenshot,
    /// The site's share image from `public/`
    ShareImage,
}

/// A site's preview image
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPreview {
    pub kind: PreviewKind,
    /// A `data:` URL of a JPEG, at most 800 px wide
    pub src: String,
    /// When the screenshot was taken (ISO 8601); null for a share image
    pub taken_at: Option<String>,
}

/// Payload of the `project-preview-updated` event
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPreviewUpdated {
    pub project_path: String,
}
