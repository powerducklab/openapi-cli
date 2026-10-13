# Security review — 2026-10-13

Scope: HTML report serialization and rendering, response-controlled fields and execution dependencies.

P1: response/error content could terminate the embedded script in an HTML report. Escape less-than characters in serialized JSON and HTML-escape status text/method/protocol. Regression checks script boundaries and lossless JSON recovery.

Validation: package type checks, existing automated tests, targeted regression tests for changes, and release build/package checks. The complete pre-change test/type-check baseline passed for all 17 owned libraries. Final release validation is recorded by the release workflow.

This is a focused P0/P1 review, not a guarantee that all vulnerabilities are absent. npm advisory severity alone is not evidence that a particular application path is exploitable.

Runtime metadata now requires Node.js 22+, matching the existing Scalar dependency requirement instead of claiming unsupported Node.js 18 compatibility. Browser entry points remain unchanged.
