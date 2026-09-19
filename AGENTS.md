# Agent notes

## Releasing

There is no version ladder. Consumers pin `@v1`, and `v1.0.0` exists only because some tools
expect a dotted version - both tags always point at the same commit, the tip of `main`:

```sh
npm run all
git tag -f v1.0.0 && git tag -f v1
git push origin v1.0.0 v1 --force
```
