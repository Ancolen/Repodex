# Security Policy

## Supported versions

Only the latest release is supported; older versions should be upgraded.

## Reporting a vulnerability

Please report vulnerabilities privately rather than opening a public issue:

- Prefer GitHub's **Private vulnerability reporting** on this repository, or
- email the maintainer directly (see the commit history / GitHub profile).

Include a description, reproduction steps, and the affected version. You'll get
a response within a few days; coordinated disclosure is appreciated.

## Scope notes

The daemon is designed to run **locally, for one user**:

- Both servers bind to `127.0.0.1` only; do not change `host` in the config to
  expose them on the network. The API is unauthenticated by design — it can
  read any indexed source code, index arbitrary directories, and shut the
  daemon down.
- CORS is restricted to localhost origins and every endpoint validates the
  `Host` header (DNS-rebinding protection).

Reports that only apply when these defaults are deliberately weakened are
low severity, but are still worth reporting.