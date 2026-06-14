# Gega Gallery

Source-available, local-first desktop workspace for visual references, prompts, and source attachments.

Gega Gallery is for designers, AI creators, creative workers, and indie makers who collect visual inspiration while moving between folders, browsers, AI tools, and design software. It brings reference images, prompts, grouping, duplicate checks, and external source-file attachments into one private desktop library.

一个源码可见、本地优先的桌面工作台，把参考图、Prompt 和源文件附件整理在同一个创意素材库里。

## ⚠️ 重要声明

本项目已切换为 [Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International](./LICENSE)（CC BY-NC-SA 4.0，署名-非商业性使用-相同方式共享）非商业许可协议。仅允许个人免费学习、研究、评估和其他非商业用途。

严禁任何形式的商业牟利、打包售卖、闭源套壳、商业 SaaS、商业交付、付费培训材料、商业产品集成，或用于任何以盈利为目的的商业项目。基于本项目的修改版本如需分发，必须继续以相同或兼容的 BY-NC-SA 协议共享，并保留署名、版权和协议声明。

[Build from source](#build-from-source) · [Roadmap](./ROADMAP.md) · [Contributing](./CONTRIBUTING.md)

## Preview

Screenshots and workflow GIFs are being prepared for the first public alpha. Until the real captures are available, this README intentionally uses text-only placeholders to avoid broken image previews.

First public screenshot pack:

- `docs/assets/screenshot-gallery.png` — main gallery and grouped asset view.
- `docs/assets/screenshot-inspector.png` — inspector with prompt and attachment context.
- `docs/assets/screenshot-preview.png` — full-screen preview with synchronized inspector context.
- `docs/assets/demo-import.gif` — import, organize, prompt, attach, and reuse workflow.

See [docs/assets/README.md](./docs/assets/README.md) for the visual asset checklist.

## What It Helps With

Creative reference work often spreads across too many places:

- Reference images live in nested folders, downloads, screenshots, browser tabs, and chat threads.
- Prompts and generation notes sit in AI tools, documents, or copied text snippets.
- Source files, project files, and related references are easy to lose after the final image is saved.
- The same asset is imported again because it was renamed, moved, or saved from another source.

Gega Gallery tries to collect that creative context into a local private library, so visual references, prompts, grouping, duplicate detection, preview context, and source attachments stay close to the work they describe.

## Core Workflows

### Capture

Bring material into the library from local files, local folders, and web-dragged assets. Folder import is designed for recursive local imports, and import progress is surfaced in the app instead of failing silently.

### Organize

Use main groups and custom subgroups to separate collections. Search local metadata, keep editable prompt text with the selected asset, attach external source/reference files, and rely on SHA-256 plus perceptual hash checks to catch duplicates.

### Reuse

Preview assets, keep the inspector synchronized with the current selection, and drag one or more selected assets back out to external creative tools when you need to continue working elsewhere.

## Workflow

The first public workflow GIF will show a short path from scattered files to reusable context:

```text
drag in local files or a folder
-> import progress appears
-> assets enter the gallery
-> select an image
-> edit prompt context
-> attach a source/reference file
-> drag the asset back out to another creative tool
```

Planned path: `docs/assets/demo-import.gif`

## Features

- Local media library backed by SQLite.
- Masonry-style gallery with multi-stage image thumbnail loading.
- Video first-frame thumbnail support.
- SHA-256 and perceptual hash based duplicate detection.
- Main group and sub-group isolation rules.
- Full-screen preview synchronized with the inspector panel.
- Editable prompt field.
- External attachment references for source files, project files, and related materials.
- Local file, folder, and web asset drag-in.
- Single and multi-file drag-out.
- Tauri/Rust commands for scanning, import, thumbnail work, preferences, and AI tool integration.

## Privacy Model

Gega Gallery is local-first by design:

- Media files stay on your device.
- SQLite data is stored locally.
- No cloud account is required.
- AI provider integration is optional.
- External AI requests only happen when explicitly configured.
- The app should not rename or mutate original user files.

Read the fuller privacy notes in [docs/PRIVACY.md](./docs/PRIVACY.md).

## How It Is Different

Gega Gallery is not a normal photo album, a cloud asset library, a bookmark manager, a note-first vault, or a simple reference board.

It is closer to a private creative workspace than a photo album: local-first, open-source, desktop-native, and centered on the relationship between visual references, prompts, source attachments, duplicate detection, and drag-in / drag-out workflows.

## More Screenshots

Optional screenshots are planned after the first public screenshot pack:

- `docs/assets/screenshot-duplicates.png` — duplicate import confirmation and existing asset context.
- `docs/assets/screenshot-groups.png` — main groups, subgroups, and grouped library organization.

## Current Status

This repository is an early public release of an active desktop application. The core app structure, media workflows, inspector, preview synchronization, attachment panel, import/export drag behavior, and performance tooling are present.

**Platform focus (this phase): macOS only.** UI and window chrome follow macOS conventions (traffic-light controls, title-bar drag regions, PingFang-first typography, Quick Look for system previews). Windows and Linux are not in scope for the first public release; backend may still contain dormant cross-platform code for a possible later port.

Packaging, release artifacts, automated regression tests, and public screenshots are still being improved. There is currently no packaged GitHub Release in this repository, so the project should be built from source on **macOS**.

## Build from Source

> **Repository layout:** Clone and work only inside `nocturne-gallery/`. The parent folder may be a wrapper; run `npm install` and all scripts from that directory (not the repo root).

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
npm run lint
npm run typecheck
npm run audit:commands   # frontend invoke ↔ Rust handlers
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

Optional: `npm run test:e2e` (requires `npm run dev` on port 1420). Performance: `npm run perf:test` / `npm run perf:report`.

On macOS, if Vite/Rollup fails to load `@rollup/rollup-darwin-arm64` because of a local code-signing mismatch, reinstall Node dependencies or run with a Node binary that can load ad-hoc signed native add-ons. This is an environment issue, not an application source issue.

## Tech Stack

- Tauri 2
- React 18
- TypeScript
- Tailwind CSS
- Rust
- SQLite via `rusqlite`
- Vite

## Repository Layout

```text
src/                 React application, stores, components, UI tokens
src-tauri/           Tauri 2 Rust backend, SQLite, media commands
docs/                Design, installation, thumbnail, privacy, and performance notes
scripts/             Local verification and audit helpers
tools/               Supporting maintainer tools
```

## Roadmap

Near-term maintenance work is tracked in [ROADMAP.md](./ROADMAP.md). Current priorities include:

- Public repository readiness.
- Build and packaging reliability on macOS (`.app` / `.dmg`).
- Import and duplicate confirmation reliability.
- Thumbnail diagnostics and media performance.
- Focused checks for group isolation and preview synchronization.

## Contributing

Contributions are welcome, especially around documentation, packaging reliability, local-first behavior, performance, and cross-platform validation. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening issues or pull requests.

## Security

Please report security issues privately. See [SECURITY.md](./SECURITY.md).

## License

This project is released under the [Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International License](./LICENSE) ([CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)).
