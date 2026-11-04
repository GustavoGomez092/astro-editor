//! Pull requests for the current repository: list (with checks and mergeability),
//! open, and merge (merge commit only, so a long-lived branch never drifts from the
//! default branch).

use super::http::GitHubClient;
use super::{ChecksSummary, PullRequest, PullRequestState};
use serde::Deserialize;
use serde_json::json;

pub struct RepoRef<'a> {
    pub owner: &'a str,
    pub repo: &'a str,
}

impl RepoRef<'_> {
    fn path(&self, rest: &str) -> String {
        format!("/repos/{}/{}{rest}", self.owner, self.repo)
    }
}

#[derive(Deserialize)]
struct ApiBranch {
    #[serde(rename = "ref")]
    name: String,
    sha: String,
}

#[derive(Deserialize)]
struct ApiPull {
    number: u32,
    title: String,
    state: String,
    #[serde(default)]
    draft: bool,
    html_url: String,
    merged_at: Option<String>,
    mergeable: Option<bool>,
    head: ApiBranch,
    base: ApiBranch,
}

#[derive(Deserialize)]
struct CombinedStatus {
    state: String,
    total_count: u32,
}

#[derive(Deserialize)]
struct CheckRun {
    status: String,
    conclusion: Option<String>,
}

#[derive(Deserialize)]
struct CheckRuns {
    check_runs: Vec<CheckRun>,
}

/// One summary from the commit's statuses and check runs: any failure wins, then
/// anything still running, then success; nothing reported is `none`
fn summarise(status: Option<&CombinedStatus>, runs: &[CheckRun]) -> ChecksSummary {
    let statuses = status.filter(|s| s.total_count > 0);
    let failed = statuses.is_some_and(|s| s.state == "failure" || s.state == "error")
        || runs.iter().any(|r| {
            matches!(
                r.conclusion.as_deref(),
                Some("failure" | "timed_out" | "cancelled" | "action_required" | "startup_failure")
            )
        });
    if failed {
        return ChecksSummary::Failure;
    }
    let pending = statuses.is_some_and(|s| s.state == "pending")
        || runs.iter().any(|r| r.status != "completed");
    if pending {
        return ChecksSummary::Pending;
    }
    if statuses.is_none() && runs.is_empty() {
        ChecksSummary::NoChecks
    } else {
        ChecksSummary::Success
    }
}

/// Checks for a commit. Best effort: if GitHub won't say, the PR shows no checks
/// rather than failing to load.
async fn checks_for(
    client: &GitHubClient,
    token: &str,
    repo: &RepoRef<'_>,
    sha: &str,
) -> ChecksSummary {
    let status_path = repo.path(&format!("/commits/{sha}/status"));
    let runs_path = repo.path(&format!("/commits/{sha}/check-runs?per_page=100"));
    let (status, runs) = tokio::join!(
        client.get::<CombinedStatus>(token, &status_path),
        client.get::<CheckRuns>(token, &runs_path),
    );
    let runs = runs.map(|r| r.check_runs).unwrap_or_default();
    summarise(status.ok().as_ref(), &runs)
}

async fn to_pull_request(
    client: &GitHubClient,
    token: &str,
    repo: &RepoRef<'_>,
    pull: ApiPull,
) -> PullRequest {
    let checks = checks_for(client, token, repo, &pull.head.sha).await;
    let state = if pull.merged_at.is_some() {
        PullRequestState::Merged
    } else if pull.state == "open" {
        PullRequestState::Open
    } else {
        PullRequestState::Closed
    };
    PullRequest {
        number: pull.number,
        title: pull.title,
        head: pull.head.name,
        base: pull.base.name,
        state,
        draft: pull.draft,
        html_url: pull.html_url,
        mergeable: pull.mergeable,
        checks,
    }
}

/// One pull request in full (the list endpoint leaves out `mergeable`)
async fn get_pull(
    client: &GitHubClient,
    token: &str,
    repo: &RepoRef<'_>,
    number: u32,
) -> Result<PullRequest, String> {
    let pull: ApiPull = client
        .get(token, &repo.path(&format!("/pulls/{number}")))
        .await?;
    Ok(to_pull_request(client, token, repo, pull).await)
}

/// Open pull requests, each with its checks and whether it can be merged
pub async fn list_pull_requests(
    client: &GitHubClient,
    token: &str,
    repo: &RepoRef<'_>,
) -> Result<Vec<PullRequest>, String> {
    let pulls: Vec<ApiPull> = client
        .get(token, &repo.path("/pulls?state=open&per_page=100"))
        .await?;
    let mut result = Vec::with_capacity(pulls.len());
    for pull in pulls {
        let number = pull.number;
        match get_pull(client, token, repo, number).await {
            Ok(full) => result.push(full),
            // Still list it, without mergeability
            Err(_) => result.push(to_pull_request(client, token, repo, pull).await),
        }
    }
    Ok(result)
}

