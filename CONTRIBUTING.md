# Contributing

See the [development guide](docs/development.md) for toolchains, build/test commands, and isolated development setup.

- `dev` is the repository's default branch. Start a working branch from `dev` and open its pull request against `dev`; verify the base before submitting.
- Open release pull requests from this repository's `dev` branch into `main`.
- Direct pushes, force pushes, and deletion of `main` or `dev` are blocked.
- Both branches require the `main-source-policy` check and resolved review conversations. No approving review is required while this is a solo project.
- PRs into `dev` allow only **Squash and merge**; keep each task as one commit.
- PRs into `main` allow only **Create a merge commit** for `dev` → `main`; preserve the ancestry of these long-lived branches. Bring `main` back into a working branch when necessary to satisfy up-to-date checks.
- The PR template lives in [`.github/pull_request_template.md`](.github/pull_request_template.md). Follow [the quality principles](docs/testing.md) and the relevant [Spec](docs/roadmap.md).

## Public content checklist

Before committing, pushing, or publishing an Issue/PR or artifact:

1. Review the complete diff and outgoing text, including docs, comments, screenshots, traces, and logs. Check both secrets and identifying environment details.
2. Retain only facts needed to explain FileHop behavior, reproduce a test, or operate a generic deployment. Replace host-specific addresses/topology and personal paths with placeholders; summarize device testing without publishing a personal device inventory.
3. Keep unrelated host software and services out of public material. Permission to inspect or deploy, and diagnostics supplied in conversation, are not permission to publish them. Ask before publishing a necessary specific environment detail.
4. Record evidence as behavior → result → limitation, not a transcript of machine inspection. Keep private runbooks outside the repository.
5. If something was already published, sanitize current public surfaces and report which history remains. History rewriting/force-pushing requires explicit authorization and cannot guarantee removal from caches or clones.

See [AGENTS.md](AGENTS.md#public-repository-privacy) for the agent guardrails. Do not use a list of previously exposed real values as a committed regression fixture.

Workflows check PR branch policy and the initialization slice's application builds, static checks, real-storage tests, browser smoke, and isolated container smoke on GitHub-hosted runners. Release workflows are not implemented yet. Creating branches or merging a PR does not deploy the application.
