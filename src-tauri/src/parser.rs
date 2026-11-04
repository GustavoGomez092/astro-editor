//! Reads the Astro content config: finds the collections, and the `image()` and
//! `reference()` helpers in each schema.
//!
//! When it exists and parses, the generated JSON schema is the source of truth for
//! fields (see `schema_merger.rs`), and this parser only adds what the JSON loses:
//! which fields are images, and which collection a reference points to. Without
//! it, `create_complete_schema` falls back to this parser's output alone, which
//! has only those fields. Either way, it doesn't parse Zod structure. It
//! regex-matches the helper calls, then walks back through the braces to build
//! each field's dotted path. A line-based structural parser broke on
//! ordinary multi-line formatting such as `z\n  .object({ ... })`, so keep it this
//! way rather than growing it into a Zod parser.
//!
//! See `docs/developer/schema-system.md`.

use crate::models::Collection;
use regex::Regex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Finds the position of the matching closing brace for an opening brace
///
/// # Arguments
/// * `content` - The string to search
/// * `start_pos` - Position of the opening brace
/// * `open_char` - The opening character (e.g., '{', '[', '(')
/// * `close_char` - The closing character (e.g., '}', ']', ')')
///
/// # Returns
/// * `Ok(usize)` - Position of the matching closing brace (inclusive)
/// * `Err(String)` - Error if no matching brace found
///
/// # Limitations
/// This utility performs naive character counting and does NOT handle:
/// - Strings containing braces (e.g., `"{"` or `"}"`)
/// - Comments containing braces
/// - Template literals or other JavaScript string features
///
/// The current implementations also don't handle these cases, so we maintain existing behavior.
fn find_matching_closing_brace(
    content: &str,
    start_pos: usize,
    open_char: char,
    close_char: char,
) -> Result<usize, String> {
    let mut brace_count = 0;

    for (i, ch) in content[start_pos..].char_indices() {
        match ch {
            c if c == open_char => brace_count += 1,
            c if c == close_char => {
                brace_count -= 1;
                if brace_count == 0 {
                    return Ok(start_pos + i + 1);
                }
            }
            _ => {}
        }
    }

    Err(format!(
        "Unclosed braces: expected closing '{close_char}' but reached end of content"
    ))
}

/// Helper type for pattern matching approach
#[derive(Debug, Clone, PartialEq)]
enum HelperType {
    Image,
    Reference,
}

/// Represents a match of an image() or reference() helper call
#[derive(Debug, Clone)]
struct HelperMatch {
    helper_type: HelperType,
    position: usize,
    collection_name: Option<String>,
}

/// Parse Astro content config file and extract collection definitions
/// Collection folders the writer set, by collection name, relative to the
/// project root. They replace `<content directory>/<name>`
pub type CollectionFolders = HashMap<String, String>;

/// Collection folders the writer set, checked, by collection name: the
/// folder, or why it can't be used
pub type ResolvedFolders = HashMap<String, Result<PathBuf, String>>;

/// A folder given relative to the project root (`./src/blog/`, `src/blog`)
pub fn project_folder(project_path: &Path, relative: &str) -> PathBuf {
    project_path.join(tidy_folder(relative))
}

fn tidy_folder(relative: &str) -> &str {
    let mut folder = relative.trim();
    while let Some(rest) = folder.strip_prefix("./") {
        folder = rest;
    }
    folder.trim_end_matches(['/', '\\'])
}

/// The path without `.` parts and doubled separators, resolved through links
/// where it exists
fn normalized(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| {
        path.components()
            .filter(|c| !matches!(c, std::path::Component::CurDir))
            .collect()
    })
}

/// Whether two paths are the same folder: by the folder itself where both
/// exist (so `Src/Content` is `src/content` on a disk that ignores case)
fn same_folder(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let (Ok(a), Ok(b)) = (std::fs::metadata(a), std::fs::metadata(b)) {
            return a.dev() == b.dev() && a.ino() == b.ino();
        }
    }
    normalized(a) == normalized(b)
}

/// Whether `inner` is `outer` or inside it
fn within(inner: &Path, outer: &Path) -> bool {
    normalized(inner)
        .ancestors()
        .any(|ancestor| same_folder(ancestor, outer))
}

/// A folder inside the project, given relative to its root: never the root
/// itself, an absolute path, a `..` that climbs out, or (once it exists) a
/// link that leads out. The error says why, as "it …"
pub fn checked_project_folder(project_path: &Path, relative: &str) -> Result<PathBuf, String> {
    let folder = tidy_folder(relative);
    if folder.is_empty() || folder == "." {
        return Err("it's the project folder itself".to_string());
    }
    let outside = || "it isn't inside the project folder".to_string();
    let path = Path::new(folder);
    let drive_letter = folder.len() > 1 && folder.as_bytes()[1] == b':';
    if path.is_absolute() || path.has_root() || folder.starts_with('\\') || drive_letter {
        return Err(outside());
    }
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(outside());
    }

    let joined = project_path.join(folder);
    if let (Ok(real), Ok(root)) = (joined.canonicalize(), project_path.canonicalize()) {
        if real == root {
            return Err("it's the project folder itself".to_string());
        }
        if !real.starts_with(&root) {
            return Err("it links outside the project".to_string());
        }
    }
    Ok(joined)
}

/// Check each folder the writer set. One that can't be used (outside the
/// project, or the content directory itself or a folder holding it, which
/// would list every collection) is refused for its collection only
pub fn resolve_collection_folders(
    project_path: &Path,
    content_dir: &Path,
    folders: &CollectionFolders,
) -> ResolvedFolders {
    folders
        .iter()
        .map(|(name, folder)| {
            let checked = checked_project_folder(project_path, folder).and_then(|path| {
                if same_folder(&path, content_dir) {
                    Err("it's the content folder itself".to_string())
                } else if within(content_dir, &path) {
                    Err("it holds the content folder".to_string())
                } else {
                    Ok(path)
                }
            });
            (name.clone(), checked)
        })
        .collect()
}

pub fn parse_astro_config(
    project_path: &Path,
    content_directory_override: Option<&str>,
    collection_folders: &ResolvedFolders,
) -> Result<Vec<Collection>, String> {
    // Try both possible config file locations
    let config_paths = [
        project_path.join("src").join("content.config.ts"), // New format
        project_path.join("src").join("content").join("config.ts"), // Old format
    ];

    for config_path in &config_paths {
        if config_path.exists() {
            let content = std::fs::read_to_string(config_path)
                .map_err(|e| format!("Failed to read config file: {e}"))?;

            return parse_collections_with_folders(
                &content,
                project_path,
                content_directory_override,
                collection_folders,
            );
        }
    }

    Ok(vec![])
}

#[cfg(test)]
fn parse_collections_from_content(
    content: &str,
    project_path: &Path,
    content_directory_override: Option<&str>,
) -> Result<Vec<Collection>, String> {
    parse_collections_with_folders(
        content,
        project_path,
        content_directory_override,
        &ResolvedFolders::new(),
    )
}

fn parse_collections_with_folders(
    content: &str,
    project_path: &Path,
    content_directory_override: Option<&str>,
    collection_folders: &ResolvedFolders,
) -> Result<Vec<Collection>, String> {
    let mut collections = Vec::new();

    // Use override if provided, otherwise default to src/content
    let content_dir = if let Some(override_path) = content_directory_override {
        project_path.join(override_path)
    } else {
        project_path.join("src").join("content")
    };

    // Remove comments and normalize whitespace
    let clean_content = remove_comments(content);

    // Look for collections object in defineConfig
    if let Some(collections_block) = extract_collections_block(&clean_content) {
        collections.extend(parse_collection_definitions(
            &collections_block,
            &content_dir,
            &clean_content, // Pass full content for schema extraction
            project_path,
            collection_folders,
        )?);
    }

    Ok(collections)
}

