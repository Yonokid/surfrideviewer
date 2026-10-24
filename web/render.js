import { $, ctx, cv, fonts, images, state, texKey } from "./state.js";
import { setFrame } from "./scene.js";
import { mul, nodeStates, parseColor, roots } from "./anim.js";

export const tmp = document.createElement("canvas"),
    tctx = tmp.getContext("2d");

export const BLEND = { 1: "lighter", 2: "difference", 3: "multiply" };

export const EXT_BLEND = [
    "source-over",
    "source-over" /* dissolve */,
    "darken",
    "multiply",
    "color-burn",
    "multiply" /* linear burn */,
    "darken" /* darker colour */,
    "lighten",
    "screen",
    "color-dodge",
    "lighter" /* linear dodge (add) */,
    "lighten" /* lighter colour */,
    "overlay",
    "soft-light",
    "hard-light",
    "hard-light" /* vivid light */,
    "hard-light" /* linear light */,
    "hard-light" /* pin light */,
    "hard-light" /* hard mix */,
    "difference",
];

// ---------- drawing ----------
export function cropOf(cref) {
    if (!cref) return null;
    const tex = state.proj.textures[cref[0]],
        img = tex && images[texKey(tex.name)];
    const c = tex?.crops[cref[1]];
    if (!img?.complete || !img.naturalWidth || !c) return null;
    const kx = img.naturalWidth / tex.w,
        ky = img.naturalHeight / tex.h;
    return {
        img,
        sx: c[0] * kx,
        sy: c[1] * ky,
        sw: (c[2] - c[0]) * kx,
        sh: (c[3] - c[1]) * ky,
        w: c[2] - c[0],
        h: c[3] - c[1],
    };
}

export function drawCrop(cr, dx, dy, dw, dh, col, flags = 0) {
    if (!cr || dw === 0 || dh === 0) return;
    if (flags & 0x30) {
        ctx.save();
        ctx.translate(
            dx + (flags & 0x10 ? dw : 0),
            dy + (flags & 0x20 ? dh : 0),
        );
        ctx.scale(flags & 0x10 ? -1 : 1, flags & 0x20 ? -1 : 1);
        drawCrop(cr, 0, 0, dw, dh, col);
        ctx.restore();
        return;
    }
    ctx.globalAlpha = Math.max(0, Math.min(1, col[3]));
    if (col[0] > 0.99 && col[1] > 0.99 && col[2] > 0.99) {
        ctx.drawImage(cr.img, cr.sx, cr.sy, cr.sw, cr.sh, dx, dy, dw, dh);
        return;
    }
    const w = Math.max(1, Math.ceil(cr.sw)),
        h = Math.max(1, Math.ceil(cr.sh));
    tmp.width = w;
    tmp.height = h;
    tctx.globalCompositeOperation = "source-over";
    tctx.drawImage(cr.img, cr.sx, cr.sy, cr.sw, cr.sh, 0, 0, w, h);
    tctx.globalCompositeOperation = "multiply";
    tctx.fillStyle = `rgb(${col[0] * 255},${col[1] * 255},${col[2] * 255})`;
    tctx.fillRect(0, 0, w, h);
    tctx.globalCompositeOperation = "destination-in";
    tctx.drawImage(cr.img, cr.sx, cr.sy, cr.sw, cr.sh, 0, 0, w, h);
    ctx.drawImage(tmp, 0, 0, w, h, dx, dy, dw, dh);
}

