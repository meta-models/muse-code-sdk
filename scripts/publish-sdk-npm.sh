#!/usr/bin/env bash
#
# publish-sdk-npm.sh — the ONLY sanctioned path to `npm publish` for
# `@muse-code/sdk` (owner launch ruling 4 + the 04:05Z seat extension, hub
# #24410; tracked on #25304).
#
# Default behaviour is `--pack-only`: it runs every gate, builds the tarball,
# prints exactly what would ship, and exits without touching the registry.
# Publishing requires the explicit `--publish` flag. There is no way to publish
# by forgetting an argument.
#
# Version posture: the package versions in LOCKSTEP with the host — D-063
# (2026-09-13, ADR 25304) amended D-013/D-053. The release train sets
# clients/sdk-ts to the crates/cli version in the same commit, `--publish`
# gates on that equality (upstream via crates/cli/Cargo.toml, in the mirror via
# publish-anchor.json's host_version), and the published README must state the
# lockstep / product-stability posture, which `--publish` also gates on below.
#
# ---------------------------------------------------------------------------
# OWNER ONE-TIMERS — none of these can be done by an agent, and nothing
# publishes until they exist.
# ---------------------------------------------------------------------------
#
#   1. Register the `@muse-code` organisation/scope on npmjs.com.
#
#      Registry hygiene while you are there: also claim the bare names `muse-code`
#      and the `@muse` scope, so neither can be squatted into looking official.
#
#   2. THEN pick one auth path — both are supported, and CI should use (a):
#
#      (a) TRUSTED PUBLISHING (OIDC) — preferred, and the only one that yields a
#          verifiable provenance attestation. On npmjs.com, for package
#          `@muse-code/sdk`, add a trusted publisher:
#              repository:  meta-models/muse-code-sdk
#              workflow:    publish-npm.yml
#          No secret is created and nothing is stored anywhere.
#
#          NOTE: `--provenance` requires the source repository to be PUBLIC.
#          npm will not attest a private repo, so a trusted-publishing run must
#          come AFTER the visibility flip tracked on #25304. This script does not
#          silently drop the flag to work around that — it fails.
#
#      (b) GRANULAR AUTOMATION TOKEN — staged, but currently NOT a usable path,
#          and the script refuses it rather than pretending otherwise.
#
#          The coordinator staged a token in the login Keychain (item
#          `npm-muse-code-publish`, account `npm`) for an interim first publish
#          from a maintainer's Mac. That cannot work as specified: npm generates
#          provenance only inside GitHub Actions or GitLab CI, so a manual run
#          fails with "Automatic provenance generation not supported for
#          provider" before it ever contacts the registry. An interim token
#          publish is therefore necessarily a publish WITHOUT provenance —
#          which owner launch ruling 4 does NOT permit.
#
#          Those two directives conflict, and resolving it is an owner call on
#          #25304: either the first publish may go unprovenanced, or the
#          interim-token plan is dropped in favour of (a). Until that is ruled,
#          `--publish` outside Actions fails loudly with that explanation.
#
# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
#   scripts/publish-sdk-npm.sh                # gates + pack, publishes nothing
#   scripts/publish-sdk-npm.sh --pack-only    # the same thing, said explicitly
#   scripts/publish-sdk-npm.sh --publish      # gates + pack + npm publish
#   scripts/publish-sdk-npm.sh --help
#
# Idempotent: if the manifest version is already on the registry, the script
# reports that and exits 0 without republishing. Re-running after a successful
# publish is a no-op, not an error.
#
# Environment (test seams only; defaults are the real tree):
#   SDK_PACKAGE_DIR   package directory to gate and pack
#
set -euo pipefail

readonly EXPECTED_NAME="@muse-code/sdk"
readonly EXPECTED_LICENSE="MIT"
readonly KEYCHAIN_ITEM="npm-muse-code-publish"
# The whitelist the tarball is audited against. Anything outside these prefixes
# in the packed tarball fails the run: `dist/qa` and `dist/test` are built
# beside `dist/src` and carry the conformance oracle, the wire taps and the
# fixture-host driver.
readonly ALLOWED_PREFIXES=("package/dist/src/" "package/package.json" "package/README.md" "package/LICENSE")

