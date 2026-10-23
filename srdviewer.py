"""SurfRide (.srd) viewer.

Usage: uv run srdviewer.py <surfboard dir> [--port N] [--translation DIR]
e.g.   uv run srdviewer.py "/path/to/CHUNITHM/App/data/surfboard" \
           --translation ~/Documents/GitHub/chutranslation/SDHD_24000

chutranslation-style JSON patches (a list of {path, value, original}) can be imported per
file in the web UI; they are POSTed with the request and applied in memory only.
--translation loads DIR/src/srd/<path>.json patches and DIR/src/texture/*.dds textures
(as build.py uses them); saving in the web UI writes the patch JSON back to DIR/src/srd.

Parses .srd (VTBF) files with amlibpy's generic VTC reader, simplifies them into
JSON and serves them, along with DDS textures converted to PNG, to index.html.
.rfz bitmap fonts (from <surfboard dir>/../*/font) are unpacked with rfz_unpack.py
into .cache/fonts/ on first run.
"""

import argparse
import io
import json
import re
import sys
from concurrent.futures import ProcessPoolExecutor
from functools import lru_cache
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from amlibpy.surf.vtbf import KNOWN_VTC, VTBF_Reader
from PIL import Image

import rfz_unpack

# amlibpy's typed SurfRide classes assert on a lot of CHUNITHM files; use the raw tree.
KNOWN_VTC.clear()

HERE = Path(__file__).parent
FONT_CACHE = HERE / ".cache" / "fonts"
TL_SRD = TL_TEX = None  # set from --translation


def text(b):
    if not isinstance(b, bytes):
        return b
    for enc in ("utf-8", "shift_jis"):
        try:
            return b.decode(enc)
        except UnicodeDecodeError:
            pass
    return b.decode("latin-1")


def props(n):
    """First value of each tag (later duplicates are ignored)."""
    out = {}
    for p in n.properties:
        out.setdefault(p.tag, text(p.value))
    return out


def multi(n, tag):
    return [text(p.value) for p in n.properties if p.tag == tag]


def group_indices(n):
    """Split a FC ... FE ... FD property list into one {tag: property index} dict per entry."""
    out, cur = [], None
    for i, p in enumerate(n.properties):
        if p.tag in (0xFC, 0xFE):
            cur = {}
            out.append(cur)
        elif p.tag == 0xFD:
            break
        else:
            if cur is None:  # some lists (SLIC) have no leading FC
                cur = {}
                out.append(cur)
            cur.setdefault(p.tag, i)
    return out


def groups(n):
    """Like group_indices, with the values."""
    return [{t: text(n.properties[i].value) for t, i in g.items()} for g in group_indices(n)]


def annotate(n, path):
    """Store each VTC's JSONPath (as used by chutranslation patches) on it as _path."""
    n._path = path
    for i, c in enumerate(n.children):
        annotate(c, f"{path}.children[{i}]")


def prop_path(n, tag, index=None, type_="Float"):
    """JSONPath of n's first `tag` property value (index into the VTC's properties via `index` for lists)."""
    i = index if index is not None else next((i for i, p in enumerate(n.properties) if p.tag == tag), None)
    if i is None or n.properties[i].type.name != type_:
        return None
    return f"{n._path}.properties[{i}].value"


def kids(n, type_):
    return [c for c in n.children if c.type == type_]


def kid(n, type_):
    k = kids(n, type_)
    return k[0] if k else None


def angle(v):
    # 0x10000 = 360 degrees, stored as u32
    v = v - (1 << 32) if v >= 1 << 31 else v
    return v * 360 / 65536


def crefs(n):
    c = kid(n, "CREF")
    return multi(c, 0x4A) if c else []


def cattrs(n):
    """CATR key/value pairs, eg. ExtParamData -> {blendMode: '0', ...}."""
    out = {}
    names, vals = multi(n, 0x03), multi(n, 0x0F)
    for k, v in zip(names, vals):
        out[k] = dict(kv.split("#", 1) for kv in v.split(",") if "#" in kv) if isinstance(v, str) else v
    return out


