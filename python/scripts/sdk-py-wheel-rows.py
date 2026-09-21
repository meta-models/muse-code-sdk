#!/usr/bin/env python3
"""The per-wheel compatibility rows for the Python SDK publish path.

The compatibility contract's release-cut half: each published
wheel pairs with the host version and schema fingerprint it was built
against, on the docs site's compatibility page. This emits that pairing for
the CURRENT tree's wheels, derived — never hand-typed — from each value's
one source of truth:

* wheel filename and version: the package manifests (PEP 427 normalization
  of the manifest's own name and version);
* host version: the generated ``muse_code_msp.REQUIRED_HOST_VERSION``
  (itself rendered from the host crate by ``scripts/gen-msp-py.sh``);
* schema fingerprint: ``schema/msp/stable/manifest.json``.

``scripts/publish-sdk-pypi.sh`` runs this as a gate — with ``--dist`` it
also proves the wheels the build actually produced are exactly the wheels
the rows name — and the publish integration commit appends the emitted rows
to ``clients/sdk-py/published-wheels.json``, which the docs build renders.
Everything here must also run from the publication mirror's checkout, so it
reads only paths inside the source closure (scripts/sdk-source-closure.json).

Stdlib only; TOML needs Python 3.11+ (tomllib) or the dev lock's tomli.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

PACKAGES = (
    # Wire types first: the facade's rows make no sense without them, and the
    # owner-run publish ships muse-code-msp first for the same reason.
    ("msp-py", "muse_code_msp"),
    ("sdk-py", "muse_code"),
)


class RowError(Exception):
    """A row could not be derived; the publish path must stop."""


def _load_toml(path: Path) -> dict[str, Any]:
    try:
        import tomllib
    except ModuleNotFoundError:
        try:
            import tomli as tomllib  # type: ignore[no-redef]
        except ModuleNotFoundError as error:
            raise RowError(
                f"reading {path} needs tomllib (Python 3.11+) or the dev lock's tomli"
            ) from error
    with path.open("rb") as handle:
        return tomllib.load(handle)


def _generated_constant(repo_root: Path, name: str) -> str:
    # Read, not imported: the mirror's publish environment must not need the
    # package importable (pydantic is not installed there), and a regex over
    # the generated module keeps this dependency-free. The constant is a
    # single-line string assignment the renderer emits.
    source = (repo_root / "clients" / "msp-py" / "src" / "muse_code_msp" / "__init__.py").read_text()
    matched = re.search(rf'^{name}(?::\s*[^=]+)?\s*=\s*"([^"]+)"$', source, re.MULTILINE)
    if not matched:
        raise RowError(
            f"generated muse_code_msp lost its {name} constant; rerun scripts/gen-msp-py.sh"
        )
    return matched.group(1)


def wheel_rows(repo_root: Path) -> dict[str, Any]:
    host_version = _generated_constant(repo_root, "REQUIRED_HOST_VERSION")
    fingerprint = _generated_constant(repo_root, "SCHEMA_FINGERPRINT")
    manifest = json.loads((repo_root / "schema" / "msp" / "stable" / "manifest.json").read_text())
    if fingerprint != manifest["fingerprint"]:
        raise RowError(
            "generated muse_code_msp is stale against the stable bundle "
            "manifest; rerun scripts/gen-msp-py.sh before publishing anything"
        )
    rows = []
    for package_dir, import_name in PACKAGES:
        project = _load_toml(repo_root / "clients" / package_dir / "pyproject.toml")["project"]
        # Plain X.Y.Z only: setuptools normalizes anything else to PEP 440 in
        # the built wheel's filename (1.0.0-rc.1 -> 1.0.0rc1), so a suffixed
        # version would derive a row naming a wheel that never gets built —
        # refuse with the real reason instead of a confusing parity mismatch.
        if not re.fullmatch(r"\d+\.\d+\.\d+", project["version"]):
            raise RowError(
                f"{project['name']} version {project['version']!r} is not plain "
                "X.Y.Z semver; PEP 440 normalization would change the built "
                "wheel's filename — extend this derivation before publishing "
                "a pre-release"
            )
        # PEP 427: runs of [-_.] in the distribution name become one _.
        normalized = re.sub(r"[-_.]+", "_", project["name"])
        rows.append(
            {
                "distribution": project["name"],
                "importName": import_name,
                "version": project["version"],
                "wheel": f"{normalized}-{project['version']}-py3-none-any.whl",
                "requiresPython": project["requires-python"],
                "hostVersion": host_version,
                "schemaFingerprint": fingerprint,
            }
        )
    return {"schemaVersion": 1, "wheels": rows}


def verify_dist(rows: dict[str, Any], dist_dir: Path) -> None:
    """The built artifacts are exactly the wheels the rows name.

    The rows are a claim about what ships; this makes the publish gate hold
    the claim against what the build actually produced, in both directions —
    a missing wheel and an unexpected one each stop the publish.
    """
    expected = {row["wheel"] for row in rows["wheels"]}
    built = {path.name for path in dist_dir.rglob("*.whl")}
    if built != expected:
        raise RowError(
            f"built wheels {sorted(built)} do not match the derived rows "
            f"{sorted(expected)}; a wheel must not ship without its row"
        )


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=None)
    parser.add_argument(
        "--dist",
        type=Path,
        default=None,
        help="a built dist tree to verify against the derived rows",
    )
    args = parser.parse_args(argv)
    repo_root = (args.repo_root or Path(__file__).resolve().parents[1]).resolve()
    try:
        rows = wheel_rows(repo_root)
        if args.dist is not None:
            verify_dist(rows, args.dist)
    except RowError as error:
        print(f"sdk-py-wheel-rows: {error}", file=sys.stderr)
        return 1
    json.dump(rows, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
