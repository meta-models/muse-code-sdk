#!/usr/bin/env bash
#
# publish-sdk-pypi.sh — the ONLY sanctioned path to a PyPI publish for
# `muse-code-msp` and `muse-code-sdk`. The publish act is OWNER-RUN, and
# this script only prepares it.
#
# Default behaviour is `--build-only`: it runs every gate OFFLINE, builds both
# distributions, audits the wheels, derives the per-wheel compatibility rows,
# prints exactly what the owner would run, and exits without touching any
# registry. Publishing requires the explicit `--publish` flag; there is no way
# to publish by forgetting an argument.
#
# Publication timing: publishing these two distributions to PyPI is ruled
# in — owner-run mirror path only, at the lockstep host version the release
# train wrote into the manifests, under the product's stability posture.
# `--publish` still refuses outside the mirror's publish-pypi.yml: trusted
# publishing performs its OIDC exchange only there, and there is no
# manual-token path, by design.
#
# Unlike publish-sdk-npm.sh, this script NEVER contacts a registry, even in
# `--publish` mode: PyPI trusted publishing performs its OIDC exchange inside
# the upload step (pypa/gh-action-pypi-publish) of the mirror's
# publish-pypi.yml, so this script holds no credential and does no network
# I/O. The gates live here; the workflow's upload step runs only after this
# exits 0 and uploads the dist tree this script staged and audited. There is
# also no registry-idempotence probe (the npm script's gate 4): PyPI refuses a
# duplicate file upload server-side, and an offline default is worth more than
# a nicer message for that case.
#
# ---------------------------------------------------------------------------
# OWNER ONE-TIMERS — none of these can be done by an agent, and
# nothing publishes until they exist.
# ---------------------------------------------------------------------------
#
#   1. Register the PyPI project names `muse-code-msp` and `muse-code-sdk`.
#
#   2. Bind a trusted publisher (OIDC) for both names on the mirror
#      `meta-models/muse-code-sdk`, workflow `publish-pypi.yml` — never an
#      agent-invented token.
#
#   3. Extend the mirror bridge with the Python closure (`python/` tree)
#      entries of scripts/sdk-source-closure.json, so a republish carries the
#      source the wheels are built from.
#
# The owner-run sequence, once those exist: dispatch the mirror's
# publish-pypi.yml, which calls this script by path with `--publish`
# (muse-code-msp rides first — the facade's wheel is meaningless without the
# wire types) and then uploads the staged dist tree via
# pypa/gh-action-pypi-publish; finally commit the per-wheel rows this script
# printed to clients/sdk-py/published-wheels.json upstream, which is how the
# compatibility page's Python row gains the release's wheels (the docs
# publish rides the SDK publish).
#
# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
#   scripts/publish-sdk-pypi.sh                # gates + build, publishes nothing
#   scripts/publish-sdk-pypi.sh --build-only   # the same thing, said explicitly
#   scripts/publish-sdk-pypi.sh --publish      # gates + build + stage for the
#                                              # workflow's upload step; refuses
#                                              # outside the mirror's
#                                              # publish-pypi.yml
#   scripts/publish-sdk-pypi.sh --help
#
# Environment:
#   SDK_PY_PYTHON   test seam: interpreter carrying the dev lock (build,
#                   setuptools); defaults to python3 on PATH
#
#   TBH_SDK_KEEP_DIR  the release-cut keep dir: when set, build-only mode
#                   copies the built distributions and wheel-rows.json here
#                   for the release run's artifact upload. Unset, nothing is
#                   kept. Not a test seam — the release lane sets it for
#                   real; the contract suite drives it through fakes on the
#                   helper's script seams instead.
#
set -euo pipefail

readonly EXPECTED_LICENSE="MIT"
readonly MIRROR_REPO="meta-models/muse-code-sdk"
# msp first: the owner-run publish ships the wire types before the facade.
readonly PACKAGE_DIRS=("clients/msp-py" "clients/sdk-py")

repo_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
}

REPO_ROOT="$(repo_root)"
PYTHON="${SDK_PY_PYTHON:-python3}"
MODE="build-only"
WORKDIR=""