def conv_data(d):
    p = props(d)
    base = {
        "kind": d.type,
        "w": p.get(0x40, 0),
        "h": p.get(0x41, 0),
        "px": p.get(0x42, 0),
        "py": p.get(0x43, 0),
        "flags": p.get(0x80 if d.type == "CSLI" else 0x49, 0),  # low nibble = blend mode, 0x10/0x20 = flip
        "vcol": multi(d, 0x44)[:4],
        "crefs": crefs(d),
    }
    if d.type == "CIMG":
        t = kid(d, "TEXT")
        if t:
            tp = props(t)
            base["text"] = {"str": tp.get(0x7A, ""), "font": tp.get(0x79, 0), "flags": tp.get(0x78, 0),
                            "scale": tp.get(0x36, [1, 1])}
    elif d.type == "CSLI":
        base["cols"], base["rows"] = p.get(0x81, 1), p.get(0x82, 1)
        s = kid(d, "SLIC")
        base["cells"] = [{"w": g.get(0x40, 0), "h": g.get(0x41, 0), "cref": g.get(0x46, i), "flags": g.get(0x83, 0)}
                         for i, g in enumerate(groups(s))] if s else []
    elif d.type == "CNUM":
        base["value"] = p.get(0x81, 0)
        base["digitW"], base["digitH"] = p.get(0x83, 0), p.get(0x84, 0)
        base["spacing"] = p.get(0x8A, 0)
        base["numFlags"] = p.get(0x80, 0)
    elif d.type == "CRFD":
        base["scene"], base["layer"] = p.get(0x80, ""), p.get(0x81, "")
        base["anim"], base["frame"] = p.get(0x83, ""), p.get(0x84, 0)
    return base


def conv_cast(c):
    nodes = groups(kid(c, "NODE"))
    trs2, trs3 = kid(c, "TRS2"), kid(c, "TRS3")
    trs = groups(trs2 or trs3)
    data, data_vtc = {}, {}
    d = kid(c, "DATA")
    for x in d.children if d else []:
        ci = props(x).get(0x51)
        if ci is not None:
            data[ci], data_vtc[ci] = conv_data(x), x
    tidx = group_indices(trs2 or trs3)
    attrs = {}
    for a in kids(kid(c, "CATL"), "CATR") if kid(c, "CATL") else []:
        attrs[props(a).get(0x51)] = cattrs(a)

    out = []
    for i, n in enumerate(nodes):
        t = trs[i] if i < len(trs) else {}
        # always xyz: pos, rotation (degrees), scale
        if trs2:
            pos, rot, scl = [*t.get(0x34, [0, 0]), 0], [0, 0, angle(t.get(0x35, 0))], [*t.get(0x36, [1, 1]), 1]
        else:
            pos, rot, scl = t.get(0x37, [0, 0, 0]), [angle(a) for a in t.get(0x38, [0, 0, 0])], t.get(0x39, [1, 1, 1])
        # JSONPaths of the user-editable values, for building patches
        edit = {}
        pp = prop_path(trs2 or trs3, 0, tidx[i].get(0x34 if trs2 else 0x37)) if i < len(tidx) else None
        if pp:
            edit["x"], edit["y"] = pp + "[0]", pp + "[1]"
        if (x := data_vtc.get(i)) is not None:
            edit["w"], edit["h"] = prop_path(x, 0x40), prop_path(x, 0x41)
            if (tx := kid(x, "TEXT")) is not None:
                edit["text"] = prop_path(tx, 0x7A, type_="AnsiString")
        out.append({
            "name": n.get(0x03, ""),
            "edit": {k: v for k, v in edit.items() if v},
            "flags": n.get(0x30, 0),
            "child": n.get(0x3C, -1),
            "sibling": n.get(0x3D, -1),
            "pos": pos, "rot": rot, "scale": scl,
            "display": t.get(0x3B, True),
            "color": t.get(0x3A, "#FFFFFFFF"),
            "data": data.get(i),
            "attrs": attrs.get(i, {}),
        })
    return out


def conv_track(t):
    p = props(t)
    k = kid(t, "KEY ")
    frames = multi(k, 0x5A)
    vals = multi(k, 0x5B)
    interp = multi(k, 0x5C) or [1] * len(frames)  # colour keys carry no interpolation: lerp them
    if any(p.tag == 0x5B and p.type.name == "Long" for p in k.properties):
        interp = [0] * len(frames)  # integer tracks (display, crop index) step
    ins = multi(k, 0x5D) or [0] * len(frames)
    outs = multi(k, 0x5E) or [0] * len(frames)
    typ = p.get(0x53, -1)
    if 3 <= typ <= 5:
        vals = [angle(v) for v in vals]
    return {"type": typ, "keys": [list(x) for x in zip(frames, vals, interp, ins, outs)]}


