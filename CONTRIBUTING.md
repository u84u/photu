# Contributing to photu

photu is a shell-pipe image manipulation CLI built on libvips/sharp. Contributions are welcome.

## Getting started

```sh
# Clone and install
git clone https://github.com/u84u/photu.git
cd photu
npm install

# Build the CLI
npm run build

# Run tests
npm test

# Lint and typecheck
npm run lint
npm run typecheck

# Format
npm run format
```

## Project structure

```
src/core/       Pure modules (no Node/sharp) — shared by CLI and playground
  plan.ts       JSON wire format, Panic error class, plan parsing/serialization
  args.ts       CLI token parsing (positionals, key=value options, bare flags)
  ops.ts        Command registry: SPECS for each stage, normalization
  completion-meta.ts  Autocomplete metadata mirrored from ops.ts SPECS
src/cli/        Stage drivers
  main.ts       CLI dispatch: read, write, explain, info, formats, completion
  exec.ts       sharp execution: URL fetch, animated frames, per-op application
  completion.ts Bash completion script generation
playground/     Browser playground (tryphotu.vercel.app)
  index.html    UI
  app.js        Pipeline parsing, rendering, autocomplete wiring
  exec-wasm.js  wasm-vips execution (browser)
  completions.js Pipeline autocomplete (pure, testable)
  serve.mjs     Local dev server (needs COOP/COEP headers)
test/           node:test test files
scripts/        build.mjs (TS strip → dist/), build-site.mjs (static site)
```

## Adding a new image operation

1. Add a `Spec` function to `SPECS` in `src/core/ops.ts`:
   - Parse positional args and `key=value` options via the `Stage` helper
   - Return a fully-normalized `Op` object with all defaults explicit
   - Call `s.finish(op)` to reject leftover arguments/options
2. Add an entry to `COMMAND_META` in `src/core/completion-meta.ts` for autocomplete
3. Add execution in `src/cli/exec.ts`'s `applyOp` switch
4. Add wasm-vips execution in `playground/exec-wasm.js`'s `renderPipeline` switch (or `fail("EUNSUPPORTED", ...)`)
5. Add tests to `test/ops.test.ts` (normalization) and `test/exec.test.ts` (CLI end-to-end)
6. Document the command in `README.md` under the Commands table

## Test conventions

- Tests use Node's built-in `node:test` runner with `node:assert/strict`
- CLI tests spawn `src/cli/main.ts` as a child process and pipe plans between stages
- Tests run concurrently (`--test-concurrency=5`); each test writes to unique output dirs
- All new ops get both normalization tests (`ops.test.ts`) and end-to-end tests (`exec.test.ts`)

## Releasing

1. Update the version in `package.json`
2. Add a changelog entry
3. `npm run prepublishOnly` (runs tests + build)
4. `npm publish`