// glyph = [advance, page, origin_x, origin_y, x1, y1, x2, y2]; atlas glyphs are white, tinted via source-in.
// Rendered strings are cached per font/text/align/colour; laying out glyphs every frame is too slow.
export function drawBitmapText(font, lines, tx, ty, align, ksx, ksy, col) {
    const pad = font.ascent,
        colour = rgba([...col.slice(0, 3), 1]),
        key = [lines.join("\n"), align, colour].join("\0");
    font.cache ??= new Map();
    let c = font.cache.get(key);
    if (!c) {
        if (font.cache.size > 500) font.cache.clear(); // crude bound (animated colours), LRU if it ever matters
        font.cache.set(key, (c = renderText(font, lines, align, colour)));
    }
    const ax = align === "center" ? c.maxW / 2 : align === "right" ? c.maxW : 0;
    ctx.drawImage(
        c.canvas,
        tx - (pad + ax) * ksx,
        ty - pad * ksy,
        c.canvas.width * ksx,
        c.canvas.height * ksy,
    );
}
export const BASELINE_SHIFT = 1;
export function renderText(font, lines, align, colour) {
    const lh = font.ascent + font.descent,
        pad = font.ascent,
        m = font.margin;
    const adv = (ch) => font.glyphs[ch.codePointAt(0)]?.[0] ?? lh / 2;
    const widths = lines.map((l) => [...l].reduce((a, ch) => a + adv(ch), 0)),
        maxW = Math.max(0, ...widths);
    const canvas = document.createElement("canvas"),
        tctx = canvas.getContext("2d");
    canvas.width = Math.ceil(maxW + pad * 2);
    canvas.height = lines.length * lh + pad * 2;
    lines.forEach((line, i) => {
        let x =
            pad +
            (align === "center"
                ? (maxW - widths[i]) / 2
                : align === "right"
                  ? maxW - widths[i]
                  : 0);
        // baseline = line top + ascent + margin: ascent excludes the glyph padding (margin) the boxes carry
        const base = pad + i * lh + font.ascent + BASELINE_SHIFT * m;
        for (const ch of line) {
            const g = font.glyphs[ch.codePointAt(0)];
            if (g && g[1] !== 65535)
                tctx.drawImage(
                    font.pages[g[1]],
                    g[4],
                    g[5],
                    g[6] - g[4],
                    g[7] - g[5],
                    x + g[2] - m,
                    base - g[3] - m,
                    g[6] - g[4],
                    g[7] - g[5],
                );
            x += adv(ch);
        }
    });
    tctx.globalCompositeOperation = "source-in";
    tctx.fillStyle = colour;
    tctx.fillRect(0, 0, canvas.width, canvas.height);
    return { canvas, maxW };
}

export const rgba = (c) =>
    `rgba(${c[0] * 255},${c[1] * 255},${c[2] * 255},${c[3]})`;

