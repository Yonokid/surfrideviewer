import { $, images, patches, state, texKey, useTlTex } from "./state.js";
import { buildTree, selRef, select } from "./editor.js";
import { pickScene, refreshAnims, setFrame } from "./scene.js";

// ---------- loading & patches ----------
export function loadImages() {
    for (const t of state.proj.textures)
        if (!images[texKey(t.name)]) {
            const img = new Image();
            img.src =
                "/api/tex?name=" +
                encodeURIComponent(t.name) +
                (useTlTex() ? "&tl=1" : "");
            img.onerror = () => {
                $("status").textContent = `Missing texture: ${t.name}`;
            };
            images[texKey(t.name)] = img;
        }
}
$("tltex").onchange = () => state.proj && loadImages();
fetch("/api/list")
    .then((r) => r.json())
    .then(({ files, patched, translation, textures }) => {
        state.server = { translation, textures, patched: new Set(patched) };
        $("tltexRow").hidden = !textures;
        if (translation) {
            $("exportPatch").textContent = "Save";
            $("clearPatch").textContent = "Revert";
        }
        const render = () => {
            const f = $("filter").value.toLowerCase();
            $("files").replaceChildren(
                ...files
                    .filter((x) => x.toLowerCase().includes(f))
                    .map((x) => {
                        const d = document.createElement("div");
                        d.textContent = x.split("/").pop();
                        d.title = x;
                        d.classList.toggle(
                            "patched",
                            patches.has(x) || state.server.patched.has(x),
                        );
                        d.classList.toggle("sel", x === state.current);
                        d.onclick = () => {
                            document
                                .querySelectorAll("#files .sel")
                                .forEach((e) => e.classList.remove("sel"));
                            d.classList.add("sel");
                            load(x);
                        };
                        return d;
                    }),
            );
        };
        $("filter").oninput = render;
        render();
        state.renderFiles = render;
        if (location.hash.length > 1)
            load(decodeURIComponent(location.hash.slice(1)));
    });

export async function load(path, keepView = false) {
    $("status").textContent = "Loading " + path + "…";
    if (state.server.patched.has(path) && !patches.has(path)) {
        const r = await fetch("/api/patch?f=" + encodeURIComponent(path));
        if (r.ok)
            patches.set(path, {
                name: path
                    .split("/")
                    .pop()
                    .replace(/\.srd$/, ".json"),
                list: await r.json(),
            });
    }
    const patch = patches.get(path),
        usePatch = patch && $("patch").checked;
    const r = await fetch(
        "/api/srd?f=" + encodeURIComponent(path),
        usePatch
            ? { method: "POST", body: JSON.stringify(patch.list) }
            : undefined,
    );
    if (!r.ok) {
        $("status").textContent = await r.text();
        return;
    }
    const view = keepView && {
        scene: +$("scene").value,
        visible: state.visible,
        animName: state.animName,
        frame: state.frame,
        sel: selRef(),
    };
    state.proj = await r.json();
    state.current = path;
    history.replaceState(null, "", "#" + encodeURIComponent(path));
    loadImages();
    state.proj.fonts.forEach(loadFont);
    $("scene").replaceChildren(
        ...state.proj.scenes.map(
            (s, i) => new Option(`${s.name} (${s.layers.length})`, i),
        ),
    );
    pickScene(view ? view.scene : 0);
    if (view) {
        // patch toggled: keep the same view
        $("scene").value = view.scene;
        state.visible = view.visible;
        $("layers")
            .querySelectorAll("input[type=checkbox]")
            .forEach((cb, li) => (cb.checked = state.visible.has(li)));
        state.animName = view.animName;
        refreshAnims();
        buildTree();
        setFrame(view.frame);
    }
    select(view?.sel && state.scene.layers[view.sel[0]]?.nodes[view.sel[1]]);
    const p = state.proj.patch;
    lastFailed = p?.failed.length ?? 0;
    updatePatchUI();
    if (p?.failed.length) {
        $("info").textContent =
            "Failed patches:\n" +
            p.failed
                .map(
                    (f) =>
                        `${f.path}\n  ${f.error}\n  wanted: ${JSON.stringify(f.original)}`,
                )
                .join("\n");
        console.warn("failed patches", p.failed);
    }
    $("status").textContent =
        `${state.proj.name}: ${state.proj.scenes.length} scenes, ${state.proj.textures.length} textures`;
}
$("patch").onchange = () => state.current && load(state.current, true);
$("importPatch").onclick = () => $("patchFile").click();
$("patchFile").onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file || !state.current) return;
    if (
        patches.get(state.current)?.dirty &&
        !confirm(`Replace unsaved edits with ${file.name}?`)
    )
        return;
    try {
        const list = JSON.parse(await file.text());
        if (!Array.isArray(list))
            throw new Error("expected a JSON list of {path, value, original}");
        patches.set(state.current, { name: file.name, list });
    } catch (err) {
        $("status").textContent = `Can't import ${file.name}: ${err.message}`;
        return;
    }
    $("patch").checked = true;
    state.renderFiles();
    load(state.current, true);
};

$("clearPatch").onclick = () => {
    const patch = patches.get(state.current);
    if (patch?.dirty && !confirm(`Discard unsaved edits in ${patch.name}?`))
        return;
    patches.delete(state.current);
    state.renderFiles();
    load(state.current, true);
};

$("exportPatch").onclick = async () => {
    const patch = patches.get(state.current);
    if (state.server.translation) {
        const r = await fetch(
            "/api/patch?f=" + encodeURIComponent(state.current),
            { method: "PUT", body: JSON.stringify(patch.list) },
        );
        if (!r.ok) {
            $("status").textContent = `Save failed: ${await r.text()}`;
            return;
        }
        state.server.patched.add(state.current);
        $("status").textContent =
            `Saved ${patch.name} (${patch.list.length} entries)`;
    } else {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(
            new Blob([JSON.stringify(patch.list, null, 2)], {
                type: "application/json",
            }),
        );
        a.download = patch.name;
        a.click();
        URL.revokeObjectURL(a.href);
    }
    patch.dirty = false;
    state.renderFiles();
    updatePatchUI();
};
addEventListener("beforeunload", (e) => {
    if ([...patches.values()].some((p) => p.dirty)) e.preventDefault();
});

let lastFailed = 0;
export function updatePatchUI() {
    const patch = patches.get(state.current),
        on = patch && $("patch").checked;
    $("importPatch").disabled = !state.current;
    $("clearPatch").disabled =
        $("exportPatch").disabled =
        $("patch").disabled =
            !patch;
    $("patchinfo").textContent = !patch
        ? ""
        : `${patch.name}: ${patch.list.length} entries` +
          (!on ? " (off)" : lastFailed ? `, ${lastFailed} failed` : "") +
          (patch.dirty ? " • unsaved" : "");
}

export function loadFont(name) {
    if (name in fonts) return;
    fonts[name] = null;
    const q = "/api/font?name=" + encodeURIComponent(name);
    fetch(q)
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((f) => {
            const n =
                1 +
                Math.max(
                    0,
                    ...Object.values(f.glyphs)
                        .map((g) => g[1])
                        .filter((p) => p !== 65535),
                );
            f.pages = [...Array(n)].map((_, i) =>
                Object.assign(new Image(), { src: `${q}&page=${i}` }),
            );
            fonts[name] = f;
        })
        .catch((e) => {
            $("status").textContent =
                `Font ${name} unavailable (${e}), using system font`;
        });
}
