//! Grammar and spell checking with Harper (`harper-core`).
//!
//! The frontend sends the editor's body text (frontmatter and the MDX import block
//! are already gone) and gets back issues with UTF-16 offsets, which is what
//! CodeMirror counts in. Harper counts in Unicode chars, so offsets are converted
//! here, at the boundary.

use std::sync::Arc;

use harper_core::linting::{LintGroup, LintKind, Suggestion};
use harper_core::spell::{FstDictionary, MergedDictionary, MutableDictionary};
use harper_core::{Dialect, DictWordMetadata, Document};
use serde::{Deserialize, Serialize};
use specta::Type;

/// Harper offers a handful of suggestions; more than this clutters the popup
const MAX_SUGGESTIONS: usize = 5;

/// Which parser rules apply. MDX adds masking for imports, component tags and
/// `{expressions}`, which Harper's Markdown parser doesn't know about
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum GrammarFileType {
    Md,
    Mdx,
}

/// The English dialects Harper supports
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum GrammarDialect {
    American,
    British,
    Canadian,
    Australian,
    Indian,
}

impl From<GrammarDialect> for Dialect {
    fn from(value: GrammarDialect) -> Self {
        match value {
            GrammarDialect::American => Dialect::American,
            GrammarDialect::British => Dialect::British,
            GrammarDialect::Canadian => Dialect::Canadian,
            GrammarDialect::Australian => Dialect::Australian,
            GrammarDialect::Indian => Dialect::Indian,
        }
    }
}

/// Spelling issues get their own underline; everything else is grammar
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum GrammarIssueKind {
    Spelling,
    Grammar,
}

/// One problem Harper found
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct GrammarIssue {
    /// Start, in UTF-16 code units from the start of the text
    pub from: u32,
    /// End (exclusive), in UTF-16 code units
    pub to: u32,
    /// Harper's rule name, such as `SpellCheck`
    pub rule: String,
    pub kind: GrammarIssueKind,
    /// The text between `from` and `to`
    pub problem: String,
    pub message: String,
    /// Replacement text for `from..to`, best first. An empty string removes it
    pub suggestions: Vec<String>,
}

/// A Harper linter set up for one dialect and personal dictionary. Building one
/// takes a few hundred milliseconds, so the command keeps it and reuses it
pub struct Checker {
    dialect: GrammarDialect,
    words: Vec<String>,
    /// The personal dictionary, lowercased, for dropping issues on its words
    folded_words: Vec<String>,
    dictionary: Arc<MergedDictionary>,
    group: LintGroup,
}

impl Checker {
    pub fn new(dialect: GrammarDialect, words: Vec<String>) -> Self {
        let mut personal = MutableDictionary::new();
        for word in &words {
            personal.append_word_str(word, DictWordMetadata::default());
        }
        let mut dictionary = MergedDictionary::new();
        dictionary.add_dictionary(FstDictionary::curated());
        dictionary.add_dictionary(Arc::new(personal));
        let dictionary = Arc::new(dictionary);
        let group = LintGroup::new_curated(dictionary.clone(), dialect.into());
        let folded_words = words.iter().map(|w| w.to_lowercase()).collect();
        Self {
            dialect,
            words,
            folded_words,
            dictionary,
            group,
        }
    }

    /// Whether this checker was built for these settings
    pub fn matches(&self, dialect: GrammarDialect, words: &[String]) -> bool {
        self.dialect == dialect && self.words == words
    }

