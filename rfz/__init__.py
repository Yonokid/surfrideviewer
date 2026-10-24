"""Unpack .rfz bitmap fonts into a PNG atlas + metrics JSON cache (see rfz_unpack.py)."""

import io
import json

from PIL import Image

from . import rfz_unpack


def unpack_font(rfz, out):
    """Unpack an .rfz into out/font.json + out/page<N>.png. Pure-Python LZW: ~40s for a 24pt font."""
    if (out / "font.json").exists():
        return
    d, _ = rfz_unpack.decompress_rfz(rfz.read_bytes())
    meta, glyph_off = rfz_unpack.parse_metadata(d)
    glyphs = rfz_unpack.parse_glyphs(d, glyph_off, meta["glyph_cnt"])
    out.mkdir(parents=True, exist_ok=True)
    for i, (_, _, _, dds) in enumerate(rfz_unpack.extract_textures(d)):
        Image.open(io.BytesIO(dds)).save(out / f"page{i}.png")
    keys = ("cell_inc_x", "page", "origin_x", "origin_y", "box_x1", "box_y1", "box_x2", "box_y2")
    font = {"ascent": meta["max_ascent"], "descent": meta["max_descent"], "margin": meta["glyph_margin"],
            "glyphs": {g["code"]: [g[k] for k in keys] for g in glyphs}}
    (out / "font.json").write_text(json.dumps(font))  # written last: marks the cache entry complete

