# Agent notes

## Building

Do not run `npm run build` (or `build:loop`/`build:worker`) yourself to "finish" a change, and do not
hand-edit `dist/index.js` or `worker/index.js`. A pre-commit hook (`.githooks/pre-commit`, wired up via
the `prepare` script) rebuilds both bundles and stages them automatically on every commit. Just edit the
sources under `src/`; the bundles will be current by the time the commit lands. Only run the build
manually if you need to sanity-check output without committing.

## Releasing

There is no version ladder. Consumers pin `@v1`, and `v1.0.0` exists only because some tools
expect a dotted version - both tags always point at the same commit, the tip of `main`. Run:

```sh
npm run release
```

instead of pushing `main` by hand. It verifies (`typecheck` + `test`), pushes `main`, then moves
`v1` and `v1.0.0` to the commit that just landed and force-pushes both - only after `main` is
confirmed on `origin`, since a tag can't point at a commit the remote doesn't have yet. If moving
the tags fails after `main` already pushed, it says so and gives you the two commands to finish
by hand rather than leaving `v1` silently stale.
