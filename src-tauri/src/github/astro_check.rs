//! Does a repository look like an Astro site? Answered for many repositories at once
//! through GitHub's GraphQL API (one query per 25 to 50 repositories, using aliases,
//! at most three in flight), so the Open from GitHub list can hide everything that
//! isn't a site.
//!
//! A repository is Astro when its default branch's root has an `astro.config.*` file,
//! or its root `package.json` lists `astro` in `dependencies` or `devDependencies`.
//! A repository with no default branch (empty) is not Astro; one we can't read, or
//! whose `package.json` we can't judge, is unknown.

use super::http::{ApiError, GitHubClient};
use super::{AstroCheck, RepoAstroCheck};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tokio::time::Instant;

/// Repositories per GraphQL query
const BATCH_SIZE: usize = 50;
/// Smaller queries for an account with a lot of repositories
const BIG_ACCOUNT_BATCH_SIZE: usize = 25;
const BIG_ACCOUNT: usize = 300;
/// Queries in flight at once
const MAX_IN_FLIGHT: usize = 3;
/// The whole call gives up after this long; what isn't answered by then is unknown
const DEADLINE: Duration = Duration::from_secs(90);
/// A `Retry-After` longer than this isn't waited for
const MAX_RETRY_WAIT_SECS: u64 = 60;
/// A `package.json` bigger than this can't be judged
const MAX_PACKAGE_JSON_BYTES: u64 = 200 * 1024;
const CONFIG_FILES: [&str; 6] = [
    "astro.config.mjs",
    "astro.config.ts",
    "astro.config.js",
    "astro.config.cjs",
    "astro.config.mts",
    "astro.config.cts",
];

