# Security Rules — Shared Template (customize per project)

## Red Lines (never violate)

- **Secrets**: Never read, print, log, or commit `.env` files, credentials, private keys, tokens, or API keys.
- **Injection**: Flag any SQL/command/script injection risk. Use parameterized queries. Never concatenate user input into commands.
- **Authentication**: Flag any auth bypass, missing auth check, or privilege escalation path.
- **Path Traversal**: Flag any file path constructed from user input without validation. Also audit paths targeting `.cursor/rules/`, `.windsurf/rules/`, or other AI tool configuration directories.
- **Unsafe Deserialization**: Flag `eval()`, `exec()`, `pickle.loads()`, `json.loads()` on untrusted input without schema validation.
- **Command Execution**: Flag `os.system()`, `subprocess.call(shell=True)`, `child_process.exec()` with user-supplied strings.
- **Overly Broad Permissions**: Flag chmod 777, public S3 buckets, open CORS `*` with credentials.
- **Dependency Risk**: Flag new dependencies without pinned versions. Check for known vulnerabilities.
- **Data Exposure**: Flag logging or error messages that leak sensitive data (PII, tokens, internal paths).
- **Hardcoded Ports/URLs**: Flag internal hostnames, IPs, or ports in code. These leak infrastructure details and break across environments.

## Hook Security

Hooks execute arbitrary Node.js code. Review hook changes carefully. Never add hooks from untrusted sources. Hooks have full access to the file system, network, and environment variables — treat them as privileged code.

## Review Checklist

Before approving any change, verify:
1. No secrets in code, config, or test fixtures
2. User input is validated and sanitized at boundaries
3. Auth/authorization is applied at every endpoint
4. External API calls have timeout and error handling
5. Sensitive operations are logged (audit trail)
6. Dependencies are pinned and from trusted sources