fn remove_comments(content: &str) -> String {
    // Improved comment removal that handles edge cases better
    let mut result = String::new();
    let mut chars = content.chars().peekable();
    let mut in_string = false;
    let mut string_char = '"';
    let mut in_block_comment = false;
    let mut escape_next = false;

    while let Some(ch) = chars.next() {
        if escape_next {
            if !in_block_comment {
                result.push(ch);
            }
            escape_next = false;
            continue;
        }

        if in_string {
            if ch == '\\' {
                escape_next = true;
                result.push(ch);
            } else if ch == string_char {
                in_string = false;
                result.push(ch);
            } else {
                result.push(ch);
            }
            continue;
        }

        if in_block_comment {
            if ch == '*' && chars.peek() == Some(&'/') {
                chars.next(); // consume '/'
                in_block_comment = false;
            }
            continue;
        }

        match ch {
            '"' | '\'' => {
                in_string = true;
                string_char = ch;
                result.push(ch);
            }
            '/' => {
                if chars.peek() == Some(&'/') {
                    // Line comment - skip to end of line
                    chars.next(); // consume second '/'
                    for next_ch in chars.by_ref() {
                        if next_ch == '\n' {
                            result.push(next_ch);
                            break;
                        }
                    }
                } else if chars.peek() == Some(&'*') {
                    // Block comment start
                    chars.next(); // consume '*'
                    in_block_comment = true;
                } else {
                    result.push(ch);
                }
            }
            _ => result.push(ch),
        }
    }

    result
}

fn extract_collections_block(content: &str) -> Option<String> {
    // Try new format first: export const collections = { ... }
    let export_collections_re = Regex::new(r"export\s+const\s+collections\s*=\s*\{").unwrap();

    if let Some(start_match) = export_collections_re.find(content) {
        let start = start_match.end() - 1; // Include the opening brace

        // Find matching closing brace
        if let Ok(end) = find_matching_closing_brace(content, start, '{', '}') {
            return Some(content[start..end].to_string());
        }
    }

    // Fallback to old format: collections: { ... } within defineConfig
    let collections_re = Regex::new(r"collections\s*:\s*\{").unwrap();

    if let Some(start_match) = collections_re.find(content) {
        let start = start_match.end() - 1; // Include the opening brace

        // Find matching closing brace
        if let Ok(end) = find_matching_closing_brace(content, start, '{', '}') {
            return Some(content[start..end].to_string());
        }
    }

    None
}

/// The start of a `defineCollection` call whose loader is `file()`
const FILE_LOADER_CALL: &str = r"defineCollection\s*\(\s*\{\s*loader:\s*file\s*\(";

/// Detect if a collection uses a file-based loader (should be excluded from main collections list)
fn is_file_based_collection(full_content: &str, variable: &str) -> bool {
    // Look for: const/let/var collectionName = defineCollection({ loader: file(...)
    // or: collectionName: defineCollection({ loader: file(...)
    // Handles exported variables too: export const collectionName = defineCollection...
    let variable = regex::escape(variable);
    let file_loader_pattern =
        format!(r"(?:(?:const|let|var)\s+)?{variable}\s*[=:]\s*{FILE_LOADER_CALL}");
    if let Ok(file_loader_re) = Regex::new(&file_loader_pattern) {
        file_loader_re.is_match(full_content)
    } else {
        false
    }
}

/// Where an entry of the collections object defines its collection
enum CollectionBinding<'a> {
    /// `blog` or `blog: blogCollection`: a variable defined elsewhere in the file
    Variable(&'a str),
    /// `blog: defineCollection({ ... })`: the call's text
    Inline(&'a str),
}

fn is_identifier(text: &str) -> bool {
    let mut chars = text.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

/// Splits text at the commas that aren't nested inside brackets or strings
fn split_top_level_commas(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    let mut part_start = 0;

    for (i, c) in text.char_indices() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None => match c {
                '\'' | '"' | '`' => quote = Some(c),
                '(' | '[' | '{' => depth += 1,
                ')' | ']' | '}' => depth -= 1,
                ',' if depth == 0 => {
                    parts.push(&text[part_start..i]);
                    part_start = i + 1;
                }
                _ => {}
            },
        }
    }
    parts.push(&text[part_start..]);
    parts
}

/// Reads the entries of the collections object (`{ ... }`, braces included) in
/// order: `blog`, `blog: blogCollection`, `'case-studies': caseStudies` or
/// `"case-studies": defineCollection({ ... })`. Keys may be quoted because
/// collection names often contain hyphens, and a trailing comma or line breaks
/// make no difference. Entries it can't read (spreads, other expressions) are
/// skipped.
fn collection_entries(collections_block: &str) -> Vec<(String, CollectionBinding<'_>)> {
    let inner = collections_block
        .strip_prefix('{')
        .and_then(|rest| rest.strip_suffix('}'))
        .unwrap_or(collections_block);

    split_top_level_commas(inner)
        .into_iter()
        .filter_map(|entry| {
            let entry = entry.trim();
            let (key, rest, quoted) = match entry.chars().next()? {
                q @ ('\'' | '"') => {
                    let close = entry[1..].find(q)? + 1;
                    (&entry[1..close], &entry[close + 1..], true)
                }
                _ => {
                    let key_end = entry
                        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '$'))
                        .unwrap_or(entry.len());
                    (&entry[..key_end], &entry[key_end..], false)
                }
            };
            if key.is_empty() {
                return None;
            }

            let rest = rest.trim();
            let binding = if rest.is_empty() {
                // Shorthand (`blog`); a quoted key needs a value
                if quoted || !is_identifier(key) {
                    return None;
                }
                CollectionBinding::Variable(key)
            } else {
                let value = rest.strip_prefix(':')?.trim();
                if is_identifier(value) {
                    CollectionBinding::Variable(value)
                } else if value.starts_with("defineCollection") {
                    CollectionBinding::Inline(value)
                } else {
                    return None;
                }
            };
            Some((key.to_string(), binding))
        })
        .collect()
}

fn parse_collection_definitions(
    collections_block: &str,
    content_dir: &Path,
    full_content: &str,
    project_path: &Path,
    collection_folders: &ResolvedFolders,
) -> Result<Vec<Collection>, String> {
    let file_loader_call = Regex::new(&format!("^{FILE_LOADER_CALL}")).unwrap();

    // Each directory-based collection, with its usual folder and the folder
    // its glob loader names, if any
    let mut candidates = Vec::new();
    for (collection_name, binding) in collection_entries(collections_block) {
        let (file_based, schema, call) = match binding {
            CollectionBinding::Variable(variable) => (
                is_file_based_collection(full_content, variable),
                extract_basic_schema(full_content, variable),
                define_collection_call(full_content, variable),
            ),
            CollectionBinding::Inline(call) => (
                file_loader_call.is_match(call),
                extract_schema_from_collection_block(call),
                Some(call),
            ),
        };

        // Skip file-based collections - they should only be used for references
        if file_based {
            continue;
        }

        let base = call.and_then(glob_loader_base).and_then(|base| {
            checked_project_folder(project_path, &base)
                .ok()
                .filter(|path| path.is_dir())
                .map(|path| (base, path))
        });
        let usual = content_dir.join(&collection_name);
        candidates.push((collection_name, schema, usual, base));
    }

    // A loader's base is a fallback for when the usual folder isn't there. It's
    // never used when it is or holds the content directory, or is, holds or
    // sits inside another collection's folder: it would list entries that
    // aren't this collection's
    let needs_base = |usual: &Path| !usual.is_dir();
    let mut others: Vec<(&str, &Path)> = candidates
        .iter()
        .filter(|(_, _, usual, _)| usual.is_dir())
        .map(|(name, _, usual, _)| (name.as_str(), usual.as_path()))
        .collect();
    others.extend(
        collection_folders
            .iter()
            .filter_map(|(name, folder)| Some((name.as_str(), folder.as_ref().ok()?.as_path()))),
    );
    others.extend(
        candidates
            .iter()
            .filter(|(_, _, usual, _)| needs_base(usual))
            .filter_map(|(name, _, _, base)| {
                base.as_ref()
                    .map(|(_, path)| (name.as_str(), path.as_path()))
            }),
    );
    let base_is_free = |name: &str, path: &Path| {
        !within(content_dir, path)
            && others
                .iter()
                .filter(|(other, _)| *other != name)
                .all(|(_, folder)| !within(path, folder) && !within(folder, path))
    };

    let mut collections = Vec::new();
    for (collection_name, schema, usual, base) in &candidates {
        // The folder found automatically: the usual one, or the loader's base
        let (automatic, loader_base) = match base {
            Some((base, path)) if needs_base(usual) && base_is_free(collection_name, path) => {
                (path.clone(), Some(base.clone()))
            }
            _ => (usual.clone(), None),
        };
        let mut collection = place_collection(
            Collection::new(collection_name.clone(), automatic),
            project_path,
            collection_folders,
        );
        if collection.path.is_dir() {
            collection.schema = schema.clone();
            collection.loader_base = loader_base;
            collections.push(collection);
        }
    }

    Ok(collections)
}