    pub fn check(&mut self, text: &str, file_type: GrammarFileType) -> Vec<GrammarIssue> {
        let chars: Vec<char> = text.chars().collect();
        let (source, masked) = match file_type {
            GrammarFileType::Md => (chars.clone(), Vec::new()),
            GrammarFileType::Mdx => mask_mdx(&chars),
        };
        let source: String = source.iter().collect();
        let document = Document::new_markdown_default(&source, &*self.dictionary);

        let mut lints: Vec<(String, harper_core::linting::Lint)> = self
            .group
            .organized_lints(&document)
            .into_iter()
            .flat_map(|(rule, lints)| lints.into_iter().map(move |lint| (rule.clone(), lint)))
            .filter(|(_, lint)| {
                let (start, end) = (lint.span.start, lint.span.end);
                end > start
                    && end <= chars.len()
                    && !masked
                        .iter()
                        .any(|&(m_start, m_end)| start < m_end && m_start < end)
            })
            .collect();

        // Several rules can flag the same words ("teh" is both a misspelling and a
        // typo for "the"). Keep one: a misspelling first, since it offers Add to
        // dictionary, then the most important by Harper's priority
        lints.sort_by_key(|(_, lint)| {
            (
                lint.span.start,
                lint.lint_kind != LintKind::Spelling,
                lint.priority,
            )
        });
        let mut kept: Vec<(String, harper_core::linting::Lint)> = Vec::new();
        for (rule, lint) in lints {
            if kept
                .last()
                .is_some_and(|(_, last)| lint.span.start < last.span.end)
            {
                continue;
            }
            kept.push((rule, lint));
        }

        let utf16 = utf16_offsets(&chars);
        kept.into_iter()
            .filter_map(|(rule, lint)| {
                let problem: String = chars[lint.span.start..lint.span.end].iter().collect();
                if self.folded_words.contains(&problem.to_lowercase()) {
                    return None;
                }
                let mut suggestions: Vec<String> = Vec::new();
                for suggestion in &lint.suggestions {
                    let replacement = match suggestion {
                        Suggestion::ReplaceWith(with) => with.iter().collect(),
                        Suggestion::InsertAfter(after) => {
                            format!("{problem}{}", after.iter().collect::<String>())
                        }
                        Suggestion::Remove => String::new(),
                    };
                    if !suggestions.contains(&replacement) {
                        suggestions.push(replacement);
                    }
                }
                suggestions.truncate(MAX_SUGGESTIONS);
                Some(GrammarIssue {
                    from: utf16[lint.span.start],
                    to: utf16[lint.span.end],
                    rule,
                    kind: if lint.lint_kind == LintKind::Spelling {
                        GrammarIssueKind::Spelling
                    } else {
                        GrammarIssueKind::Grammar
                    },
                    problem,
                    message: lint.message,
                    suggestions,
                })
            })
            .collect()
    }
}

/// The UTF-16 offset of every char index, plus one for the end of the text
fn utf16_offsets(chars: &[char]) -> Vec<u32> {
    let mut offsets = Vec::with_capacity(chars.len() + 1);
    let mut offset = 0u32;
    for c in chars {
        offsets.push(offset);
        offset += c.len_utf16() as u32;
    }
    offsets.push(offset);
    offsets
}

/// Blanks out MDX syntax that isn't prose, so Harper neither checks it nor
/// treats a component's opening line as the start of an HTML block (which would
/// hide the text inside the component). Returns the text with those parts
/// replaced by spaces (newlines are kept, so offsets and lines don't move) and
/// the char ranges blanked: `import`/`export` statements, JSX tags (including
/// ones that span lines) and `{expressions}`. Fenced code is left alone; Harper
/// skips it anyway.
fn mask_mdx(chars: &[char]) -> (Vec<char>, Vec<(usize, usize)>) {
    let mut out = chars.to_vec();
    let mut masked = Vec::new();
    let mut i = 0;
    let mut in_fence = false;

    while i < chars.len() {
        let at_line_start = i == 0 || chars[i - 1] == '\n';
        if at_line_start {
            let line_end = find_line_end(chars, i);
            let line: String = chars[i..line_end].iter().collect();
            let trimmed = line.trim_start();
            if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
                in_fence = !in_fence;
                i = line_end;
                continue;
            }
            if !in_fence && (trimmed.starts_with("import ") || trimmed.starts_with("export ")) {
                let end = esm_statement_end(chars, i);
                blank(&mut out, &mut masked, i, end);
                i = end;
                continue;
            }
        }
        if in_fence {
            i = find_line_end(chars, i).max(i + 1);
            continue;
        }

        let end = match chars[i] {
            '<' => jsx_tag_end(chars, i),
            '{' => expression_end(chars, i),
            _ => None,
        };
        match end {
            Some(end) => {
                blank(&mut out, &mut masked, i, end);
                i = end;
            }
            None => i += 1,
        }
    }

    (out, masked)
}

