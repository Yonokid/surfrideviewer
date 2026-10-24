import { $, cv, state } from "./state.js";
import { buildTree } from "./editor.js";
import { layerCentred } from "./render.js";

export function pickScene(i) {
    state.scene = state.proj.scenes[i];
    cv.width = state.scene.w;
    cv.height = state.scene.h;
    fit();
    state.visible = new Set(state.scene.layers.length ? [0] : []);
    $("layers").replaceChildren(
        ...state.scene.layers.map((l, li) => {
            const row = document.createElement("div"),
                lab = document.createElement("label");
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = state.visible.has(li);
            cb.onchange = () => {
                cb.checked ? state.visible.add(li) : state.visible.delete(li);
                refreshAnims();
                buildTree();
            };
            lab.append(cb, " " + l.name + " ");
            lab.title = l.name;
            const s = document.createElement("span");
            s.className = "tag";
            s.textContent = l.nodes.length;
            lab.append(s);
            const origin = document.createElement("select");
            origin.title =
                "Layer origin. Auto centres layers the game positions at runtime.";
            origin.append(
                new Option(
                    `Auto (${layerCentred(l) ? "centre" : "top-left"})`,
                    "auto",
                ),
                new Option("Top-left", "tl"),
                new Option("Centre", "centre"),
            );
            origin.value = l.origin || "auto";
            origin.onchange = () => {
                l.origin = origin.value;
            };
            row.append(lab, origin);
            return row;
        }),
    );
    refreshAnims();
    buildTree();
}
$("scene").onchange = (e) => pickScene(+e.target.value);

export function refreshAnims() {
    const names = new Set();
    for (const li of state.visible)
        for (const a of state.scene.layers[li].anims) names.add(a.name);
    const opts = [
        new Option("(none)", ""),
        ...[...names].map((n) => new Option(n, n)),
    ];
    $("anim").replaceChildren(...opts);
    if (!names.has(state.animName)) {
        // default to the first animation that actually moves something
        const all = [...state.visible].flatMap(
            (li) => state.scene.layers[li].anims,
        );
        state.animName =
            (all.find((a) => a.motions.length) || all[0])?.name || "";
    }
    $("anim").value = state.animName;
    $("baseAnim").replaceChildren(
        new Option("Auto (A_in…)", "auto"),
        new Option("(none)", ""),
        ...[...names].map((n) => new Option(n, n)),
    );
    $("baseAnim").value =
        state.baseAnim === "auto" || names.has(state.baseAnim)
            ? state.baseAnim
            : "auto";
    setFrame(0);
}
$("anim").onchange = (e) => {
    state.animName = e.target.value;
    setFrame(0);
};
$("baseAnim").onchange = (e) => {
    state.baseAnim = e.target.value;
};

export function maxEnd() {
    let m = 0;
    for (const li of state.visible)
        for (const a of state.scene.layers[li].anims)
            if (a.name === state.animName) m = Math.max(m, a.end);
    return m;
}
export function setFrame(f) {
    const end = maxEnd();
    state.frame = end > 0 ? f % (end + 1) : 0;
    $("frame").max = end;
    $("frame").value = Math.floor(state.frame);
    $("flabel").textContent = `${Math.floor(state.frame)} / ${end}`;
}
$("frame").oninput = (e) => {
    state.playing = false;
    $("play").textContent = "▶";
    setFrame(+e.target.value);
};
$("play").onclick = () => {
    state.playing = !state.playing;
    $("play").textContent = state.playing ? "⏸" : "▶";
};

export function fit() {
    const st = $("stage"),
        k = Math.min(st.clientWidth / cv.width, st.clientHeight / cv.height, 1);
    cv.style.width = cv.width * k + "px";
    cv.style.height = cv.height * k + "px";
}
addEventListener("resize", fit);
