// engine/presets.js
/**
 * Zodika Presets — helpers to build scenes & manifests for ZdkCore
 * - semantic presets for effects, transitions, ken burns, callouts
 * - factories return objects matching ZdkCore manifest schema
 *
 * Usage (example in app.js):
 *   import { buildManifest, makeSceneDocPhotoTitleCallout, TRANSITIONS } from "./engine/presets.js";
 *   const scenes = [
 *     makeSceneDocPhotoTitleCallout({
 *       d: 6,
 *       media: { src: "projects/demo/images/01.webp", credit: "arquivo pessoal", kenburns: KB.center },
 *       title: "investivibe <span class='highlight fx-underline'>astrológica</span>",
 *       lead: "revelar relações, não pirotecnia.",
 *       callout: { html: "mapa natal como pista", at: 2.0, anchor: "lower-left" },
 *       transitionIn: TRANSITIONS.doc.crossfade,
 *       transitionOut: TRANSITIONS.doc.crossfade
 *     }),
 *     // ... outras cenas
 *   ];
 *   const manifest = buildManifest({ durationHint: 45, theme: "light", scenes });
 */

export const EFFECTS = {
  title: ["fx-fade-up", "fx-underline"],
  subtitle: ["fx-fade-up"],
  lead: ["fx-fade-up"],
  body: ["fx-fade"],
  caption: ["fx-fade"]
};

export const KB = {
  center: "center",
  left: "left",
  right: "right",
  up: "up",
  down: "down",
  slow: "slow",         // slower zoom
  strong: "center strong" // combine for stronger zoom
};

export const TRANSITIONS = {
  doc: {
    crossfade: "crossfade",
    zoom: "zoom"
  },
  social: {
    swipe: "swipe",
    lightWipe: "light-wipe"
  }
};

/** Named anchors for callouts → normalized (x,y) in [0..1] */
export const CALLOUT_ANCHORS = {
  "lower-left":  { x: 0.12, y: 0.86 },
  "lower-right": { x: 0.88, y: 0.86 },
  "upper-left":  { x: 0.12, y: 0.18 },
  "upper-right": { x: 0.88, y: 0.18 },
  "mid-left":    { x: 0.12, y: 0.50 },
  "mid-right":   { x: 0.88, y: 0.50 },
  "center":      { x: 0.50, y: 0.50 }
};

/* -------------------------------- factories -------------------------------- */

/**
 * Create a text block (role: title|subtitle|lead|body|caption)
 * @param {Object} p
 * @param {"title"|"subtitle"|"lead"|"body"|"caption"} p.role
 * @param {string} p.html
 * @param {number} [p.at=0] - seconds after scene start
 * @param {string[]} [p.effects] - CSS classes from effects.css
 */
export function makeText({ role = "body", html = "", at = 0, effects } = {}) {
  return {
    role,
    html,
    at,
    effects: Array.isArray(effects) && effects.length ? effects : EFFECTS[role] || EFFECTS.body
  };
}

/**
 * Create a callout (documentary pointer)
 * @param {Object} p
 * @param {string} p.html
 * @param {number} [p.at=0.8]
 * @param {{x:number,y:number}|string} [p.anchor="lower-left"] - normalized or named anchor
 */
export function makeCallout({ html = "", at = 0.8, anchor = "lower-left" } = {}) {
  const pos = resolveAnchor(anchor);
  return { html, at, x: pos.x, y: pos.y };
}

/**
 * Scene: Photo + Title + (optional) Lead + one Callout
 * @param {Object} p
 * @param {number} p.d - duration (seconds)
 * @param {Object} p.media - { src, credit?, kenburns? }
 * @param {string} p.title
 * @param {string} [p.lead]
 * @param {Object} [p.callout] - { html, at?, anchor? }
 * @param {string} [p.transitionIn]
 * @param {string} [p.transitionOut]
 * @param {number} [p.t] - optional start time (usually omit; core auto-chains)
 */
export function makeSceneDocPhotoTitleCallout(p = {}) {
  const {
    d, media, title, lead, callout,
    transitionIn = TRANSITIONS.doc.crossfade,
    transitionOut = TRANSITIONS.doc.crossfade,
    t
  } = p;

  const text = [ makeText({ role: "title", html: title, at: 0.4 }) ];
  if (lead) text.push(makeText({ role: "lead", html: lead, at: 1.0 }));

  const callouts = [];
  if (callout?.html) callouts.push(makeCallout(callout));

  return sanitizeScene({
    t, d,
    media: { src: media?.src || "", credit: media?.credit, kenburns: media?.kenburns || KB.center },
    text,
    callouts,
    transitionIn, transitionOut
  });
}

/**
 * Scene: Photo + two sequential Callouts (no title required)
 * @param {Object} p
 * @param {number} p.d
 * @param {Object} p.media
 * @param {string} [p.subtitle]
 * @param {Object[]} p.callouts - array of { html, at?, anchor? }
 * @param {string} [p.transitionIn]
 * @param {string} [p.transitionOut]
 * @param {number} [p.t]
 */
