import { $, patches, state } from "./state.js";
import { updatePatchUI } from "./api.js";
import { roots, walk } from "./anim.js";

// Editable values; node.edit[key] holds the JSONPath the server found for each one.
export const FIELDS = {
    x: { label: "X", get: (n) => n.pos[0], set: (n, v) => (n.pos[0] = v) },
    y: { label: "Y", get: (n) => n.pos[1], set: (n, v) => (n.pos[1] = v) },
    w: { label: "Width", get: (n) => n.data.w, set: (n, v) => (n.data.w = v) },
    h: { label: "Height", get: (n) => n.data.h, set: (n, v) => (n.data.h = v) },
    text: {
        label: "Text",
        get: (n) => n.data.text.str,
        set: (n, v) => (n.data.text.str = v),
    },
};
export const TRACK_OF = { x: 0, y: 1, w: 11, h: 12 };
let lockAspect = false; // "Keep aspect ratio" in the editor; remembered across selections

export function selRef() {
    const li = state.scene?.layers.findIndex((l) =>
        l.nodes.includes(state.selNode),
    );
    return li >= 0
        ? [li, state.scene.layers[li].nodes.indexOf(state.selNode)]
        : null;
}

// Record an edit as a patch entry (original = the game's value), and apply it to the model for instant preview.
export function edit(n, key, value) {
    let patch = patches.get(state.current);
    if (!patch)
        patches.set(
            state.current,
            (patch = {
                name: state.current
                    .split("/")
                    .pop()
                    .replace(/\.srd$/, ".json"),
                list: [],
            }),
        );
    const path = n.edit[key],
        i = patch.list.findIndex((e) => e.path === path);
    const original = i >= 0 ? patch.list[i].original : FIELDS[key].get(n);
    if (value === original) {
        if (i >= 0) patch.list.splice(i, 1);
    } else if (i >= 0) patch.list[i].value = value;
    else patch.list.push({ path, value, original });
    FIELDS[key].set(n, value);
    patch.dirty = true;
    state.renderFiles();
    updatePatchUI();
    return value !== original;
}

export function select(n) {
    state.selNode = n || null;
    document
        .querySelectorAll("#tree .sel")
        .forEach((e) => e.classList.remove("sel"));
    if (n)
        $("tree")
            .querySelector(`[data-sel="${selRef().join(":")}"]`)
            ?.classList.add("sel");
    const ed = $("editor");
    ed.replaceChildren();
    $("info").textContent = n
        ? JSON.stringify({ ...n, flags: "0x" + n.flags.toString(16) }, null, 1)
        : "";
    if (!n) return;
    const patch = patches.get(state.current),
        locked = patch && !$("patch").checked;
    const keys = Object.keys(FIELDS).filter((k) => n.edit?.[k]);
    if (!keys.length) {
        ed.append(note("Nothing editable on this node."));
        return;
    }
    if (locked) ed.append(note("Turn Apply on to edit."));
    // Keep aspect: editing Width/Height scales the other by the ratio they had when the lock was turned on
    const inputs = {};
    let ratio = n.data && n.data.w ? n.data.h / n.data.w : 0;
    const linked = { w: ["h", (v) => v * ratio], h: ["w", (v) => v / ratio] };
    for (const k of keys) {
        const f = FIELDS[k],
            entry = patch?.list.find((e) => e.path === n.edit[k]);
        const input = document.createElement(
            k === "text" ? "textarea" : "input",
        );
        if (k === "text") input.value = f.get(n).replace(/\r\n/g, "\n");
        else {
            input.type = "number";
            input.step = 1;
            input.value = +f.get(n).toFixed(3);
        }
        input.disabled = locked;
        input.classList.toggle("changed", !!entry);
        input.title = entry
            ? `original: ${JSON.stringify(entry.original)}`
            : "";
        input.oninput = () => {
            let v;
            if (k === "text") {
                // the game uses \r\n line breaks
                const orig = entry?.original ?? f.get(n);
                v = /\r\n/.test(orig)
                    ? input.value.replace(/\r?\n/g, "\r\n")
                    : input.value;
            } else {
                if (input.value === "" || isNaN(+input.value)) return;
                v = +input.value;
            }
            input.classList.toggle("changed", edit(n, k, v));
            const [other, scale] = linked[k] || [];
            if (other && lockAspect && ratio && inputs[other]) {
                const ov = Math.round(scale(v) * 1000) / 1000;
                inputs[other].value = ov;
                inputs[other].classList.toggle("changed", edit(n, other, ov));
            }
        };
        inputs[k] = input;
        const lab = document.createElement("label");
        lab.textContent = f.label;
        ed.append(lab, input);
        if (k === "h" && inputs.w) {
            const lock = Object.assign(document.createElement("input"), {
                type: "checkbox",
                checked: lockAspect,
                disabled: locked || !ratio,
            });
            lock.onchange = () => {
                lockAspect = lock.checked;
                ratio = n.data.w ? n.data.h / n.data.w : 0;
            };
            const row = document.createElement("label");
            row.className = "note";
            row.append(lock, " Keep aspect ratio");
            ed.append(row);
        }
    }
    const li = state.scene.layers.findIndex((l) => l.nodes.includes(n)),
        ci = state.scene.layers[li].nodes.indexOf(n);
    const anim = state.scene.layers[li].anims.find(
        (a) => a.name === state.animName,
    );
    const animated = keys.filter((k) =>
        anim?.motions.some(
            (m) =>
                m.cast === ci && m.tracks.some((t) => t.type === TRACK_OF[k]),
        ),
    );
    if (animated.length)
        ed.append(
            note(
                `${animated.map((k) => FIELDS[k].label).join(", ")} animated by ${state.animName}; pick (none) to see the base value.`,
            ),
        );
}
export const note = (t) =>
    Object.assign(document.createElement("div"), {
        className: "note",
        textContent: t,
    });

// ---------- node tree panel ----------
export const KIND = { 0: "", 1: "img", 2: "slice", 3: "ref", 4: "num" };
export function buildTree() {
    const out = [];
    for (const li of state.visible) {
        const l = state.scene.layers[li];
        const h = document.createElement("div");
        h.textContent = "▣ " + l.name;
        h.style.color = "var(--acc)";
        out.push(h);
        for (const r of roots(l.nodes))
            walk(l.nodes, r, 1, (i, d) => {
                const n = l.nodes[i],
                    el = document.createElement("div");
                el.style.paddingLeft = d * 12 + "px";
                el.textContent =
                    n.name +
                    (KIND[n.flags & 15]
                        ? "  [" + KIND[n.flags & 15] + "]"
                        : "");
                el.dataset.sel = `${li}:${i}`;
                el.onclick = () => select(n);
                out.push(el);
            });
    }
    $("tree").replaceChildren(...out);
}
