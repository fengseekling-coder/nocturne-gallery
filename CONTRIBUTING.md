# Contributing

Thanks for your interest in Gega Gallery. This project is an early local-first desktop app, so contributions that improve reliability, maintainability, and cross-platform behavior are especially useful.

## Development Setup

Install dependencies:

```bash
npm install
```

Run the frontend:

```bash
npm run dev
```

Run the Tauri app:

```bash
npm run tauri:dev
```

## Validation

Before opening a pull request, run the checks that match your change:

```bash
npm run typecheck
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

For media performance work, also check the scripts under `scripts/`.

## Project Rules

- Keep the app local-first. Do not add login, cloud sync, or remote upload flows.
- Do not rename or mutate original user files.
- Persist application data through SQLite and Rust commands.
- Keep UI colors, radii, and typography aligned with the tokens in `src/styles/tokens.css`.
- Avoid `any` in TypeScript.
- Use explicit error handling in Tauri commands.
- For long-running Rust operations, preserve or add progress events.

## Pull Requests

Good pull requests are small, testable, and focused. Include:

- What changed.
- Why the change is needed.
- Manual or automated checks performed.
- Screenshots or screen recordings for visible UI changes.

## Issues

Please include reproduction steps, operating system, app version or commit, and relevant logs when reporting bugs.
