import { state } from "./state.js";

export function roots(nodes) {
    const reached = new Set();
    nodes.forEach((n) => {
        if (n.child >= 0) reached.add(n.child);
        if (n.sibling >= 0) reached.add(n.sibling);
    });
    return nodes.map((_, i) => i).filter((i) => !reached.has(i));
}
export function walk(nodes, start, depth, fn) {
    // visit node, its children, then its siblings
    for (let i = start; i >= 0 && i < nodes.length; i = nodes[i].sibling) {
        fn(i, depth);
        if (nodes[i].child >= 0) walk(nodes, nodes[i].child, depth + 1, fn);
    }
}

// ---------- animation ----------
export function evalTrack(keys, f) {
    if (!keys.length) return undefined;
    if (f <= keys[0][0]) return keys[0][1];
    for (let i = 0; i < keys.length - 1; i++) {
        const [f0, v0, interp, , out0] = keys[i],
            [f1, v1, , in1] = keys[i + 1];
        if (f >= f1) continue;
        if (interp === 0 || typeof v0 === "boolean") return v0;
        const h = f1 - f0,
            s = (f - f0) / h;
        if (typeof v0 === "string") return lerpColor(v0, v1, s);
        if (interp === 2) {
            // hermite, tangents are slopes per frame
            const s2 = s * s,
                s3 = s2 * s;
            return (
                (2 * s3 - 3 * s2 + 1) * v0 +
                (s3 - 2 * s2 + s) * h * out0 +
                (-2 * s3 + 3 * s2) * v1 +
                (s3 - s2) * h * in1
            );
        }
        return v0 + (v1 - v0) * s;
    }
    return keys[keys.length - 1][1];
}

export const parseColor = (c) =>
    [1, 3, 5, 7].map((i) => parseInt(c.substr(i, 2), 16) / 255); // #RRGGBBAA -> [r,g,b,a]
export const lerpColor = (a, b, s) => {
    const A = parseColor(a),
        B = parseColor(b);
    return (
        "#" +
        A.map((v, i) =>
            Math.round((v + (B[i] - v) * s) * 255)
                .toString(16)
                .padStart(2, "0"),
        )
            .join("")
            .toUpperCase()
    );
};
export const mul = (a, b) => a.map((v, i) => v * b[i]);

// Apply animated tracks of the layer's current animation to a copy of each node's state.
export function nodeStates(layer, name, f, base = resolveBase(layer, name)) {
    const st = layer.nodes.map((n) => ({
        x: n.pos[0],
        y: n.pos[1],
        z: n.pos[2],
        rx: n.rot[0],
        ry: n.rot[1],
        rot: n.rot[2],
        sx: n.scale[0],
        sy: n.scale[1],
        sz: n.scale[2],
        display: n.display,
        color: parseColor(n.color),
        w: n.data?.w,
        h: n.data?.h,
        vcol: n.data?.vcol?.[0] ? parseColor(n.data.vcol[0]) : [1, 1, 1, 1],
        crop: 0,
        value: n.data?.value,
    }));
    if (base) applyAnim(st, base, base.end); // tracks of the playing animation override it below
    const anim = layer.anims.find((a) => a.name === name);
    if (anim) applyAnim(st, anim, f);
    return st;
}

export function applyAnim(st, anim, f) {
    for (const m of anim.motions) {
        const s = st[m.cast];
        if (!s) continue;
        const tracks = [...m.tracks].sort(
            (a, b) => (a.type === 21) - (b.type === 21),
        );
        for (const t of tracks) {
            const v = evalTrack(t.keys, f);
            if (v === undefined) continue;
            switch (t.type) {
                case 0:
                    s.x = v;
                    break;
                case 1:
                    s.y = v;
                    break;
                case 2:
                    s.z = v;
                    break;
                case 3:
                    s.rx = v;
                    break;
                case 4:
                    s.ry = v;
                    break;
                case 5:
                    s.rot = v;
                    break;
                case 6:
                    s.sx = v;
                    break;
                case 7:
                    s.sy = v;
                    break;
                case 8:
                    s.sz = v;
                    break;
                case 9:
                    s.color = parseColor(v);
                    break;
                case 10:
                    s.display = !!v;
                    break;
                case 11:
                    s.w = v;
                    break;
                case 12:
                    s.h = v;
                    break;
                case 13:
                    s.vcol = parseColor(v);
                    break; // only top-left vertex colour, no per-vertex gradients
                case 17:
                    s.crop = v;
                    break;
                case 21:
                    s.color[3] = v;
                    break; // material alpha
                case 23:
                    s.value = v;
                    break; // number value (guessed)
            }
        }
    }
}

// The base-pose animation for a layer: chosen by name, or 'auto' = its intro (A_in, else the first A_in…).
export function resolveBase(layer, name) {
    const b =
        state.baseAnim === "auto"
            ? layer.anims.find((a) => a.name === "A_in") ||
              layer.anims.find((a) => /^A_in/i.test(a.name))
            : layer.anims.find((a) => a.name === state.baseAnim);
    return b && b.name !== name ? b : null;
}
