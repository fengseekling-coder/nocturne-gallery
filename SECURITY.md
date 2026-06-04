# Security Policy

Nocturne Gallery is a local-first desktop application. Security-sensitive areas include local file access, media scanning, SQLite persistence, drag-and-drop import/export, shell/open-file behavior, and AI provider configuration.

## Reporting a Vulnerability

Please do not open a public issue for suspected vulnerabilities.

Report privately by contacting the maintainer through GitHub. Include:

- Affected version or commit.
- Operating system.
- Clear reproduction steps.
- Expected and actual behavior.
- Any proof of concept, logs, or screenshots that help validate the issue.

## Scope

Examples of in-scope issues:

- Access to files outside the selected library or attachment paths.
- Unsafe handling of imported file names or paths.
- Unintended deletion or mutation of original user files.
- Credential exposure from AI provider settings.
- Unsafe command, shell, or open-file behavior.
- SQLite corruption or injection paths through app-controlled data.

Out-of-scope examples:

- Issues that require direct write access to the user's local database or app bundle.
- Vulnerabilities in dependencies without a project-specific exploit path.
- Social engineering or phishing.

## Supported Versions

This project is currently pre-1.0. Security fixes are applied to the main branch first.
