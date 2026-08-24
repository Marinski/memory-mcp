# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, use [GitHub's private vulnerability reporting](../../security/advisories/new)
for this repository (Security tab → "Report a vulnerability"). This opens a
private advisory thread visible only to maintainers until a fix is ready.

If private reporting isn't available, open a regular issue with minimal
detail asking for a private contact channel, and a maintainer will follow up.

Please include:
- A description of the vulnerability and its impact
- Steps to reproduce (a minimal repro is ideal)
- Affected version/commit

## Scope and threat model

memory-mcp is designed to run **behind a private network boundary** (a
WireGuard interface or equivalent) with no direct internet exposure. The
built-in `AUTH_MODE=static` bearer token is a v1 authentication mechanism
suitable for a trusted private network — it is **not** designed to withstand
exposure to the public internet. If you expose this service beyond a private
network, put a proper authenticating reverse proxy or gateway in front of it.

Particular areas maintainers care about:
- **Secret scrubbing bypass** — anything that lets a credential/secret reach
  Qdrant or Postgres despite the scrub step in `packages/core/src/ingest/scrub.ts`.
- **Auth bypass** — any way to call MCP tools/resources without a valid bearer
  token, or a timing side-channel in the bearer comparison.
- **`forget` incompleteness** — any path where a deleted fact or archive chunk
  remains queryable after a confirmed `forget` call.
- **Prompt injection via archive content** — since episodic archive chunks are
  historical (and thus untrusted) text, we wrap them in delimited blocks in
  tool results; a way to break out of that framing is in scope.

## Supported versions

This project does not yet have a stable release line — security fixes land on
the default branch. Pin to a specific commit if you need reproducibility.