export function drawData(n, s, col, depth, m) {
    const d = n.data,
        w = s.w ?? 0,
        h = s.h ?? 0,
        [x0, y0] = pivot(n, s).map((v) => -v);

    // canvas has no subtract; 'difference' is the closest stand-in
    const ext = +(n.attrs?.ExtParamData?.blendMode || 0);
    ctx.globalCompositeOperation =
        (ext > 0 && EXT_BLEND[ext]) || BLEND[d.flags & 0xf] || "source-over";
    col = mul(col, s.vcol);
    if (d.kind === "CIMG") {
        if (d.text) {
            const fname = state.proj.fonts[d.text.font] || "",
                font = fonts[fname];
            const size =
                +fname.match(/(\d+)pt/)?.[1] ||
                +n.attrs?.FontParamData?.pointY ||
                24;
            const f = d.text.flags,
                lines = d.text.str
                    .replace(/\r/g, "")
                    .replace(/\n$/, "")
                    .split("\n");
            const align = f & 8 ? "right" : f & 4 ? "center" : "left";
            const [ksx, ksy] = d.text.scale,
                lh = (font ? font.ascent + font.descent : size * 1.2) * ksy;
            const tx =
                x0 + (align === "center" ? w / 2 : align === "right" ? w : 0);
            const ty = f & 2 ? y0 + (h - lines.length * lh) / 2 : y0;
            ctx.globalAlpha = Math.max(0, Math.min(1, col[3]));
            if (font?.pages.every((p) => p.complete && p.naturalWidth)) {
                drawBitmapText(font, lines, tx, ty, align, ksx, ksy, col);
            } else {
                // font still unpacking / missing: system font
                ctx.fillStyle = rgba([...col.slice(0, 3), 1]);
                ctx.font = `${size}px "Noto Sans CJK JP", sans-serif`;
                ctx.textAlign = align;
                ctx.textBaseline = "top";
                lines.forEach((line, i) => {
                    ctx.save();
                    ctx.translate(tx, ty + i * lh);
                    ctx.scale(ksx, ksy);
                    ctx.fillText(line, 0, 0);
                    ctx.restore();
                });
                ctx.textAlign = "left";
            }
        } else if (d.crefs.length) {
            drawCrop(
                cropOf(
                    d.crefs[Math.min(s.crop, d.crefs.length - 1)] || d.crefs[0],
                ),
                x0,
                y0,
                w,
                h,
                col,
                d.flags,
            );
        } else {
            // no texture: solid colour quad
            ctx.globalAlpha = Math.max(0, Math.min(1, col[3]));
            ctx.fillStyle = rgba([...col.slice(0, 3), 1]);
            ctx.fillRect(x0, y0, w, h);
        }
    } else if (d.kind === "CSLI") {
        // SLIC cell sizes: >0 = fixed pixels, 0 = stretch to fill the rest
        const cellAt = (ci, ri) => d.cells[ri * d.cols + ci] || {};
        const cell = (ci, ri) =>
            cropOf(d.crefs[cellAt(ci, ri).cref ?? ri * d.cols + ci]);
        const fill = (sizes, total) => {
            const fixed = sizes.reduce((a, b) => a + b, 0),
                n = sizes.filter((v) => !v).length;
            return sizes.map((v) => v || Math.max(0, total - fixed) / n);
        };
        const colW = [...Array(d.cols)].map((_, ci) => cellAt(ci, 0).w ?? 0);
        const rowH = [...Array(d.rows)].map((_, ri) => cellAt(0, ri).h ?? 0);
        const cw = fill(colW, w),
            rh = fill(rowH, h);
        let yy = y0;
        for (let ri = 0; ri < d.rows; ri++) {
            let xx = x0;
            for (let ci = 0; ci < d.cols; ci++) {
                drawCrop(
                    cell(ci, ri),
                    xx,
                    yy,
                    cw[ci],
                    rh[ri],
                    col,
                    cellAt(ci, ri).flags,
                );
                xx += cw[ci];
            }
            yy += rh[ri];
        }
    } else if (d.kind === "CNUM") {
        // left-aligned, digit glyphs = crefs[0..9]; real alignment/padding flags unknown
        const digits = String(Math.max(0, Math.round(s.value ?? 0)));
        const adv = (d.digitW || w) + d.spacing;
        [...digits].forEach((ch, i) =>
            drawCrop(
                cropOf(d.crefs[+ch]),
                x0 + i * adv,
                y0,
                d.digitW || w,
                d.digitH || h,
                col,
            ),
        );
    } else if (d.kind === "CRFD" && depth < 4) {
        const sc =
            state.proj.scenes.find((x) => x.name === d.scene) || state.scene;
        const l = sc.layers.find((x) => x.name === d.layer);
        if (l)
            drawLayer(
                l,
                d.anim || state.animName,
                state.frame,
                col,
                depth + 1,
                m,
            );
    }
    ctx.globalCompositeOperation = "source-over";
}

export const pivot = (n, s) => [
    n.data.px * (n.data.w ? (s.w ?? n.data.w) / n.data.w : 1),
    n.data.py * (n.data.h ? (s.h ?? n.data.h) / n.data.h : 1),
];
export const nodeMatrix = (parent, s) =>
    parent
        .translate(s.x, s.y, s.z)
        .rotate(-s.rx, s.ry, -s.rot)
        .scale(s.sx, s.sy, s.sz);