repo_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
}

REPO_ROOT="$(repo_root)"
PACKAGE_DIR="${SDK_PACKAGE_DIR:-$REPO_ROOT/clients/sdk-ts}"
MODE="pack-only"
WORKDIR=""

cleanup() {
  # The packed tarball and its scratch dir live here. Remove them whatever
  # happens, including on a gate failure or an interrupt.
  [[ -n "$WORKDIR" && -d "$WORKDIR" ]] && rm -rf "$WORKDIR"
  return 0
}
trap cleanup EXIT INT TERM

die() {
  echo "" >&2
  echo "FAILED: $*" >&2
  echo "Nothing was published." >&2
  exit 1
}

step() { echo "==> $*"; }
ok() { echo "    ok: $*"; }

usage() {
  # Derived, never a pinned line range: this header was rewritten twice in the
  # PR that introduced it, and a pinned tail silently truncates --help the next
  # time a line is added above it. Print from line 3 until the comment block
  # ends.
  awk 'NR < 3 { next } !/^#/ { exit } { sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
  cat <<'EOF'

Flags:
  --pack-only   Run every gate and build the tarball. Publishes nothing. DEFAULT.
  --publish     Run every gate, then publish. Only works inside GitHub Actions:
                npm cannot generate provenance anywhere else, and provenance is
                required. The version must be the host version (D-063 lockstep,
                ADR 25304: crates/cli/Cargo.toml upstream, publish-anchor.json
                host_version in the mirror) and the published README must state
                the lockstep / product-stability posture; --publish checks both
                and refuses without them.
  --help        This text.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pack-only) MODE="pack-only" ;;
    --publish) MODE="publish" ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

command -v node >/dev/null 2>&1 || die "node is required"
command -v npm >/dev/null 2>&1 || die "npm is required"

MANIFEST="$PACKAGE_DIR/package.json"
[[ -f "$MANIFEST" ]] || die "no package.json at $PACKAGE_DIR"

# Read a top-level manifest field without a jq dependency.
field() {
  node -e '
    const m = require(process.argv[1]);
    const v = process.argv[2].split(".").reduce((a, k) => (a == null ? a : a[k]), m);
    process.stdout.write(v === undefined || v === null ? "" : String(v));
  ' "$MANIFEST" "$1"
}

echo "publish-sdk-npm.sh — mode: $MODE"
echo "package: $PACKAGE_DIR"
echo ""

# ---------------------------------------------------------------------------
# Gate 1 — tree anchor. Publishing from a dirty or unknown tree makes the
# provenance attestation a lie: it would name a commit whose content is not what
# was packed.
# ---------------------------------------------------------------------------
step "gate: tree anchor"
if git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  ANCHOR="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  if [[ -n "$(git -C "$REPO_ROOT" status --porcelain -- "$PACKAGE_DIR" 2>/dev/null)" ]]; then
    if [[ "$MODE" == "publish" ]]; then
      die "the package tree has uncommitted changes; a publish must name a commit that actually contains what it ships (git status --porcelain -- $PACKAGE_DIR)"
    fi
    ok "anchor $ANCHOR (tree dirty — tolerated in pack-only, fatal for --publish)"
  else
    ok "anchor $ANCHOR, package tree clean"
  fi
else
  [[ "$MODE" == "publish" ]] && die "not a git checkout; refusing to publish an unanchored tree"
  ok "not a git checkout (pack-only)"
fi

# ---------------------------------------------------------------------------
# Gate 2 — manifest identity. Each of these is something npm would either accept
# wrongly or reject with a worse message.
# ---------------------------------------------------------------------------
step "gate: manifest identity"

NAME="$(field name)"
[[ "$NAME" == "$EXPECTED_NAME" ]] ||
  die "package name is '$NAME', expected '$EXPECTED_NAME' (owner ruling, hub #24410 04:15Z)"
ok "name $NAME"

if [[ -n "$(field private)" ]]; then
  die "manifest is marked private; npm publish would refuse. Remove the field rather than setting it false."
fi
ok "not private"

LICENSE="$(field license)"
[[ "$LICENSE" == "$EXPECTED_LICENSE" ]] ||
  die "license is '$LICENSE', expected '$EXPECTED_LICENSE' (owner ruling 3, provisional)"