/// Move a collection found at its automatic folder to the folder the writer
/// set, when there's one and it's there. When it isn't there, the collection
/// stays where it was found and says which folder was missing
pub fn place_collection(
    mut collection: Collection,
    project_path: &Path,
    collection_folders: &ResolvedFolders,
) -> Collection {
    match collection_folders.get(&collection.name) {
        Some(Ok(folder)) if folder.is_dir() => {
            let automatic = std::mem::replace(&mut collection.path, folder.clone());
            collection.automatic_path = Some(automatic);
        }
        Some(Ok(folder)) => {
            let relative = folder.strip_prefix(project_path).unwrap_or(folder);
            collection.missing_folder = Some(relative.to_string_lossy().replace('\\', "/"));
        }
        Some(Err(reason)) => collection.refused_folder = Some(reason.clone()),
        None => {}
    }
    collection
}

/// The text of the `defineCollection(...)` call a variable holds
fn define_collection_call<'a>(content: &'a str, variable: &str) -> Option<&'a str> {
    let variable = regex::escape(variable);
    let re = Regex::new(&format!(
        r"(?:(?:const|let|var)\s+){variable}\s*=\s*defineCollection\s*\("
    ))
    .ok()?;
    let found = re.find(content)?;
    let end = find_matching_closing_brace(content, found.end() - 1, '(', ')').ok()?;
    Some(&content[found.start()..end])
}

