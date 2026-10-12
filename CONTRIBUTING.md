# Contributing

See the [development guide](docs/development.md) for toolchains, build/test commands, and isolated development setup.

- `dev` is the repository's default branch. For a task PR, use a working branch based on `dev` and verify the PR targets `dev`. A worktree created with its own task branch already satisfies this workflow: commit and push that branch instead of creating another at submission time. Create a branch only when no suitable task branch exists (for example, when working on `dev`).
- Open release pull requests from this repository's `dev` branch into `main`.
- Direct pushes, force pushes, and deletion of `main` or `dev` are blocked.
- Both branches require the `main-source-policy` check and resolved review conversations, but do not require PR branches to be up to date with the target branch before merging. Merge conflicts still need to be resolved. No approving review is required while this is a solo project.
- PRs into `dev` allow only **Squash and merge**; keep each task as one commit.
- PRs into `main` allow only **Create a merge commit** for `dev` → `main`; preserve the ancestry of these long-lived branches.
- The PR template lives in [`.github/pull_request_template.md`](.github/pull_request_template.md). Follow [the quality principles](docs/testing.md) and the relevant [Spec](docs/roadmap.md).

## Public content checklist

Treat tracked files, commit messages, Issue/PR bodies and comments, CI logs, and artifacts as public. Before committing, pushing, publishing, or handling an exposure:

1. Review the complete diff and outgoing text, including docs, comments, screenshots, traces, and logs. Check both secrets and identifying environment details.
2. Retain only facts needed to explain FileHop behavior, reproduce a test, or operate a generic deployment. Replace host-specific addresses/topology and personal usernames/paths with placeholders or reserved example addresses; use generic environment categories instead of device fingerprints. Redact screenshots, traces, and command output before publishing.
3. Keep unrelated host software and services out of public material. Permission to inspect or deploy, and diagnostics supplied in conversation, are not permission to publish them. Ask before publishing a necessary specific environment detail.
4. Keep private operational notes outside the repository and public tracker. Before choosing where to record evidence or durable guidance, follow the [evidence placement rules](docs/testing.md#5-与-spec-的对应及完成判定).
5. If something was already published, sanitize current public surfaces without repeating the exposed details, and report which history remains: deletion commits do not erase history. History rewriting/force-pushing requires explicit authorization and cannot guarantee removal from caches or clones. Do not commit previously exposed real values as regression fixtures.

## Checks and releases

Follow the [CI and delivery gates](docs/testing.md#4-ci-与交付门槛) to choose verification scope; commands and the manual Actions entrypoint are in the [development guide](docs/development.md#github-actions-与缓存). Documentation-only exemptions apply only to the configured allowlist, not to every Markdown file or workflow.

For artifact publication and manual deployment, follow [production operations](docs/production.md). Merging a PR does not deploy the application; remote settings and production operations require separate authorization.
