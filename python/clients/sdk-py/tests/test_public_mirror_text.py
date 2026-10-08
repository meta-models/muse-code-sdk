"""Contract tests for the shared public-bound-text gate (specification 14990 slice I).

The gate checks text the public mirror would publish - release commit
messages, publish metadata, bridge commits - and refuses any string that
names the private development side. The governing record defines eight
denied classes; scan-text tests pin each class denied and clean text
allowed. Anchor tests pin the verifiable-version shape: a matching digest
accepts, the old shape, private fields, and digest tampering refuse.
Caller tests pin the publishing scripts and the docs workflow invoking
the shared gate, with publish templates that carry no private names.

Every denied seed is assembled from fragments at runtime. The fragments
are inert on their own: writing a live private reference in this file
would trip the repository's own source gates, and the file ships in the
source closure, so the seeds must stay inert on disk.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[3]
CHECKER = PROJECT_ROOT / "scripts" / "check-public-mirror-text.py"
CLOSURE_MANIFEST = PROJECT_ROOT / "scripts" / "sdk-source-closure.json"
PYPI_SCRIPT = PROJECT_ROOT / "scripts" / "publish-sdk-pypi.sh"
BRIDGE_SCRIPT = PROJECT_ROOT / "scripts" / "bridge-developer-docs.sh"
# The workflow lives at the checkout root, two levels above the tbh project
# root (the python-docs-gate suite reads it the same way).
DOCS_WORKFLOW = PROJECT_ROOT.parents[1] / (
    ".gith" + "ub/workflows/" + "tb" + "h-muse-developer-docs.yml"
)

GATE_REFUSAL = 1


def _is_root() -> bool:
    geteuid = getattr(os, "geteuid", None)
    return geteuid is not None and geteuid() == 0


# --- Runtime-assembled denied seeds (inert fragments on disk) ----------------

_ISSUE = "tb" + "h#" + "46483"
_ISSUE_SPACED = "tb" + "h #" + "46483"
_COMMIT_PIN = "tb" + "h@" + "d" * 40
_ORG_PIN = "msl" + "src/tb" + "h@" + "e" * 40
_ORG_BARE = "msl" + "src/tb" + "h"
_ORG_SHORT = "msl" + "src"
_RUN_ID = "run " + "123456789"
_RUN_ENV = "RUN" + "_ID=" + "123456789"
_TRACKER_TASK = "T" + "1234567"
_TRACKER_TASK_SHORT = "T" + "060"
_TRACKER_DIFF = "D" + "123456"
_TRACKER_SEV = "S" + "1234567"
_SHA40 = "f" * 40
_DIGEST64 = "ab" * 32
_DEVVM = "dev" + "vm1234"
_INTERN_HOST = "internal" + "fb" + ".com" + "/x"
_GATE_NAME = "tb" + "h_gate_demo_flag"
_CORP_HOST = "build" + ".corp" + ".example.com"
_CACHE_HOST = "intern" + "cache"
_OWNER_WORD = "owner-" + "directed"
_MANUAL_WORD = "Manual bridge per the standing " + "rule"
_INTERN_HOST_UPPER = "INTERNAL" + "FB" + ".COM"
_DEVVM_UPPER = "DEV" + "VM1234"
_ORG_UPPER = "MSL" + "SRC"
_RUN_UPPER = "RUN " + "123456789"
_PIN_UPPER = "TB" + "H@" + "D" * 40
_ISSUE_UPPER = "TB" + "H#" + "46483"

# Each seed with the class expected to fire on it: the gate reports every
# firing class, so pinning the primary proves each pattern works rather
# than one broad pattern masking a dead sibling.
DENIED_SEEDS = [
    (_ISSUE, "issue-reference"),
    (_ISSUE_SPACED, "issue-reference"),
    (_COMMIT_PIN, "commit-pin"),
    (_ORG_PIN, "commit-pin"),
    (_ORG_BARE, "repository-name"),
    (_ORG_SHORT, "repository-name"),
    (_RUN_ID, "run-identifier"),
    (_RUN_ENV, "run-identifier"),
    (_TRACKER_TASK, "tracker-id"),
    (_TRACKER_TASK_SHORT, "tracker-id"),
    (_TRACKER_DIFF, "tracker-id"),
    (_TRACKER_SEV, "tracker-id"),
    (_SHA40, "commit-sha"),
    (_DEVVM, "internal-host"),
    (_INTERN_HOST, "internal-host"),
    (_GATE_NAME, "internal-host"),
    (_CORP_HOST, "internal-host"),
    (_CACHE_HOST, "internal-host"),
    (_OWNER_WORD, "internal-process-wording"),
    (_MANUAL_WORD, "internal-process-wording"),
    (_INTERN_HOST_UPPER, "internal-host"),
    (_DEVVM_UPPER, "internal-host"),
    (_ORG_UPPER, "repository-name"),
    (_RUN_UPPER, "run-identifier"),
    (_PIN_UPPER, "commit-pin"),
]

CLEAN_RELEASE_TEXT = """\
Re-mirror the SDK closure at 9.9 (lockstep)

