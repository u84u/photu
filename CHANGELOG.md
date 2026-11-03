# Changelog

All notable changes to photu are documented in this file.

## [0.4.0] - 2026-11-03

### Added
- **New image operations**: `trim`, `normalize`, `negate`, `sepia`, `level`, `median`
- **`photu version`** / `photu -v` / `photu --version` — print the installed version
- **Safety guards**: max input dimension (10000 px), max local file size (100 MB), URL fetch retries (2) with a `User-Agent` header
- **TypeScript typecheck** (`npm run typecheck`) and **ESLint** (`npm run lint`)
- **Parity test** ensuring `completion-meta.ts` stays in sync with `ops.ts` commands
- **Safety tests**: oversized files and over-dimension images are refused before decoding

### Changed
- Test script runs with `--test-concurrency=5` for parallel execution
- CLI test helpers (`run`/`pipeline`) converted from sync `spawnSync` to async process reuse
- `completion-meta.ts` now mirrors all commands including the new image ops

### Fixed
- None (this is a feature release)

## [0.3.2] - 2026-11-02
- Fix stdin race when chaining stages through a live OS pipe

## [0.3.1] - 2026-11-01
- Fix completion tests on Windows

## [0.3.0] - 2026-10-30
- Playground pipeline autocomplete
- Bash completions via `photu completion`

## [0.2.0] - 2026-10-28
- `read` accepts `http(s)://` URL sources alongside local globs

## [0.1.0] - 2026-10-25
- Initial release: shell-pipe image pipeline on libvips/sharp
