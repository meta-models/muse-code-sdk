"""The fingerprint-vector proof for the stdlib Python implementation.

``scripts/msp_fingerprint.py`` computes the schema fingerprint without the
compiled protocol crate. This suite runs it against the same shared
fixture the compiled implementation proves
(``schema/msp/fingerprint-vectors.json``): frozen values plus the twin
relations, structurally. An implementation that cannot reproduce a vector
fails here.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(_PROJECT_ROOT / "scripts"))

from msp_fingerprint import FingerprintError, bundle_fingerprint  # noqa: E402


def _vectors() -> list[dict]:
    fixture = json.loads(
        (_PROJECT_ROOT / "schema" / "msp" / "fingerprint-vectors.json").read_text()
    )
    vectors = fixture["vectors"]
    assert vectors, "an empty vector file proves nothing"
    names = [vector["name"] for vector in vectors]
    assert len(set(names)) == len(names), "vector names are unique keys"
    return vectors


def test_port_proves_every_vector():
    actuals: dict[str, str] = {}
    for vector in _vectors():
        name = vector["name"]
        try:
            actual = bundle_fingerprint(vector["variant"], vector["schema"])
        except FingerprintError as error:
            assert error.kind == vector.get("error"), (
                f"vector `{name}` refused differently ({error})"
            )
        else:
            assert actual == vector.get("fingerprint"), (
                f"vector `{name}` moved (actual {actual})"
            )
            actuals[name] = actual
    # The twin relations, structurally: a strip twin equals its stripped
    # input, key order and whitespace never move the value, and the
    # variant tag separates the two renders of one document.
    assert actuals["strip-stable"] == actuals["strip-twin"], (
        "the strip twin must equal its stripped input"
    )
    assert actuals["minimal-stable"] == actuals["reordered-whitespace"], (
        "key order and whitespace must not move the value"
    )
    assert actuals["collapse-branch"] == actuals["collapse-twin"], (
        "the collapsed twin must equal its flat form"
    )
    assert actuals["emptied-required"] == actuals["emptied-required-twin"], (
        "an emptied `required` drops the key"
    )
    assert actuals["anyof-drop-arm"] == actuals["anyof-drop-twin"], (
        "an experimental `anyOf` arm drops, not nulls"
    )
    assert actuals["kept-root-member"] == actuals["kept-root-member-twin"], (
        "a root-direct experimental member is kept, stripped"
    )
    assert actuals["enumless-oneof"] == actuals["enumless-oneof-twin"], (
        "an enum-less lone branch never collapses"
    )
    assert actuals["experimental-oneof-kept"] != actuals["experimental-oneof-flat"], (
        "experimental never collapses oneOf"
    )
    assert actuals["minimal-stable"] != actuals["minimal-experimental"], (
        "the variant tag must separate the two renders"
    )


def test_bad_bytes_refuse_with_the_vocabulary_word():
    with pytest.raises(FingerprintError) as refused:
        bundle_fingerprint("stable", b"\xff\xfe invalid utf-8 \x80")
    assert refused.value.kind == "unparseable-document"
