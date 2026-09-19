# Agent notes

## Building

Do not run `npm run build` (or `build:loop`/`build:worker`) yourself to "finish" a change, and do not
hand-edit `dist/index.js` or `worker/index.js`. A pre-commit hook (`.githooks/pre-commit`, wired up via
the `prepare` script) rebuilds both bundles and stages them automatically on every commit. Just edit the
sources under `src/`; the bundles will be current by the time the commit lands. Only run the build
manually if you need to sanity-check output without committing.

## Releasing

There is no version ladder. Consumers pin `@v1`, and `v1.0.0` exists only because some tools
expect a dotted version - both tags always point at the same commit, the tip of `main`. That is
kept true by `.github/workflows/retag.yml`, which force-moves both tags to whatever commit was
just pushed to `main` - it runs on the push event itself, so it does not matter whether that push
came from the CLI, GitHub Desktop, or anyone else with write access. Nothing needs to be run by
hand; just push to `main`.