pub async fn create_pull_request(
    client: &GitHubClient,
    token: &str,
    repo: &RepoRef<'_>,
    title: &str,
    body: &str,
    base: &str,
    head: &str,
) -> Result<PullRequest, String> {
    let body = json!({ "title": title, "body": body, "base": base, "head": head });
    let pull: ApiPull = client.post(token, &repo.path("/pulls"), &body).await?;
    Ok(to_pull_request(client, token, repo, pull).await)
}

/// Merge with a merge commit, then return the pull request as it now is
pub async fn merge_pull_request(
    client: &GitHubClient,
    token: &str,
    repo: &RepoRef<'_>,
    number: u32,
) -> Result<PullRequest, String> {
    let _: serde_json::Value = client
        .put(
            token,
            &repo.path(&format!("/pulls/{number}/merge")),
            &json!({ "merge_method": "merge" }),
        )
        .await?;
    get_pull(client, token, repo, number).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::github::http::NO_ACCESS;
    use crate::github::{ChecksSummary, PullRequestState};
    use mockito::{Matcher, Server};
    use serde_json::json;

    const REPO: RepoRef = RepoRef {
        owner: "kevin",
        repo: "site",
    };

    fn pr_json(
        number: u32,
        head: &str,
        sha: &str,
        merged: bool,
        mergeable: Option<bool>,
    ) -> String {
        json!({
            "number": number,
            "title": format!("PR {number}"),
            "state": if merged { "closed" } else { "open" },
            "draft": false,
            "html_url": format!("https://github.com/kevin/site/pull/{number}"),
            "merged_at": if merged { json!("2026-11-02T10:00:00Z") } else { json!(null) },
            "mergeable": mergeable,
            "head": { "ref": head, "sha": sha },
            "base": { "ref": "main", "sha": "base" }
        })
        .to_string()
    }

    async fn mock_checks(server: &mut Server, sha: &str, status: &str, runs: &str) {
        server
            .mock(
                "GET",
                format!("/repos/kevin/site/commits/{sha}/status").as_str(),
            )
            .with_body(status)
            .create_async()
            .await;
        server
            .mock(
                "GET",
                format!("/repos/kevin/site/commits/{sha}/check-runs").as_str(),
            )
            .match_query(Matcher::Any)
            .with_body(runs)
            .create_async()
            .await;
    }

    #[tokio::test]
    async fn list_prs_maps_checks_and_mergeable() {
        let mut server = Server::new_async().await;
        let list = format!(
            "[{},{},{},{}]",
            pr_json(1, "staging", "s1", false, None),
            pr_json(2, "fix", "s2", false, None),
            pr_json(3, "wip", "s3", false, None),
            pr_json(4, "docs", "s4", false, None)
        );
        server
            .mock("GET", "/repos/kevin/site/pulls")
            .match_query(Matcher::UrlEncoded("state".into(), "open".into()))
            .match_header("authorization", "Bearer gho_t")
            .with_body(list)
            .create_async()
            .await;
        for (n, head, sha, mergeable) in [
            (1, "staging", "s1", Some(true)),
            (2, "fix", "s2", Some(false)),
            (3, "wip", "s3", None),
            (4, "docs", "s4", Some(true)),
        ] {
            server
                .mock("GET", format!("/repos/kevin/site/pulls/{n}").as_str())
                .with_body(pr_json(n, head, sha, false, mergeable))
                .create_async()
                .await;
        }
        // 1: every check passed; 2: a check run failed; 3: still running; 4: no checks
        mock_checks(
            &mut server,
            "s1",
            r#"{"state":"success","total_count":1}"#,
            r#"{"total_count":1,"check_runs":[{"status":"completed","conclusion":"success"}]}"#,
        )
        .await;
        mock_checks(
            &mut server,
            "s2",
            r#"{"state":"success","total_count":1}"#,
            r#"{"total_count":2,"check_runs":[{"status":"completed","conclusion":"success"},{"status":"completed","conclusion":"failure"}]}"#,
        )
        .await;
        mock_checks(
            &mut server,
            "s3",
            r#"{"state":"pending","total_count":0}"#,
            r#"{"total_count":1,"check_runs":[{"status":"in_progress","conclusion":null}]}"#,
        )
        .await;
        mock_checks(
            &mut server,
            "s4",
            r#"{"state":"pending","total_count":0}"#,
            r#"{"total_count":0,"check_runs":[]}"#,
        )
        .await;
        let client = GitHubClient::with_base_urls(&server.url(), &server.url());

        let prs = list_pull_requests(&client, "gho_t", &REPO).await.unwrap();
        assert_eq!(prs.len(), 4);
        assert_eq!(
            prs[0],
            PullRequest {
                number: 1,
                title: "PR 1".to_string(),
                head: "staging".to_string(),
                base: "main".to_string(),
                state: PullRequestState::Open,
                draft: false,
                html_url: "https://github.com/kevin/site/pull/1".to_string(),
                mergeable: Some(true),
                checks: ChecksSummary::Success,
            }
        );
        assert_eq!(prs[1].mergeable, Some(false));
        assert_eq!(prs[1].checks, ChecksSummary::Failure);
        assert_eq!(prs[2].mergeable, None);
        assert_eq!(prs[2].checks, ChecksSummary::Pending);
        assert_eq!(prs[3].checks, ChecksSummary::NoChecks);
    }

    #[tokio::test]
    async fn create_pr_returns_pr() {
        let mut server = Server::new_async().await;
        let create = server
            .mock("POST", "/repos/kevin/site/pulls")
            .match_body(Matcher::Json(json!({
                "title": "Spring update",
                "body": "New posts",
                "base": "main",
                "head": "staging"
            })))
            .with_status(201)
            .with_body(pr_json(7, "staging", "s7", false, None))
            .create_async()
            .await;
        mock_checks(
            &mut server,
            "s7",
            r#"{"state":"pending","total_count":0}"#,
            r#"{"total_count":0,"check_runs":[]}"#,
        )
        .await;
        let client = GitHubClient::with_base_urls(&server.url(), &server.url());

        let pr = create_pull_request(
            &client,
            "gho_t",
            &REPO,
            "Spring update",
            "New posts",
            "main",
            "staging",
        )
        .await
        .unwrap();
        create.assert_async().await;
        assert_eq!(pr.number, 7);
        assert_eq!(pr.head, "staging");
        assert_eq!(pr.state, PullRequestState::Open);
        assert_eq!(pr.checks, ChecksSummary::NoChecks);
    }

    #[tokio::test]
    async fn create_pr_validation_error_is_readable() {
        let mut server = Server::new_async().await;
        server
            .mock("POST", "/repos/kevin/site/pulls")
            .with_status(422)
            .with_body(r#"{"message":"Validation Failed","errors":[{"message":"A pull request already exists for kevin:staging."}]}"#)
            .create_async()
            .await;
        let client = GitHubClient::with_base_urls(&server.url(), &server.url());
        let e = create_pull_request(&client, "gho_t", &REPO, "t", "", "main", "staging")
            .await
            .unwrap_err();
        assert_eq!(
            e,
            "GitHub said: A pull request already exists for kevin:staging."
        );
    }

    #[tokio::test]
    async fn merge_pr_uses_merge_method() {
        let mut server = Server::new_async().await;
        let merge = server
            .mock("PUT", "/repos/kevin/site/pulls/7/merge")
            .match_body(Matcher::PartialJson(json!({ "merge_method": "merge" })))
            .with_body(r#"{"sha":"m1","merged":true,"message":"Pull Request successfully merged"}"#)
            .expect(1)
            .create_async()
            .await;
        server
            .mock("GET", "/repos/kevin/site/pulls/7")
            .with_body(pr_json(7, "staging", "s7", true, None))
            .create_async()
            .await;
        mock_checks(
            &mut server,
            "s7",
            r#"{"state":"success","total_count":1}"#,
            r#"{"total_count":0,"check_runs":[]}"#,
        )
        .await;
        let client = GitHubClient::with_base_urls(&server.url(), &server.url());

        let pr = merge_pull_request(&client, "gho_t", &REPO, 7)
            .await
            .unwrap();
        merge.assert_async().await;
        assert_eq!(pr.state, PullRequestState::Merged);
        assert_eq!(pr.checks, ChecksSummary::Success);
    }

    #[tokio::test]
    async fn not_found_becomes_access_message() {
        for status in [404, 403] {
            let mut server = Server::new_async().await;
            server
                .mock("GET", "/repos/kevin/site/pulls")
                .match_query(Matcher::Any)
                .with_status(status)
                .with_body(r#"{"message":"Not Found"}"#)
                .create_async()
                .await;
            let client = GitHubClient::with_base_urls(&server.url(), &server.url());
            let e = list_pull_requests(&client, "gho_t", &REPO)
                .await
                .unwrap_err();
            assert_eq!(e, NO_ACCESS);
            assert_eq!(
                e,
                "Your GitHub account doesn't have access to this repository"
            );
        }
    }
}
