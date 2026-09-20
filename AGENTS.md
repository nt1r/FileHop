# FileHop Agent Guide

FileHop is a lightweight, self-hosted text and file exchange tool for desktop Web and Android. This guide defines how to work in the repository; product behavior belongs in the linked documents.

## Read Before Acting

- Before implementing or reviewing business behavior, read [CONTEXT.md](CONTEXT.md) for domain vocabulary and [docs/product.md](docs/product.md) for scope and constraints.
- Before selecting implementation work, read [docs/roadmap.md](docs/roadmap.md) and the relevant Spec linked there. Follow the current request rather than automatically advancing to the next stage.
- Before writing tests, fixing defects, or assessing delivery readiness, read [docs/testing.md](docs/testing.md). Agree on the public boundaries under test before adding tests.
- For changes spanning authentication, file lifecycle, client behavior, or deployment, read the affected Specs and their cross-references. Read unrelated Specs only when needed.
- Before creating or updating a PR description, read [.github/pull_request_template.md](.github/pull_request_template.md) and follow its structure.

## Sources of Truth

- `CONTEXT.md` defines domain terms, not implementation details.
- `docs/product.md` defines product scope and shared constraints.
- `docs/specs/` defines slice-specific behavior, technical contracts, and acceptance criteria.
- `docs/roadmap.md` maps delivery stages to Specs.
- `docs/testing.md` defines testing and delivery quality principles.
- An approved Spec is not evidence that a feature has been implemented or verified.
- Surface conflicting requirements before implementing the disputed behavior. Keep confirmed scope intact unless the user authorizes a change.
- When an authorized change alters a contract, update its authoritative document and affected references together. Keep detailed requirements out of this guide.

## Implementation Workflow

1. Inspect the repository and existing changes; preserve unrelated work.
2. Identify the applicable Spec, acceptance criteria, and smallest useful delivery slice.
3. Inspect existing build configuration and scripts before choosing commands or introducing tooling. If a command or capability is missing, report that rather than claiming it exists.
4. Implement and verify one coherent behavior at a time. Keep later-stage features outside the current slice unless requested.
5. Use the testing principles to cover risk at appropriate boundaries; avoid coupling tests to private implementation structure.
6. Check the resulting diff and any documentation affected by the change.

For reviews, report concrete findings with file references, consequences, and recommended fixes. Distinguish contract violations from optional improvements. A review request alone does not authorize edits or deployment.

## VPS and External-System Safety

The development machine is a VPS that may also host production. Treat repository access as development access, not blanket production authorization.

- Use isolated temporary databases and file directories for tests and failure injection. Verify resolved paths before destructive cleanup.
- Keep production data, credentials, and genuine user content out of source control, test fixtures, logs, screenshots, and published artifacts.
- Obtain explicit authorization before production deployment or migration, deletion of persistent data, changes to the shared Caddy entrypoint or network access, and mutations to GitHub repository settings, packages, or releases.
- Permission to edit a deployment script or document is not permission to execute it against production.
- Preserve existing remote-management access. Inspect environment configuration without printing secret values.
- Report external actions separately from local edits; a documented plan must not be presented as an applied setting.

## Completion Reporting

- Summarize changed behavior and relevant file paths.
- List checks actually executed and their outcomes. Distinguish static document checks from builds, automated tests, and real deployment or device validation.
- State unverified requirements, environment blockers, and remaining risks explicitly.
- Reference Spec acceptance identifiers where useful; do not duplicate whole acceptance lists.

## Maintaining This Guide

Keep `AGENTS.md` in English and focused on navigation, workflow, and safety. Existing product documents may remain in Chinese. Add local guides only when a directory has distinct rules that cannot be expressed economically here. Keep transient progress and easily discoverable command lists in their appropriate sources, not this file.
