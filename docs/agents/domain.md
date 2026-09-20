# Domain Documentation

This repository uses a single domain context.

## Before Exploration

- Read the root CONTEXT.md for domain vocabulary.
- If docs/adr/ exists, read decisions relevant to the area being changed.
- Follow AGENTS.md for product, Spec, and testing references.

If optional domain documents or ADR directories are absent, continue
without creating placeholders or treating their absence as a defect.

## Layout

- CONTEXT.md: domain terms and relationships, not implementation details.
- docs/adr/: architectural decisions, created only when warranted.

Do not introduce CONTEXT-MAP.md or per-module contexts merely because
Web, Rust, and Android use different languages.

## Consumer Rules

- Use the glossary's canonical terms in proposals, issues, tests, and code.
- If a necessary concept is missing or ambiguous, clarify it before
  introducing conflicting terminology.
- Surface conflicts with an existing ADR explicitly rather than silently
  overriding the decision.
- Add an ADR only for a meaningful trade-off that is costly to reverse
  and would otherwise be difficult for a future reader to understand.
