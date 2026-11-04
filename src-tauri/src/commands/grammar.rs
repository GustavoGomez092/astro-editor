//! Grammar and spell checking for the editor's body text. See `crate::grammar`.

use std::any::Any;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::panic::{catch_unwind, AssertUnwindSafe};
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

/// What the worker runs checks with: `Checker`, or a stand-in in tests
trait Engine {
    fn matches(&self, dialect: GrammarDialect, words: &[String]) -> bool;
    fn check(&mut self, text: &str, file_type: GrammarFileType) -> Vec<GrammarIssue>;
}

impl Engine for Checker {
    fn matches(&self, dialect: GrammarDialect, words: &[String]) -> bool {
        Checker::matches(self, dialect, words)
    }

    fn check(&mut self, text: &str, file_type: GrammarFileType) -> Vec<GrammarIssue> {
        Checker::check(self, text, file_type)
    }
}

fn run_worker(requests: mpsc::Receiver<Request>) {
    run_worker_with(requests, Checker::new);
}

fn text_hash(text: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    hasher.finish()
}

fn panic_message(panic: &(dyn Any + Send)) -> &str {
    panic
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| panic.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("unknown panic")
}

/// Runs checks one at a time until every sender is gone. When several are
/// waiting, only the newest runs: the others were for text that has since
/// changed. The engine is kept between checks and rebuilt when the dialect or
/// the dictionary changes.
///
/// A panic in Harper is caught (the release profile unwinds for this): the
/// check returns no issues, the engine is rebuilt, and that exact text isn't
/// checked again until it changes, so a text that trips Harper can't make
/// every pause in typing fail the same way
fn run_worker_with<E: Engine>(
    requests: mpsc::Receiver<Request>,
    build: impl Fn(GrammarDialect, Vec<String>) -> E,
) {
    let mut engine: Option<E> = None;
    let mut failed_text: Option<u64> = None;
    while let Ok(mut request) = requests.recv() {
        while let Ok(newer) = requests.try_recv() {
            let _ = request.reply.send(None);
            request = newer;
        }
        let hash = text_hash(&request.text);
        if failed_text == Some(hash) {
            let _ = request.reply.send(Some(Vec::new()));
            continue;
        }
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            if !engine
                .as_ref()
                .is_some_and(|e| e.matches(request.dialect, &request.dictionary))
            {
                engine = Some(build(request.dialect, request.dictionary.clone()));
            }
            engine
                .as_mut()
                .map(|e| e.check(&request.text, request.file_type))
                .unwrap_or_default()
        }));
        let issues = match outcome {
            Ok(issues) => issues,
            Err(panic) => {
                engine = None;
                failed_text = Some(hash);
                log::error!(
                    "Astro Editor [GRAMMAR] Harper failed on this text ({}), so it won't be checked until it changes",
                    panic_message(&*panic)
                );
                Vec::new()
            }
        };
        // The caller may have stopped waiting; nothing to do then
        let _ = request.reply.send(Some(issues));
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

    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// Panics on any text containing "boom", and counts builds and checks
    struct FakeEngine {
        checks: Arc<AtomicUsize>,
    }

    impl Engine for FakeEngine {
        fn matches(&self, _: GrammarDialect, _: &[String]) -> bool {
            true
        }

        fn check(&mut self, text: &str, _: GrammarFileType) -> Vec<GrammarIssue> {
            self.checks.fetch_add(1, Ordering::SeqCst);
            assert!(!text.contains("boom"), "injected panic");
            vec![GrammarIssue {
                from: 0,
                to: 1,
                rule: "Fake".into(),
                kind: crate::grammar::GrammarIssueKind::Grammar,
                problem: "x".into(),
                message: String::new(),
                suggestions: vec![],
            }]
        }
    }

    #[test]
    fn a_panic_gives_no_issues_and_the_same_text_is_not_checked_again() {
        let builds = Arc::new(AtomicUsize::new(0));
        let checks = Arc::new(AtomicUsize::new(0));
        let (tx, rx) = mpsc::channel();
        let worker = {
            let (builds, checks) = (builds.clone(), checks.clone());
            std::thread::spawn(move || {
                run_worker_with(rx, move |_, _| {
                    builds.fetch_add(1, Ordering::SeqCst);
                    FakeEngine {
                        checks: checks.clone(),
                    }
                })
            })
        };
        let send = |text: &str| {
            let (r, reply) = request(text);
            tx.send(r).unwrap();
            reply.blocking_recv().unwrap()
        };

        assert_eq!(send("it goes boom"), Some(vec![]));
        assert_eq!(checks.load(Ordering::SeqCst), 1);
        assert_eq!(send("it goes boom"), Some(vec![]));
        assert_eq!(
            checks.load(Ordering::SeqCst),
            1,
            "failed text checked again"
        );

        let issues = send("it's fine now").expect("checked");
        assert_eq!(issues.len(), 1);
        assert_eq!(builds.load(Ordering::SeqCst), 2, "checker not rebuilt");

        drop(tx);
        worker.join().unwrap();
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