ok "license $LICENSE"

VERSION="$(field version)"
[[ -n "$VERSION" ]] || die "manifest has no version"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+].+)?$ ]] || die "version '$VERSION' is not semver"
ok "version $VERSION"

# The lockstep version condition (D-063; ADR 25304 D1). The version is set by
# the release train in the same commit that bumps crates/cli, so the manifest
# must equal the host version of the tree it ships from. Upstream that carrier
# is crates/cli/Cargo.toml itself; in the public mirror — whose tree is exactly
# the source closure and carries no crates/* path — the re-sync writes the
# carried commit's host version into the mirror's own publish-anchor.json
# (`host_version`), and the gate reads it from there.
#
# Publish-only on purpose, like the posture gate below: pack-only runs in CI on
# every sdk-lane PR, and the same-tree equality already lives in
# clients/sdk-ts/test/npm-publication.test.ts, which reds a diverging PR in
# the path-filtered tbh-muse-sdk-ts lane (the upstream carrier file is on
# that lane's path list precisely so a carrier-only edit still runs it).
host_version_carrier=""
HOST_VERSION=""
if [[ -f "$REPO_ROOT/crates/cli/Cargo.toml" ]]; then
  host_version_carrier="crates/cli/Cargo.toml"
  HOST_VERSION="$(awk '
    /^\[package\]$/ { in_p=1; next }
    /^\[/ && in_p { exit }
    in_p && $1 == "version" && $2 == "=" { gsub(/"/, "", $3); print $3; exit }
  ' "$REPO_ROOT/crates/cli/Cargo.toml")"
elif [[ -f "$REPO_ROOT/publish-anchor.json" ]]; then
  host_version_carrier="publish-anchor.json"
  # Tolerant parse: a malformed anchor must not crash pack-only with a raw
  # Node stack (Constitution XIII scoped failure) — an empty HOST_VERSION
  # routes it to the same "names no version" refusal on --publish and a note
  # on pack-only.
  HOST_VERSION="$(node -e '
    const a = require(process.argv[1]);
    process.stdout.write(typeof a.host_version === "string" ? a.host_version : "");
  ' "$REPO_ROOT/publish-anchor.json" 2>/dev/null || true)"
fi

if [[ -n "$HOST_VERSION" && "$VERSION" == "$HOST_VERSION" ]]; then
  if [[ "$host_version_carrier" == "publish-anchor.json" ]]; then
    ok "version $VERSION matches the mirror publish anchor host_version (D-063 lockstep)"
  else
    ok "version $VERSION matches the host (crates/cli) version (D-063 lockstep)"
  fi
elif [[ "$MODE" == "publish" ]]; then
  if [[ -z "$host_version_carrier" ]]; then
    die "no host-version carrier: neither crates/cli/Cargo.toml nor a publish-anchor.json with host_version exists in this tree, so the D-063 lockstep condition cannot be checked. In the mirror, the re-sync writes host_version into publish-anchor.json; a publish from a tree that names no host version is a publish of an unverifiable version."
  elif [[ -z "$HOST_VERSION" ]]; then
    die "the host-version carrier $host_version_carrier names no version; the D-063 lockstep condition cannot be checked"
  else
    die "manifest version $VERSION does not match the host version $HOST_VERSION (from $host_version_carrier). D-063 lockstep (ADR 25304 D1): only the release train moves these versions, in one commit; a hand bump is a gate failure, not a release."
  fi
else
  if [[ -z "$HOST_VERSION" ]]; then
    echo "    note: no host-version carrier found, so --publish would refuse (D-063). Pack-only does not."
  else
    echo "    note: manifest version $VERSION does not match the host version $HOST_VERSION, so --publish would refuse (D-063). Pack-only does not; the always-on equality lives in npm-publication.test.ts."
  fi
fi

# The published posture condition (D-063; ADR 25304 D3). D-053's 0.x
# experimental / no-stability posture was superseded when the lockstep landed:
# the published README now states the product posture instead — the version
# tracks the Muse Code release (lockstep), the stable MSP surface follows the
# product's compatibility posture, and experimental (x-msp-openness) surfaces
# may change. A registry reader never opens a decision record, so the posture
# has to travel with the artifact; that is the condition on which publishing is
# permitted, so it is a gate here rather than a review note.
#
# Publish-only on purpose. Pack-only must stay green whatever the README says —
# CI runs pack-only on every push, and coupling this package's build to a
# documentation edit would red the workspace for a reason that has nothing to do
# with whether the tarball is correct.
readme_states_product_posture() {
  local readme="$PACKAGE_DIR/README.md"
  [[ -f "$readme" ]] || return 1
  # One marker per clause tdd SS7.1 makes normative, not one pinned sentence:
  # the requirement is that the posture is STATED, and pinning exact wording
  # here would make every README edit a publish outage.
  #
  #   1. the version is the Muse Code release it ships with (lockstep),
  #   2. the stable surface carries the product's compatibility posture,
  #   3. experimental-marked surfaces may change or be removed.
  grep -qiE 'lockstep|version (tracks|matches|follows|is) (the )?(muse|host)' "$readme" || return 1
  grep -qiE 'stable (msp )?surface|compatibility (posture|promise)' "$readme" || return 1
  grep -qiE '(^|[^a-z])experimental' "$readme" || return 1
  grep -qiE 'may change|change or remove|subject to change' "$readme" || return 1
  # Loose markers are substring matches, so a README asserting the OPPOSITE
  # posture could otherwise satisfy clause 1 — "no longer in lockstep" contains
  # the word. Reject that inversion explicitly: a gate that a negation passes
  # is not a gate. ONE guard, deliberately (the D-053-era gate's lesson: a
  # second guard killed correct natural wording); other inversions are caught
  # by review, which is what tdd SS7.1's "markers are a floor" sentence says.
  ! grep -qiE '(no longer|not)[[:space:]]+(in[[:space:]]+)?lockstep' "$readme" || return 1
}

if readme_states_product_posture; then
  ok "README states the lockstep / product-stability posture (D-063)"
elif [[ "$MODE" == "publish" ]]; then
  die "publishing requires the README to state the lockstep / product-stability posture explicitly, and $PACKAGE_DIR/README.md does not. D-013 as amended by D-053 and D-063 (specs/13929-msp-activation/tdd.md SS7.1; ADR 25304 D3) permits this publish BECAUSE the artifact carries the posture; without it the publish quietly drops the principle the amendments kept. All three clauses must be there, and none of them negated: the version is the Muse Code release it ships with; the stable surface follows the product's compatibility posture; experimental-marked surfaces may change or be removed."
else
  echo "    note: the README does not state the lockstep / product-stability posture yet, so --publish would refuse (D-063). Pack-only does not."
fi

ACCESS="$(field publishConfig.access)"
[[ "$ACCESS" == "public" ]] ||
  die "publishConfig.access is '$ACCESS', expected 'public' — npm defaults a scoped package to restricted"
ok "publishConfig.access public"

RUNTIME_DEPS="$(node -e 'process.stdout.write(Object.keys(require(process.argv[1]).dependencies||{}).join(","))' "$MANIFEST")"
if [[ -n "$RUNTIME_DEPS" ]]; then
  die "runtime dependencies declared ($RUNTIME_DEPS) — spec 14990 INV-009 makes that an owner escalation under the O-3 precedent, not a packaging decision"
fi
ok "zero runtime dependencies (INV-009)"

# ---------------------------------------------------------------------------
# Gate 3 — build. `prepack` builds too, but doing it here means a compile error
# fails with a compiler message instead of an empty tarball.
# ---------------------------------------------------------------------------
step "gate: build"
(cd "$PACKAGE_DIR" && npm run --silent build) || die "build failed"
ok "tsc --build clean"

# ---------------------------------------------------------------------------
# Gate 4 — already published? This is what makes the script idempotent, and it
# runs BEFORE the pack so a re-run costs nothing.
# ---------------------------------------------------------------------------
step "gate: registry state"
ALREADY_PUBLISHED="no"
if NPM_VIEW="$(npm view "$NAME@$VERSION" version --json 2>/dev/null)" && [[ -n "$NPM_VIEW" && "$NPM_VIEW" != "null" ]]; then
  ALREADY_PUBLISHED="yes"
  ok "$NAME@$VERSION is already on the registry"
else
  ok "$NAME@$VERSION is not on the registry yet"
fi

# ---------------------------------------------------------------------------
# Gate 5 — pack, then audit the tarball against the whitelist. The manifest's
# `files` field is a claim; this checks what npm actually produced.
# ---------------------------------------------------------------------------
step "gate: pack and audit"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/muse-code-sdk-publish.XXXXXX")"
chmod 700 "$WORKDIR"
PACKDIR="$WORKDIR/pack"
mkdir -p "$PACKDIR"

(cd "$PACKAGE_DIR" && npm pack --pack-destination "$PACKDIR" >/dev/null) || die "npm pack failed"
TARBALL="$(find "$PACKDIR" -name '*.tgz' -type f | head -1)"
[[ -n "$TARBALL" ]] || die "npm pack produced no tarball"

mapfile -t ENTRIES < <(tar -tzf "$TARBALL" | grep -v '/$' | sort)
[[ ${#ENTRIES[@]} -gt 0 ]] || die "the tarball is empty"

UNEXPECTED=()
for entry in "${ENTRIES[@]}"; do
  allowed="no"
  for prefix in "${ALLOWED_PREFIXES[@]}"; do
    [[ "$entry" == "$prefix"* ]] && allowed="yes" && break
  done
  [[ "$allowed" == "no" ]] && UNEXPECTED+=("$entry")
done

if [[ ${#UNEXPECTED[@]} -gt 0 ]]; then
  echo "" >&2
  echo "the tarball contains ${#UNEXPECTED[@]} path(s) outside the files whitelist:" >&2
  printf '    %s\n' "${UNEXPECTED[@]}" >&2
  die "tarball audit: unexpected paths (whitelist: ${ALLOWED_PREFIXES[*]})"
fi
ok "${#ENTRIES[@]} files, all inside the whitelist"

# The whitelist is allow-only, so it can prove nothing is EXTRA but never that
# something required is present. These must actually be in the tarball:
#
#  - main/types, because a tarball missing its own entry point is precisely what
#    a gitignored `dist/` produces, and npm reports no error for it;
#  - LICENSE, because gate 2 pins `license: MIT` and MIT requires shipping the
#    text. npm only auto-includes a LICENSE from the PACKAGE directory, so the
#    mirror's repo-root copy does not satisfy this and a license-less publish
#    would otherwise pass every gate;
#  - README.md, because it is the package's npm front page.
#
# Matched against the ENTRIES array rather than re-piping tar into `grep -q`:
# under `set -o pipefail` grep's early exit SIGPIPEs tar, and the pipeline then
# reports 141 for a SUCCESSFUL match.
REQUIRED_ENTRIES=("$(field main)" "$(field types)" "LICENSE" "README.md")
for f in "${REQUIRED_ENTRIES[@]}"; do
  [[ -n "$f" ]] || die "main/types not declared"
  found="no"
  for entry in "${ENTRIES[@]}"; do
    [[ "$entry" == "package/$f" ]] && found="yes" && break
  done
  [[ "$found" == "yes" ]] || die "required file '$f' is not in the tarball (a MIT-labelled package must ship its licence text; entry points must exist, not merely be declared)"
done
ok "main, types, LICENSE and README present in the tarball"

# ---------------------------------------------------------------------------
# Gate 6 — external audience. The README is the package's npm long description
# and the manifest description is its listing summary; 0.1.1 shipped both
# citing artifacts only the producing repository resolves (#37515, the npm
# instance of the PyPI #36888 leak class). The checker audits the PACKED
# tarball, so what is gated is what the upload step would actually ship. It
# runs in pack-only too, on purpose: pack-only rides CI on every sdk-lane PR,
# which is what reds a new leak before merge instead of at publish time.
#
# The checker is shared with the Python publish gate. Upstream it sits next to
# this script; in the public mirror the Python closure lands under python/, so
# both layouts are tried. A missing checker fails closed: a republish that
# drops it must dead-end here, not publish unaudited (the publish-sdk-pypi.sh
# posture; the closure manifest names the file for the re-sync).
# ---------------------------------------------------------------------------
step "gate: external audience (README + manifest description)"
AUDIENCE_CHECKER=""
for candidate in \
  "$REPO_ROOT/scripts/check-sdk-py-external-audience.py" \
  "$REPO_ROOT/python/scripts/check-sdk-py-external-audience.py"; do
  [[ -f "$candidate" ]] && AUDIENCE_CHECKER="$candidate" && break
done
[[ -n "$AUDIENCE_CHECKER" ]] ||
  die "check-sdk-py-external-audience.py is missing from this tree (looked under scripts/ and python/scripts/). It is a closure path in scripts/sdk-source-closure.json; a republish must carry it, and publishing without the audience audit would risk re-shipping the 0.1.1 leak class (#37515)."
command -v python3 >/dev/null 2>&1 ||
  die "python3 is required for the external-audience gate (it runs check-sdk-py-external-audience.py over the packed tarball)"
python3 "$AUDIENCE_CHECKER" --npm-tarball "$TARBALL" ||
  die "the packed tarball's README/description reference private repository artifacts (#37515). Rewrite them for an npm reader; the findings above name each leak class."
ok "no private repository references in the packed README/description"

echo ""
echo "would publish: $NAME@$VERSION  ($(wc -c <"$TARBALL" | tr -d ' ') bytes)"
printf '    %s\n' "${ENTRIES[@]}"
echo ""

# ---------------------------------------------------------------------------
# Publish, or stop.
# ---------------------------------------------------------------------------
if [[ "$MODE" != "publish" ]]; then
  echo "pack-only: every gate passed and NOTHING was published."
  echo "Re-run with --publish to publish (see --help for the owner one-timers)."
  exit 0
fi

if [[ "$ALREADY_PUBLISHED" == "yes" ]]; then
  echo "$NAME@$VERSION is already published; nothing to do (idempotent no-op)."
  echo "Bump the version in $MANIFEST to publish a new release."
  exit 0
fi

step "auth"
if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
  # Trusted publishing. npm performs the OIDC exchange itself; there is no
  # token to fetch, hold, or leak. `id-token: write` in the calling workflow is
  # the whole credential story.
  ok "GitHub Actions detected — npm trusted publishing (OIDC)"
  [[ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]] ||
    die "running in Actions but no OIDC token is available: the calling workflow needs 'permissions: id-token: write'"
else
  # npm generates provenance ONLY inside a supported CI provider (GitHub Actions
  # or GitLab CI): libnpmpublish throws "Automatic provenance generation not
  # supported for provider" before anything reaches the registry. So a manual
  # run cannot satisfy the ruling's --provenance requirement, and every line of
  # Keychain-token machinery downstream of here would dead-end 100% of the time.
  #
  # Failing here, with the real reason, rather than further down where the
  # generic npm-publish failure message would misdiagnose it as "the source
  # repository is still private".
  #
  # This leaves ONE open decision, and it is not mine: the coordinator staged a
  # granular automation token (Keychain `npm-muse-code-publish`, account `npm`)
  # for an interim first publish, and an interim token publish is by definition
  # a publish WITHOUT provenance — which owner launch ruling 4 does NOT permit.
  # Those two directives conflict. Resolving it means either dropping the provenance
  # requirement for the first publish or dropping the interim-token plan; both
  # are owner calls, tracked on #25304. Until then the Actions path is the only
  # publish path, and it is the one that produces a verifiable artifact anyway.
  die "manual publish cannot produce provenance — npm only generates it inside GitHub Actions or GitLab CI, so --provenance fails before the registry is contacted. Run the publish-npm.yml workflow in meta-models/muse-code-sdk instead. (The staged Keychain token '$KEYCHAIN_ITEM' would give an unprovenanced publish, which owner launch ruling 4 does not permit; that conflict is an owner decision on #25304.)"
fi

step "publish"
# --provenance is not optional. If the source repo is still private npm will
# refuse to attest, and this fails loudly rather than publishing something
# weaker than what was asked for.
(cd "$PACKAGE_DIR" && npm publish --provenance --access public) ||
  die "npm publish failed. If the error mentions provenance, the source repository is still private — that flip is an owner step on #25304, and dropping the flag is not the fix."

echo ""
echo "published $NAME@$VERSION with provenance."
