# Changelog

All notable changes to this package. Versions follow [Semantic Versioning](https://semver.org).

## 1.1.0 — 2026-10-29

First public release.

- Transactional tools: `send_email`, `send_batch`, `get_email`, `list_emails`, `cancel_email`, `list_domains`, with MCP annotations (read-only vs destructive) so clients can auto-approve lookups.
- Idempotency keys on both sends; `send_batch` validates each email.
- Errors keep the API's code. Rate limits are retried; quota limits (`daily_quota_exceeded`, `warmup_limit_exceeded`) and long `Retry-After`s are returned at once.
- Requires Node.js 20+.
