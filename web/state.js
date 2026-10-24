export const $ = (id) => document.getElementById(id);
export const cv = $("cv"),
    ctx = cv.getContext("2d");

export const state = {
    proj: null,
    scene: null,
    visible: new Set(),
    animName: "",
    frame: 0,
    playing: true,
    selNode: null,
    current: null, // .srd path being viewed
    baseAnim: "auto",
    renderFiles: () => {},

    server: { translation: false, textures: false, patched: new Set() },
};
export const images = {}; // texKey(name) -> HTMLImageElement
export const fonts = {}; // .rfz name -> null while unpacking, then {ascent, descent, margin, glyphs, pages}
export const patches = new Map(); // .srd path -> {name, list, dirty}: imported/loaded patches incl. unsaved edits
export const useTlTex = () => server.textures && $("tltex").checked;
export const texKey = (name) => (useTlTex() ? "tl:" : "") + name;
