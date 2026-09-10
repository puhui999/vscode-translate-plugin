# Vendored grammar notices

`tm-grammars/1.32.3/LICENSE` and `NOTICE` are byte-for-byte copies from the published `tm-grammars@1.32.3` npm tarball. `SOURCE.json` records its SHA-512 integrity value, SHA-256 hashes of the copied files, and retrieval date. No grammar package or extra runtime dependency was installed to retrieve them.

The installed `@shikijs/langs@4.4.3` package declares `tm-grammars: ^1.32.3` as a build dependency, but its npm archive only includes Shiki's own MIT license. The [Shiki v4.4.3 lockfile](https://github.com/shikijs/shiki/blob/v4.4.3/pnpm-lock.yaml) pins `packages/langs` to `tm-grammars@1.32.3`. The matching [published tarball](https://registry.npmjs.org/tm-grammars/-/tm-grammars-1.32.3.tgz) provides the complete upstream NOTICE.

`scripts/collect-licenses.mjs` copies these notices and the installed runtime package licenses to `dist/licenses`. It also lists the actual bundled grammar subset. The unmodified full NOTICE contains entries for other grammars; their inclusion in the notice does not mean those grammars are bundled.

Builds are offline. When upgrading `@shikijs/langs`, check the new release's lockfile, retrieve and verify the corresponding grammar release notices, update `SOURCE.json`, and update the collector's pinned directory if the grammar version changes. The collector rejects a Shiki version mismatch or changed vendored notice hashes.
