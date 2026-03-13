# Repository Guidelines

## Project Structure & Module Organization
This repo is an Electron + Node/Express + TypeScript app.

- `src/`: backend runtime and business logic.
  - `src/routes/`: API modules by domain (`video`, `storyboard`, `script`, `project`, etc.).
  - `src/agents/`: AI orchestration logic for outline/script/storyboard flows.
  - `src/lib/`, `src/utils/`, `src/middleware/`, `src/types/`: shared utilities, DB/runtime helpers, middleware, types.
- `scripts/`: desktop entry and build scripts (`scripts/main.ts`, `scripts/build.ts`).
- `scripts/web/index.html`: bundled renderer UI (large generated file; edit carefully).
- `env/`: environment templates for `dev/local/prod`.
- `build/`: compiled output.
- `docker/`: container startup files.

## Build, Test, and Development Commands
- `yarn dev`: run backend in dev mode with hot reload.
- `yarn dev:gui`: run Electron GUI (dev).
- `yarn local:gui`: run GUI with local env (`NODE_ENV=local`).
- `yarn local:gui:win:cmd` / `yarn local:gui:win:ps`: Windows launchers.
- `yarn lint`: TypeScript type-check (`tsc --noEmit`).
- `yarn build`: compile to `build/`.
- `yarn dist:win` / `yarn dist:mac` / `yarn dist:linux`: package desktop apps.
- `yarn test`: smoke-run compiled app (`node build/app.js`).

## Coding Style & Naming Conventions
- Language: TypeScript, `strict` mode enabled (`tsconfig.json`).
- Indentation: 2 spaces; keep semicolons and double quotes consistent with existing files.
- Naming:
  - files: camelCase for route handlers (e.g., `getVideoConfigs.ts`).
  - functions/variables: camelCase.
  - types/interfaces/classes: PascalCase.
- Use path alias `@/` for imports from `src/`.

## Testing Guidelines
- No dedicated unit-test framework is configured yet.
- Minimum requirement before PR: `yarn lint` + targeted manual verification in GUI/API flows you changed.
- For API changes, include request/response examples and error-path checks.

## Commit & Pull Request Guidelines
- Follow Conventional Commits seen in history: `feat(scope): ...`, `fix(scope): ...`, `chore(scope): ...`.
  - Example: `feat(video): add refresh endpoint for pending tasks`.
- PRs should include:
  - clear summary and affected modules,
  - screenshots/GIFs for UI changes,
  - migration/config notes (DB/env/ports/paths),
  - rollback or risk notes for AI/video generation behavior.

## Security & Configuration Tips
- Never commit real API keys, tokens, local DB files, or backup artifacts (`*.bak`, `db.sqlite`).
- Prefer env-driven paths/ports (`DB_PATH`, `UPLOAD_DIR`, `PORT`) for cross-platform consistency.
## 不允许ai 修改的标注
文件第一行: @no_modify
或者 # @no_modify