# Project compatibility fixtures

The `v6-*.json` files define the durable project baseline established on
2026-10-30. Future readers must reopen their authored source geometry, panel IDs,
reset baselines, split ancestry and retired ID counters unchanged. They are
synthetic examples and contain no imported project geometry.

The manifest records each file's SHA-256 hash, its source document and the exact
v6 writer source hashes. The final release commit cannot be embedded inside its
own committed fixture; the baseline family and source hashes identify it without
that circular dependency. Future compatibility tests read these frozen files;
they must not recreate them with the current generator to make a test pass.

The four commit-prefixed documents are additional best-effort regression cases.
They were written by `createStudy` from isolated checkouts of the public commits
listed in the manifest, using `generate.mjs`. Reachable standalone releases all
wrote study v5, covering nested layout formats 1, 2 and 3. Legacy study versions
1–4 retain separate parser/migration tests; these files do not claim to be
historical v1–v4 writer output.

`generate-v6.mjs` establishes a baseline deliberately. Do not rerun either
generator as part of the normal tests or overwrite a released baseline after a
behavior change. Add a new case or explicit migration instead.
