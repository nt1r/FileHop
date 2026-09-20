# Contributing

- `dev` is the repository's default branch. Start a working branch from `dev` and open its pull request against `dev`; verify the base before submitting.
- Open release pull requests from this repository's `dev` branch into `main`.
- Direct pushes, force pushes, and deletion of `main` or `dev` are blocked.
- Both branches require the `main-source-policy` check and resolved review conversations. No approving review is required while this is a solo project.
- PRs into `dev` allow only **Squash and merge**; keep each task as one commit.
- PRs into `main` allow only **Create a merge commit** for `dev` → `main`; preserve the ancestry of these long-lived branches. Bring `main` back into a working branch when necessary to satisfy up-to-date checks.
- The PR template lives in [`.github/pull_request_template.md`](.github/pull_request_template.md). Follow [the quality principles](docs/testing.md) and the relevant [Spec](docs/roadmap.md).

The current workflow checks PR branch policy only. Application build, test, and release workflows are not implemented yet. Creating branches or merging a PR does not deploy the application.
