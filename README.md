# surfrideviewer

Browser viewer for SurfRide `.srd` UI scenes (CHUNITHM). Parsing via [amlibpy](https://pypi.org/project/amlibpy/).

```
uv run srdviewer.py "/path/to/CHUNITHM/App/data/surfboard" [--port 8765] [--translation chutranslation/SDHD_24000]
```


Fonts: `.rfz` files in `<surfboard>/../*/font/` are unpacked on first start into `.cache/fonts/` (atlas PNGs + metrics JSON). This takes about 40 s per font, run in parallel, and text uses a system font until it is done.

`--translation DIR` loads a whole chutranslation version: `DIR/src/srd/<path>.json` patches (files with one get a ✎) and `DIR/src/texture/*.dds` (toggle *Translated textures*), as `build.py` uses them. In this mode **Save** writes the patch back to `DIR/src/srd/<path>.json` (same format as the repo: `indent=2`, `ensure_ascii=False`, no trailing newline) and **Revert** discards unsaved edits and reloads it from disk. `.srd` files are never written.

Open http://localhost:8765. Pick a file, scene, layers and animation. **Patch → Import…** loads a chutranslation-style JSON patch (`[{path, value, original}]`, e.g. `chutranslation/SDHD_24000/src/srd/<same path>.json`) for the current file; it is applied in memory only, toggled with *Apply*, and kept until the page reloads. Patches whose `original` doesn't match the file are skipped and listed under *Selected*.

**Editing:** select a node in the tree; *Selected* shows X/Y (position) and Width/Height for images, 9-slices and numbers, plus Text for text nodes. Edits preview immediately and are recorded as patch entries (`original` = the game's value; setting a value back to the original drops the entry). Changed fields are outlined; hover for the original. **Export** downloads the patch (`<file>.json`, chutranslation format, works with `build.py`). Values driven by the current animation are flagged; pick animation *(none)* to see the base value. `#<relative path>` in the URL deep-links a file.

## Format notes (CHUNITHM, PROJ version 1)

- Node type = `NODE.0x30 & 0xF`: 0 null, 1 image (`CIMG`), 2 9-slice (`CSLI`), 3 layer reference (`CRFD`), 4 number (`CNUM`).
- Tree: `NODE.0x3C` first child, `0x3D` next sibling. Origin top-left, Y down.
- `TRS2`: `0x34` pos, `0x35` rotation (0x10000 = 360°, positive = counter-clockwise on screen), `0x36` scale, `0x3B` display, `0x3A` colour. Colour (RGB and alpha) multiplies down to children and referenced layers.
- Image flags (`CIMG`/`CNUM` `0x49`, `CSLI` `0x80`, SLIC cell `0x83`): low nibble = blend (0 normal, 1 add, 2 subtract, 3 multiply), `0x10` flip X, `0x20` flip Y.
- `CATR` `ExtParamData.blendMode` (game shader, overrides the above when non-zero): 1–19 look like Photoshop blend-mode order (3 multiply, 8 screen, 9 colour dodge, 10 add, 19 difference); 20+ are effects (24/25 blur, 27 distortion), drawn normally.
- `LAYR.0x20` bit `0x1`: layer origin at screen centre.
- `CREF.0x4A` = `[texture index, crop index]`; pivot `0x42/0x43` is in pixels of the node's own size and keeps its ratio when width/height tracks (11/12) animate the size.
- Track types: 0/1 pos X/Y, 5 rot Z, 6/7 scale X/Y, 9 colour, 10 display, 11/12 width/height, 13–16 vertex colours, 17 crop index, 21 alpha.

## RFZ fonts

`rfz_unpack.py` is copied unchanged from [GzLxz190614/RFZ-Unpacker-Packer](https://gitea.tendokyu.moe/GzLxz190614/RFZ-Unpacker-Packer) (BSD-3, see `LICENSE-rfz_unpack`): `YS\x02\x00` header + 9–12 bit MSB-first LZW → `RHFONTDB` container with glyph table and ARGB4444 DDS atlases. Glyph codes are Unicode. Placement: `x = pen + origin_x - margin`, `y = baseline - origin_y - margin`, advance `cell_inc_x`, line height `ascent + descent`.

## Not handled

Masks/stencils, per-vertex gradients (top-left colour only), subtract blending (drawn as `difference`), perspective/depth sorting for TRS3 layers, `CNUM` alignment flags. Text flags (`TEXT.0x78`): `0x8` right, `0x4` centre (inferred from pivots), `0x10` not alignment (meaning unknown); vertical bits are guessed.
