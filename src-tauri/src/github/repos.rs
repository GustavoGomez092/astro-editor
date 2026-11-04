//! Which GitHub repository a project is, and the signed-in user's repositories for
//! cloning.

use super::http::GitHubClient;
use super::{RepoInfo, RepoSummary};
use crate::git::status::default_branch;
use git2::Repository;
use serde::Deserialize;

/// Enough pages for 1,000 repositories
const MAX_PAGES: usize = 10;

/// `owner` and `repo` from a github.com remote URL (HTTPS or SSH), else `None`
pub fn parse_github_remote(url: &str) -> Option<(String, String)> {
    let url = url.trim();
    let path = if let Some(rest) = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .or_else(|| url.strip_prefix("ssh://"))
        .or_else(|| url.strip_prefix("git://"))
    {
        let (authority, path) = rest.split_once('/')?;
        let host = authority.rsplit('@').next()?.split(':').next()?;
        if !host.eq_ignore_ascii_case("github.com") && !host.eq_ignore_ascii_case("www.github.com")
        {
            return None;
        }
        path
    } else {
        // scp-like SSH: git@github.com:owner/repo.git
        let (authority, path) = url.split_once(':')?;
        let host = authority.rsplit('@').next()?;
        if !host.eq_ignore_ascii_case("github.com") {
            return None;
        }
        path
    };
    let mut parts = path.trim_matches('/').split('/');
    let owner = parts.next().filter(|s| !s.is_empty())?;
    let repo = parts.next()?;
    let repo = repo.strip_suffix(".git").unwrap_or(repo);
    if repo.is_empty() || parts.next().is_some() {
        return None;
    }
    Some((owner.to_string(), repo.to_string()))
}

/// The repository `origin` points at, if it's on github.com. Worked out locally, so
/// it's available offline and before signing in.
pub fn repo_info(repo: &Repository) -> Option<RepoInfo> {
    let origin = repo.find_remote("origin").ok()?;
    let (owner, name) = parse_github_remote(origin.url()?)?;
    Some(RepoInfo {
        html_url: format!("https://github.com/{owner}/{name}"),
        default_branch: default_branch(repo).unwrap_or_else(|| "main".to_string()),
        owner,
        repo: name,
    })
}

#[derive(Deserialize)]
struct ApiOwner {
    login: String,
}

#[derive(Deserialize)]
struct ApiRepo {
    full_name: String,
    name: String,
    owner: ApiOwner,
    private: bool,
    default_branch: String,
    clone_url: String,
    updated_at: String,
}

/// Repositories the user owns or collaborates on, most recently updated first
pub async fn list_repos(client: &GitHubClient, token: &str) -> Result<Vec<RepoSummary>, String> {
    let mut repos = Vec::new();
    let mut next =
        Some("/user/repos?affiliation=owner,collaborator&sort=updated&per_page=100".to_string());
    for _ in 0..MAX_PAGES {
        let Some(url) = next.take() else { break };
        let (page, link): (Vec<ApiRepo>, _) = client.get_page(token, &url).await?;
        repos.extend(page.into_iter().map(|r| RepoSummary {
            full_name: r.full_name,
            owner: r.owner.login,
            name: r.name,
            private: r.private,
            default_branch: r.default_branch,
            clone_url: r.clone_url,
            updated_at: r.updated_at,
        }));
        next = link;
    }
    Ok(repos)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::*;
    use mockito::Matcher;

    fn pair(owner: &str, repo: &str) -> Option<(String, String)> {
        Some((owner.to_string(), repo.to_string()))
    }

    #[test]
    fn repo_info_parses_https_and_ssh_origins() {
        assert_eq!(
            parse_github_remote("https://github.com/kevin/site.git"),
            pair("kevin", "site")
        );
        assert_eq!(
            parse_github_remote("https://github.com/kevin/site"),
            pair("kevin", "site")
        );
        assert_eq!(
            parse_github_remote("https://x-access-token@github.com/kevin/site.git/"),
            pair("kevin", "site")
        );
        assert_eq!(
            parse_github_remote("git@github.com:kevin/site.git"),
            pair("kevin", "site")
        );
        assert_eq!(
            parse_github_remote("ssh://git@github.com/kevin/my.site.git"),
            pair("kevin", "my.site")
        );
        assert_eq!(
            parse_github_remote("ssh://git@github.com:22/kevin/site"),
            pair("kevin", "site")
        );

        let setup = repo_with_remote();
        setup
            .local
            .remote_set_url("origin", "git@github.com:kevin/site.git")
            .unwrap();
        assert_eq!(
            repo_info(&setup.local),
            Some(RepoInfo {
                owner: "kevin".to_string(),
                repo: "site".to_string(),
                default_branch: "main".to_string(),
                html_url: "https://github.com/kevin/site".to_string(),
            })
        );
    }

    #[test]
    fn repo_info_non_github_is_none() {
        assert_eq!(
            parse_github_remote("https://gitlab.com/kevin/site.git"),
            None
        );
        assert_eq!(parse_github_remote("git@gitlab.com:kevin/site.git"), None);
        assert_eq!(
            parse_github_remote("https://github.com.evil.example/kevin/site"),
            None
        );
        assert_eq!(parse_github_remote("https://github.com/kevin"), None);
        assert_eq!(parse_github_remote("/tmp/remote"), None);

        // A local bare remote, and no remote at all
        let setup = repo_with_remote();
        assert_eq!(repo_info(&setup.local), None);
        let (_dir, plain) = init_repo();
        assert_eq!(repo_info(&plain), None);
    }

    #[tokio::test]
    async fn list_repos_paginates() {
        let mut server = mockito::Server::new_async().await;
        let repo_json = |name: &str, private: bool| {
            format!(
                r#"{{"full_name":"kevin/{name}","name":"{name}","owner":{{"login":"kevin"}},"private":{private},"default_branch":"main","clone_url":"https://github.com/kevin/{name}.git","updated_at":"2026-11-01T10:00:00Z"}}"#
            )
        };
        let page_two = format!("{}/user/repos?page=2", server.url());
        let first = server
            .mock("GET", "/user/repos")
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("affiliation".into(), "owner,collaborator".into()),
                Matcher::UrlEncoded("sort".into(), "updated".into()),
            ]))
            .match_header("authorization", "Bearer gho_t")
            .with_header("link", &format!(r#"<{page_two}>; rel="next""#))
            .with_body(format!("[{}]", repo_json("site", true)))
            .expect(1)
            .create_async()
            .await;
        let second = server
            .mock("GET", "/user/repos")
            .match_query(Matcher::UrlEncoded("page".into(), "2".into()))
            .with_body(format!("[{}]", repo_json("blog", false)))
            .expect(1)
            .create_async()
            .await;
        let client = GitHubClient::with_base_urls(&server.url(), &server.url());

        let repos = list_repos(&client, "gho_t").await.unwrap();
        first.assert_async().await;
        second.assert_async().await;
        assert_eq!(
            repos
                .iter()
                .map(|r| r.full_name.as_str())
                .collect::<Vec<_>>(),
            vec!["kevin/site", "kevin/blog"]
        );
        assert_eq!(
            repos[0],
            RepoSummary {
                full_name: "kevin/site".to_string(),
                owner: "kevin".to_string(),
                name: "site".to_string(),
                private: true,
                default_branch: "main".to_string(),
                clone_url: "https://github.com/kevin/site.git".to_string(),
                updated_at: "2026-11-01T10:00:00Z".to_string(),
            }
        );
    }
}
