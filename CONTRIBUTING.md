# Contributing

See the [development guide](docs/development.md) for toolchains, build/test commands, and isolated development setup.

- `dev` is the repository's default branch. Start a working branch from `dev` and open its pull request against `dev`; verify the base before submitting.
- Open release pull requests from this repository's `dev` branch into `main`.
- Direct pushes, force pushes, and deletion of `main` or `dev` are blocked.
- Both branches require the `main-source-policy` check and resolved review conversations. No approving review is required while this is a solo project.
- PRs into `dev` allow only **Squash and merge**; keep each task as one commit.
- PRs into `main` allow only **Create a merge commit** for `dev` → `main`; preserve the ancestry of these long-lived branches. Bring `main` back into a working branch when necessary to satisfy up-to-date checks.
- The PR template lives in [`.github/pull_request_template.md`](.github/pull_request_template.md). Follow [the quality principles](docs/testing.md) and the relevant [Spec](docs/roadmap.md).

Workflows check PR branch policy and run application builds, static checks, real-storage tests, browser smoke, shell syntax, and Compose configuration validation on GitHub-hosted runners. Development PRs additionally build test images and run isolated container smoke when container, dependency, toolchain, build configuration, migration, or CI/test orchestration paths change. PRs into `main` always run those container checks; pushes to `dev`/`main` run the base checks only. Manual Application checks runs include the full container checks. See the [development guide](docs/development.md#github-actions-检查分层) for selection details and limitations.

Test images are loaded only into the runner, not published. Production ARM64 artifact publishing from eligible version tags on `main` is specified but not implemented yet. Creating branches or merging a PR does not deploy the application.