def conv_anim(a):
    p = props(a)
    motions = kids(a, "MOT ")
    end = p.get(0x56, 0)
    if end < 0:  # CHUNITHM stores -1; use the last track frame instead
        end = max((props(t).get(0x59, 0) for m in motions for t in kids(m, "TRK ")), default=0)
    return {
        "name": p.get(0x03, ""),
        "end": end,
        "loop": bool(p.get(0x5F, 0)),
        "motions": [{"cast": props(m).get(0x51, -1), "tracks": [conv_track(t) for t in kids(m, "TRK ")]}
                    for m in motions],
    }


def conv_layer(l):
    p = props(l)
    cast = kid(l, "CAST")
    return {
        "name": p.get(0x03, ""),
        "flags": p.get(0x20, 0),
        "nodes": conv_cast(cast) if cast else [],
        "anims": [conv_anim(a) for a in kids(l, "ANIM")],
    }


def apply_patches(vtbf, patches):
    """Apply chutranslation patches ($.children[i]...properties[j].value) to the loaded tree, in memory.
    Returns the patches that failed (bad path, or `original` doesn't match, e.g. another game version);
    those are skipped."""
    get = lambda o, k: o[k] if isinstance(k, int) else getattr(o, k)
    bad = []
    for p in patches:
        *keys, last = [int(k) if k.isdigit() else k for k in re.findall(r"[A-Za-z_]+|\d+", p["path"])]
        try:
            obj = vtbf
            for k in keys:
                obj = get(obj, k)
            cur = get(obj, last)
            if isinstance(cur, bytes):
                ok, new = text(cur) == p.get("original", text(cur)), p["value"].encode("utf-8")
            else:
                orig = p.get("original", cur)
                ok, new = (abs(cur - orig) < 1e-4 if isinstance(cur, float) else cur == orig), p["value"]
        except (IndexError, AttributeError, TypeError, KeyError) as e:
            bad.append({**p, "error": f"{type(e).__name__}: {e}"})
            continue
        if not ok:
            bad.append({**p, "error": f"original mismatch, file has {text(cur)!r}"})
        elif isinstance(last, int):
            obj[last] = new
        else:
            setattr(obj, last, new)
    return bad


def convert(path, patches=None):
    with open(path, "rb") as f:
        vtbf = VTBF_Reader(f).load()
    patch = None
    if patches is not None:
        bad = apply_patches(vtbf, patches)
        patch = {"applied": len(patches) - len(bad), "failed": bad}
    root = vtbf.children[0]
    annotate(root, "$.children[0]")
    proj = kid(root, "PROJ")
    pp = props(proj)
    textures = []
    for tl in kids(proj, "TEXL"):
        for t in kids(tl, "TEX "):
            tp = props(t)
            textures.append({"name": tp.get(0x61, ""), "w": tp.get(0x40, 0), "h": tp.get(0x41, 0),
                             "crops": multi(kid(t, "CROP"), 0x65) if kid(t, "CROP") else []})
    scenes = []
    for s in kids(proj, "SCN "):
        sp = props(s)
        scenes.append({"name": sp.get(0x03, ""), "w": sp.get(0x40, 1920), "h": sp.get(0x41, 1080),
                       "bg": sp.get(0x04, "#000000FF"), "layers": [conv_layer(l) for l in kids(s, "LAYR")]})
    return {"name": pp.get(0x03, ""), "patch": patch, "fonts": [props(f).get(0x03, "") for f in kids(proj, "FONT")],
            "textures": textures, "scenes": scenes}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(HERE), **kw)

    def send_bytes(self, body, ctype, status=200):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        try:
            if url.path == "/api/list":
                files = sorted(str(p.relative_to(ROOT)) for p in ROOT.rglob("*.srd"))
                patched = [f for f in files if (pf := patch_file(f)) and pf.is_file()]
                return self.send_bytes(json.dumps({"files": files, "patched": patched, "translation": bool(TL_SRD),
                                                   "textures": bool(TL_TEX and TL_TEX.is_dir())}).encode(),
                                       "application/json")
            if url.path == "/api/patch":
                pf = patch_file(q["f"][0])
                if not pf or not pf.is_file():
                    return self.send_bytes(b"no patch", "text/plain", 404)
                return self.send_bytes(pf.read_bytes(), "application/json")
            if url.path == "/api/srd":
                return self.send_srd(q)
            if url.path == "/api/font":  # metrics json, or ?page=N for an atlas png
                name = Path(q["name"][0]).stem
                if name not in FONTS:
                    return self.send_bytes(b"not found", "text/plain", 404)
                FONTS[name].result()  # blocks until unpacked (first run only)
                if "page" in q:
                    return self.send_bytes((FONT_CACHE / name / f"page{int(q['page'][0])}.png").read_bytes(), "image/png")
                return self.send_bytes((FONT_CACHE / name / "font.json").read_bytes(), "application/json")
            if url.path == "/api/tex":
                png = texture_png(q["name"][0], q.get("tl") == ["1"])
                if png is None:
                    return self.send_bytes(b"not found", "text/plain", 404)
                return self.send_bytes(png, "image/png")
        except Exception as e:
            return self.send_bytes(f"{type(e).__name__}: {e}".encode(), "text/plain", 500)
        super().do_GET()

    def do_POST(self):
        """POST /api/srd?f=<file> with a patch list as the body: same as GET, with the patch applied."""
        url = urlparse(self.path)
        try:
            n = int(self.headers.get("Content-Length", 0))
            if url.path != "/api/srd" or n > 16 << 20:
                return self.send_bytes(b"bad request", "text/plain", 400)
            patches = json.loads(self.rfile.read(n))
            if not isinstance(patches, list):
                return self.send_bytes(b"patch must be a JSON list", "text/plain", 400)
            return self.send_srd(parse_qs(url.query), patches)
        except Exception as e:
            return self.send_bytes(f"{type(e).__name__}: {e}".encode(), "text/plain", 500)

    def do_PUT(self):
        """PUT /api/patch?f=<file> with a patch list: write it to the translation's src/srd/<file>.json."""
        url = urlparse(self.path)
        try:
            pf = patch_file(parse_qs(url.query)["f"][0]) if url.path == "/api/patch" else None
            n = int(self.headers.get("Content-Length", 0))
            if not pf or n > 16 << 20:
                return self.send_bytes(b"bad request (is --translation set?)", "text/plain", 400)
            patches = json.loads(self.rfile.read(n))
            if not isinstance(patches, list):
                return self.send_bytes(b"patch must be a JSON list", "text/plain", 400)
            save_patch(pf, patches)
            return self.send_bytes(b"saved", "text/plain")
        except Exception as e:
            return self.send_bytes(f"{type(e).__name__}: {e}".encode(), "text/plain", 500)

    def send_srd(self, q, patches=None):
        path = (ROOT / q["f"][0]).resolve()
        if ROOT.resolve() not in path.parents:  # no path traversal
            return self.send_bytes(b"forbidden", "text/plain", 403)
        return self.send_bytes(json.dumps(convert(path, patches)).encode(), "application/json")


