#!/usr/bin/env bash
#
# publish-sdk-crates.sh — the gates every crates.io publication of
# `muse-code-sdk` passes. Of this script's runs, only the mirror workflow's
# `--publish` uploads; the owner's one-time first publication is made from
# the same clean commit on which a build-only run has just passed.
#
# Default behaviour is `--build-only`: it runs every gate, packages the crate,
# runs `cargo publish --dry-run`, prints exactly what the owner would run, and
# exits without uploading anything. Publishing requires the explicit
# `--publish` flag; there is no way to publish by forgetting an argument.
#
# `--publish` refuses outside the mirror's publish-crates.yml: it runs only in
# GitHub Actions, in the mirror repository, under that workflow, with the
# short-lived token crates.io trusted publishing hands it. No agent ever holds
# a crates.io credential.
#
# The same script runs from this repository and from the public mirror's
# `rust/` tree, so it needs no path that exists only upstream: the crate is
# `clients/sdk-rs` under the script's root in both (the mirror's re-sync
# routes it to `rust/clients/sdk-rs`). The host version is the CLI crate's in
# this repository (read only when its manifest is present) and the mirror's
# publish-anchor.json `host_version` there (ADR 51992 D3).
#
# ---------------------------------------------------------------------------
# OWNER ONE-TIMERS — none of these can be done by an agent.
# ---------------------------------------------------------------------------
#
#   1. The crates.io account, and at the first publication the crate's
#      owners (the mirror's owner team plus a second individual owner).
#
#   2. The first publication itself. crates.io binds trusted publishing only
#      to a crate that already exists, so the first version goes up with an
#      owner-held token, from the mirror at the release tag, on a clean
#      checkout where this script's build-only run has just passed;
#      build-only prints that command. The first version can never be
#      replaced, so it gets the same gates.
#
#   3. The mirror's publish-crates.yml and its crates.io trusted-publisher
#      binding. After that, each release dispatches the workflow, which runs
#      this script by path with `--publish`.
#
# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
#   scripts/publish-sdk-crates.sh                # gates + dry run, publishes nothing
#   scripts/publish-sdk-crates.sh --build-only   # the same thing, said explicitly
#   scripts/publish-sdk-crates.sh --publish      # gates + dry run + cargo publish;
#                                                # refuses outside the mirror's
#                                                # publish-crates.yml
#   scripts/publish-sdk-crates.sh --help
#
# Gates, in order: tree anchor (clean for --publish); manifest identity (name,
# licence, version equal to the host version); repository is the public
# mirror; no path dependency of any kind; the packaged file list is the public
# set; the packaged .crate passes the external-audience text check, every
# file of it (the check npm and PyPI run); `cargo publish --dry-run`; and a
# standalone copy laid out like the mirror's `rust/` folder, with no
# workspace above it, packages cleanly.
#
# Environment:
#   CARGO           cargo to run; defaults to cargo on PATH. Network policy
#                   is cargo's own (CARGO_NET_OFFLINE=true keeps every gate
#                   but `cargo publish --dry-run` offline when the dependency
#                   cache is warm).
#
#   CARGO_TARGET_DIR where every cargo step builds and the .crate lands; a
#                   dir the caller sets is kept after the run, and the default
#                   (inside the work dir) is removed with it.
#
#   SDK_CRATE_DIR   test seam: crate directory to gate and package
#
#   SDK_ANCHOR_PATH test seam: anchor file to use instead of the mirror's
#                   publish-anchor.json; the digest root stays this tree
#
set -euo pipefail

readonly CRATE_NAME="muse-code-sdk"
readonly EXPECTED_LICENSE="MIT"
readonly MIRROR_URL="https://github.com/meta-models/muse-code-sdk"
readonly MIRROR_REPO="${MIRROR_URL#https://github.com/}"
readonly MIRROR_WORKFLOW="$MIRROR_REPO/.github/workflows/publish-crates.yml@"
# This repository's CLI crate manifest, relative to the tree root; the mirror
# has none.
readonly HOST_CLI_MANIFEST="crates/cli/Cargo.toml"

repo_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
}

REPO_ROOT="$(repo_root)"
CARGO="${CARGO:-cargo}"
MODE="build-only"
WORKDIR=""

cleanup() {
  [[ -n "$WORKDIR" && -d "$WORKDIR" ]] && rm -rf "$WORKDIR"
  return 0
}
# Cleanup runs on exit; a signal exits, so a cancelled --publish never goes
# on to the upload.
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