#[derive(Deserialize)]
struct GraphQlResponse {
    errors: Option<Vec<Value>>,
    data: Option<HashMap<String, Option<RepoNode>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepoNode {
    default_branch_ref: Option<Value>,
    #[serde(default)]
    package: Option<Blob>,
    #[serde(flatten)]
    rest: HashMap<String, Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Blob {
    byte_size: Option<u64>,
    is_truncated: Option<bool>,
    text: Option<String>,
}

fn build_query(count: usize) -> String {
    let vars: Vec<String> = (0..count)
        .map(|i| format!("$o{i}: String!, $n{i}: String!"))
        .collect();
    // `... on Blob`, so a folder with that name isn't mistaken for the file
    let config_fields: String = CONFIG_FILES
        .iter()
        .enumerate()
        .map(|(i, file)| {
            format!("c{i}: object(expression: \"HEAD:{file}\") {{ ... on Blob {{ oid }} }} ")
        })
        .collect();
    let repos: String = (0..count)
        .map(|i| {
            format!(
                "r{i}: repository(owner: $o{i}, name: $n{i}) {{ defaultBranchRef {{ name }} {config_fields}package: object(expression: \"HEAD:package.json\") {{ ... on Blob {{ byteSize isTruncated text }} }} }} "
            )
        })
        .collect();
    format!("query({}) {{ {repos}}}", vars.join(", "))
}

/// Whether `package.json` lists astro; `None` when it can't be judged (too big,
/// cut short, not text or not JSON)
fn package_lists_astro(blob: &Blob) -> Option<bool> {
    if blob.is_truncated == Some(true) || blob.byte_size.unwrap_or(0) > MAX_PACKAGE_JSON_BYTES {
        return None;
    }
    let text = blob.text.as_deref()?.trim_start_matches('\u{feff}');
    let json = serde_json::from_str::<Value>(text).ok()?;
    Some(
        ["dependencies", "devDependencies"]
            .iter()
            .any(|key| json.get(key).and_then(|d| d.get("astro")).is_some()),
    )
}

fn judge(node: Option<&RepoNode>) -> AstroCheck {
    let Some(node) = node else {
        return AstroCheck::Unknown;
    };
    // No default branch: an empty repository, which has no site in it
    if node
        .default_branch_ref
        .as_ref()
        .map_or(true, Value::is_null)
    {
        return AstroCheck::NotAstro;
    }
    // A match has an `oid`; a folder of that name gives an empty object
    let has_config = (0..CONFIG_FILES.len()).any(|i| {
        node.rest
            .get(&format!("c{i}"))
            .is_some_and(|v| v.get("oid").is_some())
    });
    if has_config {
        return AstroCheck::Astro;
    }
    match node.package.as_ref().map(package_lists_astro) {
        None | Some(Some(false)) => AstroCheck::NotAstro,
        Some(Some(true)) => AstroCheck::Astro,
        Some(None) => AstroCheck::Unknown,
    }
}

async fn query_batch(
    client: &GitHubClient,
    token: &str,
    batch: &[(String, String, String)],
) -> Result<Vec<RepoAstroCheck>, ApiError> {
    let mut variables = serde_json::Map::new();
    for (i, (_, owner, name)) in batch.iter().enumerate() {
        variables.insert(format!("o{i}"), json!(owner));
        variables.insert(format!("n{i}"), json!(name));
    }
    let variables = Value::Object(variables);
    let query = build_query(batch.len());
    let mut response: Result<GraphQlResponse, ApiError> =
        client.graphql(token, &query, &variables).await;
    // Rate limited: wait as long as GitHub asked (within reason) and try once more
    if let Err(ApiError {
        retry_after: Some(secs),
        ..
    }) = &response
    {
        if *secs <= MAX_RETRY_WAIT_SECS {
            tokio::time::sleep(Duration::from_secs(*secs)).await;
            response = client.graphql(token, &query, &variables).await;
        }
    }
    // Errors for single repositories leave a null in `data`, which is "unknown"
    let response = response?;
    // No data at all means the whole query failed, not just one repository
    let Some(data) = response.data else {
        let message = response
            .errors
            .as_deref()
            .and_then(|e| e.first())
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .map_or("GitHub sent no answer.".to_string(), |m| {
                format!("GitHub said: {m}")
            });
        return Err(ApiError {
            status: None,
            retry_after: None,
            message,
        });
    };
    Ok(batch
        .iter()
        .enumerate()
        .map(|(i, (full_name, _, _))| RepoAstroCheck {
            full_name: full_name.clone(),
            check: judge(data.get(&format!("r{i}")).and_then(Option::as_ref)),
        })
        .collect())
}

/// One answer per name, in the same order. Names that aren't "owner/name" are
/// `unknown`, and so is every repository in a query that failed. Only when every
/// query failed (offline, signed out, rate limited) is it an error, so answers
/// already gathered are never thrown away.
pub async fn check_repos(
    client: &GitHubClient,
    token: &str,
    full_names: &[String],
) -> Result<Vec<RepoAstroCheck>, String> {
    check_repos_within(client, token, full_names, DEADLINE).await
}

async fn check_repos_within(
    client: &GitHubClient,
    token: &str,
    full_names: &[String],
    deadline: Duration,
) -> Result<Vec<RepoAstroCheck>, String> {
    let valid: Vec<(String, String, String)> = full_names
        .iter()
        .filter_map(|full| {
            let (owner, name) = full.split_once('/')?;
            (!owner.is_empty() && !name.is_empty() && !name.contains('/'))
                .then(|| (full.clone(), owner.to_string(), name.to_string()))
        })
        .collect();
    let size = if valid.len() > BIG_ACCOUNT {
        BIG_ACCOUNT_BATCH_SIZE
    } else {
        BATCH_SIZE
    };
    let permits = Arc::new(Semaphore::new(MAX_IN_FLIGHT));
    let mut tasks = JoinSet::new();
    let batches: Vec<Vec<(String, String, String)>> =
        valid.chunks(size).map(<[_]>::to_vec).collect();
    let total = batches.len();
    for (index, batch) in batches.into_iter().enumerate() {
        let (client, token, permits) = (client.clone(), token.to_string(), permits.clone());
        tasks.spawn(async move {
            let _permit = permits.acquire().await;
            (index, query_batch(&client, &token, &batch).await)
        });
    }
    let mut answers: HashMap<String, AstroCheck> = HashMap::new();
    let mut failures: Vec<String> = Vec::new();
    let until = Instant::now() + deadline;
    let mut finished = 0;
    loop {
        let done = match tokio::time::timeout_at(until, tasks.join_next()).await {
            Ok(Some(done)) => done,
            Ok(None) => break,
            Err(_) => {
                log::warn!(
                    "Astro Editor [GITHUB] Checking repositories took too long; {} of {total} queries unanswered",
                    total - finished
                );
                tasks.abort_all();
                failures.extend((finished..total).map(|_| "Checking took too long.".to_string()));
                break;
            }
        };
        finished += 1;
        let Ok((index, result)) = done else {
            failures.push("The check stopped unexpectedly.".to_string());
            continue;
        };
        match result {
            Ok(checks) => answers.extend(checks.into_iter().map(|c| (c.full_name, c.check))),
            Err(e) => {
                log::warn!(
                    "Astro Editor [GITHUB] Checking repositories (query {} of {total}) failed: {}",
                    index + 1,
                    e.message
                );
                failures.push(e.message);
            }
        }
    }
    if total > 0 && failures.len() == total {
        return Err(failures.swap_remove(0));
    }
    Ok(full_names
        .iter()
        .map(|full| RepoAstroCheck {
            full_name: full.clone(),
            check: answers.get(full).copied().unwrap_or(AstroCheck::Unknown),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::Matcher;

    /// One repository's node in a mocked response
    fn node(config: Option<&str>, package: Option<&str>, empty: bool) -> Value {
        let mut n = serde_json::Map::new();
        n.insert(
            "defaultBranchRef".into(),
            if empty {
                Value::Null
            } else {
                json!({"name": "main"})
            },
        );
        for (i, file) in CONFIG_FILES.iter().enumerate() {
            n.insert(
                format!("c{i}"),
                if config == Some(file) {
                    json!({"oid": "abc123"})
                } else {
                    Value::Null
                },
            );
        }
        n.insert(
            "package".into(),
            match package {
                Some(text) => json!({"byteSize": text.len(), "isTruncated": false, "text": text}),
                None => Value::Null,
            },
        );
        Value::Object(n)
    }

    async fn run(data: Value, names: &[&str], errors: Option<Value>) -> Vec<AstroCheck> {
        let mut server = mockito::Server::new_async().await;
        let mut body = json!({ "data": data });
        if let Some(e) = errors {
            body["errors"] = e;
        }
        let mock = server
            .mock("POST", "/graphql")
            .match_header("authorization", "Bearer gho_t")
            .with_body(body.to_string())
            .create_async()
            .await;
        let client = GitHubClient::with_base_urls(&server.url(), &server.url());
        let names: Vec<String> = names.iter().map(|s| s.to_string()).collect();
        let out = check_repos(&client, "gho_t", &names).await.unwrap();
        mock.assert_async().await;
        out.into_iter().map(|a| a.check).collect()
    }

    #[tokio::test]
    async fn detects_a_config_file() {
        for file in CONFIG_FILES {
            let got = run(json!({"r0": node(Some(file), None, false)}), &["k/a"], None).await;
            assert_eq!(got, vec![AstroCheck::Astro], "{file}");
        }
    }

    #[tokio::test]
    async fn detects_astro_in_dependencies_and_dev_dependencies() {
        let got = run(
            json!({
                "r0": node(None, Some(r#"{"dependencies":{"astro":"^5.0.0"}}"#), false),
                "r1": node(None, Some(r#"{"devDependencies":{"astro":"^5.0.0"}}"#), false),
            }),
            &["k/a", "k/b"],
            None,
        )
        .await;
        assert_eq!(got, vec![AstroCheck::Astro, AstroCheck::Astro]);
    }

    #[tokio::test]
    async fn other_repositories_are_not_astro() {
        let got = run(
            json!({
                "r0": node(None, Some(r#"{"dependencies":{"react":"19"}}"#), false),
                "r1": node(None, None, false),
                "r2": node(None, Some(r#"{"name":"astro-notes"}"#), false),
            }),
            &["k/a", "k/b", "k/c"],
            None,
        )
        .await;
        assert_eq!(got, vec![AstroCheck::NotAstro; 3]);
    }

    fn blob(text: &str, byte_size: u64, truncated: bool) -> Blob {
        Blob {
            byte_size: Some(byte_size),
            is_truncated: Some(truncated),
            text: Some(text.to_string()),
        }
    }

    #[test]
    fn a_package_json_that_cannot_be_judged_is_none() {
        let astro = r#"{"dependencies":{"astro":"1"}}"#;
        assert_eq!(package_lists_astro(&blob(astro, 30, false)), Some(true));
        // A byte order mark in front is fine
        let with_bom = format!("\u{feff}{astro}");
        assert_eq!(package_lists_astro(&blob(&with_bom, 33, false)), Some(true));
        assert_eq!(
            package_lists_astro(&blob(astro, MAX_PACKAGE_JSON_BYTES + 1, false)),
            None
        );
        assert_eq!(package_lists_astro(&blob(astro, 30, true)), None);
        assert_eq!(package_lists_astro(&blob("{nope", 5, false)), None);
    }

    #[tokio::test]
    async fn a_package_json_that_cannot_be_judged_makes_the_repository_unknown() {
        let big = Blob {
            byte_size: Some(MAX_PACKAGE_JSON_BYTES + 1),
            is_truncated: Some(false),
            text: Some("{}".into()),
        };
        let mut n = node(None, None, false);
        n["package"] = json!({"byteSize": big.byte_size, "isTruncated": false, "text": big.text});
        let mut bad = node(None, None, false);
        bad["package"] = json!({"byteSize": 5, "isTruncated": false, "text": "{nope"});
        let got = run(json!({"r0": n, "r1": bad}), &["k/a", "k/b"], None).await;
        assert_eq!(got, vec![AstroCheck::Unknown; 2]);
    }

    #[tokio::test]
    async fn an_empty_repository_is_not_astro() {
        let got = run(json!({"r0": node(None, None, true)}), &["k/empty"], None).await;
        assert_eq!(got, vec![AstroCheck::NotAstro]);
    }

    #[tokio::test]
    async fn a_folder_named_like_a_config_file_does_not_count() {
        let mut n = node(None, None, false);
        n["c0"] = json!({});
        let got = run(json!({"r0": n}), &["k/a"], None).await;
        assert_eq!(got, vec![AstroCheck::NotAstro]);
    }

    #[tokio::test]
    async fn one_repository_failing_does_not_fail_the_batch() {
        let got = run(
            json!({"r0": Value::Null, "r1": node(Some("astro.config.mjs"), None, false)}),
            &["k/private", "k/site"],
            Some(json!([{"type": "NOT_FOUND", "path": ["r0"], "message": "Could not resolve"}])),
        )
        .await;
        assert_eq!(got, vec![AstroCheck::Unknown, AstroCheck::Astro]);
    }

    #[tokio::test]
    async fn more_than_fifty_repositories_go_in_several_queries() {
        let mut server = mockito::Server::new_async().await;
        let mut first = serde_json::Map::new();
        for i in 0..50 {
            first.insert(format!("r{i}"), node(Some("astro.config.ts"), None, false));
        }
        let first_mock = server
            .mock("POST", "/graphql")
            .match_body(Matcher::Regex(r#""o49":"k""#.into()))
            .with_body(json!({"data": first}).to_string())
            .expect(1)
            .create_async()
            .await;
        let second_mock = server
            .mock("POST", "/graphql")
            .match_body(Matcher::Regex(r#""n1":"repo-51""#.into()))
            .with_body(
                json!({"data": {"r0": node(None, None, false), "r1": node(None, None, false)}})
                    .to_string(),
            )
            .expect(1)
            .create_async()
            .await;
        let client = GitHubClient::with_base_urls(&server.url(), &server.url());
        let names: Vec<String> = (0..52).map(|i| format!("k/repo-{i}")).collect();
        let got = check_repos(&client, "t", &names).await.unwrap();
        first_mock.assert_async().await;
        second_mock.assert_async().await;
        assert_eq!(got.len(), 52);
        assert_eq!(got[49].check, AstroCheck::Astro);
        assert_eq!(got[50].check, AstroCheck::NotAstro);
        assert_eq!(got[51].full_name, "k/repo-51");
    }

    #[tokio::test]
    async fn bad_names_are_unknown_without_a_request() {
        let client = GitHubClient::with_base_urls("http://127.0.0.1:9", "http://127.0.0.1:9");
        let got = check_repos(&client, "t", &["nonsense".to_string()])
            .await
            .unwrap();
        assert_eq!(got[0].check, AstroCheck::Unknown);
    }

    #[tokio::test]
    async fn a_failed_query_leaves_the_other_answers_alone() {
        let mut server = mockito::Server::new_async().await;
        let mut first = serde_json::Map::new();
        for i in 0..50 {
            first.insert(format!("r{i}"), node(Some("astro.config.ts"), None, false));
        }
        server
            .mock("POST", "/graphql")
            .match_body(Matcher::Regex(r#""n1":"repo-1""#.into()))
            .with_body(json!({"data": first}).to_string())
            .create_async()
            .await;
        server
            .mock("POST", "/graphql")
            .match_body(Matcher::Regex(r#""n1":"repo-51""#.into()))
            .with_status(502)
            .create_async()
            .await;
        let client = GitHubClient::with_base_urls(&server.url(), &server.url());
        let names: Vec<String> = (0..52).map(|i| format!("k/repo-{i}")).collect();
        let got = check_repos(&client, "t", &names).await.unwrap();
        assert_eq!(got[0].check, AstroCheck::Astro);
        assert_eq!(got[49].check, AstroCheck::Astro);
        assert_eq!(got[50].check, AstroCheck::Unknown);
        assert_eq!(got[51].check, AstroCheck::Unknown);
    }

    #[tokio::test]
    async fn when_every_query_fails_it_is_an_error() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("POST", "/graphql")
            .with_status(502)
            .create_async()
            .await;
        let client = GitHubClient::with_base_urls(&server.url(), &server.url());
        let err = check_repos(&client, "t", &["k/a".to_string()])
            .await
            .unwrap_err();
        assert!(err.contains("GitHub returned an error"), "{err}");
    }

    #[tokio::test]
    async fn a_rate_limit_is_waited_out_once() {
        let mut server = mockito::Server::new_async().await;
        let limited = server
            .mock("POST", "/graphql")
            .with_status(429)
            .with_header("retry-after", "0")
            .expect(1)
            .create_async()
            .await;
        let ok = server
            .mock("POST", "/graphql")
            .with_body(
                json!({"data": {"r0": node(Some("astro.config.mjs"), None, false)}}).to_string(),
            )
            .expect(1)
            .create_async()
            .await;
        let client = GitHubClient::with_base_urls(&server.url(), &server.url());
        let got = check_repos(&client, "t", &["k/a".to_string()])
            .await
            .unwrap();
        limited.assert_async().await;
        ok.assert_async().await;
        assert_eq!(got[0].check, AstroCheck::Astro);
    }

    #[tokio::test]
    async fn big_accounts_use_smaller_queries() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/graphql")
            .with_body(json!({"data": {}}).to_string())
            .expect(13)
            .create_async()
            .await;
        let client = GitHubClient::with_base_urls(&server.url(), &server.url());
        let names: Vec<String> = (0..320).map(|i| format!("k/repo-{i}")).collect();
        check_repos(&client, "t", &names).await.unwrap();
        // 320 repositories in queries of 25 is 13 requests (50 would be 7)
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn queries_not_answered_by_the_deadline_are_unknown() {
        let mut server = mockito::Server::new_async().await;
        let mut first = serde_json::Map::new();
        for i in 0..50 {
            first.insert(format!("r{i}"), node(Some("astro.config.ts"), None, false));
        }
        server
            .mock("POST", "/graphql")
            .match_body(Matcher::Regex(r#""n1":"repo-1""#.into()))
            .with_body(json!({"data": first}).to_string())
            .create_async()
            .await;
        server
            .mock("POST", "/graphql")
            .match_body(Matcher::Regex(r#""n1":"repo-51""#.into()))
            .with_chunked_body(|w| {
                std::thread::sleep(Duration::from_millis(1500));
                w.write_all(b"{}")
            })
            .create_async()
            .await;
        let client = GitHubClient::with_base_urls(&server.url(), &server.url());
        let names: Vec<String> = (0..52).map(|i| format!("k/repo-{i}")).collect();
        let started = Instant::now();
        let got = check_repos_within(&client, "t", &names, Duration::from_millis(300))
            .await
            .unwrap();
        assert!(started.elapsed() < Duration::from_millis(1200));
        assert_eq!(got[0].check, AstroCheck::Astro);
        assert_eq!(got[50].check, AstroCheck::Unknown);
        assert_eq!(got[51].check, AstroCheck::Unknown);
    }

    #[tokio::test]
    async fn errors_with_no_data_are_a_failed_query() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("POST", "/graphql")
            .with_body(
                json!({"data": null, "errors": [{"message": "Something broke"}]}).to_string(),
            )
            .create_async()
            .await;
        let client = GitHubClient::with_base_urls(&server.url(), &server.url());
        let err = check_repos(&client, "t", &["k/a".to_string()])
            .await
            .unwrap_err();
        assert_eq!(err, "GitHub said: Something broke");

        // A missing `data` is the same
        let mut server = mockito::Server::new_async().await;
        server
            .mock("POST", "/graphql")
            .with_body(json!({"errors": [{"message": "Nope"}]}).to_string())
            .create_async()
            .await;
        let client = GitHubClient::with_base_urls(&server.url(), &server.url());
        assert!(check_repos(&client, "t", &["k/a".to_string()])
            .await
            .is_err());
    }
}
