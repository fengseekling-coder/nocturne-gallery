# Nocturne Gallery

Nocturne Gallery is a local-first desktop asset manager for designers and creative workers. It helps organize visual references, prompts, source attachments, web captures, and duplicate media without sending the user's library to a cloud service.

The app is built with Tauri 2, React 18, TypeScript, Tailwind CSS, Rust, and SQLite. The interface is Chinese-first and follows a dark Arc-inspired minimalist visual system.

## Why This Project Exists

Creative asset libraries become hard to maintain when files, prompts, references, source project files, and web inspiration are scattered across folders and tools. Nocturne Gallery provides a local workspace where those materials can be imported, grouped, searched, previewed, annotated, and exported while preserving the original files.

The project focuses on practical maintainer work:

- Cross-platform desktop behavior across macOS and Windows.
- Local SQLite data modeling and migration-safe storage.
- Media scanning, thumbnail generation, deduplication, and drag-and-drop workflows.
- Performance work for masonry grids, large image libraries, and preview synchronization.
- AI-assisted prompt and metadata workflows that remain controlled by local settings.

## Features

- Local media library with SQLite persistence.
- Masonry gallery with multi-stage image thumbnail loading.
- Video first-frame thumbnails.
- SHA-256 and perceptual hash based duplicate detection.
- Main group and sub-group isolation rules.
- Full-screen preview synchronized with the inspector panel.
- Editable prompt field with attachment references.
- External attachment cards for source files, project files, and references.
- Local file, folder, and web asset drag-in.
- Single and multi-file drag-out.
- Tauri/Rust commands for scanning, import, thumbnail work, preferences, and AI tool integration.

## Current Status

This repository is an early public release of an active desktop application. The core app structure, media workflows, inspector, preview synchronization, attachment panel, and performance tooling are present. Packaging, documentation, automated tests, and cross-platform polish are still being improved.

## Tech Stack

- Tauri 2
- React 18
- TypeScript
- Tailwind CSS
- Rust
- SQLite via `rusqlite`
- Vite

## Getting Started

### Prerequisites

- Node.js 18 or newer
- npm
- Rust and Cargo from rustup
- Git
- Platform-specific Tauri dependencies

### Install

```bash
npm install
```

### Run Frontend Dev Server

```bash
npm run dev
```

### Run Tauri App

```bash
npm run tauri:dev
```

### Validate

```bash
npm run typecheck
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

On macOS, if Vite/Rollup fails to load `@rollup/rollup-darwin-arm64` because of a local code-signing mismatch, reinstall Node dependencies or run with a Node binary that can load ad-hoc signed native add-ons. This is an environment issue, not an application source issue.

## Repository Layout

```text
src/                 React application, stores, components, UI tokens
src-tauri/           Tauri 2 Rust backend, SQLite, media commands
docs/                Design, installation, thumbnail, and performance notes
scripts/             Local verification and audit helpers
tools/               Supporting maintainer tools
```

## Maintainer Focus

Near-term maintenance work is tracked in [ROADMAP.md](./ROADMAP.md). The most important areas are:

- Build and packaging reliability on macOS and Windows.
- Import progress and duplicate confirmation behavior.
- Media thumbnail correctness and performance.
- Inspector and full-screen preview synchronization.
- Safer AI provider configuration and local-first defaults.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening issues or pull requests.

## Security

Please report security issues privately. See [SECURITY.md](./SECURITY.md).

## License

This project is released under the [MIT License](./LICENSE).
