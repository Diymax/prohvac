# Release

`npm run build:release` builds the frontend, copies a strict runtime allowlist
into a temporary stage, removes tests and source maps, writes
`RELEASE_MANIFEST.json`, verifies every file, creates a deterministic-order
`release/prohvac-release.tar.gz`, then atomically publishes the output directory.
The unpacked stage is not retained.

The manifest records application version, commit hash (or `unavailable` outside
a Git checkout), build timestamp, Node version, latest schema migration, and
SHA-256/size for every runtime file. Set `SOURCE_DATE_EPOCH` to the source commit
time for reproducible metadata; archive paths, ownership, modes, timestamps, and
gzip metadata are normalized.

`npm run verify:release` extracts into a temporary directory and rejects:

- `.env*` except `.env.example`;
- databases, WAL/SHM, uploads, logs, temporary/part files;
- tests, fixtures, reports, coverage, source maps, `node_modules`;
- private-key files, recognized assigned credentials, and nested archives;
- files absent from the manifest or with mismatched hashes/sizes.

The release contains the locale/design inputs required by the documented
first-deploy seed, so `node scripts/seed-content.mjs --dry-run` is self-contained.
Production database and user uploads are never packaged.
