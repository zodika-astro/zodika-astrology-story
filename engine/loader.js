// engine/loader.js
/**
 * Zodika Loader
 * - Detects project from URL (?project=foo)
 * - Loads and validates ./projects/<project>/manifest.json
 * - Resolves relative asset paths against manifest URL
 * - Preloads images with concurrency, retry and timeout
 * - Exposes small helpers for app bootstrap
 *
 * Usage (example in scripts/app.js):
 *   import { detectProjectFromURL, loadProject, getStageMount } from "../engine/loader.js";
 *   import { ZdkCore } from "../engine/core.js";
 *
 *   const project = detectProjectFromURL("demo");
 *   const { manifest } = await loadProject(project, { preload: "all", injectPreload: true, debug: false });
 *   const mount = getStageMount();
 *   const core = new ZdkCore({ mount, manifest, debug: false });
 *   core.start();
 */

const DEFAULTS = {
  preload: "all",        // "all" | "none"  (core also preloads ahead)
  concurrency: 4,
  retry: 2,
  timeoutMs: 12000,
  injectPreload: true,   // add <link rel="preload" as="image" href="...">
  debug: false
};

/* -------------------------------- Public API ------------------------------ */

/** Read ?project=<name> from the URL (fallback provided) */
export function detectProjectFromURL(fallback = "demo") {
  try {
    const q = new URLSearchParams(window.location.search);
    const p = (q.get("project") || "").trim();
    return p || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Build canonical URLs for a project's files
 * @param {string} project
 * @param {string} [baseHref] - defaults to current document base
 */
export function buildProjectPaths(project, baseHref) {
  const base = toURL(baseHref || document.baseURI || window.location.href);
  const dir = new URL(`projects/${encodeURIComponent(project)}/`, base).href;
  return {
    dir,
    manifest: new URL("manifest.json", dir).href,
    imagesDir: new URL("images/", dir).href
  };
}

/**
 * Load and prepare project
 * - fetch & parse manifest.json
 * - validate & normalize (resolve media.src to absolute)
 * - optionally preload all images and inject <link rel="preload">
 *
 * @param {string} project
 * @param {Object} opts
 * @param {"all"|"none"} [opts.preload="all"]
 * @param {number} [opts.concurrency=4]
 * @param {number} [opts.retry=2]
 * @param {number} [opts.timeoutMs=12000]
 * @param {boolean} [opts.injectPreload=true]
 * @param {boolean} [opts.debug=false]
 */
export async function loadProject(project, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const paths = buildProjectPaths(project);

  log(cfg, `[Loader] project="${project}" paths:`, paths);

  // 1) fetch & parse manifest
  const raw = await fetchJSON(paths.manifest, { retry: cfg.retry, timeoutMs: cfg.timeoutMs });
  if (!raw || !Array.isArray(raw.scenes)) {
    throw new Error(`Manifest missing 'scenes' array at ${paths.manifest}`);
  }

  // 2) normalize & resolve asset URLs
  const manifest = normalizeManifest(raw, paths.manifest);
  log(cfg, "[Loader] manifest normalized:", manifest);

  // 3) Collect image URLs
  const assetURLs = collectMediaURLs(manifest);
  log(cfg, `[Loader] assets (${assetURLs.length}):`, assetURLs);

  // 4) Inject <link rel="preload"> hints (optional)
  if (cfg.injectPreload && assetURLs.length) {
    injectPreloadLinks(assetURLs);
  }

  // 5) Preload images (optional, 'all')
  if (cfg.preload === "all" && assetURLs.length) {
    await preloadImages(assetURLs, { concurrency: cfg.concurrency, retry: cfg.retry, timeoutMs: cfg.timeoutMs, debug: cfg.debug });
  }

  return { manifest, assetURLs, paths };
}

/** Return the 9:16 mount element (.frame-916) or throw */
export function getStageMount(selector = ".frame-916") {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`Loader: mount element "${selector}" not found`);
  return el;
}

/** Convenience: create a very simple error overlay inside the frame */
export function showErrorOverlay(message, mount = getStageMount()) {
  const ov = document.createElement("div");
  ov.style.position = "absolute";
  ov.style.inset = "0";
  ov.style.background = "rgba(255,251,244,.96)";
  ov.style.display = "grid";
  ov.style.placeItems = "center";
  ov.style.padding = "24px";
  ov.style.zIndex = "999";
  ov.style.color = "#48252f";
  ov.style.fontFamily = 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
  ov.style.textAlign = "center";
  ov.innerHTML = `<div style="max-width:760px;">
    <h2 style="margin:0 0 8px;font-size:20px;letter-spacing:.2px;">Something went wrong</h2>
    <p style="margin:0;color:#857861;line-height:1.55;">${escapeHTML(String(message || "Unknown error"))}</p>
  </div>`;
  mount.appendChild(ov);
  return ov;
}

/* ------------------------------ Internals --------------------------------- */

/** Fetch JSON with retry + timeout */
async function fetchJSON(url, { retry = 1, timeoutMs = 10000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retry; attempt++) {
    try {
      const res = await fetchWithTimeout(url, { timeoutMs });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      await sleep(200 * attempt);
    }
  }
  throw lastErr || new Error(`Failed to fetch ${url}`);
}

function fetchWithTimeout(url, { timeoutMs = 10000, ...init } = {}) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(id));
}

