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
# Version posture: publishing at 0.x IS permitted, since D-053 (2026-08-31)
# amended D-013. The stability promise is still withheld until 1.0 — the
# amendment preserved it by requiring the published README to state the
# experimental / no-stability posture, which `--publish` gates on below.
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
                required. Publishing at 0.x is permitted (D-013 as amended by
                D-053) provided the published README states the experimental /
                no-stability posture; --publish checks that and refuses without
                it.
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

# The 0.x posture condition. D-013 read "no stability promise, no published SDK,
# no conformance claim before 1.0", and the version interlock that used to sit
# here refused every 0.x publish on the strength of it. D-053 (2026-08-31, owner
# ruling "(c)" on hub #24410; specs/13929-msp-activation/decision.md) amended
# that: publishing at 0.x is PERMITTED. The interlock was deleted in the same PR
# that landed the amendment, as its own comment required.
#
# What the amendment did NOT do is delete the principle. It moved it onto the
# artifact: a registry reader never opens a decision record, so the published
# README has to say, in the reader's own terms, that this is a 0.x experimental
# release with no stability promise before 1.0. That is the condition on which
# publishing is permitted, so it is a gate here rather than a review note.
#
# Publish-only on purpose. Pack-only must stay green whatever the README says —
# CI runs pack-only on every push, and coupling this package's build to a
# documentation edit would red the workspace for a reason that has nothing to do
# with whether the tarball is correct.
readme_states_0x_posture() {
  local readme="$PACKAGE_DIR/README.md"
  [[ -f "$readme" ]] || return 1
  # One marker per clause tdd SS7.1 makes normative, not one pinned sentence:
  # the requirement is that the posture is STATED, and pinning exact wording
  # here would make every README edit a publish outage.
  #
  #   1. this is an experimental release,
  #   2. there is no stability promise before 1.0,
  #   3. a release may change or remove API in use.
  grep -qiE '(^|[^a-z])experimental' "$readme" || return 1
  grep -qiE 'no stability promise|no stability guarantee|not stable|no compatibility promise' "$readme" || return 1
  grep -qiE 'may change|change or remove|subject to change' "$readme" || return 1
  # Loose markers are substring matches, so a README asserting the OPPOSITE
  # posture could otherwise satisfy clause 1 — "this SDK is no longer
  # experimental" contains the word. Reject that inversion explicitly: a gate
  # that a negation passes is not a gate.
  #
  # ONE guard, deliberately. A second guard on "the stability promise applies"
  # was tried and removed: it also matched the correct posture stated as "no
  # stability promise applies before 1.0" and killed the publish on natural
  # wording — the wording-sensitive outage loose markers exist to avoid. Other
  # inversions (a README promising nothing will ever change) are caught by
  # review, which is what tdd SS7.1's "markers are a floor" sentence says.
  ! grep -qiE '(no longer|not|nolonger)[[:space:]]+experimental' "$readme" || return 1
}

if [[ "${VERSION%%.*}" == "0" ]]; then
  if readme_states_0x_posture; then
    ok "README states the 0.x experimental / no-stability posture (D-053)"
  elif [[ "$MODE" == "publish" ]]; then
    die "publishing at 0.x requires the README to state the experimental / no-stability posture explicitly, and $PACKAGE_DIR/README.md does not. D-013 as amended by D-053 (specs/13929-msp-activation/tdd.md SS7.1) permits this publish BECAUSE the artifact carries the posture; without it the publish quietly drops the principle the amendment kept. All three clauses must be there, and none of them negated: this is an experimental release; there is no stability promise before 1.0; a release may change or remove API in use."
  else
    echo "    note: the README does not state the 0.x experimental / no-stability posture yet, so --publish would refuse (D-053). Pack-only does not."
  fi
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
