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

## Pull Requests as a Triage Surface

**PRs as a request surface: no.**

## Scope of Setup

This configuration does not itself authorize creating issues, labels,
or changing repository settings. Follow the task's authorization and
the safety rules in AGENTS.md.
