import json
import tempfile
from pathlib import Path
from types import SimpleNamespace as NS

import srdviewer as s


def prop(tag, value):
    return NS(tag=tag, value=value)


def test_groups():
    # FC-delimited list (NODE/TRS2) and a list with no leading FC (SLIC)
    node = NS(properties=[prop(0xFC, None), prop(3, b"a"), prop(0xFE, None), prop(3, b"b"), prop(0xFD, None)])
    assert s.groups(node) == [{3: "a"}, {3: "b"}]
    slic = NS(properties=[prop(0x40, 100), prop(0xFE, None), prop(0x40, 0)])
    assert s.groups(slic) == [{0x40: 100}, {0x40: 0}]


def test_angle():
    assert s.angle(16384) == 90
    assert s.angle(2**32 - 16384) == -90


def test_apply_patches():
    tree = NS(children=[NS(properties=[prop(3, "あ".encode()), prop(0x36, [1.0, 1.0])])])
    patches = [
        {"path": "$.children[0].properties[0].value", "value": "A", "original": "あ"},
        {"path": "$.children[0].properties[1].value[0]", "value": 2.0, "original": 1.0},
        {"path": "$.children[0].properties[1].value[1]", "value": 9.0, "original": 5.0},  # mismatch: skipped
        {"path": "$.children[3].properties[0].value", "value": "x", "original": "x"},  # bad path
    ]
    bad = s.apply_patches(tree, patches)
    assert tree.children[0].properties[0].value == b"A"
    assert tree.children[0].properties[1].value == [2.0, 1.0]
    assert [b["value"] for b in bad] == [9.0, "x"]


def test_save_patch():
    with tempfile.TemporaryDirectory() as d:
        pf = Path(d) / "sub" / "a.json"
        s.save_patch(pf, [{"path": "$.x[0]", "value": -22, "original": 1.5}, {"path": "$.t", "value": "あ", "original": "い"}])
        text = pf.read_text(encoding="utf-8")
        assert text == json.dumps([{"path": "$.x[0]", "value": -22.0, "original": 1.5},
                                   {"path": "$.t", "value": "あ", "original": "い"}], indent=2, ensure_ascii=False)
        assert '"-22.0"' not in text and "-22.0" in text and not text.endswith("\n")


if __name__ == "__main__":
    test_groups()
    test_angle()
    test_apply_patches()
    test_save_patch()
    print("ok")
