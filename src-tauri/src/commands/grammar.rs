//! Grammar and spell checking for the editor's body text. See `crate::grammar`.

use std::sync::{Arc, Mutex};

use tauri::State;

use crate::grammar::{Checker, GrammarDialect, GrammarFileType, GrammarIssue};

/// The checker, kept between calls because building one takes a few hundred
/// milliseconds. Rebuilt when the dialect or the personal dictionary changes
#[derive(Default, Clone)]
pub struct GrammarState(Arc<Mutex<Option<Checker>>>);

/// Checks `text` (the body, without frontmatter) and returns its issues, with
/// UTF-16 offsets. Runs on a blocking thread, so typing never waits on it
#[tauri::command]
#[specta::specta]
pub async fn check_grammar(
    state: State<'_, GrammarState>,
    text: String,
    file_type: GrammarFileType,
    dialect: GrammarDialect,
    dictionary: Vec<String>,
) -> Result<Vec<GrammarIssue>, String> {
    let checker = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut checker = checker
            .lock()
            .map_err(|e| format!("Grammar checker is unavailable: {e}"))?;
        if !checker
            .as_ref()
            .is_some_and(|c| c.matches(dialect, &dictionary))
        {
            *checker = Some(Checker::new(dialect, dictionary));
        }
        let checker = checker.as_mut().expect("checker was just set");
        Ok(checker.check(&text, file_type))
    })
    .await
    .map_err(|e| format!("Grammar check failed: {e}"))?
}
