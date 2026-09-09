# Security policy

Report vulnerabilities privately to the maintainer email in `package.json` (or via GitHub private vulnerability reporting). Please do not open public issues for security problems.

Scope of particular interest: anything that lets a hook leak tool input beyond localhost, daemon endpoints reachable from other hosts, and device-token handling (`fitgate login`/`fitgate sync`). Server-side issues (review tokens, webhooks, health-profile handling) belong to the FitGate Cloud/server codebase, not this repo.

We aim to acknowledge within 72 hours and fix within 30 days.
