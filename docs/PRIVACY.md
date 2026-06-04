# Privacy

Nocturne Gallery is designed as a local-first desktop application. These notes describe the intended privacy model for the current pre-1.0 project.

## Local-First by Default

The app is intended to work without a cloud account. Your media library, grouping state, prompts, preferences, and attachment references are handled through local application storage and local files.

Nocturne Gallery should not upload your media library to a hosted service as part of normal library management.

## What Stays Local

The following data is expected to stay on your device:

- Imported media files.
- SQLite application data.
- Grouping, prompt, metadata, and preference records.
- External attachment references.
- Generated thumbnail and metadata side files.

The app should not rename or mutate original user files as part of normal import, organization, preview, or duplicate-detection workflows.

## Optional AI Provider Integrations

AI provider integration is optional. External AI requests should only happen when you explicitly configure an AI provider or API endpoint and use an AI-assisted workflow.

When AI integrations are configured, the data sent depends on the provider workflow being used. Treat prompts, selected media context, and generated metadata as potentially shareable with the configured provider. Review your provider settings and API endpoint before using those features.

API keys and provider configuration should be handled carefully on your local machine. Do not publish local settings files or credentials.

## File Safety Principles

The project follows these file-safety principles:

- Do not require login or cloud sync for local library workflows.
- Do not scan outside the selected library or explicitly attached paths.
- Do not rename original user files.
- Do not silently delete user files.
- Use confirmation for destructive decisions.
- Keep external attachments as references instead of copying them into the media library unless a workflow explicitly says otherwise.

## Pre-1.0 Limitations

Nocturne Gallery is still pre-1.0. Packaging, public release artifacts, automated regression tests, and cross-platform polish are still in progress.

Users should expect rough edges during alpha testing, especially around platform-specific file handling, media metadata edge cases, and optional AI provider configuration.

This document describes the intended privacy model, not a formal security audit.

## What to Back Up During Alpha Testing

Before testing with important creative work, back up:

- Your original media folder.
- Any `.nocturne_meta` sidecar metadata folders created near the library.
- The local SQLite database used by the app.
- Any prompt, tag, or attachment metadata that is important to your workflow.
- Local AI provider settings that you need to preserve.

Use test copies of important libraries when evaluating new builds.