/// Index of the `\n` ending the line that starts at `start`, or the text's end
fn find_line_end(chars: &[char], start: usize) -> usize {
    chars[start..]
        .iter()
        .position(|&c| c == '\n')
        .map_or(chars.len(), |p| start + p)
}

/// Where an `import`/`export` statement starting at `start` ends: the end of its
/// line, or of a later line once every `{` it opened is closed
fn esm_statement_end(chars: &[char], start: usize) -> usize {
    let mut depth = 0i32;
    let mut i = start;
    while i < chars.len() {
        match chars[i] {
            '{' => depth += 1,
            '}' => depth -= 1,
            '\n' if depth <= 0 => return i,
            _ => {}
        }
        i += 1;
    }
    chars.len()
}

/// Replaces `start..end` with spaces, keeping newlines
fn blank(out: &mut [char], masked: &mut Vec<(usize, usize)>, start: usize, end: usize) {
    if end <= start {
        return;
    }
    for c in &mut out[start..end] {
        if *c != '\n' {
            *c = ' ';
        }
    }
    masked.push((start, end));
}

/// A blank line ends any tag or expression: neither spans paragraphs in MDX,
/// so seeing one means the `<` or `{` was just text
fn is_blank_line_at(chars: &[char], i: usize) -> bool {
    chars[i] == '\n' && chars.get(i + 1) == Some(&'\n')
}

/// The end (exclusive) of a JSX tag starting at `start` (`<Name …>`, `</Name>`,
/// `<Name … />`, `<>`, `</>`), or None if this `<` isn't one
fn jsx_tag_end(chars: &[char], start: usize) -> Option<usize> {
    let mut i = start + 1;
    if chars.get(i) == Some(&'/') {
        i += 1;
    }
    match chars.get(i) {
        Some('>') => return Some(i + 1),
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return None,
    }
    let mut quote: Option<char> = None;
    let mut depth = 0i32;
    while i < chars.len() {
        let c = chars[i];
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                }
            }
            None => match c {
                '"' | '\'' => quote = Some(c),
                '{' => depth += 1,
                '}' => depth -= 1,
                '`' if depth == 0 => return None,
                '<' if depth == 0 => return None,
                '>' if depth == 0 => return Some(i + 1),
                _ => {}
            },
        }
        if is_blank_line_at(chars, i) {
            return None;
        }
        i += 1;
    }
    None
}

