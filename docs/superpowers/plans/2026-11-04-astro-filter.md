# Astro-only Open from GitHub

1. Rust: `github::astro_check` (GraphQL, 50 per query, aliases), `GitHubClient::graphql`, `pushed_at` on `RepoSummary`, command `github_check_astro_repos`; mockito tests.
2. Frontend: `lib/git/astro-sites.ts` (localStorage cache keyed by name + push, show-all choice, filter), `useAstroSiteStatus` (chunked queries).
3. Dialog: switch, "Checking…" / "Couldn't check" rows, empty state with a Show all button.
4. Docs in `docs/developer/git-and-github.md`; styleguide states.
5. Verify with `bun run check:all` and screenshots (mocked repos: not signed in).
