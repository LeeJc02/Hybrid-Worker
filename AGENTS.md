# Repository Guidelines

## Project Structure & Module Organization

This repository contains the TypeScript implementation of the `hybrid-worker` skill harness. Runtime code lives in `src/`, with responsibilities split by concern: CLI orchestration (`cli.ts`), worker execution (`worker.ts`), Git/worktree handling (`git.ts`, `merge.ts`), environment setup (`env.ts`), schemas, reporting, and usage parsing. Tests are in `tests/` and use the `*.test.ts` suffix. JSON contracts live in `schemas/`; architecture and compatibility notes are in `docs/`. `agents/openai.yaml` and `SKILL.md` define skill integration and behavior. `dist/` is generated output—change `src/`, then rebuild instead of editing compiled files directly.

## Build, Test, and Development Commands

- `npm ci`: install the exact locked dependency set (Node.js 22+).
- `npm run dev -- --doctor`: run the TypeScript CLI through `tsx` without building.
- `npm run build`: compile `src/**/*.ts` into `dist/`.
- `npm test`: run the Vitest suite once.
- `npm run test:watch`: rerun affected tests during development.
- `npm run check`: compile and run all tests.
- `npm run verify`: run build, tests, dependency audit, doctor checks, and package dry-run.

Use `npm run check` before every submission; use `npm run verify` for release-facing changes.

## Coding Style & Naming Conventions

Use TypeScript ES modules, two-space indentation, semicolons, double quotes, and explicit types at module boundaries. Keep strict compiler settings passing, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Name files and functions with concise lowercase camelCase terms (`parseArgs`, `worker.ts`); use PascalCase for types and classes (`WorkerResult`, `EventLogger`). No formatter or linter is configured, so match nearby code and keep diffs focused.

## Testing Guidelines

Tests use Vitest. Add unit coverage to `tests/core.test.ts` for pure parsing, validation, or schema behavior; add end-to-end harness scenarios to `tests/fake-worker.test.ts`. Avoid live Claude calls in automated tests. Test both success and gate-rejection paths when changing worker, merge, artifact, or validation behavior.

## Commit & Pull Request Guidelines

This copied directory has no local Git history. Use Conventional Commits, such as `feat: add strict plan validation` or `fix: reject generated worker artifacts`, and keep each commit to one independent change. Pull requests should explain behavior changes, list verification commands, link relevant issues, and call out CLI, schema, report, or compatibility impacts. Include screenshots only for user-visible UI changes.

## Security & Generated Files

Never commit credentials, worker logs, run artifacts, caches, or `node_modules/`. Keep JSON schemas and documentation synchronized with externally visible contract changes.