/// The end (exclusive) of a `{…}` expression starting at `start`, or None if
/// the braces don't close before a blank line
fn expression_end(chars: &[char], start: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    for (i, &c) in chars.iter().enumerate().skip(start) {
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                }
            }
            None => match c {
                '"' | '\'' | '`' => quote = Some(c),
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(i + 1);
                    }
                }
                _ => {}
            },
        }
        if is_blank_line_at(chars, i) {
            return None;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(text: &str, file_type: GrammarFileType) -> Vec<GrammarIssue> {
        Checker::new(GrammarDialect::American, vec![]).check(text, file_type)
    }

    fn utf16_slice(text: &str, from: u32, to: u32) -> String {
        let units: Vec<u16> = text.encode_utf16().collect();
        String::from_utf16(&units[from as usize..to as usize]).unwrap()
    }

    #[test]
    fn flags_misspelling_with_suggestion() {
        let text = "This is teh test.";
        let issues = check(text, GrammarFileType::Md);
        let issue = issues
            .iter()
            .find(|i| i.problem == "teh")
            .expect("teh flagged");
        assert_eq!(issue.kind, GrammarIssueKind::Spelling);
        assert!(issue.suggestions.contains(&"the".to_string()));
        assert_eq!(utf16_slice(text, issue.from, issue.to), "teh");
    }

    #[test]
    fn flags_grammar_as_grammar() {
        let issues = check("This is an test of the checker.", GrammarFileType::Md);
        let issue = issues
            .iter()
            .find(|i| i.problem == "an")
            .expect("an flagged");
        assert_eq!(issue.kind, GrammarIssueKind::Grammar);
        assert_eq!(issue.suggestions, vec!["a".to_string()]);
    }

    #[test]
    fn utf16_offsets_after_emoji_and_accent() {
        let text = "Café “quoted” 🎉 and teh end.";
        let issues = check(text, GrammarFileType::Md);
        let issue = issues
            .iter()
            .find(|i| i.problem == "teh")
            .expect("teh flagged");
        assert_eq!(utf16_slice(text, issue.from, issue.to), "teh");
    }

    #[test]
    fn skips_code_and_urls() {
        let text = "Run `npm instal` first.\n\n```js\nconst x = 'speling'\n```\n\nSee https://example.com/teh-pagge for more.\n";
        let issues = check(text, GrammarFileType::Md);
        assert!(issues.is_empty(), "unexpected issues: {issues:?}");
    }

    #[test]
    fn mdx_masks_imports_tags_and_expressions() {
        let text = "import Foo from '../components/Foo.astro'\n\n<Callout type=\"warning\" title=\"Heads upp\">\n\nAll good here.\n\n</Callout>\n\nText with <Badge text=\"Neww\" /> inline and {frontmatter.titel} too.\n";
        let issues = check(text, GrammarFileType::Mdx);
        assert!(issues.is_empty(), "unexpected issues: {issues:?}");
    }

    #[test]
    fn mdx_masks_multi_line_component_tags() {
        let text = "<Card\n  title=\"Speling\"\n  icon=\"starr\"\n>\n\nFine words.\n\n</Card>\n";
        let issues = check(text, GrammarFileType::Mdx);
        assert!(issues.is_empty(), "unexpected issues: {issues:?}");
    }

    #[test]
    fn mdx_checks_text_between_component_lines() {
        let text = "<Callout>\nThis is teh text inside.\n</Callout>\n";
        let issues = check(text, GrammarFileType::Mdx);
        assert!(
            issues.iter().any(|i| i.problem == "teh"),
            "text inside a component wasn't checked: {issues:?}"
        );
    }

    #[test]
    fn dictionary_word_is_not_flagged_in_any_case() {
        let mut checker = Checker::new(GrammarDialect::American, vec!["Kevvin".to_string()]);
        let issues = checker.check("Kevvin wrote this, and kevvin agreed.", GrammarFileType::Md);
        assert!(
            !issues
                .iter()
                .any(|i| i.problem.eq_ignore_ascii_case("kevvin")),
            "dictionary word flagged: {issues:?}"
        );
    }

    #[test]
    fn dialect_changes_spelling() {
        let text = "The colour of the sky.";
        let american =
            Checker::new(GrammarDialect::American, vec![]).check(text, GrammarFileType::Md);
        let british =
            Checker::new(GrammarDialect::British, vec![]).check(text, GrammarFileType::Md);
        assert!(american.iter().any(|i| i.problem == "colour"));
        assert!(!british.iter().any(|i| i.problem == "colour"));
    }

    #[test]
    fn overlapping_issues_keep_one() {
        let issues = check("I saw teh dog.", GrammarFileType::Md);
        let on_teh = issues.iter().filter(|i| i.problem == "teh").count();
        assert_eq!(on_teh, 1, "{issues:?}");
    }

    #[test]
    fn matches_compares_dialect_and_words() {
        let checker = Checker::new(GrammarDialect::British, vec!["a".to_string()]);
        assert!(checker.matches(GrammarDialect::British, &["a".to_string()]));
        assert!(!checker.matches(GrammarDialect::American, &["a".to_string()]));
        assert!(!checker.matches(GrammarDialect::British, &[]));
    }
}