cleanup() {
  # The built distributions and their scratch dir live here. Remove them
  # whatever happens. The publish-mode staged tree survives because it is
  # COPIED to a path outside this scratch dir precisely so this trap never
  # touches what the calling workflow's upload step consumes.
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
  # Derived, never a pinned line range (the publish-sdk-npm.sh lesson): print
  # from line 3 until the comment block ends.
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
# Trusted-publishing gate (publish mode only) — checked FIRST, before even
# the tooling preflight, so the refusal names the governing constraint
# rather than whatever incidental check a dev machine trips, and a refused
# --publish never runs the build gates. It needs only $MODE and the env.
# Either way this script contacts no registry: the calling workflow's upload
# step (pypa/gh-action-pypi-publish) performs the OIDC exchange. (Not named
# "Gate 0": the deleted Gate 0 was the old publication-timing
# refusal; this block is the surviving mirror-workflow-only constraint.)
# ---------------------------------------------------------------------------
if [[ "$MODE" == "publish" ]]; then
  step "gate: trusted-publishing context"
  [[ -n "${GITHUB_ACTIONS:-}" ]] ||
    die "the publish path runs only inside the mirror's publish-pypi.yml (trusted publishing); there is no manual-token path, by design"
  [[ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]] ||
    die "running in Actions but no OIDC token is available: the calling workflow needs 'permissions: id-token: write'"
  ok "inside the mirror workflow with an OIDC token available"
fi

# ---------------------------------------------------------------------------
# Mirror-anchor gate — right after the trusted context, before the tooling
# preflight and the build gates, so a refused --publish never runs them. The
# anchor must be the verifiable-version shape (host_version plus a content
# digest, no producing-side references) and the digest must recompute over
# this tree, through the shared public-bound-text gate every publish path
# calls. --publish refuses on any failure, including a missing anchor: a
# publish from a tree that names no verifiable version is a publish of an
# unverifiable version. Build-only notes a missing anchor or a shape/digest
# failure (what --publish would refuse) but still refuses anchor bytes
# carrying denied classes — content is never noteable (the Gate 4b
# posture). The classification reads check-anchor's machine-readable
# verdict line, computed once in the shared gate — never the human prose,
# so rewording a message cannot mute a content refusal into a note.
# The match is a full line, not a substring: the die echoes the anchor
# output, so a shape-only anchor quoting the token would otherwise
# escalate a note into a die.
# A missing checker dies in both modes: missing infrastructure,
# not a condition.
# This gate binds shape and digest only: it runs before any manifest is
# parsed, so it cannot yet name the built version. The version binding
# lives in Gate 2, per package: --publish refuses on mismatch,
# build-only notes it (npm lockstep-note parity). The tree is pinned
# with --root, following the resolved anchor's layout: a rooted anchor
# digests the repo root, a sibling anchor the mirror root. Only the
# auto-resolution moves the root — an explicit SDK_ANCHOR_PATH pins the
# anchor alone, never the tree, so proof anchors live outside it.
# SDK_ANCHOR_PATH overrides the anchor location for tests; the publish
# workflow never sets it.
# ---------------------------------------------------------------------------
step "gate: mirror anchor"
command -v "$PYTHON" >/dev/null 2>&1 || die "$PYTHON is required for the mirror-anchor verification"
TEXT_CHECKER=""
for candidate in \
  "$REPO_ROOT/scripts/check-public-mirror-text.py" \
  "$REPO_ROOT/python/scripts/check-public-mirror-text.py"; do
  [[ -f "$candidate" ]] && TEXT_CHECKER="$candidate" && break
done
[[ -n "$TEXT_CHECKER" ]] ||
  die "check-public-mirror-text.py is missing from this tree (looked under scripts/ and python/scripts/). It is a closure path in scripts/sdk-source-closure.json; a republish must carry it, and publishing without the anchor audit would risk shipping an unverifiable anchor."
ANCHOR_PATH="${SDK_ANCHOR_PATH:-$REPO_ROOT/publish-anchor.json}"
ANCHOR_ROOT="$REPO_ROOT"
if [[ -z "${SDK_ANCHOR_PATH:-}" && ! -f "$ANCHOR_PATH" ]]; then
  # Mirror layout: publish-pypi.yml calls python/scripts/publish-sdk-pypi.sh,
  # so REPO_ROOT is the mirror's python/ tree while the re-mirror writes the
  # anchor at the mirror root — probe the verbatim sibling (the wheel-rows
  # verbatim-sibling precedent: the rooted layout wins wherever it exists).
  # The digest root follows the anchor: the digest covers the whole carried
  # tree and only recomputes from the mirror root.
  SIBLING_ROOT="$(dirname "$REPO_ROOT")"
  if [[ -f "$SIBLING_ROOT/publish-anchor.json" ]]; then
    ANCHOR_PATH="$SIBLING_ROOT/publish-anchor.json"
    ANCHOR_ROOT="$SIBLING_ROOT"
  fi
fi
ANCHOR_VERIFIED="" # set only by the mirror gate's ok branch
if [[ ! -f "$ANCHOR_PATH" ]]; then
  if [[ "$MODE" == "publish" ]]; then
    die "no publish anchor at $ANCHOR_PATH, so --publish names no verifiable version. In the mirror, the re-sync writes publish-anchor.json; a publish from a tree without one is a publish of an unverifiable version."
  else
    echo "    note: no publish anchor found, so --publish would refuse. Build-only does not."
  fi
else
  CLOSURE_MANIFEST=""
  for candidate in \
    "$REPO_ROOT/scripts/sdk-source-closure.json" \
    "$REPO_ROOT/python/scripts/sdk-source-closure.json"; do
    [[ -f "$candidate" ]] && CLOSURE_MANIFEST="$candidate" && break
  done
  anchor_args=(check-anchor --anchor "$ANCHOR_PATH" --root "$ANCHOR_ROOT")
  [[ -n "$CLOSURE_MANIFEST" ]] && anchor_args+=(--manifest "$CLOSURE_MANIFEST")
  if [[ "$MODE" == "publish" ]]; then
    "$PYTHON" "$TEXT_CHECKER" "${anchor_args[@]}" ||
      die "the publish anchor failed verification (findings above); refusing an unverifiable version"
    ok "publish anchor verifies (verifiable version, content digest matches)"
  else
    if anchor_out="$("$PYTHON" "$TEXT_CHECKER" "${anchor_args[@]}" 2>&1)"; then
      ok "publish anchor verifies (verifiable version, content digest matches)"
      ANCHOR_VERIFIED=1
    elif grep -q -x -F 'anchor-verdict: content-refused' <<<"$anchor_out"; then
      die "the publish anchor carries denied classes: $anchor_out. Content refuses in build-only too."
    else
      echo "    note: the publish anchor would refuse --publish ($anchor_out). Build-only does not."
    fi
  fi
fi

command -v "$PYTHON" >/dev/null 2>&1 || die "$PYTHON is required"
command -v git >/dev/null 2>&1 || die "git is required"
"$PYTHON" -c 'import build' 2>/dev/null ||
  die "the 'build' package is missing; install the dev lock (clients/py-dev-requirements.txt)"

echo "publish-sdk-pypi.sh — mode: $MODE"
echo "packages: ${PACKAGE_DIRS[*]}"
echo ""

# Read a [project] field without assuming tomllib (Python 3.10 uses the dev
# lock's tomli). Dotted keys walk tables; a missing leaf prints nothing.
field() {
  "$PYTHON" -c '
import sys
try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib
with open(sys.argv[1], "rb") as handle:
    value = tomllib.load(handle)
for key in sys.argv[2].split("."):
    if not isinstance(value, dict) or key not in value:
        sys.exit(0)
    value = value[key]
sys.stdout.write(value if isinstance(value, str) else repr(value))
' "$1" "$2"
}

# ---------------------------------------------------------------------------
# Gate 1 — tree anchor. Publishing from a dirty or unknown tree makes the
# release's provenance a lie: it would name a commit whose content is not what
# was built.
# ---------------------------------------------------------------------------
step "gate: tree anchor"
if git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  ANCHOR="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  DIRTY=""
  for package in "${PACKAGE_DIRS[@]}"; do
    [[ -n "$(git -C "$REPO_ROOT" status --porcelain -- "$package" 2>/dev/null)" ]] && DIRTY="$package"
  done
  if [[ -n "$DIRTY" ]]; then
    [[ "$MODE" == "publish" ]] &&
      die "the $DIRTY tree has uncommitted changes; a publish must name a commit that actually contains what it ships"
    ok "anchor $ANCHOR (tree dirty — tolerated in build-only, fatal for --publish)"
  else
    ok "anchor $ANCHOR, package trees clean"
  fi
else
  [[ "$MODE" == "publish" ]] && die "not a git checkout; refusing to publish an unanchored tree"
  ok "not a git checkout (build-only)"
fi

# ---------------------------------------------------------------------------
# Gate 2 — manifest identity, per package. Each of these is something PyPI
# would either accept wrongly or reject with a worse message.
# ---------------------------------------------------------------------------
for package in "${PACKAGE_DIRS[@]}"; do
  step "gate: manifest identity ($package)"
  MANIFEST="$REPO_ROOT/$package/pyproject.toml"
  [[ -f "$MANIFEST" ]] || die "no pyproject.toml at $package"

  NAME="$(field "$MANIFEST" project.name)"
  case "$package" in
    clients/msp-py) EXPECTED_NAME="muse-code-msp" ;;
    clients/sdk-py) EXPECTED_NAME="muse-code-sdk" ;;
  esac
  [[ "$NAME" == "$EXPECTED_NAME" ]] ||
    die "$package: name is '$NAME', expected '$EXPECTED_NAME' (the chartered PyPI names)"
  ok "name $NAME"

  VERSION="$(field "$MANIFEST" project.version)"
  # Plain X.Y.Z only, deliberately: setuptools normalizes anything else to
  # PEP 440 in the built wheel's filename (1.0.0-rc.1 -> 1.0.0rc1), so a
  # suffixed version would make the derived per-wheel row miss the real
  # artifact. The first pre-release, if one is ever wanted, extends the row
  # derivation first.
  [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "$package: version '$VERSION' is not plain X.Y.Z semver (a PEP 440 suffix changes the built wheel's filename; extend scripts/sdk-py-wheel-rows.py before publishing a pre-release)"
  ok "version $VERSION"

  # Publish-only anchor version binding: the mirror gate above verified
  # anchor shape and content digest, but a stale anchor for another
  # version verifies too when the mirrored bytes are unchanged between
  # releases — so each package binds the anchor's host_version to its
  # own built version here. Build-only omits the binding (npm parity).
  if [[ "$MODE" == "publish" ]]; then
    version_args=(check-anchor --anchor "$ANCHOR_PATH" --root "$ANCHOR_ROOT")
    [[ -n "$CLOSURE_MANIFEST" ]] && version_args+=(--manifest "$CLOSURE_MANIFEST")
    version_args+=(--expect-version "$VERSION")
    "$PYTHON" "$TEXT_CHECKER" "${version_args[@]}" ||
      die "$package: the publish anchor names a different version than the built $VERSION (findings above); refusing a version-unverifiable publish"
  elif [[ -n "$ANCHOR_VERIFIED" ]]; then
    # Build-only notes what --publish would refuse (npm lockstep-note
    # parity): a stale anchor version notes here and dies there. The
    # mirror gate already proved shape, digest, and content on this
    # exact tree, so any refusal from this --expect-version rerun is a
    # version mismatch by elimination — classified on the verdict
    # token like every publisher, never on the checker's prose.
    version_args=(check-anchor --anchor "$ANCHOR_PATH" --root "$ANCHOR_ROOT")
    [[ -n "$CLOSURE_MANIFEST" ]] && version_args+=(--manifest "$CLOSURE_MANIFEST")
    version_args+=(--expect-version "$VERSION")
    if version_out="$("$PYTHON" "$TEXT_CHECKER" "${version_args[@]}" 2>&1)"; then
      :  # Bound: build-only stays silent on a matching version.
    elif grep -q -x -F 'anchor-verdict: content-refused' <<<"$version_out"; then
      # Unreachable on a static tree (the mirror gate dies on content
      # first); die here so an anchor swapped between gates cannot
      # sail past denied bytes (Gate 4b: content refuses in
      # build-only too).
      die "the publish anchor carries denied classes: $version_out. Content refuses in build-only too."
    elif grep -q -x -F 'anchor-verdict: refused' <<<"$version_out"; then
      # The verdict decides note-vs-silent (the token rule: verdict
      # token, never the checker's prose); the prose below only picks
      # the note's wording after refusal is established, so a checker
      # rewording degrades the text to the generic note, never to
      # silence.
      if grep -q -F "version mismatch for" <<<"$version_out"; then
        echo "    note: the publish anchor names a different version than the built $VERSION, so --publish would refuse on version binding. Build-only does not."
      else
        echo "    note: the publish anchor version recheck refused ($version_out), so --publish would refuse. Build-only does not."
      fi
    else
      echo "    note: the publish anchor version recheck failed without a verdict ($version_out), so --publish would refuse. Build-only does not."
    fi
  fi

  LICENSE="$(field "$MANIFEST" project.license)"
  [[ "$LICENSE" == "$EXPECTED_LICENSE" ]] ||
    die "$package: license is '$LICENSE', expected the SPDX expression '$EXPECTED_LICENSE'"
  [[ -f "$REPO_ROOT/$package/LICENSE" ]] ||
    die "$package: MIT requires shipping the text, and license-files reads the package's own LICENSE"
  ok "license $LICENSE with shipped text"

  # Every outbound link points at the public venue; nothing legitimate in a
  # published manifest names the private producer repository.
  grep -q "github.com/$MIRROR_REPO" "$MANIFEST" ||
    die "$package: [project.urls] must point at the mirror $MIRROR_REPO"
  ! grep -q "mslsrc/tb[h]" "$MANIFEST" ||
    die "$package: the manifest advertises the private repository"
  ok "links point at $MIRROR_REPO"

  # Dependency posture: zero runtime deps in muse-code-msp,
  # exactly the pinned pydantic in muse-code-sdk. A drift here is an owner
  # escalation, not a packaging decision.
  DEPS="$(field "$MANIFEST" project.dependencies)"
  case "$package" in
    clients/msp-py)
      [[ "$DEPS" == "[]" ]] || die "$package: runtime dependencies declared ($DEPS); the wire-types package is granted none"
      ;;
    clients/sdk-py)
      [[ "$DEPS" =~ ^\[\'pydantic==[0-9.]+\'\]$ ]] ||
        die "$package: dependencies must be exactly the pinned pydantic, got $DEPS"
      ;;
  esac
  ok "dependency posture holds"
done

# ---------------------------------------------------------------------------
# Gate 3 — build, offline. --no-isolation so the build backend is the dev
# lock's exact setuptools, not whatever is current that day, and
# so the default mode does no network I/O.
# ---------------------------------------------------------------------------
step "gate: build"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/muse-code-sdk-pypi.XXXXXX")"
chmod 700 "$WORKDIR"
DISTDIR="$WORKDIR/dist"
for package in "${PACKAGE_DIRS[@]}"; do
  BUILD_LOG="$WORKDIR/build-$(basename "$package").log"
  ( cd "$REPO_ROOT/$package" &&
    "$PYTHON" -m build --no-isolation --outdir "$DISTDIR/$(basename "$package")" . ) \
    >"$BUILD_LOG" 2>&1 || { cat "$BUILD_LOG" >&2; die "$package: build failed"; }
  ok "$package built (sdist + wheel)"
done

# ---------------------------------------------------------------------------
# Gate 4 — wheel audit. The manifest's packaging config is a claim; this
# checks what the build actually produced: an explicit whitelist (a new
# top-level path defaults to NOT shipping), plus the entries that must exist —
# py.typed, because the Typing :: Typed classifier and mypy consumers rely on
# it; the licenses/LICENSE the MIT expression requires; and the sdist beside
# each wheel.
# ---------------------------------------------------------------------------
step "gate: wheel audit"
for package in "${PACKAGE_DIRS[@]}"; do
  case "$package" in
    clients/msp-py) IMPORT_NAME="muse_code_msp" ;;
    clients/sdk-py) IMPORT_NAME="muse_code" ;;
  esac
  PKG_DIST="$DISTDIR/$(basename "$package")"
  "$PYTHON" - "$PKG_DIST" "$IMPORT_NAME" <<'AUDIT' || die "$package: wheel audit failed"
import sys, zipfile
from pathlib import Path

dist, import_name = Path(sys.argv[1]), sys.argv[2]
wheels = sorted(dist.glob("*.whl"))
sdists = sorted(dist.glob("*.tar.gz"))
if len(wheels) != 1 or len(sdists) != 1:
    sys.exit(f"expected exactly one wheel and one sdist in {dist}, got {wheels} / {sdists}")
entries = zipfile.ZipFile(wheels[0]).namelist()
allowed = (f"{import_name}/",)
unexpected = [
    entry
    for entry in entries
    if not entry.startswith(allowed) and ".dist-info/" not in entry
]
if unexpected:
    sys.exit(
        "the wheel contains paths outside the import package: "
        f"{unexpected} — tests, QA harnesses and repo files must not ship"
    )
for required_suffix in (f"{import_name}/py.typed", ".dist-info/licenses/LICENSE"):
    if not any(entry.endswith(required_suffix) for entry in entries):
        sys.exit(f"required wheel entry missing: *{required_suffix}")
print(f"    ok: {wheels[0].name}: {len(entries)} entries, all inside {import_name}/ + dist-info")
AUDIT
done

# ---------------------------------------------------------------------------
# Gate 4b — external audience. What the upload step ships is public: the
# wheel METADATA (summary + long description, i.e. the README), every
# packaged module docstring, and the sdist PKG-INFO must not reference
# artifacts only the producing repository resolves (the 1.3.0 publish
# shipped spec paths, ADR/issue numbers, INV/FR ids and an internal dev
# loop in both long descriptions). Audits the BUILT distributions, not the
# tree, so it gates exactly what would ship.
# ---------------------------------------------------------------------------
step "gate: external audience"
"$PYTHON" "$REPO_ROOT/scripts/check-sdk-py-external-audience.py" --dist "$DISTDIR" ||
  die "the built distributions reference private repository artifacts; rewrite for the PyPI audience"
ok "no private repository references in what would ship"

# ---------------------------------------------------------------------------
# Gate 5 — the per-wheel compatibility rows (the release-cut half of the
# compatibility page contract).
# Derived from the tree and verified against the built wheels; the first
# published wheel cannot ship without its row on the compatibility page.
# ---------------------------------------------------------------------------
step "gate: per-wheel compatibility rows"
ROWS_FILE="$WORKDIR/wheel-rows.json"
"$PYTHON" "$REPO_ROOT/scripts/sdk-py-wheel-rows.py" --repo-root "$REPO_ROOT" --dist "$DISTDIR" >"$ROWS_FILE" ||
  die "per-wheel row derivation failed; a wheel must not ship without its compatibility row"
ok "rows derived and matched against the built wheels"

echo ""
echo "would publish (in this order):"
for package in "${PACKAGE_DIRS[@]}"; do
  find "$DISTDIR/$(basename "$package")" -type f | sort | sed 's/^/    /'
done
echo ""
echo "per-wheel compatibility rows (append to clients/sdk-py/published-wheels.json"
echo "in the publish integration commit; the docs publish rides them):"
sed 's/^/    /' "$ROWS_FILE"
echo ""

# ---------------------------------------------------------------------------
# Publish, or stop.
# ---------------------------------------------------------------------------
if [[ "$MODE" != "publish" ]]; then
  # The release-cut keep seam: every gate passed, so the verified
  # distributions may leave the scratch dir. Publish mode never reaches
  # here — its dist/ staging below is the only publish path.
  if [[ -n "${TBH_SDK_KEEP_DIR:-}" ]]; then
    mkdir -p "$TBH_SDK_KEEP_DIR"
    cp -r "$DISTDIR/." "$TBH_SDK_KEEP_DIR/"
    cp "$ROWS_FILE" "$TBH_SDK_KEEP_DIR/wheel-rows.json"
    echo "kept the built distributions and wheel rows in $TBH_SDK_KEEP_DIR"
  fi
  echo "build-only: every gate passed and NOTHING was published."
  echo ""
  echo "The owner-run sequence (see the one-timers above):"
  echo "  1. dispatch publish-pypi.yml on $MIRROR_REPO — it calls this script"
  echo "     by path with --publish, then uploads the staged dist tree via"
  echo "     pypa/gh-action-pypi-publish (muse-code-msp first, muse-code-sdk"
  echo "     second: the facade is meaningless without the wire types);"
  echo "  2. append the rows above to clients/sdk-py/published-wheels.json in"
  echo "     the publish integration commit (never by hand-editing values)."
  exit 0
fi

step "publish staging"
# The trusted-publishing context was gated FIRST (the block after argument
# parsing); from here the job is only to stage what the calling workflow's
# upload step consumes.
# The upload dir holds ONLY distributions: the pypi-publish action wraps
# twine, and twine refuses any non-dist file in its target, so the rows
# artifact stages BESIDE the upload dir, never inside it.
STAGED="$REPO_ROOT/dist/sdk-py-publish"
STAGED_ROWS="$REPO_ROOT/dist/sdk-py-wheel-rows.json"
rm -rf "$STAGED" && mkdir -p "$STAGED"
cp "$DISTDIR"/*/* "$STAGED/"
cp "$ROWS_FILE" "$STAGED_ROWS"
ok "staged $STAGED (distributions only) for the workflow's pypa/gh-action-pypi-publish step"
ok "staged $STAGED_ROWS for the publish integration commit (clients/sdk-py/published-wheels.json)"
echo ""
echo "every gate passed; the calling workflow's upload step publishes $STAGED."
