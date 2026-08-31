# Cookbook harness: validated, CI-executed recipes

This package is the runnable side of the developer-docs Cookbook
(issue #24225). Each docs page under
`developer-docs/src/content/docs/cookbook/` except the group's index page is
backed by exactly one recipe module in `src/recipes/`, registered in
`src/manifest.ts`, and executed by the `cookbook-journeys` CI job — so a
recipe that stops working reds the build instead of quietly rotting on the
page. The binding is tested in both directions: a registered recipe whose
page is missing fails, and an orphan page with no recipe fails too.

It also owns the shared journey kit under `src/kit/`: the
`Segment`/`runSegment`/`summarize` expect-block contract and the `Host`
spawn-plus-notification-recorder, extracted from `@muse-code/sdk-quickstart`,
which now consumes them from here.

## Run it

From `projects/tbh`:

```sh
npm ci
npm run build --workspace @muse-code/sdk
cargo build --release --locked -p tbh-cli --bin tbh
cargo build --release --locked -p tbh-conformance --bin muse-conformance
MUSE_BIN=$PWD/target/release/tbh \
MUSE_CONFORMANCE_BIN=$PWD/target/release/muse-conformance \
  npm run recipes --workspace @muse-code/sdk-cookbook
```

You get one block per recipe (its journey lines, in the quickstart's report
format) and one verdict line. Exit 0 means every recipe passed. A recipe
whose required binary was not provided FAILS the run — the cookbook never
skips a recipe, because a verdict that quietly thinned is not a verdict.

`npm test` is the binary-free half: the runner's contract (serial order,
missing-host failure, throw capture, verdict aggregation) and the manifest's
recipe-to-docs-page binding.

To run one recipe with only its own binaries built, pass `--only`:

```sh
npm run recipes --workspace @muse-code/sdk-cookbook -- --only cancel-mid-turn
```

## Adding a recipe

1. Write the recipe module in `src/recipes/` as a small journey over the
   shared kit; declare which host binaries it `needs`.
2. Register it in `src/manifest.ts`.
3. Write its docs page under `developer-docs/src/content/docs/cookbook/`, in
   the friendly voice recorded in `developer-docs/README.md`, with every wire
   example bound to a committed transcript via `wire-excerpt`.
4. The manifest test fails until the docs page exists, and the docs build
   fails if a wire example does not match its transcript.

A recipe that cannot run headless (needs a live provider) is gated behind an
explicit env opt-in, excluded from the headless verdict, and its page says
so. No such recipe exists yet.