@lru_cache(maxsize=None)
def dds_index():
    return {p.stem.lower(): p for p in ROOT.rglob("*.dds")}


def patch_file(rel):
    """Translation patch path for a surfboard-relative .srd path (None without --translation or if invalid)."""
    if not TL_SRD or not rel.endswith(".srd") or not (ROOT / rel).is_file():
        return None
    pf = (TL_SRD / rel).with_suffix(".json")
    return pf if TL_SRD.resolve() in pf.resolve().parents else None


def save_patch(pf, patches):
    """Write in the repo's format (json.dump indent=2, ensure_ascii=False, no trailing newline).
    JS sends whole floats as ints (-22 vs -22.0); every numeric field the editor writes is a Float, so restore that."""
    for e in patches:
        for k in ("value", "original"):
            if type(e.get(k)) is int:
                e[k] = float(e[k])
    pf.parent.mkdir(parents=True, exist_ok=True)
    tmp = pf.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(patches, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(pf)  # atomic: a crash never leaves a half-written patch


@lru_cache(maxsize=512)
def texture_png(name, translated=False):
    """PNG of a texture by name; translated=True prefers the --translation src/texture copy (like build.py)."""
    tl = TL_TEX / f"{Path(name).stem}.dds" if translated and TL_TEX else None
    path = tl if tl and tl.is_file() else dds_index().get(Path(name).stem.lower())
    if path is None:
        return None
    buf = io.BytesIO()
    Image.open(path).save(buf, "PNG", compress_level=1)
    return buf.getvalue()


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


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("surfboard", type=Path)
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--translation", type=Path, help="chutranslation version dir, e.g. chutranslation/SDHD_24000")
    args = ap.parse_args()
    ROOT, port = args.surfboard, args.port
    if args.translation:
        if not (args.translation / "src").is_dir():
            sys.exit(f"{args.translation}/src not found")
        TL_SRD, TL_TEX = args.translation / "src" / "srd", args.translation / "src" / "texture"
    pool = ProcessPoolExecutor()
    FONTS = {p.stem: pool.submit(unpack_font, p, FONT_CACHE / p.stem) for p in ROOT.parent.glob("*/font/*.rfz")}
    print(f"Serving {ROOT} on http://localhost:{port} ({len(FONTS)} fonts, translation: {args.translation or 'none'})")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