Gate-accepted artifact from the internal source tree (tracked internally);
this publish changed only the mirrored files.
"""


def run_checker(*args: str, text: str | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(CHECKER), *args],
        input=text,
        capture_output=True,
        text=True,
        cwd=PROJECT_ROOT,
        timeout=60,
    )


def closure_entry_names() -> list[str]:
    manifest = json.loads(CLOSURE_MANIFEST.read_text(encoding="utf-8"))
    return list(manifest["closure_paths"])


# --- Scan-text arms ------------------------------------------------------------


@pytest.mark.parametrize("seed,expected_class", DENIED_SEEDS)
def test_scan_text_denies_each_private_shape(seed: str, expected_class: str) -> None:
    result = run_checker("scan-text", "--text", f"release notes mention {seed} here")
    assert result.returncode == GATE_REFUSAL, result.stderr
    output = result.stdout + result.stderr
    assert seed in output
    assert f"denied {expected_class}" in output


def test_scan_text_denies_seed_from_stdin() -> None:
    result = run_checker("scan-text", text=f"notes {_ISSUE}\n")
    assert result.returncode == GATE_REFUSAL, result.stderr
    assert _ISSUE in (result.stdout + result.stderr)


def test_scan_text_accepts_clean_release_notes() -> None:
    result = run_checker("scan-text", "--text", CLEAN_RELEASE_TEXT)
    assert result.returncode == 0, result.stderr


def test_scan_text_accepts_longer_hex_digest() -> None:
    result = run_checker("scan-text", "--text", f"checksum {_DIGEST64} recorded")
    assert result.returncode == 0, result.stderr


def test_scan_text_accepts_short_priority_and_storage_tokens() -> None:
    result = run_checker("scan-text", "--text", "P0 fix for the S3 staging copy")
    assert result.returncode == 0, result.stderr


def test_scan_text_accepts_uppercase_issue_shape() -> None:
    # Uppercase TBH is ordinary prose ("to be honest"), so the
    # case-sensitive issue class lets it through by design.
    result = run_checker("scan-text", "--text", f"notes mention {_ISSUE_UPPER} here")
    assert result.returncode == 0, result.stderr


# --- Digest and anchor arms ----------------------------------------------------


def git_env() -> dict[str, str]:
    # Hermetic git identity: the digest reads the tracked set, so the
    # fixture stages it — with machine-global config blanked, exactly
    # like the ts fixture, so a developer's global ignore never leaks
    # in. ls-files reads the index, so no commit (and no user config)
    # is needed.
    env = dict(os.environ)
    env["GIT_CONFIG_GLOBAL"] = "/dev/null"
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    return env


def stage_all(root: Path) -> None:
    subprocess.run(
        ["git", "-C", str(root), "add", "-A"],
        check=True,
        capture_output=True,
        env=git_env(),
        timeout=60,
    )


def write_mirror_tree(
    root: Path,
    files: dict[str, str],
    entries: list[str] | None = None,
    notes: dict[str, str] | None = None,
) -> None:
    manifest: dict[str, object] = {"closure_paths": sorted(entries or files)}
    if notes is not None:
        manifest["path_notes"] = notes
    (root / "scripts").mkdir(parents=True, exist_ok=True)
    (root / "scripts" / "sdk-source-closure.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    for relpath, body in files.items():
        target = root / relpath
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body, encoding="utf-8")
    subprocess.run(
        ["git", "-C", str(root), "init", "-q"],
        check=True,
        capture_output=True,
        env=git_env(),
        timeout=60,
    )
    stage_all(root)


def digest_of(root: Path) -> str:
    result = run_checker("digest-tree", "--root", str(root))
    assert result.returncode == 0, result.stderr
    return result.stdout.strip()


def write_anchor(root: Path, payload: dict[str, object]) -> Path:
    anchor = root / "publish-anchor.json"
    anchor.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return anchor


def test_digest_tree_is_stable_and_path_sensitive(tmp_path: Path) -> None:
    write_mirror_tree(tmp_path, {"clients/a.txt": "one\n", "scripts/b.sh": "two\n"})
    first = digest_of(tmp_path)
    assert digest_of(tmp_path) == first
    (tmp_path / "clients" / "a.txt").write_text("one changed\n", encoding="utf-8")
    second = digest_of(tmp_path)
    assert second != first
    renamed = tmp_path / "clients" / "renamed.txt"
    (tmp_path / "clients" / "a.txt").rename(renamed)
    manifest_path = tmp_path / "scripts" / "sdk-source-closure.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["closure_paths"] = ["clients/renamed.txt", "scripts/b.sh"]
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    stage_all(tmp_path)
    assert digest_of(tmp_path) != second


def test_digest_tree_refuses_missing_closure_entry(tmp_path: Path) -> None:
    write_mirror_tree(tmp_path, {"clients/a.txt": "one\n"})
    manifest_path = tmp_path / "scripts" / "sdk-source-closure.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["closure_paths"].append("clients/ghost.txt")
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    result = run_checker("digest-tree", "--root", str(tmp_path))
    assert result.returncode == GATE_REFUSAL, result.stdout
    assert "clients/ghost.txt" in (result.stdout + result.stderr)


def test_digest_tree_refuses_symlinked_closure_entry(tmp_path: Path) -> None:
    write_mirror_tree(tmp_path, {"clients/a.txt": "one\n"})
    target = tmp_path / "clients" / "a.txt"
    target.unlink()
    target.symlink_to(tmp_path / "scripts" / "sdk-source-closure.json")
    result = run_checker("digest-tree", "--root", str(tmp_path))
    assert result.returncode == GATE_REFUSAL, result.stdout
    assert "not a regular file" in (result.stdout + result.stderr)


def test_digest_tree_refuses_shadowed_closure_entry(tmp_path: Path) -> None:
    write_mirror_tree(tmp_path, {"clients/a.txt": "one\n"})
    shadow = tmp_path / "python" / "clients" / "a.txt"
    shadow.parent.mkdir(parents=True, exist_ok=True)
    shadow.write_text("shadow\n", encoding="utf-8")
    stage_all(tmp_path)
    result = run_checker("digest-tree", "--root", str(tmp_path))
    assert result.returncode == GATE_REFUSAL, result.stdout
    assert "ambiguous" in (result.stdout + result.stderr)


def test_digest_tree_names_every_shadowed_closure_entry(tmp_path: Path) -> None:
    # Two entries tracked under both layouts: the refusal names both,
    # never only the first. First-wins reporting hid the second stray
    # behind the first, failing the next run one entry later.
    write_mirror_tree(
        tmp_path,
        {"clients/a.txt": "one\n", "clients/b.txt": "two\n"},
    )
    for name in ("a.txt", "b.txt"):
        shadow = tmp_path / "python" / "clients" / name
        shadow.parent.mkdir(parents=True, exist_ok=True)
        shadow.write_text("shadow\n", encoding="utf-8")
    stage_all(tmp_path)
    result = run_checker("digest-tree", "--root", str(tmp_path))
    assert result.returncode == GATE_REFUSAL, result.stdout
    output = result.stdout + result.stderr
    assert "ambiguous" in output
    assert output.count("ambiguous") == 2
    assert "clients/a.txt" in output
    assert "clients/b.txt" in output


def test_digest_tree_names_every_missing_closure_entry(tmp_path: Path) -> None:
    # Two missing entries: the refusal names both, never only the first.
    write_mirror_tree(
        tmp_path,
        {"clients/a.txt": "one\n"},
        entries=[
            "clients/a.txt",
            "clients/ghost-one.txt",
            "clients/ghost-two.txt",
        ],
    )
    stage_all(tmp_path)
    result = run_checker("digest-tree", "--root", str(tmp_path))
    assert result.returncode == GATE_REFUSAL, result.stdout
    output = result.stdout + result.stderr
    assert "missing" in output
    assert "clients/ghost-one.txt" in output
    assert "clients/ghost-two.txt" in output


@pytest.mark.skipif(_is_root(), reason="uid 0 bypasses permission bits")
def test_digest_tree_names_every_unreadable_closure_entry(
    tmp_path: Path,
) -> None:
    # Two unreadable files: the refusal names both, never only the first.
    write_mirror_tree(
        tmp_path,
        {"clients/a.txt": "one\n", "clients/b.txt": "two\n"},
    )
    stage_all(tmp_path)
    first = tmp_path / "clients" / "a.txt"
    second = tmp_path / "clients" / "b.txt"
    first.chmod(0o000)
    second.chmod(0o000)
    try:
        result = run_checker("digest-tree", "--root", str(tmp_path))
    finally:
        first.chmod(0o644)
        second.chmod(0o644)
    assert result.returncode == GATE_REFUSAL, result.stdout
    output = result.stdout + result.stderr
    assert "unreadable" in output
    assert "clients/a.txt" in output
    assert "clients/b.txt" in output


@pytest.mark.skipif(_is_root(), reason="uid 0 bypasses permission bits")
def test_digest_tree_names_entries_across_failure_classes(
    tmp_path: Path,
) -> None:
    # One shadowed, one missing, one unreadable: the refusal names all
    # three, proving collection spans every failure class at once.
    write_mirror_tree(
        tmp_path,
        {"clients/a.txt": "one\n", "clients/b.txt": "two\n"},
        entries=["clients/a.txt", "clients/b.txt", "clients/ghost.txt"],
    )
    shadow = tmp_path / "python" / "clients" / "a.txt"
    shadow.parent.mkdir(parents=True, exist_ok=True)
    shadow.write_text("shadow\n", encoding="utf-8")
    stage_all(tmp_path)
    locked = tmp_path / "clients" / "b.txt"
    locked.chmod(0o000)
    try:
        result = run_checker("digest-tree", "--root", str(tmp_path))
    finally:
        locked.chmod(0o644)
    assert result.returncode == GATE_REFUSAL, result.stdout
    output = result.stdout + result.stderr
    assert "clients/a.txt" in output
    assert "clients/ghost.txt" in output
    assert "clients/b.txt" in output


def test_digest_tree_walks_directory_entries(tmp_path: Path) -> None:
    # Directory closure entries expand to their walked files: nested
    # content joins the digest, and tampering a nested file mismatches.
    write_mirror_tree(
        tmp_path,
        {
            "clients/pkg/a.txt": "one\n",
            "clients/pkg/nested/b.txt": "two\n",
            "clients/top.txt": "top\n",
        },
        entries=["clients/pkg", "clients/top.txt"],
    )
    first = digest_of(tmp_path)
    (tmp_path / "clients" / "pkg" / "nested" / "b.txt").write_text(
        "tampered\n", encoding="utf-8"
    )
    assert digest_of(tmp_path) != first


def test_digest_tree_matches_across_layouts(tmp_path: Path) -> None:
    # The digest names files mirror-relative (the python/ mapping
    # applied), so the producer tree and the mirror tree — same bytes,
    # different layouts — digest identically. Both a marked directory
    # and marked files ride the mapping: a file-mapping regression
    # must break this equality too.
    producer = tmp_path / "producer"
    mirror = tmp_path / "mirror"
    notes = {
        "clients/pkg": "Python closure. Marked for the mapping test.",
        "scripts/tool.sh": "Python closure. Marked for the mapping test.",
    }
    write_mirror_tree(
        producer,
        {
            "clients/pkg/a.txt": "one\n",
            "clients/pkg/b.txt": "two\n",
            "scripts/tool.sh": "three\n",
        },
        entries=["clients/pkg", "scripts/tool.sh"],
        notes=notes,
    )
    write_mirror_tree(
        mirror,
        {
            "python/clients/pkg/a.txt": "one\n",
            "python/clients/pkg/b.txt": "two\n",
            "python/scripts/tool.sh": "three\n",
        },
        entries=["clients/pkg", "scripts/tool.sh"],
        notes=notes,
    )
    assert digest_of(producer) == digest_of(mirror)


def test_digest_tree_refuses_symlink_inside_directory(tmp_path: Path) -> None:
    # A symlink anywhere under a walked entry refuses instead of
    # resolving: link following could escape the closure.
    write_mirror_tree(
        tmp_path,
        {"clients/pkg/a.txt": "one\n"},
        entries=["clients/pkg"],
    )
    (tmp_path / "clients" / "pkg" / "escape").symlink_to("/etc/hostname")
    stage_all(tmp_path)
    result = run_checker("digest-tree", "--root", str(tmp_path))
    assert result.returncode == GATE_REFUSAL, result.stdout
    assert "not a regular file" in (result.stdout + result.stderr)


def test_digest_tree_refuses_symlinked_directory(tmp_path: Path) -> None:
    # A symlinked directory inside a walked entry refuses like a
    # symlinked file: staging proves the carried-set state, and the
    # gate refuses the link instead of following it out of the closure.
    write_mirror_tree(
        tmp_path,
        {"clients/pkg/a.txt": "one\n"},
        entries=["clients/pkg"],
    )
    (tmp_path / "clients" / "pkg" / "linked").symlink_to("/tmp")
    stage_all(tmp_path)
    result = run_checker("digest-tree", "--root", str(tmp_path))
    assert result.returncode == GATE_REFUSAL, result.stdout
    assert "not a regular file" in (result.stdout + result.stderr)


def test_digest_tree_ignores_untracked_junk(tmp_path: Path) -> None:
    # Build output and stray files are untracked, so they cannot
    # perturb the digest and refuse a valid anchor: the digest covers
    # the carried (tracked) set only.
    write_mirror_tree(
        tmp_path,
        {"clients/pkg/a.txt": "one\n"},
        entries=["clients/pkg"],
    )
    first = digest_of(tmp_path)
    junk = tmp_path / "clients" / "pkg" / "node_modules" / "dep" / "x.js"
    junk.parent.mkdir(parents=True, exist_ok=True)
    junk.write_text("junk\n", encoding="utf-8")
    (tmp_path / "clients" / "pkg" / "notes.local").write_text(
        "junk\n", encoding="utf-8"
    )
    assert digest_of(tmp_path) == first


@pytest.mark.skipif(_is_root(), reason="uid 0 bypasses permission bits")
def test_digest_tree_refuses_unreadable_directory(tmp_path: Path) -> None:
    # An unreadable directory refuses through AnchorError like any
    # digest condition — never a bare traceback from the walk.
    write_mirror_tree(
        tmp_path,
        {"clients/pkg/a.txt": "one\n"},
        entries=["clients/pkg"],
    )
    entry = tmp_path / "clients" / "pkg"
    entry.chmod(0o000)
    try:
        result = run_checker("digest-tree", "--root", str(tmp_path))
    finally:
        entry.chmod(0o755)
    assert result.returncode == GATE_REFUSAL, result.stdout
    output = result.stdout + result.stderr
    assert "unreadable" in output
    assert "Traceback" not in output


def test_digest_tree_refuses_non_object_manifest(tmp_path: Path) -> None:
    write_mirror_tree(tmp_path, {"clients/a.txt": "one\n"})
    manifest_path = tmp_path / "scripts" / "sdk-source-closure.json"
    manifest_path.write_text('["clients/a.txt"]\n', encoding="utf-8")
    result = run_checker("digest-tree", "--root", str(tmp_path))
    assert result.returncode == GATE_REFUSAL, result.stdout
    assert "not a JSON object" in (result.stdout + result.stderr)


def test_digest_tree_refuses_non_string_path_notes(tmp_path: Path) -> None:
    write_mirror_tree(tmp_path, {"clients/a.txt": "one\n"})
    manifest_path = tmp_path / "scripts" / "sdk-source-closure.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["path_notes"] = {"clients/a.txt": 123}
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    result = run_checker("digest-tree", "--root", str(tmp_path))
    assert result.returncode == GATE_REFUSAL, result.stdout
    assert "path_notes" in (result.stdout + result.stderr)


def test_digest_tree_refuses_non_checkout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The digest covers tracked files, so outside a git checkout it
    # refuses with a clean message — never a bare git traceback. The
    # ceiling sits one level above the fixture root: git only honors a
    # ceiling that is a strict parent of where it starts looking, so a
    # pin at the fixture itself would be a no-op and a TMPDIR nested
    # inside any checkout would find that repo and false-red with a
    # different refusal.
    monkeypatch.setenv("GIT_CEILING_DIRECTORIES", str(tmp_path.parent))
    (tmp_path / "scripts").mkdir(parents=True, exist_ok=True)
    (tmp_path / "scripts" / "sdk-source-closure.json").write_text(
        json.dumps({"closure_paths": ["clients/a.txt"]}) + "\n", encoding="utf-8"
    )
    target = tmp_path / "clients" / "a.txt"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("one\n", encoding="utf-8")
    result = run_checker("digest-tree", "--root", str(tmp_path))
    assert result.returncode == GATE_REFUSAL, result.stdout
    output = result.stdout + result.stderr
    assert "git checkout" in output
    assert "Traceback" not in output


def test_closure_python_marked_set_is_frozen() -> None:
    # LOAD-BEARING FREEZE: the digest maps entries under python/ by the
    # manifest's path_notes ("Python closure" marks) — the same rule the
    # re-mirror copy uses. Rewording a note opening would silently remap
    # the digest, so the marked set is frozen by name: legitimate changes
    # update this pin deliberately, never by loosening.
    manifest = json.loads(CLOSURE_MANIFEST.read_text(encoding="utf-8"))
    notes = manifest["path_notes"]
    marked = {
        path for path, note in notes.items() if note.startswith("Python closure")
    }
    assert marked == {
        "clients/msp-py",
        "clients/py-dev-requirements.txt",
        "clients/sdk-cookbook-py",
        "clients/sdk-py",
        "clients/sdk-quickstart-py",
        "scripts/check-public-mirror-text.py",
        "scripts/check-sdk-py-external-audience.py",
        "scripts/publish-sdk-pypi.sh",
        "scripts/sdk-py-wheel-rows.py",
    }


def test_scan_text_refuses_undecodable_file(tmp_path: Path) -> None:
    binary = tmp_path / "bytes.bin"
    binary.write_bytes(b"\xff\xfe\x00bad")
    result = run_checker("scan-text", "--file", str(binary))
    assert result.returncode == GATE_REFUSAL, result.stdout
    assert "cannot read scan-text file" in (result.stdout + result.stderr)


def test_scan_text_refuses_undecodable_stdin() -> None:
    result = subprocess.run(
        [sys.executable, str(CHECKER), "scan-text"],
        input=b"\xff\xfe\x00bad",
        capture_output=True,
        cwd=PROJECT_ROOT,
        timeout=60,
    )
    assert result.returncode == GATE_REFUSAL
    assert b"cannot read scan-text standard input" in result.stderr


def test_check_anchor_catches_json_escaped_denied_text(tmp_path: Path) -> None:
    # A JSON \u escape hides the shape from raw-bytes scanning but not
    # from the decoded value scan: this is why callers classify the
    # verify output instead of pre-scanning bytes.
    write_mirror_tree(tmp_path, {"clients/a.txt": "one\n"})
    escaped = "tb" + "\\u0068#" + "464" + "83"
    anchor = tmp_path / "publish-anchor.json"
    anchor.write_text(
        '{"host_version": "9.9 built from '
        + escaped
        + '", "content_sha256": "'
        + digest_of(tmp_path)
        + '"}\n',
        encoding="utf-8",
    )
    raw = run_checker("scan-text", "--file", str(anchor))
    assert raw.returncode == 0, raw.stderr
    result = run_checker("check-anchor", "--anchor", str(anchor))
    assert result.returncode == GATE_REFUSAL, result.stderr
    output = result.stdout + result.stderr
    assert "denied issue-reference" in output
    assert "anchor-verdict: content-refused" in output


def _parses_nesting(depth: int) -> bool:
    try:
        json.loads('{"a":' * depth + '1' + '}' * depth)
    except RecursionError:
        return False
    return True


@pytest.mark.parametrize(
    "depth,expect_denied",
    [
        # Past every parser: proves the json.loads RecursionError catch.
        (100000, False),
        # Parses, then walks 2000 levels: proves the iterative walker
        # (a recursive walker tracebacks here with no verdict). Gated
        # on a runtime probe, not a version guess: older parsers cap
        # lower and must take the skip with its reason, never a guess.
        (2000, True),
    ],
)
def test_check_anchor_handles_deep_nesting(
    depth: int, expect_denied: bool, tmp_path: Path
) -> None:
    # Both layers refuse through the verdict, never a bare traceback:
    # the parser catch for unparseable depth, the iterative walker for
    # parseable depth (a banned seed at the bottom proves the walk ran).
    if expect_denied and not _parses_nesting(depth):
        pytest.skip("interpreter JSON parser cannot reach walker depth")
    write_mirror_tree(tmp_path, {"clients/a.txt": "one\n"})
    anchor = tmp_path / "publish-anchor.json"
    anchor.write_text(
        '{"host_version": "9.9", "deep": '
        + '{"a":' * depth
        + f'"{_ISSUE}"'
        + '}' * depth
        + '}\n',
        encoding="utf-8",
    )
    result = run_checker("check-anchor", "--anchor", str(anchor))
    assert result.returncode == GATE_REFUSAL, result.stderr
    output = result.stdout + result.stderr
    assert "Traceback" not in output
    if expect_denied:
        assert "denied issue-reference" in output
        assert "anchor-verdict: content-refused" in output
    else:
        assert "not JSON" in output
        assert "anchor-verdict: refused" in output


def test_check_anchor_accepts_matching_verifiable_version(tmp_path: Path) -> None:
    write_mirror_tree(tmp_path, {"clients/a.txt": "one\n"})
    anchor = write_anchor(
        tmp_path,
        {"host_version": "9.9", "content_sha256": digest_of(tmp_path)},
    )
    result = run_checker(
        "check-anchor", "--anchor", str(anchor), "--expect-version", "9.9"
    )
    assert result.returncode == 0, result.stderr


def test_check_anchor_refuses_old_shape(tmp_path: Path) -> None:
    write_mirror_tree(tmp_path, {"clients/a.txt": "one\n"})
    anchor = write_anchor(
        tmp_path,
        {
            "source": {
                "repository": _ORG_BARE,
                "commit": _SHA40,
                "closure_manifest": "scripts/sdk-source-closure.json",
            },
            "published_at": "2026-10-02T00:00:00Z",
            "host_version": "9.9",
        },
    )
    result = run_checker("check-anchor", "--anchor", str(anchor))
    assert result.returncode == GATE_REFUSAL, result.stderr
    output = result.stdout + result.stderr
    assert "verifiable version" in output
    # The old shape carries live banned values: every failure is
    # reported, so the denied hits must appear beside the shape error —
    # a first-failure-wins regression hiding banned bytes fails here.
    assert "denied repository-name" in output
    assert "denied commit-sha" in output
    assert "anchor-verdict: content-refused" in output


def test_check_anchor_refuses_private_fields(tmp_path: Path) -> None:
    write_mirror_tree(tmp_path, {"clients/a.txt": "one\n"})
    anchor = write_anchor(
        tmp_path,
        {
            "host_version": "9.9",
            "content_sha256": digest_of(tmp_path),
            "repository": _ORG_BARE,
            "commit": _SHA40,
        },
    )
    result = run_checker("check-anchor", "--anchor", str(anchor))
    assert result.returncode == GATE_REFUSAL, result.stderr
    output = result.stdout + result.stderr
    assert "anchor field" in output
    assert "denied repository-name" in output
    assert "denied commit-sha" in output
    assert "anchor-verdict: content-refused" in output


def test_check_anchor_accepts_repo_meta_hand_authored(tmp_path: Path) -> None:
    # D3 keeps the mirror-local hand-authored list: a v2 anchor
    # carrying repo_meta.hand_authored verifies like a bare one.
    write_mirror_tree(tmp_path, {"clients/a.txt": "one\n"})
    anchor = write_anchor(
        tmp_path,
        {
            "host_version": "9.9",
            "content_sha256": digest_of(tmp_path),
            "repo_meta": {"hand_authored": ["README.md", "LICENSE"]},
        },
    )
    result = run_checker("check-anchor", "--anchor", str(anchor))
    assert result.returncode == 0, result.stderr


def test_check_anchor_refuses_denied_text_in_repo_meta(tmp_path: Path) -> None:
    # Allowing the key must not carve it out of the content scan.
    write_mirror_tree(tmp_path, {"clients/a.txt": "one\n"})
    anchor = write_anchor(
        tmp_path,
        {
            "host_version": "9.9",
            "content_sha256": digest_of(tmp_path),
            "repo_meta": {"hand_authored": [f"notes-{_ISSUE}.md"]},
        },
    )
    result = run_checker("check-anchor", "--anchor", str(anchor))
    assert result.returncode == GATE_REFUSAL, result.stderr
    output = result.stdout + result.stderr
    assert "issue-reference" in output
    assert "anchor-verdict: content-refused" in output


def test_check_anchor_refuses_published_at(tmp_path: Path) -> None:
    # v2 drops the timestamp with the private fields: a v2 anchor
    # carrying published_at refuses on shape, with a clean verdict
    # (a timestamp carries no denied content).
    write_mirror_tree(tmp_path, {"clients/a.txt": "one\n"})
    anchor = write_anchor(
        tmp_path,
        {
            "host_version": "9.9",
            "content_sha256": digest_of(tmp_path),
            "published_at": "2026-10-04T00:00:00Z",
        },
    )
    result = run_checker("check-anchor", "--anchor", str(anchor))
    assert result.returncode == GATE_REFUSAL, result.stderr
    output = result.stdout + result.stderr
    assert "anchor field" in output
    assert "anchor-verdict: refused" in output


def test_check_anchor_treats_repo_meta_as_opaque(tmp_path: Path) -> None:
    # repo_meta is opaque by design: any JSON value verifies, only its
    # strings are scanned for denied references, and the gate never
    # validates its shape.
    write_mirror_tree(tmp_path, {"clients/a.txt": "one\n"})
    anchor = write_anchor(
        tmp_path,
        {
            "host_version": "9.9",
            "content_sha256": digest_of(tmp_path),
            "repo_meta": 42,
        },
    )
    result = run_checker("check-anchor", "--anchor", str(anchor))
    assert result.returncode == 0, result.stderr


def test_check_anchor_refuses_denied_text_in_scalar_repo_meta(
    tmp_path: Path,
) -> None:
    # Opacity cuts both ways: a scalar repo_meta carrying denied text
    # refuses through the content scan with a content verdict.
    write_mirror_tree(tmp_path, {"clients/a.txt": "one\n"})
    anchor = write_anchor(
        tmp_path,
        {
            "host_version": "9.9",
            "content_sha256": digest_of(tmp_path),
            "repo_meta": f"notes-{_ISSUE}.md",
        },
    )
    result = run_checker("check-anchor", "--anchor", str(anchor))
    assert result.returncode == GATE_REFUSAL, result.stderr
    output = result.stdout + result.stderr
    assert "issue-reference" in output
    assert "anchor-verdict: content-refused" in output


def test_check_anchor_refuses_denied_text_in_allowed_field(tmp_path: Path) -> None:
    write_mirror_tree(tmp_path, {"clients/a.txt": "one\n"})
    anchor = write_anchor(
        tmp_path,
        {
            "host_version": f"9.9 built from {_ISSUE}",
            "content_sha256": digest_of(tmp_path),
        },
    )
    result = run_checker("check-anchor", "--anchor", str(anchor))
    assert result.returncode == GATE_REFUSAL, result.stderr
    output = result.stdout + result.stderr
    assert "anchor field" in output
    assert "issue-reference" in output
    assert "anchor-verdict: content-refused" in output


def test_check_anchor_refuses_denied_text_in_anchor_key(tmp_path: Path) -> None:
    # A banned token hiding in a JSON key refuses like one in a value:
    # keys ride the same decoded scan, so the shape-only "unexpected
    # field" error cannot smuggle them past the publishers' classifier.
    write_mirror_tree(tmp_path, {"clients/a.txt": "one\n"})
    anchor = write_anchor(
        tmp_path,
        {
            "host_version": "9.9",
            "content_sha256": digest_of(tmp_path),
            f"note-from-{_ISSUE}": "clean value",
        },
    )
    result = run_checker("check-anchor", "--anchor", str(anchor))
    assert result.returncode == GATE_REFUSAL, result.stderr
    output = result.stdout + result.stderr
    assert "denied issue-reference" in output
    assert "(key)" in output
    assert "anchor-verdict: content-refused" in output


def test_check_anchor_marks_shape_only_refusal(tmp_path: Path) -> None:
    # The machine-readable verdict both ways: a refusal with no denied
    # bytes says "refused", never "content-refused", so publishers note
    # it in non-publish modes instead of dying.
    write_mirror_tree(tmp_path, {"clients/a.txt": "one\n"})
    anchor = write_anchor(tmp_path, {"host_version": "9.9"})
    result = run_checker("check-anchor", "--anchor", str(anchor))
    assert result.returncode == GATE_REFUSAL, result.stderr
    output = result.stdout + result.stderr
    assert "anchor-verdict: refused" in output
    assert "content-refused" not in output


def test_check_anchor_refuses_digest_mismatch(tmp_path: Path) -> None:
    write_mirror_tree(tmp_path, {"clients/a.txt": "one\n"})
    anchor = write_anchor(
        tmp_path,
        {"host_version": "9.9", "content_sha256": digest_of(tmp_path)},
    )
    (tmp_path / "clients" / "a.txt").write_text("tampered\n", encoding="utf-8")
    result = run_checker("check-anchor", "--anchor", str(anchor))
    assert result.returncode == GATE_REFUSAL, result.stderr
    output = result.stdout + result.stderr
    assert "mismatch" in output
    assert "anchor-verdict: refused" in output
    assert "content-refused" not in output


@pytest.mark.skipif(_is_root(), reason="uid 0 bypasses permission bits")
def test_check_anchor_refuses_unreadable_closure_entry(tmp_path: Path) -> None:
    # An unreadable entry refuses through the verdict like any digest
    # condition: the refusal ends with the verdict line, never a bare
    # traceback that would skip it.
    write_mirror_tree(tmp_path, {"clients/a.txt": "one\n"})
    anchor = write_anchor(
        tmp_path,
        {"host_version": "9.9", "content_sha256": digest_of(tmp_path)},
    )
    entry = tmp_path / "clients" / "a.txt"
    entry.chmod(0o000)
    try:
        result = run_checker("check-anchor", "--anchor", str(anchor))
    finally:
        entry.chmod(0o644)
    assert result.returncode == GATE_REFUSAL, result.stderr
    output = result.stdout + result.stderr
    assert "unreadable" in output
    assert "Traceback" not in output
    assert "anchor-verdict: refused" in output
    assert "content-refused" not in output


def test_check_anchor_refuses_version_mismatch(tmp_path: Path) -> None:
    write_mirror_tree(tmp_path, {"clients/a.txt": "one\n"})
    anchor = write_anchor(
        tmp_path,
        {"host_version": "9.9", "content_sha256": digest_of(tmp_path)},
    )
    result = run_checker(
        "check-anchor", "--anchor", str(anchor), "--expect-version", "8.8"
    )
    assert result.returncode == GATE_REFUSAL, result.stderr
    assert "version" in (result.stdout + result.stderr)


def test_check_anchor_refuses_unreadable_anchor(tmp_path: Path) -> None:
    write_mirror_tree(tmp_path, {"clients/a.txt": "one\n"})
    missing = tmp_path / "publish-anchor.json"
    result = run_checker("check-anchor", "--anchor", str(missing))
    assert result.returncode == GATE_REFUSAL, result.stderr
    assert "anchor" in (result.stdout + result.stderr)


def test_closure_manifest_lists_checker_itself() -> None:
    assert "scripts/check-public-mirror-text.py" in closure_entry_names()


# --- Python publish caller arms -------------------------------------------------


def test_pypi_publish_invokes_shared_text_gate() -> None:
    script = PYPI_SCRIPT.read_text(encoding="utf-8")
    # Live call sites, not the filename alone: commenting out the gate
    # must break these pins. The classifier matches the gate's
    # machine-readable verdict token, never human prose; the die-vs-note
    # behavior itself is proved by fixture runs, not this pin.
    assert '"$REPO_ROOT/scripts/check-public-mirror-text.py"' in script
    assert '"$PYTHON" "$TEXT_CHECKER" "${anchor_args[@]}"' in script
    assert "grep -q -x -F 'anchor-verdict: content-refused'" in script
    assert "grep -q -x -F 'anchor-verdict: refused'" in script
    assert 'version_args+=(--expect-version "$VERSION")' in script
    # script_python()'s default must track the script's own PYTHON
    # default: the delegating stub builds on it, so a drift would
    # reintroduce interpreter divergence silently.
    assert 'PYTHON="${SDK_PY_PYTHON:-python3}"' in script


def test_pypi_publish_with_bad_anchor_refuses_through_script(
    tmp_path: Path,
) -> None:
    write_mirror_tree(tmp_path, {"clients/a.txt": "one\n"})
    anchor = write_anchor(
        tmp_path,
        {
            "source": {
                "repository": _ORG_BARE,
                "commit": _SHA40,
                "closure_manifest": "scripts/sdk-source-closure.json",
            },
            "published_at": "2026-10-02T00:00:00Z",
            "host_version": "9.9",
        },
    )
    env = dict(os.environ)
    env["GITHUB_ACTIONS"] = "true"
    env["ACTIONS_ID_TOKEN_REQUEST_URL"] = "https://example.invalid/token"
    env["SDK_ANCHOR_PATH"] = str(anchor)
    result = subprocess.run(
        ["bash", str(PYPI_SCRIPT), "--publish"],
        capture_output=True,
        text=True,
        cwd=PROJECT_ROOT,
        env=env,
        timeout=300,
    )
    assert result.returncode != 0
    output = result.stdout + result.stderr
    # All three markers: the missing-anchor die shares "verifiable
    # version" but not the verify-failure markers, so a plumbing
    # regression that never reaches the gate cannot pass.
    assert "verifiable version" in output
    assert "failed verification" in output
    assert "verifiable version shape" in output


def package_version(package: str) -> str:
    # The manifest's own version line, without assuming tomllib (the
    # suite runs on 3.10 too): the binding proof needs the exact string
    # the script read.
    text = (PROJECT_ROOT / package / "pyproject.toml").read_text(encoding="utf-8")
    match = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
    assert match, f"no version line in {package}/pyproject.toml"
    return match.group(1)


def package_trees_clean() -> bool:
    # The --publish proofs run the script's Gate 1 (tree anchor),
    # which refuses a dirty package tree: in CI the checkout is clean,
    # while a local edit session skips until it commits.
    result = subprocess.run(
        [
            "git",
            "-C",
            str(PROJECT_ROOT),
            "status",
            "--porcelain",
            "--",
            "clients/msp-py",
            "clients/sdk-py",
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    return result.returncode == 0 and not result.stdout.strip()


def script_python() -> str:
    # The interpreter the script itself resolves ($PYTHON). The
    # script's `:-` maps empty to the default too, so `or` — a
    # `.get` with default would return a set-but-empty string,
    # breaking the guard probe and the stub env.
    return os.environ.get("SDK_PY_PYTHON") or "python3"


def script_python_has_build() -> bool:
    # Gate 2 sits past the tooling preflight, which needs the dev
    # lock's `build` package: without it these proofs skip (the
    # suite's no-full-lock posture) instead of red/green on the
    # wrong gate.
    result = subprocess.run(
        [script_python(), "-c", "import build"],
        capture_output=True,
        timeout=60,
    )
    return result.returncode == 0


@pytest.mark.parametrize(
    "seam,expected",
    [(None, "python3"), ("", "python3"), ("/custom/python", "/custom/python")],
)
def test_script_python_matches_script_default(
    seam: str | None, expected: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Parity with PYTHON="${SDK_PY_PYTHON:-python3}": unset and
    # empty both resolve to python3, anything else passes through.
    if seam is None:
        monkeypatch.delenv("SDK_PY_PYTHON", raising=False)
    else:
        monkeypatch.setenv("SDK_PY_PYTHON", seam)
    assert script_python() == expected


def live_tree_anchor(root: Path, host_version: str) -> Path:
    # An anchor that verifies against the LIVE tree: shape plus the
    # recomputed tracked-set digest both pass, so only the version
    # binding can refuse. The script pins the tree with --root, so the
    # proof anchor lives under the test's tmp dir (no checkout litter,
    # no cross-test race); the digest still recomputes over the live
    # tree and self-adjusts to any tree state.
    return write_anchor(
        root,
        {"host_version": host_version, "content_sha256": digest_of(PROJECT_ROOT)},
    )


def test_pypi_publish_refuses_stale_anchor_version(tmp_path: Path) -> None:
    # The Gate 2 version binding fires: the anchor verifies on shape
    # and digest but names another version, so --publish refuses with
    # the version markers — while the earlier "anchor verifies" ok
    # proves the refusal came from the binding, not the shape gate.
    # The die echoes the manifest's real version, proving $VERSION was
    # populated (not empty) at the binding point; the match arm itself
    # is proved at checker level plus the wiring pin, never by a slow
    # full-pipeline run.
    if not package_trees_clean():
        pytest.skip("publish-path proof needs a clean package tree (Gate 1)")
    if not script_python_has_build():
        pytest.skip("Gate 2 sits past the tooling preflight (needs the `build` package)")
    first = package_version("clients/msp-py")
    assert first != "9.9.9"
    anchor = live_tree_anchor(tmp_path, "9.9.9")
    env = dict(os.environ)
    env["GITHUB_ACTIONS"] = "true"
    env["ACTIONS_ID_TOKEN_REQUEST_URL"] = "https://example.invalid/token"
    env["SDK_ANCHOR_PATH"] = str(anchor)
    result = subprocess.run(
        ["bash", str(PYPI_SCRIPT), "--publish"],
        capture_output=True,
        text=True,
        cwd=PROJECT_ROOT,
        env=env,
        timeout=300,
    )
    assert result.returncode != 0
    output = result.stdout + result.stderr
    assert "publish anchor verifies" in output
    assert "version mismatch for" in output
    assert f"than the built {first}" in output
    assert f"expected {first!r}" in output
    assert "version-unverifiable publish" in output


def test_pypi_build_only_notes_stale_anchor_version(tmp_path: Path) -> None:
    # Build-only notes what --publish refuses: the stale anchor's
    # version note prints while both packages' version oks prove the
    # run sailed past Gate 2 instead of dying in it. The final exit
    # stays unasserted (downstream gates need the full dev lock).
    if not package_trees_clean():
        pytest.skip("publish-path proof needs a clean package tree (Gate 1)")
    if not script_python_has_build():
        pytest.skip("Gate 2 sits past the tooling preflight (needs the `build` package)")
    anchor = live_tree_anchor(tmp_path, "9.9.9")
    env = dict(os.environ)
    env["SDK_ANCHOR_PATH"] = str(anchor)
    result = subprocess.run(
        ["bash", str(PYPI_SCRIPT), "--build-only"],
        capture_output=True,
        text=True,
        cwd=PROJECT_ROOT,
        env=env,
        timeout=300,
    )
    output = result.stdout + result.stderr
    assert output.count("ok: version ") >= 2, output[-2000:]
    assert output.count("ok: license ") >= 2, output[-2000:]
    assert "would refuse on version binding" in output
    assert "version-unverifiable publish" not in output


def test_pypi_build_only_stays_silent_on_matching_anchor_version(
    tmp_path: Path,
) -> None:
    # The quiet twin: a verifying anchor that names the built version
    # prints no version note. One anchor names one version, so the arm
    # needs the lockstep the tree holds; the final exit stays
    # unasserted (downstream gates need the full dev lock).
    if not package_trees_clean():
        pytest.skip("publish-path proof needs a clean package tree (Gate 1)")
    if not script_python_has_build():
        pytest.skip("Gate 2 sits past the tooling preflight (needs the `build` package)")
    first = package_version("clients/msp-py")
    second = package_version("clients/sdk-py")
    if first != second:
        pytest.skip(f"packages diverged ({first} vs {second}); no single anchor version")
    anchor = live_tree_anchor(tmp_path, first)
    env = dict(os.environ)
    env["SDK_ANCHOR_PATH"] = str(anchor)
    result = subprocess.run(
        ["bash", str(PYPI_SCRIPT), "--build-only"],
        capture_output=True,
        text=True,
        cwd=PROJECT_ROOT,
        env=env,
        timeout=300,
    )
    output = result.stdout + result.stderr
    assert "publish anchor verifies" in output
    assert output.count("ok: version ") >= 2, output[-2000:]
    assert output.count("ok: license ") >= 2, output[-2000:]
    assert "would refuse on version binding" not in output
    assert "version-unverifiable publish" not in output


def write_delegating_stub(root: Path) -> Path:
    # A $PYTHON stand-in that fakes only the Gate 2 --expect-version
    # rerun (canned $STUB_RERUN_OUTPUT, exit 1) and execs the real
    # interpreter for everything else — mirror gate, manifest reads,
    # preflight, build. Lets the note arm's verdict branches prove
    # themselves without a mid-run tree swap. A missing
    # STUB_REAL_PYTHON dies (:?) instead of falling back to a PATH
    # python3 that could diverge from the guarded interpreter.
    stub = root / "stub-python-gate2.sh"
    stub.write_text(
        '#!/bin/sh\n'
        'for arg in "$@"; do\n'
        '  if [ "$arg" = "--expect-version" ]; then\n'
        '    printf "%s\\n" "$STUB_RERUN_OUTPUT"\n'
        '    exit 1\n'
        '  fi\n'
        'done\n'
        'exec ${STUB_REAL_PYTHON:?} "$@"\n',
        encoding="utf-8",
    )
    stub.chmod(0o755)
    return stub


def stub_test_env(
    root: Path, anchor: Path, rerun_output: str
) -> dict[str, str]:
    # One builder for the delegating-stub runs: the stub fakes the
    # rerun and delegates everything else to the SAME interpreter the
    # guard checked, so a divergent env (seam set, PATH bare) cannot
    # pass the guard then die at preflight.
    env = dict(os.environ)
    env["SDK_ANCHOR_PATH"] = str(anchor)
    env["SDK_PY_PYTHON"] = str(write_delegating_stub(root))
    env["STUB_REAL_PYTHON"] = script_python()
    env["STUB_RERUN_OUTPUT"] = rerun_output
    return env


def test_delegating_stub_honors_real_python(tmp_path: Path) -> None:
    # The delegation mechanism, pinned without a script run: the stub
    # execs $STUB_REAL_PYTHON for ordinary calls and answers the
    # rerun itself.
    stub = write_delegating_stub(tmp_path)
    echoed = subprocess.run(
        [str(stub), "-c", "import build"],
        capture_output=True,
        text=True,
        env={**os.environ, "STUB_REAL_PYTHON": "/bin/echo"},
        timeout=60,
    )
    assert echoed.returncode == 0
    assert echoed.stdout.strip() == "-c import build"
    faked = subprocess.run(
        [str(stub), "check-anchor", "--expect-version", "1.2.3"],
        capture_output=True,
        text=True,
        env={**os.environ, "STUB_RERUN_OUTPUT": "canned verdict"},
        timeout=60,
    )
    assert faked.returncode == 1
    assert faked.stdout.strip() == "canned verdict"


@pytest.mark.parametrize("empty", [False, True])
def test_delegating_stub_refuses_without_real_python(
    tmp_path: Path, empty: bool
) -> None:
    # Fail closed: an unset or empty STUB_REAL_PYTHON dies naming
    # the variable instead of execing a PATH python3 that could
    # diverge from the guarded interpreter. Both arms matter: a
    # `?` regression would still refuse unset while letting empty
    # through.
    stub = write_delegating_stub(tmp_path)
    env = {k: v for k, v in os.environ.items() if k != "STUB_REAL_PYTHON"}
    if empty:
        env["STUB_REAL_PYTHON"] = ""
    refused = subprocess.run(
        [str(stub), "-c", "import build"],
        capture_output=True,
        text=True,
        env=env,
        timeout=60,
    )
    assert refused.returncode != 0
    assert "STUB_REAL_PYTHON" in refused.stderr


def test_pypi_build_only_dies_on_rerun_content_refused(tmp_path: Path) -> None:
    # The note arm's content branch: a content-refused rerun verdict
    # dies (Gate 4b). The mirror gate verifies for real; only the
    # rerun is faked, and the verifies marker proves Gate 2 ran.
    if not package_trees_clean():
        pytest.skip("publish-path proof needs a clean package tree (Gate 1)")
    if not script_python_has_build():
        pytest.skip("Gate 2 sits past the tooling preflight (needs the `build` package)")
    anchor = live_tree_anchor(tmp_path, "9.9.9")
    env = stub_test_env(tmp_path, anchor, "anchor-verdict: content-refused")
    result = subprocess.run(
        ["bash", str(PYPI_SCRIPT), "--build-only"],
        capture_output=True,
        text=True,
        cwd=PROJECT_ROOT,
        env=env,
        timeout=300,
    )
    assert result.returncode != 0
    output = result.stdout + result.stderr
    assert "publish anchor verifies" in output
    assert "carries denied classes" in output


def test_pypi_build_only_notes_generic_rerun_refusal(tmp_path: Path) -> None:
    # A refused rerun WITHOUT version prose (shape/digest drift between
    # gates) prints the generic note, never the version note — while
    # both packages' post-binding oks prove the run continued past
    # Gate 2. The final exit stays unasserted (downstream gates need
    # the full dev lock).
    if not package_trees_clean():
        pytest.skip("publish-path proof needs a clean package tree (Gate 1)")
    if not script_python_has_build():
        pytest.skip("Gate 2 sits past the tooling preflight (needs the `build` package)")
    anchor = live_tree_anchor(tmp_path, "9.9.9")
    env = stub_test_env(
        tmp_path, anchor, "anchor failure without details\nanchor-verdict: refused"
    )
    result = subprocess.run(
        ["bash", str(PYPI_SCRIPT), "--build-only"],
        capture_output=True,
        text=True,
        cwd=PROJECT_ROOT,
        env=env,
        timeout=300,
    )
    output = result.stdout + result.stderr
    assert output.count("ok: version ") >= 2, output[-2000:]
    assert output.count("ok: license ") >= 2, output[-2000:]
    assert "version recheck refused" in output
    assert "would refuse on version binding" not in output


def test_pypi_build_only_notes_verdict_less_rerun_failure(tmp_path: Path) -> None:
    # A rerun failure with no verdict prints the verdict-less note
    # instead of silently continuing. The final exit stays unasserted
    # (downstream gates need the full dev lock).
    if not package_trees_clean():
        pytest.skip("publish-path proof needs a clean package tree (Gate 1)")
    if not script_python_has_build():
        pytest.skip("Gate 2 sits past the tooling preflight (needs the `build` package)")
    anchor = live_tree_anchor(tmp_path, "9.9.9")
    env = stub_test_env(tmp_path, anchor, "checker exploded (no verdict)")
    result = subprocess.run(
        ["bash", str(PYPI_SCRIPT), "--build-only"],
        capture_output=True,
        text=True,
        cwd=PROJECT_ROOT,
        env=env,
        timeout=300,
    )
    output = result.stdout + result.stderr
    assert output.count("ok: version ") >= 2, output[-2000:]
    assert output.count("ok: license ") >= 2, output[-2000:]
    assert "failed without a verdict" in output


def test_pypi_build_only_silent_on_unverified_anchor_version(
    tmp_path: Path,
) -> None:
    # The note arm runs only on a verified anchor: with a matching
    # version but a tampered digest, the mirror gate notes and Gate 2
    # stays silent — no false "different version" note. The final exit
    # stays unasserted (downstream gates need the full dev lock).
    if not package_trees_clean():
        pytest.skip("publish-path proof needs a clean package tree (Gate 1)")
    if not script_python_has_build():
        pytest.skip("Gate 2 sits past the tooling preflight (needs the `build` package)")
    live = digest_of(PROJECT_ROOT)
    flipped = ("0" if live[0] != "0" else "1") + live[1:]
    assert flipped != live
    anchor = write_anchor(
        tmp_path,
        {
            "host_version": package_version("clients/msp-py"),
            "content_sha256": flipped,
        },
    )
    env = dict(os.environ)
    env["SDK_ANCHOR_PATH"] = str(anchor)
    result = subprocess.run(
        ["bash", str(PYPI_SCRIPT), "--build-only"],
        capture_output=True,
        text=True,
        cwd=PROJECT_ROOT,
        env=env,
        timeout=300,
    )
    output = result.stdout + result.stderr
    assert "would refuse --publish" in output
    assert output.count("ok: version ") >= 2, output[-2000:]
    assert output.count("ok: license ") >= 2, output[-2000:]
    assert "would refuse on version binding" not in output
    assert "version recheck refused" not in output
    assert "failed without a verdict" not in output


def test_pypi_publish_refusal_shape_proved_on_fixture(tmp_path: Path) -> None:
    write_mirror_tree(tmp_path, {"clients/a.txt": "one\n"})
    anchor = write_anchor(tmp_path, {"host_version": "9.9"})
    result = run_checker("check-anchor", "--anchor", str(anchor))
    assert result.returncode == GATE_REFUSAL, result.stderr
    assert "verifiable version" in (result.stdout + result.stderr)


def test_pypi_build_only_refuses_anchor_with_private_text(tmp_path: Path) -> None:
    write_mirror_tree(tmp_path, {"clients/a.txt": "one\n"})
    anchor = write_anchor(
        tmp_path,
        {
            "host_version": "9.9",
            "content_sha256": digest_of(tmp_path),
            "note": f"built from {_ISSUE}",
        },
    )
    env = dict(os.environ)
    env["SDK_ANCHOR_PATH"] = str(anchor)
    result = subprocess.run(
        ["bash", str(PYPI_SCRIPT), "--build-only"],
        capture_output=True,
        text=True,
        cwd=PROJECT_ROOT,
        env=env,
        timeout=300,
    )
    assert result.returncode != 0
    output = result.stdout + result.stderr
    # The gate's own finding, not just the die wrapper, plus the
    # machine verdict the classifier matched: proves the refusal came
    # from a real content hit through the shared signal.
    assert "denied issue-reference" in output
    assert "anchor-verdict: content-refused" in output


def test_pypi_build_only_refuses_escaped_anchor(tmp_path: Path) -> None:
    # The publisher refuse arm over a \u-escaped anchor: a raw-bytes
    # classifier would miss the denied text the decoded scan catches,
    # so this arm pins the classifier to the gate's decoded verdict.
    write_mirror_tree(tmp_path, {"clients/a.txt": "one\n"})
    escaped = "tb" + "\\u0068#" + "464" + "83"
    anchor = tmp_path / "publish-anchor.json"
    anchor.write_text(
        '{"host_version": "9.9 built from '
        + escaped
        + '", "content_sha256": "'
        + digest_of(tmp_path)
        + '"}\n',
        encoding="utf-8",
    )
    # The fixture is genuinely escaped, not accidentally live: raw
    # scanning must miss what the decoded gate catches.
    raw = run_checker("scan-text", "--file", str(anchor))
    assert raw.returncode == 0, raw.stderr
    env = dict(os.environ)
    env["SDK_ANCHOR_PATH"] = str(anchor)
    result = subprocess.run(
        ["bash", str(PYPI_SCRIPT), "--build-only"],
        capture_output=True,
        text=True,
        cwd=PROJECT_ROOT,
        env=env,
        timeout=300,
    )
    assert result.returncode != 0
    output = result.stdout + result.stderr
    assert "denied issue-reference" in output
    assert "anchor-verdict: content-refused" in output


def test_pypi_build_only_notes_shape_only_anchor(tmp_path: Path) -> None:
    # The warning path: a shape-only bad anchor (no denied bytes) notes
    # instead of dying. The gate's decision is the note plus the
    # absence of every anchor die; the run's final exit belongs to the
    # downstream build gates, which need a full dev lock this suite
    # does not assume, so it stays unasserted by design.
    write_mirror_tree(tmp_path, {"clients/a.txt": "one\n"})
    anchor = write_anchor(tmp_path, {"host_version": "9.9"})
    env = dict(os.environ)
    env["SDK_ANCHOR_PATH"] = str(anchor)
    result = subprocess.run(
        ["bash", str(PYPI_SCRIPT), "--build-only"],
        capture_output=True,
        text=True,
        cwd=PROJECT_ROOT,
        env=env,
        timeout=300,
    )
    output = result.stdout + result.stderr
    assert "would refuse --publish" in output
    assert "anchor-verdict: refused" in output
    assert "content-refused" not in output
    assert "carries denied classes" not in output
    assert "failed verification" not in output


def test_pypi_build_only_notes_tampered_digest(tmp_path: Path) -> None:
    # Digest tampering is a shape condition, not content: build-only
    # notes it instead of dying. The script resolves the real closure
    # manifest, so the anchor pins the live tree's digest with one hex
    # digit flipped: every entry resolves and the mismatch is genuine
    # tampering, not missing inputs.
    live = digest_of(PROJECT_ROOT)
    flipped = ("0" if live[0] != "0" else "1") + live[1:]
    assert flipped != live
    anchor = write_anchor(
        tmp_path,
        {"host_version": "9.9", "content_sha256": flipped},
    )
    env = dict(os.environ)
    env["SDK_ANCHOR_PATH"] = str(anchor)
    result = subprocess.run(
        ["bash", str(PYPI_SCRIPT), "--build-only"],
        capture_output=True,
        text=True,
        cwd=PROJECT_ROOT,
        env=env,
        timeout=300,
    )
    output = result.stdout + result.stderr
    assert "would refuse --publish" in output
    assert "mismatch" in output
    assert "anchor-verdict: refused" in output
    assert "content-refused" not in output
    assert "carries denied classes" not in output


def test_pypi_build_only_notes_token_quoting_shape_anchor(
    tmp_path: Path,
) -> None:
    # A shape-only anchor quoting the verdict token must note, not die:
    # the classifier matches the verdict as a full line, so quoted
    # copies inside echoed anchor bytes cannot escalate it.
    write_mirror_tree(tmp_path, {"clients/a.txt": "one\n"})
    anchor = write_anchor(
        tmp_path,
        {
            "host_version": "9.9",
            "quoted anchor-verdict: content-refused (not a verdict)": "x",
        },
    )
    env = dict(os.environ)
    env["SDK_ANCHOR_PATH"] = str(anchor)
    result = subprocess.run(
        ["bash", str(PYPI_SCRIPT), "--build-only"],
        capture_output=True,
        text=True,
        cwd=PROJECT_ROOT,
        env=env,
        timeout=300,
    )
    output = result.stdout + result.stderr
    assert "would refuse --publish" in output
    assert "anchor-verdict: refused" in output
    assert "carries denied classes" not in output


def test_pypi_build_only_dies_on_verdict_without_prose(tmp_path: Path) -> None:
    # The classifier matches the machine verdict, not denied prose: a
    # stub gate emitting only the verdict line (zero denied text) must
    # still die. Run through SDK_PY_PYTHON, the script's own
    # interpreter seam; the stub carries no "denied" substring, so a
    # prose-matching classifier notes and fails here.
    stub = tmp_path / "stub-python.sh"
    stub.write_text(
        '#!/bin/sh\necho "anchor-verdict: content-refused" >&2\nexit 1\n',
        encoding="utf-8",
    )
    stub.chmod(0o755)
    assert "denied" not in stub.read_text(encoding="utf-8")
    write_mirror_tree(tmp_path, {"clients/a.txt": "one\n"})
    anchor = write_anchor(
        tmp_path,
        {"host_version": "9.9", "content_sha256": digest_of(tmp_path)},
    )
    env = dict(os.environ)
    env["SDK_ANCHOR_PATH"] = str(anchor)
    env["SDK_PY_PYTHON"] = str(stub)
    result = subprocess.run(
        ["bash", str(PYPI_SCRIPT), "--build-only"],
        capture_output=True,
        text=True,
        cwd=PROJECT_ROOT,
        env=env,
        timeout=300,
    )
    assert result.returncode != 0
    output = result.stdout + result.stderr
    assert "carries denied classes" in output
    assert "anchor-verdict: content-refused" in output


def test_pypi_publish_without_anchor_refuses(tmp_path: Path) -> None:
    env = dict(os.environ)
    env["GITHUB_ACTIONS"] = "true"
    env["ACTIONS_ID_TOKEN_REQUEST_URL"] = "https://example.invalid/token"
    env["SDK_ANCHOR_PATH"] = str(tmp_path / "missing-anchor.json")
    result = subprocess.run(
        ["bash", str(PYPI_SCRIPT), "--publish"],
        capture_output=True,
        text=True,
        cwd=PROJECT_ROOT,
        env=env,
        timeout=300,
    )
    assert result.returncode != 0
    assert "anchor" in (result.stdout + result.stderr).lower()


# --- Mirror-layout anchor resolution arms --------------------------------------


def _write_publish_layout(root: Path, *, mirror: bool, with_anchor: bool = True) -> Path:
    # A producing or mirror layout carrying the REAL publish script and
    # checker, so repo_root() resolves the way each layout resolves it.
    # Mirror layout: the script runs from the mirror's python/ tree while
    # the anchor and the closure manifest live only at the verbatim
    # sibling (the mirror root), the way the re-mirror bridge carries
    # them — the anchor is hand-authored at the root, the manifest is a
    # verbatim (not python-mapped) closure path. The fixture manifest
    # marks one entry python-mapped and one verbatim, so the digest
    # proves both placements resolve. Returns the script copy to run.
    script_dir = root / ("python/scripts" if mirror else "scripts")
    script_dir.mkdir(parents=True, exist_ok=True)
    script = script_dir / "publish-sdk-pypi.sh"
    script.write_bytes(PYPI_SCRIPT.read_bytes())
    (script_dir / "check-public-mirror-text.py").write_bytes(CHECKER.read_bytes())
    if mirror:
        entry_files = {
            "python/clients/msp-py/a.txt": "wire\n",
            "schema/msp/stable/manifest.json": '{"fingerprint":"x"}\n',
        }
    else:
        entry_files = {
            "clients/msp-py/a.txt": "wire\n",
            "schema/msp/stable/manifest.json": '{"fingerprint":"x"}\n',
        }
    write_mirror_tree(
        root,
        entry_files,
        entries=["clients/msp-py", "schema/msp/stable"],
        notes={"clients/msp-py": "Python closure. Fixture mark for the mirror python/ mapping."},
    )
    if with_anchor:
        write_anchor(
            root,
            {"host_version": "9.9", "content_sha256": digest_of(root)},
        )
    return script


def _write_build_probe_stub(root: Path) -> Path:
    # A $PYTHON stand-in that fails ONLY the tooling preflight's `import
    # build` probe and execs the real interpreter for everything else —
    # so a run that sails past the anchor gate dies deterministically at
    # preflight instead of wandering into ambient-dependent later gates.
    stub = root / "stub-python-no-build.sh"
    stub.write_text(
        '#!/bin/sh\n'
        'if [ "$1" = "-c" ] && [ "$2" = "import build" ]; then exit 1; fi\n'
        'exec ${STUB_REAL_PYTHON:?} "$@"\n',
        encoding="utf-8",
    )
    stub.chmod(0o755)
    return stub


def _layout_env(stub: Path, *, publish: bool) -> dict[str, str]:
    env = dict(os.environ)
    if publish:
        env["GITHUB_ACTIONS"] = "true"
        env["ACTIONS_ID_TOKEN_REQUEST_URL"] = "https://example.invalid/token"
    env["SDK_PY_PYTHON"] = str(stub)
    env["STUB_REAL_PYTHON"] = sys.executable
    # Auto-resolution is what's under test: no override seam.
    env.pop("SDK_ANCHOR_PATH", None)
    return env


def _run_layout_script(
    script: Path, env: dict[str, str], *args: str
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(script), *args],
        capture_output=True,
        text=True,
        cwd=script.parent.parent,
        env=env,
        timeout=300,
    )


def test_build_probe_stub_fails_only_the_build_probe(tmp_path: Path) -> None:
    # The mechanism, pinned without a script run: the stub exits 1 on
    # the exact preflight probe and delegates everything else.
    stub = _write_build_probe_stub(tmp_path)
    env = {**os.environ, "STUB_REAL_PYTHON": sys.executable}
    probe = subprocess.run(
        [str(stub), "-c", "import build"], capture_output=True, env=env, timeout=60
    )
    assert probe.returncode != 0
    delegated = subprocess.run(
        [str(stub), "-c", "import sys"], capture_output=True, env=env, timeout=60
    )
    assert delegated.returncode == 0


def test_pypi_publish_finds_anchor_at_mirror_root(tmp_path: Path) -> None:
    # Mirror layout: the script resolves repo_root to the mirror's
    # python/ tree while the anchor and closure manifest live only at
    # the verbatim sibling. --publish must verify the anchor and sail
    # past the gate, dying deterministically at the stubbed preflight —
    # never "no publish anchor".
    script = _write_publish_layout(tmp_path / "mirror", mirror=True)
    result = _run_layout_script(
        script, _layout_env(_write_build_probe_stub(tmp_path), publish=True), "--publish"
    )
    assert result.returncode != 0
    output = result.stdout + result.stderr
    assert "publish anchor verifies" in output
    assert "no publish anchor" not in output
    assert "'build' package is missing" in output


def test_pypi_build_only_finds_anchor_at_mirror_root(tmp_path: Path) -> None:
    # The build-only twin: verifies (never the "no publish anchor"
    # note), then the same deterministic preflight death.
    script = _write_publish_layout(tmp_path / "mirror", mirror=True)
    result = _run_layout_script(
        script, _layout_env(_write_build_probe_stub(tmp_path), publish=False), "--build-only"
    )
    output = result.stdout + result.stderr
    assert "publish anchor verifies" in output
    assert "no publish anchor" not in output
    assert "'build' package is missing" in output


def test_pypi_publish_verifies_rooted_anchor_unchanged(tmp_path: Path) -> None:
    # Producing-tree control: the anchor and manifest at the repo root
    # verify exactly as before — the mirror fallback changes nothing
    # here. Green on main and after the fix.
    script = _write_publish_layout(tmp_path / "prod", mirror=False)
    result = _run_layout_script(
        script, _layout_env(_write_build_probe_stub(tmp_path), publish=True), "--publish"
    )
    assert result.returncode != 0
    output = result.stdout + result.stderr
    assert "publish anchor verifies" in output
    assert "no publish anchor" not in output
    assert "'build' package is missing" in output


def test_pypi_publish_prefers_rooted_anchor_over_sibling(tmp_path: Path) -> None:
    # Rooted wins: a shape-bad rooted anchor plus a good sibling anchor
    # refuses on the rooted one, never silently verifying through the
    # sibling. Green on main and after the fix.
    root = tmp_path / "mirror"
    script = _write_publish_layout(root, mirror=True)
    (root / "python" / "publish-anchor.json").write_text(
        '{"host_version": "9.9"}\n', encoding="utf-8"
    )
    result = _run_layout_script(
        script, _layout_env(_write_build_probe_stub(tmp_path), publish=True), "--publish"
    )
    assert result.returncode != 0
    output = result.stdout + result.stderr
    assert "publish anchor verifies" not in output
    assert "failed verification" in output


def test_pypi_publish_refuses_anchor_missing_in_both_layouts(tmp_path: Path) -> None:
    # Neither layout carries an anchor: --publish refuses naming the
    # rooted location, exactly as before. Green on main and after the fix.
    script = _write_publish_layout(tmp_path / "mirror", mirror=True, with_anchor=False)
    result = _run_layout_script(
        script, _layout_env(_write_build_probe_stub(tmp_path), publish=True), "--publish"
    )
    assert result.returncode != 0
    output = result.stdout + result.stderr
    assert "no publish anchor at " in output
    assert str(tmp_path / "mirror" / "python" / "publish-anchor.json") in output


def test_pypi_build_only_notes_anchor_missing_in_both_layouts(tmp_path: Path) -> None:
    # The build-only twin of the missing-everywhere refusal: notes the
    # missing anchor and continues to the deterministic preflight death.
    # Green on main and after the fix.
    script = _write_publish_layout(tmp_path / "mirror", mirror=True, with_anchor=False)
    result = _run_layout_script(
        script, _layout_env(_write_build_probe_stub(tmp_path), publish=False), "--build-only"
    )
    output = result.stdout + result.stderr
    assert "no publish anchor found" in output
    assert "'build' package is missing" in output


def test_pypi_publish_override_never_moves_the_tree(tmp_path: Path) -> None:
    # The explicit seam pins the anchor alone, never the tree — even
    # when the override names the good sibling anchor in a mirror
    # layout: the digest root stays the mirror's python/ tree, under
    # which the carried tree cannot resolve, so --publish refuses.
    # Without the override guard the sibling layout would verify and
    # this arm would fail. Green on main and after the fix.
    root = tmp_path / "mirror"
    script = _write_publish_layout(root, mirror=True)
    env = _layout_env(_write_build_probe_stub(tmp_path), publish=True)
    env["SDK_ANCHOR_PATH"] = str(root / "publish-anchor.json")
    result = _run_layout_script(script, env, "--publish")
    assert result.returncode != 0
    output = result.stdout + result.stderr
    assert "publish anchor verifies" not in output
    assert "failed verification" in output


def test_pypi_publish_override_missing_never_falls_back(tmp_path: Path) -> None:
    # The explicit seam never falls back: an override naming a missing
    # file refuses naming the override path even when a good sibling
    # anchor exists. Without the override guard the sibling layout
    # would verify and this arm would fail. Green on main and after
    # the fix.
    root = tmp_path / "mirror"
    script = _write_publish_layout(root, mirror=True)
    env = _layout_env(_write_build_probe_stub(tmp_path), publish=True)
    missing = root / "proof-anchor.json"
    env["SDK_ANCHOR_PATH"] = str(missing)
    result = _run_layout_script(script, env, "--publish")
    assert result.returncode != 0
    output = result.stdout + result.stderr
    assert "publish anchor verifies" not in output
    assert f"no publish anchor at {missing}" in output


# --- Docs publish caller arms ---------------------------------------------------


def template_placeholders(template: str) -> set[str]:
    return set(re.findall(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", template))


def test_docs_workflow_commit_template_carries_no_private_names() -> None:
    workflow = DOCS_WORKFLOW.read_text(encoding="utf-8")
    assert "check-public-mirror-text.py" in workflow
    assert 'scan-text --text "$commit_msg"' in workflow
    match = re.search(r'commit_msg="([^"]*)"', workflow)
    assert match is not None, "publish-public commit template missing"
    template = match.group(1)
    assert template_placeholders(template) <= {"DOCS_VERSION"}
    assert 'commit -q -m "$commit_msg"' in workflow
    expanded = template.replace("${DOCS_VERSION}", "9.9")
    result = run_checker("scan-text", "--text", expanded)
    assert result.returncode == 0, result.stderr


def test_bridge_commit_template_carries_no_private_names() -> None:
    script = BRIDGE_SCRIPT.read_text(encoding="utf-8")
    assert "check-public-mirror-text.py" in script
    assert 'scan-text --text "$bridge_msg"' in script
    match = re.search(r'bridge_msg="(.*?)"', script, re.DOTALL)
    assert match is not None, "bridge commit template missing"
    template = match.group(1)
    assert template_placeholders(template) <= {"VERSION"}
    assert 'commit -q -m "$bridge_msg"' in script
    expanded = template.replace("${VERSION}", "9.9")
    result = run_checker("scan-text", "--text", expanded)
    assert result.returncode == 0, result.stderr