/// The `base` folder of a collection's `glob()` loader when it's written as
/// a plain string, as given (`./writing/posts`). None when its `pattern`
/// isn't a plain string or names a folder (`posts/*.md`), since then the
/// entries aren't simply the files under the base
fn glob_loader_base(call: &str) -> Option<String> {
    let glob_start = Regex::new(r"\bglob\s*\(").unwrap().find(call)?;
    let end = find_matching_closing_brace(call, glob_start.end() - 1, '(', ')').ok()?;
    let options = &call[glob_start.end()..end];
    let string_option = |key: &str| {
        let re = Regex::new(&format!(
            r#"\b{key}\s*:\s*(?:'([^']*)'|"([^"]*)"|`([^`$]*)`)"#
        ))
        .unwrap();
        let captures = re.captures(options)?;
        captures
            .get(1)
            .or_else(|| captures.get(2))
            .or_else(|| captures.get(3))
            .map(|m| m.as_str().to_string())
    };

    // The pattern: a string, or an array of strings
    let patterns = match string_option("pattern") {
        Some(pattern) => vec![pattern],
        None => {
            let array = Regex::new(r"\bpattern\s*:\s*\[([^\]]*)\]").unwrap();
            let entries = array.captures(options)?.get(1)?.as_str().to_string();
            let item = Regex::new(r#"^\s*(?:'([^']*)'|"([^"]*)"|`([^`$]*)`)\s*$"#).unwrap();
            entries
                .split(',')
                .filter(|entry| !entry.trim().is_empty())
                .map(|entry| {
                    let captures = item.captures(entry)?;
                    captures
                        .get(1)
                        .or_else(|| captures.get(2))
                        .or_else(|| captures.get(3))
                        .map(|m| m.as_str().to_string())
                })
                .collect::<Option<Vec<_>>>()?
        }
    };
    if patterns
        .iter()
        .any(|pattern| pattern_names_a_folder(pattern))
    {
        return None;
    }
    string_option("base")
}

/// Whether a glob pattern picks files from a named folder (`posts/*.md`):
/// a `/` comes before any glob character
fn pattern_names_a_folder(pattern: &str) -> bool {
    let pattern = tidy_folder_prefix(pattern);
    let glob = pattern
        .find(['*', '?', '[', '{', '!'])
        .unwrap_or(pattern.len());
    pattern.find('/').is_some_and(|slash| slash < glob)
}

fn tidy_folder_prefix(pattern: &str) -> &str {
    let mut pattern = pattern.trim();
    while let Some(rest) = pattern.strip_prefix("./") {
        pattern = rest;
    }
    pattern
}

fn extract_basic_schema(content: &str, collection_name: &str) -> Option<String> {
    // Try both formats:
    // 1. const blog = defineCollection(...)
    // 2. blog: defineCollection(...)
    let collection_name = regex::escape(collection_name);
    let const_pattern = format!(r"const\s+{collection_name}\s*=\s*defineCollection\s*\(");
    let object_pattern = format!(r"{collection_name}\s*:\s*defineCollection\s*\(");

    let const_re = Regex::new(&const_pattern).unwrap();
    let object_re = Regex::new(&object_pattern).unwrap();

    let start_match = const_re.find(content).or_else(|| object_re.find(content));

    if let Some(start_match) = start_match {
        // Find the matching closing parenthesis for defineCollection(...)
        let start = start_match.end() - 1; // Position of the opening parenthesis

        if let Ok(end) = find_matching_closing_brace(content, start, '(', ')') {
            let collection_block = &content[start_match.start()..end];

            // Now extract schema from within this block
            return extract_schema_from_collection_block(collection_block);
        }
    }

    None
}

fn extract_schema_from_collection_block(collection_block: &str) -> Option<String> {
    // Look for z.object({ ... }) within the collection block
    let schema_start_re = Regex::new(r"z\.object\s*\(\s*\{").unwrap();

    if let Some(start_match) = schema_start_re.find(collection_block) {
        // Find the matching closing brace for the object
        let start = start_match.end() - 1; // Position of the opening brace

        if let Ok(end) = find_matching_closing_brace(collection_block, start, '{', '}') {
            let schema_text = &collection_block[start + 1..end - 1].trim(); // +1 to skip opening brace, -1 to skip closing brace
            return parse_schema_fields(schema_text);
        }
    }

    None
}

fn parse_schema_fields(schema_text: &str) -> Option<String> {
    extract_zod_special_fields(schema_text)
}

/// Find all image() and reference() helper calls in schema text
/// Returns positions and metadata for each helper found
fn find_helper_calls(schema_text: &str) -> Vec<HelperMatch> {
    let mut matches = Vec::new();

    // Find image() calls
    let image_re = Regex::new(r"image\s*\(\s*\)").unwrap();
    for image_match in image_re.find_iter(schema_text) {
        matches.push(HelperMatch {
            helper_type: HelperType::Image,
            position: image_match.start(),
            collection_name: None,
        });
    }

    // Find reference() calls
    let reference_re = Regex::new(r#"reference\s*\(\s*['"]([^'"]+)['"]\s*\)"#).unwrap();
    for reference_match in reference_re.captures_iter(schema_text) {
        let position = reference_match.get(0).unwrap().start();
        let collection_name = reference_match.get(1).unwrap().as_str().to_string();

        matches.push(HelperMatch {
            helper_type: HelperType::Reference,
            position,
            collection_name: Some(collection_name),
        });
    }

    matches
}

/// Find the field name by scanning backwards from a position to the nearest ':'
/// Returns the field name (identifier before the colon)
fn find_field_name_backwards(schema_text: &str, start_pos: usize) -> Option<String> {
    let chars: Vec<char> = schema_text.chars().collect();
    let mut pos = start_pos;

    // Scan backwards to find ':'
    while pos > 0 {
        if chars[pos] == ':' {
            // Found colon, now scan backwards to find the field name
            let mut field_end = pos;
            while field_end > 0 && chars[field_end - 1].is_whitespace() {
                field_end -= 1;
            }

            let mut field_start = field_end;
            while field_start > 0 {
                let ch = chars[field_start - 1];
                if ch.is_alphanumeric() || ch == '_' || ch == '$' {
                    field_start -= 1;
                } else {
                    break;
                }
            }

            if field_start < field_end {
                let field_name: String = chars[field_start..field_end].iter().collect();
                return Some(field_name);
            }
        }
        pos -= 1;
    }

    None
}

/// Check if a helper is inside a z.array() call
/// Returns true if z.array( appears between the last ':' and the helper position
fn is_inside_array(schema_text: &str, helper_position: usize) -> bool {
    // Scan backwards from helper position to find the last ':'
    let chars: Vec<char> = schema_text.chars().collect();
    let mut pos = helper_position;

    while pos > 0 {
        if chars[pos] == ':' {
            // Found the field colon, now check if z.array( appears between : and helper
            let between = &schema_text[pos..helper_position];
            return between.contains("z.array(");
        }
        pos -= 1;
    }

    false
}

/// Find the field name at the current position by scanning backwards
///
/// Returns the field name if found, or None if no field name exists at this position
fn find_immediate_field_name(schema_text: &str, position: usize) -> Option<String> {
    find_field_name_backwards(schema_text, position)
}

/// Build the parent path by traversing up through nested braces
///
/// Returns a vector of parent field names (in reverse order - innermost to outermost)
fn build_parent_path(schema_text: &str, start_position: usize, chars: &[char]) -> Vec<String> {
    let mut path_components = Vec::new();
    let mut brace_level = 0;
    let mut current_pos = start_position;

    while current_pos > 0 {
        current_pos -= 1;
        let ch = chars[current_pos];

        match ch {
            '}' => {
                brace_level += 1;
            }
            '{' => {
                brace_level -= 1;

                // When we exit to a parent level (brace_level becomes negative)
                if brace_level < 0 {
                    // Look for a parent field name before this '{'
                    if let Some(parent_field) = find_field_name_backwards(schema_text, current_pos)
                    {
                        // Make sure we haven't already added this field (avoid duplicates)
                        if path_components.last() != Some(&parent_field) {
                            path_components.push(parent_field);
                        }
                        // Reset brace level for the next parent
                        brace_level = 0;
                    } else {
                        // No parent field found, we've reached the top level
                        break;
                    }
                }
            }
            _ => {}
        }
    }

    path_components
}

/// Trace backwards from helper position to build dotted field path
///
/// Examples:
/// - Top-level: "heroImage: image()" → "heroImage"
/// - Nested: "coverImage: z.object({ image: image() })" → "coverImage.image"
/// - Deep: "meta: { author: { avatar: image() } }" → "meta.author.avatar"
fn resolve_field_path(schema_text: &str, helper_position: usize) -> Result<String, String> {
    let chars: Vec<char> = schema_text.chars().collect();

    // First, find the immediate field name for this helper
    if let Some(field_name) = find_immediate_field_name(schema_text, helper_position) {
        let mut path_components = vec![field_name];

        // Now trace backwards through brace levels to find parent fields
        let parent_fields = build_parent_path(schema_text, helper_position, &chars);
        path_components.extend(parent_fields);

        // Reverse to get the path from outermost to innermost
        path_components.reverse();
        let path = path_components.join(".");
        Ok(path)
    } else {
        Err(format!(
            "Could not find field name for helper at position {helper_position}"
        ))
    }
}

/// Extract special fields (image and reference helpers) using pattern matching
///
/// This is the main entry point. Returns the JSON that `extract_zod_enhancements`
/// and `parse_zod_schema` in `schema_merger.rs` read.
fn extract_zod_special_fields(schema_text: &str) -> Option<String> {
    // 1. Find all helper calls
    let helpers = find_helper_calls(schema_text);

    if helpers.is_empty() {
        return None;
    }

    // 2. Resolve field path for each helper
    let mut fields_json = Vec::new();

    for helper in helpers {
        match resolve_field_path(schema_text, helper.position) {
            Ok(field_path) => {
                // Check if this helper is inside an array
                let in_array = is_inside_array(schema_text, helper.position);

                // Create field JSON based on helper type and array context
                let field_json = if in_array {
                    // Array field
                    match helper.helper_type {
                        HelperType::Image => {
                            serde_json::json!({
                                "name": field_path,
                                "type": "Array",
                                "arrayType": "Image",
                                "optional": true,
                                "default": null,
                                "constraints": {}
                            })
                        }
                        HelperType::Reference => {
                            serde_json::json!({
                                "name": field_path,
                                "type": "Array",
                                "arrayType": "Reference",
                                "arrayReferenceCollection": helper.collection_name.unwrap_or_default(),
                                "optional": true,
                                "default": null,
                                "constraints": {}
                            })
                        }
                    }
                } else {
                    // Non-array field
                    match helper.helper_type {
                        HelperType::Image => {
                            serde_json::json!({
                                "name": field_path,
                                "type": "Image",
                                "optional": true,
                                "default": null,
                                "constraints": {}
                            })
                        }
                        HelperType::Reference => {
                            serde_json::json!({
                                "name": field_path,
                                "type": "Reference",
                                "referencedCollection": helper.collection_name.unwrap_or_default(),
                                "optional": true,
                                "default": null,
                                "constraints": {}
                            })
                        }
                    }
                };

                fields_json.push(field_json);
            }
            Err(_) => {
                // Skip this field - it will be treated as whatever JSON schema says
            }
        }
    }

    // 3. Serialize to JSON (same format as before)
    if !fields_json.is_empty() {
        let schema_json = serde_json::json!({
            "type": "zod",
            "fields": fields_json
        });

        return Some(schema_json.to_string());
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    // --- UNIT TESTS FOR BRACE MATCHING UTILITY ---

    #[test]
    fn test_find_matching_closing_brace_simple() {
        let content = "{ foo }";
        let result = find_matching_closing_brace(content, 0, '{', '}');
        assert!(result.is_ok(), "Should find matching brace");
        assert_eq!(
            result.unwrap(),
            7,
            "Should point to position after closing brace"
        );
    }

    #[test]
    fn test_find_matching_closing_brace_nested() {
        let content = "{ { } }";
        let result = find_matching_closing_brace(content, 0, '{', '}');
        assert!(
            result.is_ok(),
            "Should find matching brace for nested structure"
        );
        assert_eq!(
            result.unwrap(),
            7,
            "Should point to outermost closing brace"
        );
    }

    #[test]
    fn test_find_matching_closing_brace_deep_nested() {
        let content = "{ { { } } }";
        let result = find_matching_closing_brace(content, 0, '{', '}');
        assert!(
            result.is_ok(),
            "Should find matching brace for deeply nested structure"
        );
        assert_eq!(
            result.unwrap(),
            11,
            "Should point to outermost closing brace"
        );
    }

    #[test]
    fn test_find_matching_closing_brace_with_content() {
        let content = r#"{ foo: "bar", baz: 123 }"#;
        let result = find_matching_closing_brace(content, 0, '{', '}');
        assert!(result.is_ok(), "Should find matching brace with content");
        assert_eq!(
            result.unwrap(),
            24,
            "Should point to position after closing brace"
        );
    }

    #[test]
    fn test_find_matching_closing_brace_empty() {
        let content = "{}";
        let result = find_matching_closing_brace(content, 0, '{', '}');
        assert!(result.is_ok(), "Should find matching brace for empty block");
        assert_eq!(
            result.unwrap(),
            2,
            "Should point to position after closing brace"
        );
    }

    #[test]
    fn test_find_matching_closing_brace_unmatched() {
        let content = "{ { }";
        let result = find_matching_closing_brace(content, 0, '{', '}');
        assert!(result.is_err(), "Should return error for unmatched braces");
        assert!(
            result.unwrap_err().contains("Unclosed braces"),
            "Error message should mention unclosed braces"
        );
    }

    #[test]
    fn test_find_matching_closing_brace_parentheses() {
        let content = "( foo ( bar ) )";
        let result = find_matching_closing_brace(content, 0, '(', ')');
        assert!(result.is_ok(), "Should work with parentheses");
        assert_eq!(
            result.unwrap(),
            15,
            "Should point to position after closing parenthesis"
        );
    }

    #[test]
    fn test_find_matching_closing_brace_brackets() {
        let content = "[ [ 1, 2 ], [ 3, 4 ] ]";
        let result = find_matching_closing_brace(content, 0, '[', ']');
        assert!(result.is_ok(), "Should work with square brackets");
        assert_eq!(
            result.unwrap(),
            22,
            "Should point to position after closing bracket"
        );
    }

    #[test]
    fn test_find_matching_closing_brace_real_world_example() {
        let content = r#"{ blog: defineCollection({ schema: z.object({ title: z.string() }) }) }"#;
        let result = find_matching_closing_brace(content, 0, '{', '}');
        assert!(
            result.is_ok(),
            "Should work with real-world nested structure"
        );
        assert_eq!(result.unwrap(), 71, "Should find outermost closing brace");
    }

    // --- END BRACE MATCHING UTILITY TESTS ---

    #[test]
    fn test_parse_simple_config() {
        let content = r#"
import { defineConfig, defineCollection, z } from 'astro:content';

export default defineConfig({
  collections: {
    blog: defineCollection({
      type: 'content',
      schema: z.object({
        title: z.string(),
        description: z.string().optional(),
        pubDate: z.coerce.date(),
        draft: z.boolean().default(false),
      }),
    }),
  },
});
"#;

        let temp_dir = std::env::temp_dir().join("test-astro-parser");
        let project_path = temp_dir.join("project");
        let blog_path = project_path.join("src").join("content").join("blog");

        fs::create_dir_all(&blog_path).unwrap();

        let result = parse_collections_from_content(content, &project_path, None);
        assert!(result.is_ok());

        let collections = result.unwrap();
        assert_eq!(collections.len(), 1);
        assert_eq!(collections[0].name, "blog");
        // Schema is None because there are no image() or reference() helpers
        assert!(collections[0].schema.is_none());

        // Clean up
        fs::remove_dir_all(&temp_dir).ok();
    }

    #[test]
    fn test_empty_config() {
        let content = r#"
export default defineConfig({
  collections: {},
});
"#;
        let project_path = PathBuf::from("/tmp/empty-project");
        let result = parse_collections_from_content(content, &project_path, None);
        assert!(result.is_ok());
        assert_eq!(result.unwrap().len(), 0);
    }

    #[test]
    fn test_extract_collections_block() {
        let content = r#"
export default defineConfig({
  collections: {
    blog: defineCollection({ schema: z.object({}) }),
    notes: defineCollection({ schema: z.object({}) }),
  },
  other: "value"
});
"#;
        let block = extract_collections_block(content);
        assert!(block.is_some());
        let block_content = block.unwrap();
        assert!(block_content.contains("blog"));
        assert!(block_content.contains("notes"));
    }

    #[test]
    fn test_extract_collections_block_export_const() {
        // New format used in our tests
        let content = r#"
export const collections = {
  test: defineCollection({
    schema: ({ image }) => z.object({
      hero: image(),
    }),
  }),
};
"#;
        let block = extract_collections_block(content);
        assert!(block.is_some(), "Should extract collections block");
        let block_content = block.unwrap();
        assert!(
            block_content.contains("test"),
            "Should contain 'test' collection"
        );
        assert!(
            block_content.contains("defineCollection"),
            "Should contain defineCollection"
        );
    }

    #[test]
    fn test_full_parse_with_image_helper() {
        // This is the EXACT content from test_find_top_level_image
        let content = r#"
export const collections = {
  test: defineCollection({
    schema: ({ image }) => z.object({
      hero: image(),
      title: z.string(),
    }),
  }),
};
"#;
        let temp_dir = std::env::temp_dir().join("test-full-parse-image");
        let project_path = temp_dir.join("project");
        let test_path = project_path.join("src").join("content").join("test");

        fs::create_dir_all(&test_path).unwrap();

        let result = parse_collections_from_content(content, &project_path, None);
        assert!(result.is_ok(), "Should parse successfully");

        let collections = result.unwrap();
        assert_eq!(collections.len(), 1, "Should find 1 collection");
        assert_eq!(collections[0].name, "test");
        assert!(
            collections[0].schema.is_some(),
            "Should have schema with image helper"
        );

        // Clean up
        fs::remove_dir_all(&temp_dir).ok();
    }

    // --- `export const collections = { ... }` FORMS ---

    /// Makes `src/content/<name>` for each collection and parses `config`
    fn parse_with_dirs(config: &str, dirs: &[&str]) -> Vec<Collection> {
        let temp = tempfile::tempdir().unwrap();
        for dir in dirs {
            fs::create_dir_all(temp.path().join("src").join("content").join(dir)).unwrap();
        }
        parse_collections_from_content(config, temp.path(), None).unwrap()
    }

    fn names(collections: &[Collection]) -> Vec<&str> {
        collections.iter().map(|c| c.name.as_str()).collect()
    }

    fn has_image_field(collection: &Collection, field: &str) -> bool {
        let schema: serde_json::Value =
            serde_json::from_str(collection.schema.as_deref().unwrap_or("{}")).unwrap();
        schema["fields"].as_array().is_some_and(|fields| {
            fields
                .iter()
                .any(|f| f["name"] == field && f["type"] == "Image")
        })
    }

    const IMAGE_COLLECTIONS: &str = r#"
const settings = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/settings' }),
  schema: z.object({ email: z.string().email() }),
});

const sketchStrip = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/sketch-strip' }),
  schema: ({ image }) =>
    z.object({
      src: image(),
      alt: z.string(),
    }),
});

