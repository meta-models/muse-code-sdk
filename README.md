# Muse Code SDK

This repository holds two published artifacts:

- **`main` — the source of `@muse/sdk`**, the MSP TypeScript SDK, together with
  the protocol declarations and fixtures it needs to build and test on its own.
- **`gh-pages` — the built Muse Developer Docs**: the wire-protocol reference,
  the SDK reference, and the guides and cookbook that go with them.

**Read the docs:** <https://meta-models.github.io/muse-code-sdk>

---

## The SDK source

`@muse/sdk` is the TypeScript facade over the Muse Session Protocol (MSP). It
has **zero runtime dependencies** — pure TypeScript over the generated protocol
declarations and the Node standard library.

```
clients/sdk-ts/     @muse/sdk — the facade, its QA harness and its test suite
clients/msp-ts/     @muse/msp — the generated MSP wire types, re-exported in place
schema/msp/         the committed protocol declarations, stable manifest and
                    recorded conformance transcripts the tests replay
```

### Build from source

Requires Node.js 20 or newer (CI uses 22). From the repository root:

```sh
npm install     # links the two workspace packages; installs the pinned TypeScript
npm run build   # tsc --build
npm test        # builds, then runs the node:test suites
```

`npm test` reports **343 passing**. Four arms fail by design in a standalone
checkout: the tests in `clients/sdk-ts/test/muse-serve-child.test.ts` and
`clients/sdk-ts/test/spawn-handshake.test.ts` spawn the real Rust `tbh serve`
host, which is not part of this repository. They fail with
`could not find Cargo.toml` and are the only expected failures — anything else
is a genuine one, so please report it.

To typecheck the committed protocol declarations on their own:

```sh
scripts/check-msp-ts-typecheck.sh
```

### npm publication is pending

`@muse/sdk` is **not on npm yet**, which is why the packages here are marked
private and versioned `0.0.0`. Building from source, as above, is the supported
way to use it today. Consuming it from a registry will be possible once
publication is set up; until then a `npm install @muse/sdk` will not resolve.

### License

This source is released under the **MIT License** — see [`LICENSE`](LICENSE).

The choice is **provisional**: MIT is what applies today, and it is what you may
rely on for the source as published here. It is recorded as provisional because
the licensing review has not formally concluded, so the terms could still be
revised before the 1.0 release.

### This source is mirrored, not developed here

`publish-anchor.json` names the exact upstream commit each copy came from, and
its `repo_meta.hand_authored` list is the authoritative record of which files
are *not* mirrored. Today that list is `README.md`, `.nojekyll`, `LICENSE`,
`.github/` and `publish-anchor.json` itself.

Every other file is a verbatim copy from the producing repository. Nothing
outside that list is hand-maintained, so an edit made to a mirrored file in this
repository would be silently overwritten by the next publish. Corrections to
mirrored files belong upstream.

---

## The documentation site

The site is generated and published automatically. The `gh-pages` branch holds
the built site exactly as it is served; it is replaced wholesale on each
publish, so it carries no history worth reading and no hand edits survive there.

Every published build is produced by one pipeline and validated before it is
published: the reference pages are generated from the protocol schema and the
SDK's own type information rather than hand-copied, the site is built offline
and proven self-contained, and each build's provenance — the commit and schema
fingerprint it was rendered from — is stamped on the site's front page.

The documentation is a **Developer Preview**, as the banner on every page says.

## Before this repository is public

While the repository is private, GitHub serves Pages on a generated hostname
instead of the address above, and it serves this branch at its root. The site's
assets and internal links are written for `/muse-code-sdk` — the path the site
occupies at its public address — so **on the temporary hostname the pages load
unstyled and the links do not resolve**. That is expected, not a fault to fix.

**Do not "correct" the canonical URLs or the base path against the temporary
hostname.** A built site carries root-absolute references under exactly one
base; repointing it at the soak hostname would only move the breakage to the
public address, and it would have to be undone at the visibility flip. The
generated hostname is transient and disappears when the repository becomes
public, at which point every link resolves as written.

## Support

**Issues are open, and reports and questions are welcome.**
[Open an issue](https://github.com/meta-models/muse-code-sdk/issues/new/choose) —
there is a short form for bugs and one for questions. Bugs in the SDK, in the
protocol declarations and in the documentation all belong here, as do questions
about how to use any of it.

Issues are triaged into the team's internal tracker, and fixes are made upstream
and land here on the next publish. We may reply on the issue when a fix ships
rather than linking an internal change you would not be able to read.

This is a **Developer Preview** with no service-level commitment on response
times. It is worked on actively, and an unanswered issue is not a closed one.

### Pull requests

Please **do not** open pull requests. Nothing is written or maintained in this
repository — the documentation is generated and the source is mirrored from
upstream — so a change made here would be overwritten by the next publish. A
patch is still welcome; attach it to an issue as a diff or a description, and we
will apply it upstream and credit you.
