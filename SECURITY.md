# Security Policy

Gega Gallery is a local-first desktop application. Security-sensitive areas include local file access, media scanning, SQLite persistence, drag-and-drop import/export, shell/open-file behavior, and AI provider configuration.

## Local-First and Optional AI Network Access

Gega Gallery does not require login, cloud sync, telemetry, or background upload for its core library features. Media files, prompts, metadata, thumbnails, attachments, and provider settings are stored locally.

Optional AI features may contact a provider only when the user configures a provider and actively invokes an AI action. Provider API keys and model settings are local preferences; they must not be silently uploaded, synchronized, or logged. Any future AI feature that sends media content, prompts, file paths, or metadata to a provider must make that behavior explicit in the UI and documentation.

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
