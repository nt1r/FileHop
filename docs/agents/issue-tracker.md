# Issue Tracker: GitHub

Track implementation tasks, bugs, and proposals in GitHub Issues for
`nt1r/FileHop`. Use the `gh` CLI.

## Sources of Truth

- Approved Specs in `docs/specs/` remain authoritative for behavior and
  acceptance criteria.
- Issues reference the relevant Spec and acceptance identifiers; do not
  duplicate full Specs.
- Proposals in issues do not change approved requirements automatically.
- Move a Spec's authority to an issue only with explicit agreement, and
  update repository references to avoid parallel authoritative copies.

## Public Content

Before creating or updating bodies, comments, or linked evidence, apply the
[public content checklist](../../CONTRIBUTING.md#public-content-checklist).
Issues and PRs are public: summarize project behavior and results, not private
machine inspection. User-provided diagnostics are not publication consent.

## Updating Existing Issues: Body First

For an authorized issue update, edit the existing issue body by default.
Keep progress, findings, decisions, references, verification results, and
closure summaries in the relevant sections so the body reflects the
current state without requiring readers to reconstruct it from comments.

- Read the latest body and comments before editing. Preserve relevant
  existing content and user-authored context; merge changes into the
  appropriate sections rather than replacing the body with a status report.
- Routine updates and closure need only a body edit (if content changed)
  and the appropriate state or label change, not an accompanying comment.
- Add a comment only when the user explicitly requests one, or when a
  conversational reply or question to another participant is needed.
  Keep confirmed outcomes in the body; avoid duplicating the body update
  in a separate comment.
- If the body cannot be edited, report the blocker and ask how to proceed
  rather than silently falling back to a comment.

Skill or workflow instructions to "update the issue", "record findings",
"capture the outcome", or "leave a reference on the issue" follow this
body-first policy unless the user explicitly requests a comment.

## Operations

Confirm the target repository from `git remote -v`. Use an explicit
`--repo nt1r/FileHop` when operating outside the clone.

- Read: `gh issue view <number> --comments`
- Read structured details:
  `gh issue view <number> --json number,title,body,labels,comments,state`
- List: `gh issue list --state open --json number,title,labels`
- Create: `gh issue create --title "..." --body-file <file>`
- Update body (default): `gh issue edit <number> --body-file <file>`
- Comment (exceptions above only):
  `gh issue comment <number> --body-file <file>`
- Label: `gh issue edit <number> --add-label "..." --remove-label "..."`
- Close: `gh issue close <number>` (update the body first if a closure
  summary is needed)

Use a file or heredoc for multiline bodies rather than interpolating
untrusted text into shell commands.

When a skill says "publish to the issue tracker", create a GitHub issue
within the user's authorized task. When it says "fetch the relevant
ticket", read the issue, labels, and comments.

GitHub issues and PRs share a number space. Resolve whether a reference
is an issue or PR before acting; use `gh pr view` and `gh pr diff` for PRs.

## Linking Pull Requests to Issues

Read each target issue's body and comments, then use visible references in
[the PR template](../../.github/pull_request_template.md):

- `Closes #123`: fully resolved or otherwise ready for closure; explain any
  closure reason other than full implementation. Repeat the keyword per issue.
- `Closes` also applies when only simple manual acceptance checks remain.
  List pending steps, expected results, and relevant acceptance IDs in Evidence;
  notify the user and wait for confirmation that all criteria pass before merge.
  Pending is not passed; missing work, known defects, and substantial unverified
  risks do not qualify for this exception.
- `Refs #123`: should remain open after merge. If verification fails, fix before
  merge or use `Refs` and leave the remaining scope open.

Use `Closes owner/repo#123` across repositories. GitHub closes issues on merge
into the default branch without checking acceptance results; leave them open
until then. For other target branches, carry closing references into the eventual
PR to the default branch.

## Pull Requests as a Triage Surface

**PRs as a request surface: no.**

## Scope of Setup

This configuration does not itself authorize creating issues, labels,
or changing repository settings. Follow the task's authorization and
the safety rules in AGENTS.md.
