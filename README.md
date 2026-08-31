# Muse Code SDK

TypeScript SDK and developer documentation for building clients that drive
[Muse Code](https://meta-models.github.io/muse-code-sdk) agent sessions over
the Muse Session Protocol (MSP).

**Read the docs:** <https://meta-models.github.io/muse-code-sdk>

## Install from npm

```sh
npm install @muse-code/sdk
```

Requires Node.js 20 or newer. The package has **zero runtime dependencies**
and ships its own TypeScript declarations. Start with the
[quickstart](https://meta-models.github.io/muse-code-sdk/guides/quickstart/).

The SDK is a **Developer Preview**: it is published pre-1.0 and carries no
stability promise yet — minor releases may change APIs while the surface
settles.

## What is in this repository

- **`main` — the source of `@muse-code/sdk`**, together with the protocol
  declarations, examples and fixtures it needs to build and test on its own.
- **`gh-pages` — the built Muse Code Developer Docs**: the wire-protocol
  reference, the SDK reference, and the guides and cookbook that go with them.

```
clients/sdk-ts/         @muse-code/sdk — the facade, its QA harness and test suite
clients/msp-ts/         @muse-code/msp — the generated MSP wire types
clients/sdk-quickstart/ the executable quickstart journey the docs render
clients/sdk-cookbook/   the executable cookbook recipes the docs render
schema/msp/             the committed protocol declarations, stable manifest and
                        recorded conformance transcripts the tests replay
```

### Build from source

Requires Node.js 20 or newer (CI uses 22). From the repository root:

```sh
npm install     # links the workspace packages; installs the pinned TypeScript
npm run build   # tsc --build
npm test        # builds, then runs the node:test suites
```

The suite passes in a standalone checkout except for the arms in
`clients/sdk-ts/test/muse-serve-child.test.ts` and
`clients/sdk-ts/test/spawn-handshake.test.ts`, which spawn a real `muse` host
binary that is not part of this repository. Those fail by design without one —
anything else is a genuine failure, so please report it.

To typecheck the committed protocol declarations on their own:

```sh
scripts/check-msp-ts-typecheck.sh
```

### License

Released under the **MIT License** — see [`LICENSE`](LICENSE).

### This source is mirrored, not developed here

`publish-anchor.json` names the exact upstream commit each copy came from, and
its `repo_meta.hand_authored` list is the authoritative record of which files
are *not* mirrored. Today that list is `README.md`, `.nojekyll`, `LICENSE`,
`.github/` and `publish-anchor.json` itself.

Every other file is a verbatim copy from the producing repository. Nothing
outside that list is hand-maintained, so an edit made to a mirrored file in
this repository would be silently overwritten by the next publish. Corrections
to mirrored files belong upstream.

## The documentation site

The site is generated and published automatically. The `gh-pages` branch holds
the built site exactly as it is served; it is replaced wholesale on each
publish, so it carries no history worth reading and no hand edits survive
there.

Every published build is produced by one pipeline and validated before it is
published: the reference pages are generated from the protocol schema and the
SDK's own type information rather than hand-copied, the site is built offline
and proven self-contained, and each build's provenance — the commit and schema
fingerprint it was rendered from — is stamped on the site's front page.

The documentation is a **Developer Preview**, as the banner on every page says.

## Support

**Issues are open, and reports and questions are welcome.**
[Open an issue](https://github.com/meta-models/muse-code-sdk/issues/new/choose) —
there is a short form for bugs and one for questions. Bugs in the SDK, in the
protocol declarations and in the documentation all belong here, as do questions
about how to use any of it.

Issues are triaged into the team's internal tracker, and fixes are made
upstream and land here on the next publish. We may reply on the issue when a
fix ships rather than linking an internal change you would not be able to read.
