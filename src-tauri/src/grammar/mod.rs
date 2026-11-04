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

/// Style rules that underline a whole heading or sentence. They're matters of
/// house style rather than mistakes (many sites use sentence-case headings),
/// and an underline that long is the opposite of quiet
const RULES_OFF: [&str; 2] = ["UseTitleCase", "LongSentences"];

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
        let mut group = LintGroup::new_curated(dictionary.clone(), dialect.into());
        for rule in RULES_OFF {
            group.config.set_rule_enabled(rule, false);
        }
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
        // For MDX, `origin` maps each char Harper sees back to the text's
        let (source, masked, origin) = match file_type {
            GrammarFileType::Md => (chars.clone(), Vec::new(), None),
            GrammarFileType::Mdx => {
                let (blanked, masked) = mask_mdx(&chars);
                let (source, origin) = strip_indentation(&blanked);
                (source, masked, Some(origin))
            }
        };
        let source: String = source.iter().collect();
        let document = Document::new_markdown_default(&source, &*self.dictionary);

        let lints: Vec<(String, harper_core::linting::Lint)> = self
            .group
            .organized_lints(&document)
            .into_iter()
            .flat_map(|(rule, lints)| lints.into_iter().map(move |lint| (rule.clone(), lint)))
            .map(|(rule, mut lint)| {
                if let Some(origin) = &origin {
                    if lint.span.end > lint.span.start && lint.span.end < origin.len() {
                        let end = origin[lint.span.end - 1] + 1;
                        lint.span.start = origin[lint.span.start];
                        lint.span.end = end;
                    }
                }
                (rule, lint)
            })
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
        // typo for "the"), and underlines can't overlap, so keep one of each set
        let kept = keep_non_overlapping(lints, |(_, lint)| {
            (
                lint.span.start,
                lint.span.end,
                lint.lint_kind == LintKind::Spelling,
                lint.priority,
            )
        });

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

