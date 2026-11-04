//! Does a repository look like an Astro site? Answered for many repositories at once
//! through GitHub's GraphQL API (one query per ~50 repositories, using aliases), so
//! the Open from GitHub list can hide everything that isn't a site.
//!
//! A repository is Astro when its default branch's root has an `astro.config.*` file,
//! or its root `package.json` lists `astro` in `dependencies` or `devDependencies`.

use super::http::GitHubClient;
use super::{AstroCheck, RepoAstroCheck};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;

/// Repositories per GraphQL query
const BATCH_SIZE: usize = 50;
/// A `package.json` bigger than this is treated as "no"
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
    let config_fields: String = CONFIG_FILES
        .iter()
        .enumerate()
        .map(|(i, file)| format!("c{i}: object(expression: \"HEAD:{file}\") {{ __typename }} "))
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

fn package_lists_astro(blob: &Blob) -> bool {
    if blob.is_truncated == Some(true) || blob.byte_size.unwrap_or(0) > MAX_PACKAGE_JSON_BYTES {
        return false;
    }
    let Some(text) = blob.text.as_deref() else {
        return false;
    };
    let Ok(json) = serde_json::from_str::<Value>(text) else {
        return false;
    };
    ["dependencies", "devDependencies"]
        .iter()
        .any(|key| json.get(key).and_then(|d| d.get("astro")).is_some())
}

fn judge(node: Option<&RepoNode>) -> AstroCheck {
    let Some(node) = node else {
        return AstroCheck::Unknown;
    };
    // No default branch: an empty repository
    if node
        .default_branch_ref
        .as_ref()
        .map_or(true, Value::is_null)
    {
        return AstroCheck::Unknown;
    }
    let has_config = (0..CONFIG_FILES.len()).any(|i| {
        node.rest
            .get(&format!("c{i}"))
            .is_some_and(|v| !v.is_null())
    });
    let in_package = node.package.as_ref().is_some_and(package_lists_astro);
    if has_config || in_package {
        AstroCheck::Astro
    } else {
        AstroCheck::NotAstro
    }
}

async fn check_batch(
    client: &GitHubClient,
    token: &str,
    batch: &[(String, String, String)],
) -> Result<Vec<RepoAstroCheck>, String> {
    let mut variables = serde_json::Map::new();
    for (i, (_, owner, name)) in batch.iter().enumerate() {
        variables.insert(format!("o{i}"), json!(owner));
        variables.insert(format!("n{i}"), json!(name));
    }
    let response: GraphQlResponse = client
        .graphql(token, &build_query(batch.len()), &Value::Object(variables))
        .await?;
    // Errors for single repositories leave a null in `data`, which is "unknown"
    let data = response.data.unwrap_or_default();
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
/// `unknown`. A request that fails as a whole (offline, signed out) is an error.
pub async fn check_repos(
    client: &GitHubClient,
    token: &str,
    full_names: &[String],
) -> Result<Vec<RepoAstroCheck>, String> {
    let valid: Vec<(String, String, String)> = full_names
        .iter()
        .filter_map(|full| {
            let (owner, name) = full.split_once('/')?;
            (!owner.is_empty() && !name.is_empty() && !name.contains('/'))
                .then(|| (full.clone(), owner.to_string(), name.to_string()))
        })
        .collect();
    let mut answers: HashMap<String, AstroCheck> = HashMap::new();
    for batch in valid.chunks(BATCH_SIZE) {
        for answer in check_batch(client, token, batch).await? {
            answers.insert(answer.full_name, answer.check);
        }
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
                    json!({"__typename": "Blob"})
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
                "r2": node(None, Some("not json"), false),
                "r3": node(None, Some(r#"{"name":"astro-notes"}"#), false),
            }),
            &["k/a", "k/b", "k/c", "k/d"],
            None,
        )
        .await;
        assert_eq!(got, vec![AstroCheck::NotAstro; 4]);
    }

    #[tokio::test]
    async fn a_huge_package_json_counts_as_no() {
        let blob = Blob {
            byte_size: Some(MAX_PACKAGE_JSON_BYTES + 1),
            is_truncated: Some(false),
            text: Some(r#"{"dependencies":{"astro":"1"}}"#.into()),
        };
        assert!(!package_lists_astro(&blob));
    }

    #[tokio::test]
    async fn an_empty_repository_is_unknown() {
        let got = run(json!({"r0": node(None, None, true)}), &["k/empty"], None).await;
        assert_eq!(got, vec![AstroCheck::Unknown]);
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
}