/** Normalize manifest: clamp durations, resolve media.src relative to manifest URL */
function normalizeManifest(raw, manifestUrl) {
  const base = new URL(".", manifestUrl).href;
  const m = clone(raw);
  if (!Array.isArray(m.scenes)) m.scenes = [];
  m.scenes = m.scenes.map((s, i) => {
    const scene = { ...s };
    // duration
    scene.d = Math.max(0.1, Number(scene.d || 0));
    if (!scene.d || !isFinite(scene.d)) {
      throw new Error(`Manifest scene[${i}] requires positive duration 'd'`);
    }
    // media
    const media = scene.media || {};
    const src = String(media.src || "").trim();
    scene.media = {
      src: src ? new URL(src, base).href : "",
      credit: media.credit,
      kenburns: media.kenburns || "center"
    };
    // text & callouts normalize arrays
    if (!Array.isArray(scene.text)) scene.text = [];
    if (!Array.isArray(scene.callouts)) scene.callouts = [];
    // transitions defaults
    scene.transitionIn  = scene.transitionIn  || "crossfade";
    scene.transitionOut = scene.transitionOut || scene.transitionIn;
    return scene;
  });

  // preserve theme/duration hint if present
  m.theme = m.theme === "dark" ? "dark" : "light";
  m.duration = Number(m.duration) || sumDurations(m.scenes);
  return m;
}

/** Gather unique media URLs from manifest */
function collectMediaURLs(manifest) {
  const set = new Set();
  (manifest.scenes || []).forEach(s => {
    const u = s?.media?.src;
    if (u) set.add(u);
  });
  return Array.from(set);
}

/** Inject <link rel="preload" as="image"> for each URL (idempotent-ish) */
function injectPreloadLinks(urls = []) {
  const head = document.head || document.getElementsByTagName("head")[0];
  urls.forEach(u => {
    if (!u) return;
    if (head.querySelector(`link[rel="preload"][as="image"][href="${cssEscape(u)}"]`)) return;
    const link = document.createElement("link");
    link.rel = "preload";
    link.as = "image";
    link.href = u;
    head.appendChild(link);
  });
}

/**
 * Preload many images with concurrency and retry
 * @param {string[]} urls
 * @param {Object} opts
 * @param {number} [opts.concurrency=4]
 * @param {number} [opts.retry=2]
 * @param {number} [opts.timeoutMs=12000]
 * @param {boolean} [opts.debug=false]
 */
async function preloadImages(urls, { concurrency = 4, retry = 2, timeoutMs = 12000, debug = false } = {}) {
  const queue = [...urls];
  let active = 0;
  let resolved = 0;
  const total = queue.length;

  return new Promise((resolve) => {
    const next = () => {
      if (!queue.length && active === 0) return resolve(true);
      while (active < concurrency && queue.length) {
        const url = queue.shift();
        active++;
        preloadImage(url, { retry, timeoutMs })
          .catch((e) => log({ debug }, "[Loader] preload error:", url, e?.message || e))
          .finally(() => {
            active--;
            resolved++;
            if (debug) {
              // eslint-disable-next-line no-console
              console.info(`[Loader] preloaded ${resolved}/${total}`);
            }
            next();
          });
      }
    };
    next();
  });
}

/** Preload single image with retry + timeout */
async function preloadImage(url, { retry = 1, timeoutMs = 10000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retry; attempt++) {
    try {
      await decodeImage(url, timeoutMs);
      return true;
    } catch (err) {
      lastErr = err;
      await sleep(150 * attempt);
    }
  }
  throw lastErr || new Error(`Failed to preload ${url}`);
}

/** Efficient image decode pipeline with timeout */
function decodeImage(src, timeoutMs = 10000) {
  return new Promise((res, rej) => {
    const img = new Image();
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      rej(new Error("decode timeout"));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      img.onload = img.onerror = null;
    }

    img.decoding = "async";
    img.referrerPolicy = "no-referrer-when-downgrade";
    img.onload = () => {
      if (done) return;
      done = true;
      cleanup();
      // Attempt to force decode for smoother first paint if supported
      if (img.decode) {
        img.decode().then(() => res(true)).catch(() => res(true));
      } else {
        res(true);
      }
    };
    img.onerror = () => {
      if (done) return;
      done = true;
      cleanup();
      rej(new Error("image error"));
    };
    img.src = src;
  });
}

/* --------------------------------- Utils ---------------------------------- */

function toURL(href) {
  try { return new URL(href, window.location.href); }
  catch { return new URL(String(href), window.location.origin); }
}

function sumDurations(scenes) {
  return scenes.reduce((acc, s) => acc + (Number(s?.d) || 0), 0);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function clone(x) {
  if (typeof structuredClone === "function") return structuredClone(x);
  return JSON.parse(JSON.stringify(x));
}

function escapeHTML(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function cssEscape(s) {
  // minimal escape for attribute selectors; hrefs rarely need it
  return String(s).replace(/"/g, '\\"');
}

function log(cfg, ...args) {
  if (!cfg || !cfg.debug) return;
  // eslint-disable-next-line no-console
  console.info(...args);
}

/* ------------------------------ UMD Fallback ------------------------------ */
if (typeof window !== "undefined" && !window.ZdkLoader) {
  window.ZdkLoader = {
    detectProjectFromURL,
    buildProjectPaths,
    loadProject,
    getStageMount,
    showErrorOverlay
  };
}
