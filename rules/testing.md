# Testing Rules — Shared Template (customize per project)

## Requirements

- **Behavior changes require tests**: Any code change that alters behavior must include or update tests.
- **Prefer behavior tests over implementation-detail tests**: Test what the code does, not how it does it.
- **Cover boundary and failure cases**: Happy path alone is insufficient. Include edge cases, null/empty inputs, error conditions.
- **Do not weaken existing assertions**: Relaxing a test assertion requires explicit justification.
- **Tests must pass before completion**: No known failing tests at handoff.

## Test Isolation

Tests must not depend on execution order. Each test sets up its own state. Shared mutable state between tests (global variables, database rows, file system artifacts) is forbidden. Use setup/teardown hooks to guarantee a clean slate for every test case.

## Flaky Tests

Flaky tests (pass/fail intermittently) are bugs, not noise. Fix or quarantine within 24 hours. Common causes: race conditions, reliance on wall-clock time, shared state leakage, network-dependent assertions without mocks. Quarantined tests must have a tracking issue and a target fix date.

## Test Priority (P0 → P3)

| Priority | Type | Description |
|----------|------|-------------|
| P0 | Acceptance Criteria | One test per Given/When/Then scenario |
| P1 | Boundary Conditions | Edge cases, null/empty inputs, max/min values |
| P2 | Core Logic Units | Unit tests for key functions and state transitions |
| P3 | Integration | Cross-component interaction, API contracts |

## Coverage Target

- **80% or higher** line coverage for new/modified code
- If automated coverage is not achievable, document manual verification steps

## Test Quality Signals

- **Good**: Descriptive name (`returns_empty_array_when_no_results_match_query`), AAA structure (Arrange-Act-Assert), tests one behavior per case
- **Bad**: Name repeats function name (`test_getUser`), no assertions, tests mock behavior instead of real behavior, depends on test execution order

## Regression vs New-Feature Test Layering

- **Regression test scripts test ONLY already-released features.** A regression script (e.g. an online/HTTP regression suite) is a stable "no regression" net over released behavior. Do NOT add new-feature request cases to it during a pipeline run — `baseline-regression` runs that script BEFORE any code exists, and a not-yet-implemented new-feature case would fail it.
- **New-feature tests are written in the `testing` stage.** Every in-scope acceptance criterion must be covered in the `testing` stage — via unit tests, or (for HTTP/API contract criteria that cannot be exercised offline without a forbidden mock seam) via a live end-to-end verification.
- **Permanent regression cases for a new feature are added ONLY after the feature ships.** That is post-release work, not a completion gate of the current pipeline. Mark such criteria `DEFERRED_RELEASE`, not `MISSING`.