/// Drops items whose ranges overlap one already kept, keeping misspellings
/// first (they offer Add to dictionary), then the shorter range (so a broad
/// issue can't hide a typo inside it), then Harper's priority (lower is more
/// important). `key` gives (start, end, is spelling, priority). Returns the
/// kept items in text order
fn keep_non_overlapping<T>(
    mut items: Vec<T>,
    key: impl Fn(&T) -> (usize, usize, bool, u8),
) -> Vec<T> {
    items.sort_by_key(|item| {
        let (start, end, spelling, priority) = key(item);
        (!spelling, end - start, priority, start)
    });
    let mut kept: Vec<T> = Vec::new();
    for item in items {
        let (start, end, ..) = key(&item);
        let overlaps = kept.iter().any(|k| {
            let (k_start, k_end, ..) = key(k);
            start < k_end && k_start < end
        });
        if !overlaps {
            kept.push(item);
        }
    }
    kept.sort_by_key(|item| key(item).0);
    kept
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
            // ESM only starts a block, so a wrapped line of a paragraph that
            // happens to begin with "export " is still prose
            let starts_block = i == 0 || (i >= 2 && chars[i - 2] == '\n');
            if !in_fence
                && starts_block
                && (trimmed.starts_with("import ") || trimmed.starts_with("export "))
            {
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

/// Removes the spaces and tabs at the start of every line. MDX has no indented
/// code blocks, but Harper's Markdown parser does, so text indented inside a
/// component (Starlight's `<TabItem>`, say) would be skipped as code. Returns
/// the text and, for each of its chars plus the end, the index in `chars`
fn strip_indentation(chars: &[char]) -> (Vec<char>, Vec<usize>) {
    let mut out = Vec::with_capacity(chars.len());
    let mut origin = Vec::with_capacity(chars.len() + 1);
    let mut at_line_start = true;
    for (i, &c) in chars.iter().enumerate() {
        if at_line_start && (c == ' ' || c == '\t') {
            continue;
        }
        at_line_start = c == '\n';
        out.push(c);
        origin.push(i);
    }
    origin.push(chars.len());
    (out, origin)
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
    fn mdx_checks_indented_text_inside_components() {
        let text = "import { Tabs, TabItem } from '@astrojs/starlight/components';\n\n<Tabs>\n  <TabItem label=\"Stars\">\n    Sirius, Vega and teh rest of the sky.\n  </TabItem>\n  <TabItem label=\"Moons\">\n    Io, Europa, Ganymede and Callisto are teh big ones.\n  </TabItem>\n</Tabs>\n";
        let issues = check(text, GrammarFileType::Mdx);
        let tehs: Vec<_> = issues.iter().filter(|i| i.problem == "teh").collect();
        assert_eq!(tehs.len(), 2, "{issues:?}");
        for issue in tehs {
            assert_eq!(utf16_slice(text, issue.from, issue.to), "teh");
        }
    }

    #[test]
    fn mdx_checks_a_wrapped_line_that_starts_with_export() {
        let text = "You can save the page and\nexport teh file later.\n";
        let issues = check(text, GrammarFileType::Mdx);
        assert!(issues.iter().any(|i| i.problem == "teh"), "{issues:?}");
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

    const LONG_SENTENCE: &str = "This is a very long sentence that keeps going and going with many words in it so that it becomes far too long for a reader to follow comfortably and it also has teh misspelling hidden somewhere in the middle of all these words that keep on coming without any pause at all.";

    #[test]
    fn spelling_inside_a_long_sentence_is_flagged() {
        let issues = check(LONG_SENTENCE, GrammarFileType::Md);
        assert!(issues.iter().any(|i| i.problem == "teh"), "{issues:?}");
    }

    #[test]
    fn style_rules_that_cover_whole_lines_are_off() {
        let issues = check(
            &format!("# Writing with fewer words\n\n{LONG_SENTENCE}\n"),
            GrammarFileType::Md,
        );
        assert!(
            issues
                .iter()
                .all(|i| i.rule != "UseTitleCase" && i.rule != "LongSentences"),
            "{issues:?}"
        );
    }

    #[test]
    fn overlaps_keep_spelling_then_the_shorter_issue() {
        // (start, end, is spelling, priority)
        let kept = keep_non_overlapping(
            vec![
                (0, 16, false, 1),
                (8, 10, false, 1),
                (9, 12, true, 255),
                (20, 24, false, 1),
            ],
            |&(start, end, spelling, priority)| (start, end, spelling, priority),
        );
        assert_eq!(kept, vec![(9, 12, true, 255), (20, 24, false, 1)]);
    }

    /// About 5,000 words of varied prose with a misspelling every few sentences
    fn long_text() -> String {
        let words: Vec<&str> = "the quick writer keeps a steady rhythm while drafting long articles about design craft and the small decisions that shape a project from the first sketch to the final page".split(' ').collect();
        let mut seed = 4u64;
        let mut next = |n: usize| {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (seed >> 33) as usize % n
        };
        let mut paragraphs = Vec::new();
        let (mut count, mut sentence) = (0, 0);
        while count < 5000 {
            let mut sentences = Vec::new();
            for _ in 0..5 {
                let n = 12 + next(11);
                let mut w: Vec<&str> = (0..n).map(|_| words[next(words.len())]).collect();
                sentence += 1;
                if sentence % 7 == 0 {
                    w[next(n)] = "teh";
                }
                count += n;
                sentences.push(format!("{}.", w.join(" ")));
            }
            paragraphs.push(sentences.join(" "));
        }
        paragraphs.join("\n\n")
    }

    /// Timing check, not run by default:
    /// `cargo test --release --lib grammar::tests::timing -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn timing_long_text() {
        use std::time::Instant;
        let text = long_text();
        let started = Instant::now();
        let mut checker = Checker::new(GrammarDialect::American, vec![]);
        println!("build checker: {:?}", started.elapsed());
        for label in ["first check", "same text again"] {
            let started = Instant::now();
            let issues = checker.check(&text, GrammarFileType::Md);
            println!("{label}: {:?} ({} issues)", started.elapsed(), issues.len());
        }
        // The first long misspelling on a thread builds Harper's spelling
        // automaton, which is why checks run on one long-lived thread
        let started = Instant::now();
        checker.check("A qwrtzpklmnbvcx word.", GrammarFileType::Md);
        println!("a long misspelling: {:?}", started.elapsed());
        let edited = text.replacen("writer", "writers", 1);
        let started = Instant::now();
        checker.check(&edited, GrammarFileType::Md);
        println!("after a one-word edit: {:?}", started.elapsed());
    }

    #[test]
    fn matches_compares_dialect_and_words() {
        let checker = Checker::new(GrammarDialect::British, vec!["a".to_string()]);
        assert!(checker.matches(GrammarDialect::British, &["a".to_string()]));
        assert!(!checker.matches(GrammarDialect::American, &["a".to_string()]));
        assert!(!checker.matches(GrammarDialect::British, &[]));
    }
}