die() {
  echo "" >&2
  echo "FAILED: $*" >&2
  echo "Nothing was published." >&2
  exit 1
}

step() { echo "==> $*"; }
ok() { echo "    ok: $*"; }
note() { echo "    note: $*"; }

usage() {
  # Derived, never a pinned line range: print from line 3 until the comment
  # block ends.
  awk 'NR < 3 { next } !/^#/ { exit } { sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --build-only) MODE="build-only" ;;
    --publish) MODE="publish" ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# Trusted-publishing gate (publish mode only) — checked FIRST, so a refused
# --publish names the governing constraint and runs no other gate.
# ---------------------------------------------------------------------------
if [[ "$MODE" == "publish" ]]; then
  step "gate: trusted-publishing context"
  [[ -n "${GITHUB_ACTIONS:-}" ]] ||
    die "the publish path runs only inside the mirror's publish-crates.yml (trusted publishing). The owner's one-time first publication runs the command build-only prints, by hand; there is no other token path."
  [[ "${GITHUB_REPOSITORY:-}" == "$MIRROR_REPO" ]] ||
    die "the publish path runs only in the mirror repository $MIRROR_REPO, not '${GITHUB_REPOSITORY:-}'"
  [[ "${GITHUB_WORKFLOW_REF:-}" == "$MIRROR_WORKFLOW"* ]] ||
    die "the publish path runs only under the mirror's publish-crates.yml, not '${GITHUB_WORKFLOW_REF:-}'"
  [[ -n "${CARGO_REGISTRY_TOKEN:-}" ]] ||
    die "running in the mirror workflow but CARGO_REGISTRY_TOKEN is empty: the workflow must pass the token its crates.io trusted-publishing step minted"
  ok "inside the mirror's publish-crates.yml with a trusted-publishing token"
fi

command -v "$CARGO" >/dev/null 2>&1 || die "$CARGO is required"
command -v python3 >/dev/null 2>&1 || die "python3 is required (manifest metadata, the anchor check and the external-audience check)"

# The shared tools live under scripts/ here, and under the mirror's python/
# tree there; the mirror's rust/ tree is a sibling of python/.
find_shared() {
  local candidate
  for candidate in \
    "$REPO_ROOT/scripts/$1" \
    "$(dirname "$REPO_ROOT")/python/scripts/$1"; do
    [[ -f "$candidate" ]] && echo "$candidate" && return 0
  done
  return 0
}

TEXT_CHECKER="$(find_shared check-public-mirror-text.py)"
[[ -n "$TEXT_CHECKER" ]] ||
  die "check-public-mirror-text.py is missing from this tree (looked under scripts/ and ../python/scripts/); publishing without the public-mirror text check is refused"
AUDIENCE_CHECKER="$(find_shared check-sdk-py-external-audience.py)"
[[ -n "$AUDIENCE_CHECKER" ]] ||
  die "check-sdk-py-external-audience.py is missing from this tree (looked under scripts/ and ../python/scripts/); publishing without the external-audience check is refused"

# The crate is clients/sdk-rs under this tree's root, here and in the mirror's
# rust/ tree.
is_sdk_crate() {
  [[ -f "$1/Cargo.toml" ]] && grep -q -x "name = \"$CRATE_NAME\"" "$1/Cargo.toml"
}
if [[ -n "${SDK_CRATE_DIR:-}" ]]; then
  CRATE_DIR="$SDK_CRATE_DIR"
elif is_sdk_crate "$REPO_ROOT/clients/sdk-rs"; then
  CRATE_DIR="$REPO_ROOT/clients/sdk-rs"
else
  die "no $CRATE_NAME crate found at clients/sdk-rs under this tree's root"
fi
CRATE_DIR="$(cd "$CRATE_DIR" && pwd)"
MANIFEST="$CRATE_DIR/Cargo.toml"

WORKDIR="$(mktemp -d)"
# One target dir for every cargo step, so the standalone build reuses the
# dry run's dependency artifacts.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$WORKDIR/target}"
DIRTY_FLAG=()
[[ "$MODE" == "build-only" ]] && DIRTY_FLAG=(--allow-dirty)

echo "publish-sdk-crates.sh — mode: $MODE"
echo "crate: $CRATE_DIR"
echo ""

