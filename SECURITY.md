# Security policy

## Supported versions

Security fixes are applied to the latest published version and the default branch.

## Reporting a vulnerability

Please use GitHub's private security-advisory flow for this repository. Do not open a public issue containing credentials, exploit details, or sensitive provider responses. If private reporting is not available, open a minimal issue asking the maintainer for a private contact channel without including sensitive details.

## Scope

This project is read-only. It should never place trades, execute arbitrary commands supplied through market data, or expose configured API keys in responses or logs. Relevant reports include:

- credential disclosure
- command or code execution
- path traversal or unsafe local-file access
- prompt-injection behavior caused by treating upstream data as instructions
- schema bypasses that permit unbounded or unintended network requests
- dependency or release-pipeline compromise

Market-data inaccuracies, delayed quotes, provider outages, and upstream rate limiting are reliability issues rather than security vulnerabilities unless they create one of the impacts above.