export function layerCentred(layer) {
    if (layer.flags & 1) return true;
    if (layer._centred !== undefined) return layer._centred;
    const st = nodeStates(layer, "", 0, null); // resting pose, no base animation
    let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
    const visit = (i, parent) => {
        for (; i >= 0 && i < layer.nodes.length; i = layer.nodes[i].sibling) {
            const n = layer.nodes[i],
                s = st[i];
            const m = nodeMatrix(parent, s);
            if (n.data)
                for (const [px, py] of [
                    [0, 0],
                    [s.w || 0, 0],
                    [0, s.h || 0],
                    [s.w || 0, s.h || 0],
                ]) {
                    const [ox, oy] = pivot(n, s),
                        p = m.transformPoint({ x: px - ox, y: py - oy });
                    x0 = Math.min(x0, p.x);
                    y0 = Math.min(y0, p.y);
                    x1 = Math.max(x1, p.x);
                    y1 = Math.max(y1, p.y);
                }
            if (n.child >= 0) visit(n.child, m);
        }
    };
    for (const r of roots(layer.nodes)) visit(r, new DOMMatrix());
    const cx = (x0 + x1) / 2,
        cy = (y0 + y1) / 2;
    return (layer._centred =
        isFinite(cx) &&
        Math.hypot(cx, cy) <
            Math.hypot(cx - state.scene.w / 2, cy - state.scene.h / 2));
}

let boxes = [];
export function drawLayer(
    layer,
    name,
    f,
    col,
    depth,
    base = ctx.getTransform(),
) {
    const end = layer.anims.find((a) => a.name === name)?.end ?? 0;
    const st = nodeStates(layer, name, end > 0 ? f % (end + 1) : f);
    // no perspective from the scene camera and no depth sorting; needs WebGL if those matter.
    const visit = (i, parent, inherited) => {
        for (; i >= 0 && i < layer.nodes.length; i = layer.nodes[i].sibling) {
            const n = layer.nodes[i],
                s = st[i];
            if (!s.display) continue;
            const m = nodeMatrix(parent, s);
            ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
            // colour (RGB and alpha) multiplies down to children, e.g. black C_error_*_txt parents make white text black
            const c = inherited.map((v, k) => v * s.color[k]);
            if (n.data) {
                drawData(n, s, c, depth, m);
                if ($("showbox").checked || n === state.selNode)
                    boxes.push({
                        m: ctx.getTransform(),
                        x: -pivot(n, s)[0],
                        y: -pivot(n, s)[1],
                        w: s.w,
                        h: s.h,
                        sel: n === state.selNode,
                    });
            }
            if (n.child >= 0) visit(n.child, m, c);
        }
    };
    for (const r of roots(layer.nodes)) visit(r, base, col);
    ctx.setTransform(base);
}

let last = performance.now();
export function tick(now) {
    if (state.playing && state.proj)
        setFrame(state.frame + ((now - last) * 60) / 1000);
    last = now;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (state.scene) {
        if ($("showbg").checked) {
            ctx.fillStyle = rgba(parseColor(state.scene.bg));
            ctx.fillRect(0, 0, cv.width, cv.height);
        }
        boxes = [];
        for (const li of [...state.visible].sort((a, b) => a - b)) {
            const l = state.scene.layers[li];
            const c =
                l.origin === "centre" || (l.origin !== "tl" && layerCentred(l));
            ctx.setTransform(
                1,
                0,
                0,
                1,
                c ? state.scene.w / 2 : 0,
                c ? state.scene.h / 2 : 0,
            );
            drawLayer(l, state.animName, state.frame, [1, 1, 1, 1], 0);
        }
        ctx.globalAlpha = 1;
        for (const b of boxes) {
            ctx.setTransform(b.m);
            ctx.strokeStyle = b.sel ? "#ff0" : "rgba(95,179,255,.6)";
            ctx.lineWidth = (b.sel ? 3 : 1) / Math.hypot(b.m.a, b.m.b);
            ctx.strokeRect(b.x, b.y, b.w, b.h);
        }
    }
    requestAnimationFrame(tick);
}