# ---------------------------------------------------------------------------
# Gate 1 — tree anchor. Publishing from a dirty or unknown tree makes the
# release's provenance a lie: it would name a commit whose content is not
# what was built.
# ---------------------------------------------------------------------------
step "gate: tree anchor"
ANCHOR_COMMIT=""
TREE_CLEAN=""
if git -C "$CRATE_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  ANCHOR_COMMIT="$(git -C "$CRATE_DIR" rev-parse HEAD)"
  if [[ -n "$(git -C "$CRATE_DIR" status --porcelain -- . 2>/dev/null)" ]]; then
    [[ "$MODE" == "publish" ]] &&
      die "the crate tree has uncommitted changes; a publish must name a commit that actually contains what it ships"
    ok "anchor $ANCHOR_COMMIT (tree dirty — tolerated in build-only, fatal for --publish)"
  else
    TREE_CLEAN=1
    ok "anchor $ANCHOR_COMMIT, crate tree clean"
  fi
else
  [[ "$MODE" == "publish" ]] && die "not a git checkout; refusing to publish an unanchored tree"
  ok "not a git checkout (build-only)"
fi

# Resolved metadata, so workspace-inherited fields read as cargo will publish
# them. One line per field: name, version, license, repository, then each
# path dependency as `name (kind)`.
METADATA="$WORKDIR/metadata.txt"
"$CARGO" metadata --no-deps --format-version 1 --manifest-path "$MANIFEST" >"$WORKDIR/metadata.json" ||
  die "cargo metadata could not read $MANIFEST"
python3 - "$WORKDIR/metadata.json" "$MANIFEST" >"$METADATA" <<'PY' ||
import json, os, sys
data = json.load(open(sys.argv[1]))
want = os.path.realpath(sys.argv[2])
package = next(p for p in data["packages"] if os.path.realpath(p["manifest_path"]) == want)
print(package["name"])
print(package["version"])
print(package.get("license") or "")
print(package.get("repository") or "")
for dep in package["dependencies"]:
    if dep.get("path"):
        print(f"{dep['name']} ({dep.get('kind') or 'normal'})")
PY
  die "cargo metadata names no package at $MANIFEST"
NAME="$(sed -n 1p "$METADATA")"
VERSION="$(sed -n 2p "$METADATA")"
LICENSE="$(sed -n 3p "$METADATA")"
REPOSITORY="$(sed -n 4p "$METADATA")"
PATH_DEPS="$(sed -n '5,$p' "$METADATA")"

# ---------------------------------------------------------------------------
# Gate 2 — manifest identity: name, licence, and the lockstep version.
# ---------------------------------------------------------------------------
step "gate: manifest identity"
[[ "$NAME" == "$CRATE_NAME" ]] || die "name is '$NAME', expected '$CRATE_NAME'"
ok "name $NAME"
[[ "$LICENSE" == "$EXPECTED_LICENSE" ]] ||
  die "license is '$LICENSE', expected '$EXPECTED_LICENSE' (the sibling SDKs' licence, shipped with its LICENSE file)"
ok "license $LICENSE"