const floatingSketches = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/floating-sketches' }),
  schema: ({ image }) => z.object({ src: image(), left: z.number() }),
});
"#;

    #[test]
    fn export_with_single_quoted_keys_and_trailing_comma() {
        let config = format!(
            "{IMAGE_COLLECTIONS}
export const collections = {{
  settings,
  'sketch-strip': sketchStrip,
  'floating-sketches': floatingSketches,
}};
"
        );
        let collections =
            parse_with_dirs(&config, &["settings", "sketch-strip", "floating-sketches"]);

        assert_eq!(
            names(&collections),
            ["settings", "sketch-strip", "floating-sketches"]
        );
        assert!(has_image_field(&collections[1], "src"));
        assert!(has_image_field(&collections[2], "src"));
    }

    #[test]
    fn export_with_double_quoted_keys_on_one_line() {
        let config = format!(
            r#"{IMAGE_COLLECTIONS}
export const collections = {{ settings, "sketch-strip": sketchStrip, "floating-sketches": floatingSketches }};
"#
        );
        let collections =
            parse_with_dirs(&config, &["settings", "sketch-strip", "floating-sketches"]);

        assert_eq!(
            names(&collections),
            ["settings", "sketch-strip", "floating-sketches"]
        );
        assert!(has_image_field(&collections[1], "src"));
    }

    #[test]
    fn export_of_shorthand_names_over_several_lines_with_trailing_comma() {
        let config = r#"
const blog = defineCollection({
  schema: ({ image }) => z.object({ cover: image() }),
});
const notes = defineCollection({ schema: z.object({ title: z.string() }) });

export const collections = {
  blog,
  notes,
};
"#;
        let collections = parse_with_dirs(config, &["blog", "notes"]);

        assert_eq!(names(&collections), ["blog", "notes"]);
        assert!(has_image_field(&collections[0], "cover"));
    }

    #[test]
    fn export_with_an_unquoted_key_naming_a_variable() {
        let config = r#"
const blogCollection = defineCollection({
  schema: ({ image }) => z.object({ cover: image() }),
});
export const collections = { blog: blogCollection, };
"#;
        let collections = parse_with_dirs(config, &["blog"]);

        assert_eq!(names(&collections), ["blog"]);
        assert!(has_image_field(&collections[0], "cover"));
    }

    #[test]
    fn export_with_a_quoted_key_and_an_inline_collection() {
        let config = r#"
export const collections = {
  'case-studies': defineCollection({
    schema: ({ image }) => z.object({ hero: image() }),
  }),
};
"#;
        let collections = parse_with_dirs(config, &["case-studies"]);

        assert_eq!(names(&collections), ["case-studies"]);
        assert!(has_image_field(&collections[0], "hero"));
    }

    #[test]
    fn export_with_a_quoted_key_skips_file_loader_collections() {
        let config = r#"
const teamMembers = defineCollection({
  loader: file('src/data/team.json'),
  schema: z.object({ name: z.string() }),
});
const posts = defineCollection({ schema: z.object({ title: z.string() }) });
export const collections = {
  'team-members': teamMembers,
  posts,
};
"#;
        let collections = parse_with_dirs(config, &["team-members", "posts"]);

        assert_eq!(names(&collections), ["posts"]);
    }

    #[test]
    fn collections_keep_the_order_of_the_config() {
        let config = r#"
const work = defineCollection({ schema: z.object({}) });
const settings = defineCollection({ schema: z.object({}) });
const about = defineCollection({ schema: z.object({}) });
export const collections = { work, settings, about };
"#;
        let temp = tempfile::tempdir().unwrap();
        for name in ["about", "settings", "work"] {
            fs::create_dir_all(temp.path().join("src").join("content").join(name)).unwrap();
        }

        let collections = parse_collections_from_content(config, temp.path(), None).unwrap();
        let names: Vec<&str> = collections.iter().map(|c| c.name.as_str()).collect();

        assert_eq!(names, ["work", "settings", "about"]);
    }

    #[test]
    fn test_remove_comments() {
        let content = r#"
// This is a comment
export default defineConfig({
  /* This is a block comment */
  collections: {
    blog: defineCollection({}) // End comment
  }
});
"#;
        let clean = remove_comments(content);
        assert!(!clean.contains("This is a comment"));
        assert!(!clean.contains("block comment"));
        assert!(!clean.contains("End comment"));
        assert!(clean.contains("defineConfig"));
    }

    #[test]
    fn test_improved_comment_stripping() {
        let content = r#"
// Line comment at start
export const collections = {
  test: defineCollection({
    /* Multi-line block comment
       with multiple lines
       // and nested line comment
    */
    schema: z.object({
      title: z.string(), // End-of-line comment
      description: z.string().optional(), /* inline block */
      content: "/* not a comment inside string */",
      regex: /\/\* also not a comment in regex \*\//,
    }),
  }),
};
"#;
        let clean = remove_comments(content);

        // Should remove comments
        assert!(!clean.contains("Line comment at start"));
        assert!(!clean.contains("Multi-line block comment"));
        assert!(!clean.contains("End-of-line comment"));
        assert!(!clean.contains("inline block"));

        // Should preserve content inside strings and regex
        assert!(clean.contains("/* not a comment inside string */"));
        // The regex content should be preserved (just check for the path structure)
        assert!(clean.contains("regex:"));

        // Should preserve the actual code
        assert!(clean.contains("export const collections"));
        assert!(clean.contains("z.string()"));
    }

    // --- UNIT TESTS FOR HELPER DISCOVERY ---

    #[test]
    fn test_find_helper_calls_basic() {
        let schema_text = r#"
        z.object({
            hero: image(),
            author: reference('authors'),
            title: z.string(),
            tags: z.array(reference('tags')),
        })
        "#;

        let helpers = find_helper_calls(schema_text);

        // Should find 1 image() and 2 reference() calls
        assert_eq!(helpers.len(), 3, "Should find 3 helpers total");

        let image_helpers: Vec<_> = helpers
            .iter()
            .filter(|h| h.helper_type == HelperType::Image)
            .collect();
        assert_eq!(image_helpers.len(), 1, "Should find 1 image() helper");

        let reference_helpers: Vec<_> = helpers
            .iter()
            .filter(|h| h.helper_type == HelperType::Reference)
            .collect();
        assert_eq!(
            reference_helpers.len(),
            2,
            "Should find 2 reference() helpers"
        );

        // Verify collection names are extracted
        let author_helper = reference_helpers
            .iter()
            .find(|h| h.collection_name == Some("authors".to_string()));
        assert!(author_helper.is_some(), "Should find reference('authors')");

        let tags_helper = reference_helpers
            .iter()
            .find(|h| h.collection_name == Some("tags".to_string()));
        assert!(tags_helper.is_some(), "Should find reference('tags')");
    }

    #[test]
    fn test_find_helper_calls_multiline() {
        let schema_text = r#"
        z.object({
            coverImage: z
                .object({
                    image: image().optional(),
                    alt: z.string(),
                })
                .optional(),
        })
        "#;

        let helpers = find_helper_calls(schema_text);

        // Should find the image() even with multi-line formatting
        assert_eq!(helpers.len(), 1, "Should find 1 helper");
        assert_eq!(helpers[0].helper_type, HelperType::Image);
    }

    #[test]
    fn test_find_helper_calls_deep_nesting() {
        let schema_text = r#"
        z.object({
            metadata: z.object({
                author: z.object({
                    avatar: image(),
                }),
            }),
        })
        "#;

        let helpers = find_helper_calls(schema_text);

        // Should find the deeply nested image()
        assert_eq!(helpers.len(), 1, "Should find 1 helper");
        assert_eq!(helpers[0].helper_type, HelperType::Image);
    }

    // --- UNIT TEST FOR INTEGRATION ---

    #[test]
    fn test_extract_zod_special_fields_basic() {
        // This is what should be extracted from z.object({ ... })
        let schema_text = r#"
hero: image(),
title: z.string(),
        "#;

        let result = extract_zod_special_fields(schema_text);
        assert!(result.is_some(), "Should find image() helper");

        let schema_json = result.unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&schema_json).unwrap();

        assert_eq!(parsed["type"], "zod");
        let fields = parsed["fields"].as_array().unwrap();
        assert_eq!(fields.len(), 1, "Should have 1 field (only image helper)");
        assert_eq!(fields[0]["name"], "hero");
        assert_eq!(fields[0]["type"], "Image");
    }

    #[test]
    fn test_extract_basic_schema_with_arrow_function() {
        let content = r#"
export const test = defineCollection({
  schema: ({ image }) => z.object({
    hero: image(),
    title: z.string(),
  }),
});
        "#;

        let result = extract_basic_schema(content, "test");
        assert!(
            result.is_some(),
            "Should extract schema from arrow function syntax"
        );

        let schema_json = result.unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&schema_json).unwrap();

        assert_eq!(parsed["type"], "zod");
        let fields = parsed["fields"].as_array().unwrap();
        assert_eq!(fields.len(), 1, "Should have 1 field");
        assert_eq!(fields[0]["name"], "hero");
        assert_eq!(fields[0]["type"], "Image");
    }

    // --- UNIT TESTS FOR PATH RESOLUTION ---

    #[test]
    fn test_resolve_top_level_field() {
        let schema_text = r#"
        z.object({
            hero: image(),
            title: z.string(),
        })
        "#;

        let helpers = find_helper_calls(schema_text);
        assert_eq!(helpers.len(), 1);

        let path = resolve_field_path(schema_text, helpers[0].position);
        assert!(path.is_ok(), "Should resolve path successfully");
        assert_eq!(path.unwrap(), "hero", "Should resolve to 'hero'");
    }

    #[test]
    fn test_resolve_nested_field() {
        let schema_text = r#"
        z.object({
            coverImage: z.object({
                image: image(),
                alt: z.string(),
            }),
        })
        "#;

        let helpers = find_helper_calls(schema_text);
        assert_eq!(helpers.len(), 1);

        let path = resolve_field_path(schema_text, helpers[0].position);
        assert!(path.is_ok(), "Should resolve path successfully");
        assert_eq!(
            path.unwrap(),
            "coverImage.image",
            "Should resolve to 'coverImage.image'"
        );
    }

    #[test]
    fn test_resolve_deep_nested_field() {
        let schema_text = r#"
        z.object({
            metadata: z.object({
                author: z.object({
                    avatar: image(),
                }),
            }),
        })
        "#;

        let helpers = find_helper_calls(schema_text);
        assert_eq!(helpers.len(), 1);

        let path = resolve_field_path(schema_text, helpers[0].position);
        assert!(path.is_ok(), "Should resolve path successfully");
        assert_eq!(
            path.unwrap(),
            "metadata.author.avatar",
            "Should resolve to 'metadata.author.avatar'"
        );
    }

    #[test]
    fn test_resolve_multiline_nested() {
        let schema_text = r#"
        z.object({
            coverImage: z
                .object({
                    image: image().optional(),
                    alt: z.string(),
                })
                .optional(),
        })
        "#;

        let helpers = find_helper_calls(schema_text);
        assert_eq!(helpers.len(), 1);

        let path = resolve_field_path(schema_text, helpers[0].position);
        assert!(path.is_ok(), "Should resolve path successfully");
        assert_eq!(
            path.unwrap(),
            "coverImage.image",
            "Should resolve to 'coverImage.image' even with multi-line"
        );
    }

    #[test]
    fn test_resolve_array_of_references() {
        let schema_text = r#"
        z.object({
            tags: z.array(reference('tags')),
        })
        "#;

        let helpers = find_helper_calls(schema_text);
        assert_eq!(helpers.len(), 1);

        let path = resolve_field_path(schema_text, helpers[0].position);
        assert!(path.is_ok(), "Should resolve path successfully");
        assert_eq!(path.unwrap(), "tags", "Should resolve to 'tags'");
    }

    #[test]
    fn test_resolve_multiple_helpers() {
        let schema_text = r#"
        z.object({
            hero: image(),
            author: reference('authors'),
            coverImage: z.object({
                image: image(),
                alt: z.string(),
            }),
        })
        "#;

        let helpers = find_helper_calls(schema_text);
        assert_eq!(helpers.len(), 3, "Should find 3 helpers");

        // Test each helper's path
        for helper in &helpers {
            let path = resolve_field_path(schema_text, helper.position);
            assert!(path.is_ok(), "Should resolve all paths successfully");
            let path_str = path.unwrap();

            match helper.helper_type {
                HelperType::Image => {
                    assert!(
                        path_str == "hero" || path_str == "coverImage.image",
                        "Image path should be 'hero' or 'coverImage.image', got '{path_str}'"
                    );
                }
                HelperType::Reference => {
                    assert_eq!(path_str, "author", "Reference path should be 'author'");
                }
            }
        }
    }

    // --- NEW FOCUSED TESTS FOR PATTERN MATCHING APPROACH ---

    #[test]
    fn test_find_top_level_image() {
        let content = r#"
export const collections = {
  test: defineCollection({
    schema: ({ image }) => z.object({
      hero: image(),
      title: z.string(),
    }),
  }),
};
"#;
        let temp_dir = std::env::temp_dir().join("test-top-level-image");
        let project_path = temp_dir.join("project");
        let test_path = project_path.join("src").join("content").join("test");

        fs::create_dir_all(&test_path).unwrap();

        let result = parse_collections_from_content(content, &project_path, None);
        assert!(result.is_ok());

        let collections = result.unwrap();
        assert_eq!(collections.len(), 1);

        let schema_json = collections[0].schema.as_ref().unwrap();
        let parsed_schema: serde_json::Value = serde_json::from_str(schema_json).unwrap();
        let fields = parsed_schema["fields"].as_array().unwrap();

        // Should find hero as Image type
        let hero_field = fields.iter().find(|f| f["name"] == "hero");
        assert!(hero_field.is_some(), "Should find hero field");
        let hero_field = hero_field.unwrap();
        assert_eq!(hero_field["type"], "Image");

        // Clean up
        fs::remove_dir_all(&temp_dir).ok();
    }

    #[test]
    fn test_find_nested_image() {
        let content = r#"
export const collections = {
  test: defineCollection({
    schema: ({ image }) => z.object({
      coverImage: z.object({
        image: image().optional(),
        alt: z.string(),
      }),
    }),
  }),
};
"#;
        let temp_dir = std::env::temp_dir().join("test-nested-image");
        let project_path = temp_dir.join("project");
        let test_path = project_path.join("src").join("content").join("test");

        fs::create_dir_all(&test_path).unwrap();

        let result = parse_collections_from_content(content, &project_path, None);
        assert!(result.is_ok());

        let collections = result.unwrap();
        assert_eq!(collections.len(), 1);

        let schema_json = collections[0].schema.as_ref().unwrap();
        let parsed_schema: serde_json::Value = serde_json::from_str(schema_json).unwrap();
        let fields = parsed_schema["fields"].as_array().unwrap();

        // Should find coverImage.image with dotted path
        let image_field = fields.iter().find(|f| f["name"] == "coverImage.image");
        assert!(
            image_field.is_some(),
            "Should find coverImage.image field with dotted path"
        );
        let image_field = image_field.unwrap();
        assert_eq!(image_field["type"], "Image");

        // Clean up
        fs::remove_dir_all(&temp_dir).ok();
    }

    #[test]
    fn test_find_deep_nested_image() {
        let content = r#"
export const collections = {
  test: defineCollection({
    schema: ({ image }) => z.object({
      metadata: z.object({
        author: z.object({
          avatar: image(),
        }),
      }),
    }),
  }),
};
"#;
        let temp_dir = std::env::temp_dir().join("test-deep-nested-image");
        let project_path = temp_dir.join("project");
        let test_path = project_path.join("src").join("content").join("test");

        fs::create_dir_all(&test_path).unwrap();

        let result = parse_collections_from_content(content, &project_path, None);
        assert!(result.is_ok());

        let collections = result.unwrap();
        assert_eq!(collections.len(), 1);

        let schema_json = collections[0].schema.as_ref().unwrap();
        let parsed_schema: serde_json::Value = serde_json::from_str(schema_json).unwrap();
        let fields = parsed_schema["fields"].as_array().unwrap();

        // Should find metadata.author.avatar with dotted path
        let avatar_field = fields
            .iter()
            .find(|f| f["name"] == "metadata.author.avatar");
        assert!(
            avatar_field.is_some(),
            "Should find metadata.author.avatar field with dotted path"
        );
        let avatar_field = avatar_field.unwrap();
        assert_eq!(avatar_field["type"], "Image");

        // Clean up
        fs::remove_dir_all(&temp_dir).ok();
    }

    #[test]
    fn test_find_reference_helper() {
        let content = r#"
export const collections = {
  test: defineCollection({
    schema: ({ reference }) => z.object({
      author: reference('authors'),
      tags: z.array(reference('tags')),
    }),
  }),
};
"#;
        let temp_dir = std::env::temp_dir().join("test-reference-helper");
        let project_path = temp_dir.join("project");
        let test_path = project_path.join("src").join("content").join("test");

        fs::create_dir_all(&test_path).unwrap();

        let result = parse_collections_from_content(content, &project_path, None);
        assert!(result.is_ok());

        let collections = result.unwrap();
        assert_eq!(collections.len(), 1);

        let schema_json = collections[0].schema.as_ref().unwrap();
        let parsed_schema: serde_json::Value = serde_json::from_str(schema_json).unwrap();
        let fields = parsed_schema["fields"].as_array().unwrap();

        // Should find author as Reference type with collection name
        let author_field = fields.iter().find(|f| f["name"] == "author");
        assert!(author_field.is_some(), "Should find author field");
        let author_field = author_field.unwrap();
        assert_eq!(author_field["type"], "Reference");
        assert_eq!(author_field["referencedCollection"], "authors");

        // Should find tags as Array type with Reference inner type
        let tags_field = fields.iter().find(|f| f["name"] == "tags");
        assert!(tags_field.is_some(), "Should find tags field");
        let tags_field = tags_field.unwrap();
        assert_eq!(tags_field["type"], "Array");
        assert_eq!(tags_field["arrayType"], "Reference");
        assert_eq!(tags_field["arrayReferenceCollection"], "tags");

        // Clean up
        fs::remove_dir_all(&temp_dir).ok();
    }

    #[test]
    fn test_multiline_nested_object() {
        let content = r#"
export const collections = {
  test: defineCollection({
    schema: ({ image }) => z.object({
      coverImage: z
        .object({
          image: image().optional(),
          alt: z.string().optional(),
        })
        .optional(),
    }),
  }),
};
"#;
        let temp_dir = std::env::temp_dir().join("test-multiline-nested");
        let project_path = temp_dir.join("project");
        let test_path = project_path.join("src").join("content").join("test");

        fs::create_dir_all(&test_path).unwrap();

        let result = parse_collections_from_content(content, &project_path, None);
        assert!(result.is_ok());

        let collections = result.unwrap();
        assert_eq!(collections.len(), 1);

        let schema_json = collections[0].schema.as_ref().unwrap();
        let parsed_schema: serde_json::Value = serde_json::from_str(schema_json).unwrap();
        let fields = parsed_schema["fields"].as_array().unwrap();

        // Should find coverImage.image despite multi-line formatting
        let image_field = fields.iter().find(|f| f["name"] == "coverImage.image");
        assert!(
            image_field.is_some(),
            "Should find coverImage.image field even with multi-line formatting"
        );
        let image_field = image_field.unwrap();
        assert_eq!(image_field["type"], "Image");

        // Clean up
        fs::remove_dir_all(&temp_dir).ok();
    }

    #[test]
    fn test_array_of_references() {
        let content = r#"
export const collections = {
  test: defineCollection({
    schema: ({ reference }) => z.object({
      relatedArticles: z.array(reference('articles')),
    }),
  }),
};
"#;
        let temp_dir = std::env::temp_dir().join("test-array-references");
        let project_path = temp_dir.join("project");
        let test_path = project_path.join("src").join("content").join("test");

        fs::create_dir_all(&test_path).unwrap();

        let result = parse_collections_from_content(content, &project_path, None);
        assert!(result.is_ok());

        let collections = result.unwrap();
        assert_eq!(collections.len(), 1);

        let schema_json = collections[0].schema.as_ref().unwrap();
        let parsed_schema: serde_json::Value = serde_json::from_str(schema_json).unwrap();
        let fields = parsed_schema["fields"].as_array().unwrap();

        // Should find relatedArticles as Array with Reference inner type
        let related_field = fields.iter().find(|f| f["name"] == "relatedArticles");
        assert!(related_field.is_some(), "Should find relatedArticles field");
        let related_field = related_field.unwrap();
        assert_eq!(related_field["type"], "Array");
        assert_eq!(related_field["arrayType"], "Reference");
        assert_eq!(related_field["arrayReferenceCollection"], "articles");

        // Clean up
        fs::remove_dir_all(&temp_dir).ok();
    }

    #[test]
    fn test_helpers_with_comments() {
        let content = r#"
export const collections = {
  test: defineCollection({
    schema: ({ image }) => z.object({
      // Profile image
      avatar: image().optional(),
      /* Cover image */
      cover: z.object({
        image: image(), // The actual image
      }),
    }),
  }),
};
"#;
        let temp_dir = std::env::temp_dir().join("test-helpers-comments");
        let project_path = temp_dir.join("project");
        let test_path = project_path.join("src").join("content").join("test");

        fs::create_dir_all(&test_path).unwrap();

        let result = parse_collections_from_content(content, &project_path, None);
        assert!(result.is_ok());

        let collections = result.unwrap();
        assert_eq!(collections.len(), 1);

        let schema_json = collections[0].schema.as_ref().unwrap();
        let parsed_schema: serde_json::Value = serde_json::from_str(schema_json).unwrap();
        let fields = parsed_schema["fields"].as_array().unwrap();

        // Should find both avatar and cover.image
        let avatar_field = fields.iter().find(|f| f["name"] == "avatar");
        assert!(avatar_field.is_some(), "Should find avatar field");
        assert_eq!(avatar_field.unwrap()["type"], "Image");

        let cover_image_field = fields.iter().find(|f| f["name"] == "cover.image");
        assert!(cover_image_field.is_some(), "Should find cover.image field");
        assert_eq!(cover_image_field.unwrap()["type"], "Image");

        // Clean up
        fs::remove_dir_all(&temp_dir).ok();
    }

    // --- END NEW FOCUSED TESTS ---

    #[test]
    fn test_content_directory_override() {
        let content = r#"
import { defineConfig, defineCollection, z } from 'astro:content';

export default defineConfig({
  collections: {
    blog: defineCollection({
      type: 'content',
      schema: z.object({
        title: z.string(),
        date: z.coerce.date(),
      }),
    }),
  },
});
"#;

        let temp_dir = std::env::temp_dir().join("test-content-dir-override");
        let project_path = temp_dir.join("project");
        // Use a custom content directory instead of src/content
        let custom_content_dir = "content";
        let blog_path = project_path.join(custom_content_dir).join("blog");

        fs::create_dir_all(&blog_path).unwrap();

        // Test with override
        let result =
            parse_collections_from_content(content, &project_path, Some(custom_content_dir));
        assert!(result.is_ok());

        let collections = result.unwrap();
        assert_eq!(collections.len(), 1);
        assert_eq!(collections[0].name, "blog");
        // Schema is None because there are no image() or reference() helpers
        assert!(collections[0].schema.is_none());

        // Verify the path is using the override
        let expected_path = project_path.join(custom_content_dir).join("blog");
        assert_eq!(collections[0].path, expected_path);

        // Test without override - should not find the collection since it's in custom location
        let result_without_override = parse_collections_from_content(content, &project_path, None);
        assert!(result_without_override.is_ok());
        let collections_without_override = result_without_override.unwrap();
        assert_eq!(collections_without_override.len(), 0); // Should be empty since default path doesn't exist

        // Clean up
        fs::remove_dir_all(&temp_dir).ok();
    }
}