export function makeSceneDocPhoto2Callouts(p = {}) {
  const {
    d, media, subtitle, callouts = [],
    transitionIn = TRANSITIONS.social.swipe,
    transitionOut = TRANSITIONS.doc.crossfade,
    t
  } = p;

  const text = [];
  if (subtitle) text.push(makeText({ role: "subtitle", html: subtitle, at: 0.4 }));

  const calloutNodes = callouts
    .filter(c => c && c.html)
    .map((c, i) => makeCallout({ ...c, at: c.at ?? (0.9 + i * 1.2) }));

  return sanitizeScene({
    t, d,
    media: { src: media?.src || "", credit: media?.credit, kenburns: media?.kenburns || KB.left },
    text,
    callouts: calloutNodes,
    transitionIn, transitionOut
  });
}

/**
 * Scene: Closing statement (title or lead) + optional caption
 * @param {Object} p
 * @param {number} p.d
 * @param {Object} p.media
 * @param {string} [p.title]
 * @param {string} [p.lead]
 * @param {string} [p.caption]
 * @param {string} [p.transitionIn]
 * @param {string} [p.transitionOut]
 * @param {number} [p.t]
 */
export function makeSceneClosing(p = {}) {
  const {
    d, media, title, lead, caption,
    transitionIn = TRANSITIONS.doc.zoom,
    transitionOut = TRANSITIONS.doc.crossfade,
    t
  } = p;

  const text = [];
  if (title) text.push(makeText({ role: "title", html: title, at: 0.5 }));
  if (lead)  text.push(makeText({ role: "lead",  html: lead,  at: 1.1 }));
  if (caption) text.push(makeText({ role: "caption", html: caption, at: Math.max(1.6, d - 1.4) }));

  return sanitizeScene({
    t, d,
    media: { src: media?.src || "", credit: media?.credit, kenburns: media?.kenburns || KB.slow },
    text,
    callouts: [],
    transitionIn, transitionOut
  });
}

/* ----------------------------- manifest helpers --------------------------- */

/**
 * Build a manifest; core will auto-chain 't' if omitted.
 * @param {Object} p
 * @param {"light"|"dark"} [p.theme="light"]
 * @param {number} [p.durationHint] - optional note (not enforced)
 * @param {Array<Object>} p.scenes
 */
export function buildManifest({ theme = "light", durationHint, scenes = [] } = {}) {
  return {
    theme,
    duration: Number(durationHint) || sumDurations(scenes),
    scenes
  };
}

/** Apply theme to manifest (returns new object) */
export function applyTheme(manifest, theme = "light") {
  const m = clone(manifest);
  m.theme = theme;
  return m;
}

/**
 * Wrap keywords in a string with underline effect
 * Example: underlineKeywords("caminho aparece", ["caminho"]) →
 *          " <span class='fx-underline'>caminho</span> aparece"
 */
export function underlineKeywords(html, keywords = []) {
  if (!html || !Array.isArray(keywords) || keywords.length === 0) return html;
  let out = html;
  keywords.forEach(k => {
    if (!k) return;
    const re = new RegExp(`(${escapeRegExp(k)})`, "gi");
    out = out.replace(re, "<span class=\"fx-underline\">$1</span>");
  });
  return out;
}

/* -------------------------------- internals -------------------------------- */

function resolveAnchor(anchor) {
  if (typeof anchor === "string" && CALLOUT_ANCHORS[anchor]) return CALLOUT_ANCHORS[anchor];
  if (anchor && typeof anchor.x === "number" && typeof anchor.y === "number") {
    return {
      x: clamp01(anchor.x),
      y: clamp01(anchor.y)
    };
  }
  return CALLOUT_ANCHORS["lower-left"];
}

function sanitizeScene(s) {
  const d = Number(s.d);
  if (!d || d <= 0) throw new Error("Scene requires positive duration 'd'");
  const media = s.media || {};
  return {
    t: typeof s.t === "number" ? s.t : undefined,
    d,
    media: {
      src: media.src || "",
      credit: media.credit,
      kenburns: media.kenburns || KB.center
    },
    text: Array.isArray(s.text) ? s.text : [],
    callouts: Array.isArray(s.callouts) ? s.callouts : [],
    transitionIn: s.transitionIn || TRANSITIONS.doc.crossfade,
    transitionOut: s.transitionOut || s.transitionIn || TRANSITIONS.doc.crossfade
  };
}

function sumDurations(scenes) {
  return scenes.reduce((acc, s) => acc + (Number(s?.d) || 0), 0);
}

function clamp01(n) { return Math.max(0, Math.min(1, Number(n))); }

function clone(x) {
  if (typeof structuredClone === "function") return structuredClone(x);
  return JSON.parse(JSON.stringify(x));
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* UMD fallback */
if (typeof window !== "undefined") {
  window.ZdkPresets = {
    EFFECTS, KB, TRANSITIONS, CALLOUT_ANCHORS,
    makeText, makeCallout,
    makeSceneDocPhotoTitleCallout,
    makeSceneDocPhoto2Callouts,
    makeSceneClosing,
    buildManifest, applyTheme, underlineKeywords
  };
}
