# Contributing

1. Create a focused branch from `main`.
2. Run `npm ci` and `npm run audit:ui`.
3. Keep account files, tokens, logs, build output, and local reference material out of commits.
4. Describe behavior changes and manual verification in the pull request.

Changes to OAuth, credential storage, account switching, or update delivery
must include failure-path testing and must never log authentication material.
