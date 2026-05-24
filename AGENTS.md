# Repository Guidelines

## Project Structure & Module Organization

This repository contains a Node.js MCP server for building AWS Pricing Calculator estimates. The entry point is `mcp-server.js`, which registers MCP tools and uses helpers from `lib/`. Core modules are `lib/aws-client.js` for AWS Calculator manifest access, `lib/estimate-builder.js` for estimate payload construction, and `lib/ec2.js` for EC2-specific config transformation. Tests live in `test/*.test.js`. The validation suite lives in `validation/`, with mappings in `validation/field-mapping.json`, BDD scenarios under `validation/features/`, step tests under `validation/steps/`, and optional Playwright checks under `validation/playwright/`. Build output is generated in `dist/` and should not be hand-edited.

## Build, Test, and Development Commands

- `pnpm install --frozen-lockfile`: install dependencies exactly from `pnpm-lock.yaml`.
- `pnpm test`: run the Node.js test suite with `node --test test/*.test.js`.
- `pnpm mcp`: start the MCP server locally over stdio from `mcp-server.js`.
- `pnpm build`: bundle and minify the server to `dist/mcp-server.js`, then create `dist/aws-calculator.zip`.
- `pnpm validate`: run API-only validation against AWS Pricing Calculator mappings.
- `pnpm validate:visual`: run validation plus Playwright visual checks.
- `pnpm validate:report`: generate `validation/report.json`.

## Coding Style & Naming Conventions

Use CommonJS (`require`, `module.exports`) and plain JavaScript. Follow the existing style: two-space indentation, semicolons, single quotes, and descriptive camelCase names. Test files use the `*.test.js` suffix. Keep changes focused; avoid broad formatting churn. Validate MCP inputs with Zod schemas and keep user-facing errors actionable.

## Testing Guidelines

Use the built-in `node:test` runner and `node:assert/strict`. Add or update focused tests in `test/` for behavior changes in `lib/` or `mcp-server.js`. Use validation commands when changing service-field handling, estimate export payloads, or `validation/field-mapping.json`. For targeted validation, use commands such as `node validation/run-validation.js --service "Lambda"`.

## Commit & Pull Request Guidelines

Recent history uses short imperative or conventional-style subjects, for example `feat: add validation suite...` and `Send unit fields in validation buildConfig (#6)`. Keep commit messages concise and scoped. Pull requests should describe the change, list tests run, link related issues, and include screenshots or generated calculator URLs when changing user-visible estimate output. Follow `CONTRIBUTING.md`: work from latest `main`, discuss significant work first, and do not report security issues publicly.

## Security & Configuration Tips

No AWS credentials are required. The server calls public AWS Calculator endpoints and keeps estimates in memory only. Optional environment variables include `AWS_MANIFEST_URL`, `AWS_SAVE_URL`, and validation settings such as `VALIDATION_REGION`, `VALIDATION_TIMEOUT`, `VALIDATION_CONCURRENCY`, and `VALIDATION_SERVICE`.