# The release train sets the crate version in the same commit that bumps the
# host, so it must equal the host version of the tree it ships from. Unlike
# the npm pack-only lane, no per-PR job runs this script, so a definite
# mismatch refuses in both modes; only a tree with no carrier at all is a
# build-only note.
host_version_carrier=""
HOST_VERSION=""
ANCHOR_PATH=""
ANCHOR_ROOT="$REPO_ROOT"
package_version() {
  awk '
    /^\[package\]$/ { in_p=1; next }
    /^\[/ && in_p { exit }
    in_p && $1 == "version" && $2 == "=" { gsub(/"/, "", $3); print $3; exit }
  ' "$1"
}
if [[ "$CRATE_DIR" == "$REPO_ROOT/clients/sdk-rs" && -f "$REPO_ROOT/$HOST_CLI_MANIFEST" ]]; then
  # This repository's own crate: D3's host version is the CLI crate's. The
  # mirror carries no CLI crate, so there the anchor below decides.
  host_version_carrier="$HOST_CLI_MANIFEST"
  HOST_VERSION="$(package_version "$REPO_ROOT/$HOST_CLI_MANIFEST")"
else
  if [[ -n "${SDK_ANCHOR_PATH:-}" ]]; then
    ANCHOR_PATH="$SDK_ANCHOR_PATH"
  elif [[ -f "$(dirname "$REPO_ROOT")/publish-anchor.json" ]]; then
    # The mirror writes the anchor at its root, beside rust/; the digest
    # covers the whole carried tree, so it recomputes from that root.
    ANCHOR_ROOT="$(dirname "$REPO_ROOT")"
    ANCHOR_PATH="$ANCHOR_ROOT/publish-anchor.json"
  fi
  if [[ -n "$ANCHOR_PATH" && -f "$ANCHOR_PATH" ]]; then
    host_version_carrier="publish-anchor.json"
    HOST_VERSION="$(python3 -c '
import json, sys
try:
    value = json.load(open(sys.argv[1])).get("host_version")
except Exception:
    value = None
sys.stdout.write(value if isinstance(value, str) else "")
' "$ANCHOR_PATH")"
  fi
fi

if [[ -z "$host_version_carrier" ]]; then
  [[ "$MODE" == "publish" ]] &&
    die "no host-version carrier: no $HOST_CLI_MANIFEST for this tree's crate and no publish-anchor.json, so the lockstep condition cannot be checked"
  note "no host-version carrier found, so --publish would refuse. Build-only does not."
elif [[ -z "$HOST_VERSION" ]]; then
  die "the host-version carrier $host_version_carrier names no version; the lockstep condition cannot be checked"
elif [[ "$VERSION" != "$HOST_VERSION" ]]; then
  die "manifest version $VERSION does not match the host version $HOST_VERSION (from $host_version_carrier). Lockstep: only the release train moves these versions, in one commit; a hand bump is a gate failure, not a release."
else
  ok "version $VERSION matches the host version (from $host_version_carrier)"
fi

# The mirror anchor must also verify: the verifiable-version shape, no denied
# text, and a content digest that recomputes over this tree. --publish
# refuses on any failure; build-only notes shape and digest but refuses
# denied content, read from the checker's machine-readable verdict line.
if [[ "$host_version_carrier" == "publish-anchor.json" ]]; then
  # check-anchor reads the closure manifest at <root>/scripts/, where the
  # release sync puts it in the mirror too.
  anchor_args=(check-anchor --anchor "$ANCHOR_PATH" --root "$ANCHOR_ROOT")
  [[ "$MODE" == "publish" ]] && anchor_args+=(--expect-version "$VERSION")
  if anchor_out="$(python3 "$TEXT_CHECKER" "${anchor_args[@]}" 2>&1)"; then
    ok "mirror publish anchor verifies (content digest matches)"
  elif [[ "$MODE" == "publish" ]]; then
    die "the mirror publish anchor failed verification: $anchor_out"
  elif grep -q -x -F 'anchor-verdict: content-refused' <<<"$anchor_out"; then
    die "the mirror publish anchor carries denied classes: $anchor_out. Content refuses in build-only too."
  else
    note "the mirror publish anchor would refuse --publish ($anchor_out). Build-only does not."
  fi
fi

# ---------------------------------------------------------------------------
# Gate 3 — repository. The published manifest names the public mirror, the
# one public venue, never the private producer.
# ---------------------------------------------------------------------------
step "gate: repository"
[[ "$REPOSITORY" == "$MIRROR_URL" ]] ||
  die "repository is '$REPOSITORY', expected the public mirror $MIRROR_URL"
ok "repository $REPOSITORY"

# ---------------------------------------------------------------------------
# Gate 4 — no path dependencies, dev-dependencies included. A path dependency
# does not exist in the mirror, and cargo would strip a versionless one from
# the published manifest silently.
# ---------------------------------------------------------------------------
step "gate: no path dependencies"
[[ -z "$PATH_DEPS" ]] ||
  die "path dependencies would not resolve outside this tree: $(tr '\n' ' ' <<<"$PATH_DEPS")"
ok "every dependency resolves from a registry"

# ---------------------------------------------------------------------------
# Gate 5 — the packaged file list is exactly the public set: the library, its
# examples, README.md, LICENSE, Cargo.toml, and the files cargo adds.
# ---------------------------------------------------------------------------
step "gate: packaged file list"
"$CARGO" package --list "${DIRTY_FLAG[@]}" --manifest-path "$MANIFEST" >"$WORKDIR/files.txt" ||
  die "cargo package --list failed"
unexpected=""
while IFS= read -r file; do
  case "$file" in
    Cargo.toml | Cargo.toml.orig | Cargo.lock | .cargo_vcs_info.json) ;;
    README.md | LICENSE | src/* | examples/*) ;;
    *) unexpected+="$file " ;;
  esac
done <"$WORKDIR/files.txt"
[[ -z "$unexpected" ]] || die "files outside the public set would ship: $unexpected"
for required in Cargo.toml README.md LICENSE src/lib.rs; do
  grep -q -x -F "$required" "$WORKDIR/files.txt" || die "the package must ship $required"
done
ok "$(wc -l <"$WORKDIR/files.txt" | tr -d ' ') files, all in the public set"

# ---------------------------------------------------------------------------
# Gate 6 — the external-audience text check over the packaged .crate, the
# bytes crates.io and docs.rs would serve (ADR 51992 D3): the README, the
# manifest's description and every packaged .rs file's `//!` docs (module
# pages and the examples' headers) with the full table, and every file,
# cargo's own records included, with the tree tier. A crate packaged from
# this repository's checkout records its private path and refuses here; the
# mirror's records name only public paths.
# ---------------------------------------------------------------------------
step "gate: external-audience text"
"$CARGO" package --no-verify "${DIRTY_FLAG[@]}" --manifest-path "$MANIFEST" >/dev/null 2>"$WORKDIR/package.log" ||
  die "cargo package failed: $(cat "$WORKDIR/package.log")"
# A successful `cargo package` always writes this file; the checker refuses
# one that is missing or unreadable.
CRATE_FILE="$CARGO_TARGET_DIR/package/$NAME-$VERSION.crate"
python3 "$AUDIENCE_CHECKER" --crate "$CRATE_FILE" ||
  die "the packaged crate fails the external-audience text check (findings above)"
ok "the packaged crate passes the external-audience text check"

# ---------------------------------------------------------------------------
# Gate 7 — cargo's own publish checks, short of the upload.
# ---------------------------------------------------------------------------
step "gate: cargo publish --dry-run"
"$CARGO" publish --dry-run "${DIRTY_FLAG[@]}" --manifest-path "$MANIFEST" ||
  die "cargo publish --dry-run failed (output above)"
ok "cargo publish --dry-run passes"

# ---------------------------------------------------------------------------
# Gate 8 — the crate as the mirror holds it. A standalone copy laid out like
# the mirror's rust/ folder, with no workspace above it, must package: any
# workspace inheritance (`[lints] workspace = true` included) or path
# dependency fails here, not after the first publish.
# ---------------------------------------------------------------------------
step "gate: standalone mirror layout"
STANDALONE="$WORKDIR/mirror/rust/clients/sdk-rs"
mkdir -p "$STANDALONE"
for entry in src examples Cargo.toml README.md LICENSE; do
  [[ -e "$CRATE_DIR/$entry" ]] && cp -R "$CRATE_DIR/$entry" "$STANDALONE/"
done
# The tree's lockfile, when there is one, pins the same dependency versions.
for lockfile in "$CRATE_DIR/Cargo.lock" "$REPO_ROOT/Cargo.lock"; do
  [[ -f "$lockfile" ]] && cp "$lockfile" "$STANDALONE/Cargo.lock" && break
done
(cd "$STANDALONE" && "$CARGO" package --allow-dirty --manifest-path "$STANDALONE/Cargo.toml") ||
  die "a standalone copy laid out like the mirror's rust/ folder does not package (output above); no workspace inheritance or path dependency may remain"
ok "a standalone copy packages cleanly"

echo ""
if [[ "$MODE" == "build-only" ]]; then
  echo "All gates passed. NOTHING was published."
  echo ""
  if [[ -z "$TREE_CLEAN" ]]; then
    echo "This run's tree was not a clean checkout; rerun on a clean one before"
    echo "the first publication."
    echo ""
  fi
  echo "The owner's one-time first publication runs by hand, with an owner-held"
  echo "crates.io token, from the root of the public mirror at the release tag,"
  echo "on a clean checkout where this script's build-only run has just passed:"
  echo ""
  echo "  cargo publish --manifest-path rust/clients/sdk-rs/Cargo.toml"
  echo ""
  echo "Later releases go through the mirror's publish-crates.yml, which runs this"
  echo "script with --publish."
  exit 0
fi

step "publish: $NAME $VERSION to crates.io"
"$CARGO" publish --manifest-path "$MANIFEST" || die "cargo publish failed (output above)"
ok "published $NAME $VERSION"
