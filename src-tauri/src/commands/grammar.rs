//! Grammar and spell checking for the editor's body text. See `crate::grammar`.

use std::sync::{mpsc, Mutex};

use tauri::State;
use tokio::sync::oneshot;

use crate::grammar::{Checker, GrammarDialect, GrammarFileType, GrammarIssue};

struct Request {
    text: String,
    file_type: GrammarFileType,
    dialect: GrammarDialect,
    dictionary: Vec<String>,
    /// `None` when a newer request replaced this one before it ran
    reply: oneshot::Sender<Option<Vec<GrammarIssue>>>,
}

/// Sends checks to one long-lived worker thread, started on the first check.
#[derive(Default)]
pub struct GrammarState(Mutex<Option<mpsc::Sender<Request>>>);

/// Runs checks one at a time until every sender is gone. When several are
/// waiting, only the newest runs: the others were for text that has since
/// changed. The checker is kept between checks and rebuilt when the dialect or
/// the dictionary changes.
fn run_worker(requests: mpsc::Receiver<Request>) {
    let mut checker: Option<Checker> = None;
    while let Ok(mut request) = requests.recv() {
        while let Ok(newer) = requests.try_recv() {
            let _ = request.reply.send(None);
            request = newer;
        }
        if !checker
            .as_ref()
            .is_some_and(|c| c.matches(request.dialect, &request.dictionary))
        {
            checker = Some(Checker::new(request.dialect, request.dictionary));
        }
        if let Some(checker) = checker.as_mut() {
            let issues = checker.check(&request.text, request.file_type);
            // The caller may have stopped waiting; nothing to do then
            let _ = request.reply.send(Some(issues));
        }
    }
}

/// Checks `text` (the body, without frontmatter) and returns its issues, with
/// UTF-16 offsets, or `null` if a newer check replaced this one before it ran.
///
/// Checks run on one dedicated thread rather than the blocking pool: Harper
/// builds its spelling automaton once per thread, which takes up to a second,
/// so a fresh pool thread would make an occasional check that slow
#[tauri::command]
#[specta::specta]
pub async fn check_grammar(
    state: State<'_, GrammarState>,
    text: String,
    file_type: GrammarFileType,
    dialect: GrammarDialect,
    dictionary: Vec<String>,
) -> Result<Option<Vec<GrammarIssue>>, String> {
    let (reply, response) = oneshot::channel();
    let mut request = Request {
        text,
        file_type,
        dialect,
        dictionary,
        reply,
    };
    {
        let mut sender = state
            .0
            .lock()
            .map_err(|e| format!("Grammar checker is unavailable: {e}"))?;
        // Start the worker on first use, and again if it stopped
        for _ in 0..2 {
            let worker = sender.get_or_insert_with(|| {
                let (tx, rx) = mpsc::channel();
                std::thread::Builder::new()
                    .name("grammar".into())
                    .spawn(move || run_worker(rx))
                    .expect("failed to start the grammar thread");
                tx
            });
            match worker.send(request) {
                Ok(()) => break,
                Err(mpsc::SendError(returned)) => {
                    request = returned;
                    *sender = None;
                }
            }
        }
    }
    response
        .await
        .map_err(|_| "Grammar check stopped before it finished".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(text: &str) -> (Request, oneshot::Receiver<Option<Vec<GrammarIssue>>>) {
        let (reply, response) = oneshot::channel();
        let request = Request {
            text: text.to_string(),
            file_type: GrammarFileType::Md,
            dialect: GrammarDialect::American,
            dictionary: vec![],
            reply,
        };
        (request, response)
    }

    #[test]
    fn only_the_newest_waiting_check_runs() {
        let (tx, rx) = mpsc::channel();
        let (first, first_reply) = request("I saw teh dog.");
        let (second, second_reply) = request("I saw teh cat.");
        let (third, third_reply) = request("I saw teh bird.");
        for r in [first, second, third] {
            tx.send(r).unwrap();
        }
        drop(tx);
        run_worker(rx);

        assert_eq!(first_reply.blocking_recv().unwrap(), None);
        assert_eq!(second_reply.blocking_recv().unwrap(), None);
        let issues = third_reply.blocking_recv().unwrap().expect("newest ran");
        assert!(issues.iter().any(|i| i.problem == "teh"));
    }

    #[test]
    fn checks_one_after_another_all_run() {
        let (tx, rx) = mpsc::channel();
        let worker = std::thread::spawn(move || run_worker(rx));
        for text in ["I saw teh dog.", "Then an apple fell."] {
            let (r, reply) = request(text);
            tx.send(r).unwrap();
            assert!(reply.blocking_recv().unwrap().is_some());
        }
        drop(tx);
        worker.join().unwrap();
    }
}
