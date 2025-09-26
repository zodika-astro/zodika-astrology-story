// engine/core.js
/**
 * Zodika Timeline Core (vanilla)
 * - Plays a continuous documentary-like sequence (no UI)
 * - Data-driven via manifest object (passed from app.js)
 * - Renders a 9:16 stage with layers and applies CSS effect classes
 *
 * Manifest schema (simplified):
 * {
 *   duration: 45.0,                 // total target duration in seconds (advisory)
 *   theme: "light" | "dark",        // optional; adds .theme--dark on <html>
 *   scenes: [
 *     {
 *       // If "t" omitted, start time is previous.t + previous.d (auto-chaining)
 *       t: 0.0,                     // start time (s)
 *       d: 6.0,                     // duration (s)
 *       media: {
 *         src: "projects/demo/images/01.webp",
 *         credit: "arquivo pessoal",
 *         kenburns: "center|left|right|up|down|slow|strong"
 *       },
 *       text: [
 *         { role: "title",   html: "investivibe <span class='highlight'>astrológica</span>", at: 0.4, effects: ["fx-fade-up","fx-underline"] },
 *         { role: "lead",    html: "revelar relações, não pirotecnia.", at: 1.0, effects: ["fx-fade-up"] },
 *         { role: "caption", html: "mapa como pista", at: 4.8, effects: ["fx-fade"] }
 *       ],
 *       callouts: [
 *         { html: "detalhe relevante", at: 2.0, x: 0.18, y: 0.78 } // x,y as % of frame (0..1). Horizontal line for now.
 *       ],
 *       transitionIn:  "crossfade|swipe|zoom|light-wipe",
 *       transitionOut: "crossfade|swipe|zoom"
 *     }
 *   ]
 * }
 */

export class ZdkCore {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.mount - Element that contains the 9:16 frame (.frame-916)
   * @param {Object} options.manifest - Timeline manifest (see schema above)
   * @param {boolean} [options.debug=false] - Logs and safe guides
   */
  constructor({ mount, manifest, debug = false } = {}) {
    if (!mount) throw new Error("ZdkCore: 'mount' element is required");
    if (!manifest || !Array.isArray(manifest.scenes)) {
      throw new Error("ZdkCore: 'manifest.scenes' is required");
    }
    this.mount = mount;
    this.manifest = this.#normalizeManifest(manifest);
    this.debug = debug;

    // layers
    this.layers = {
      bg: this.#ensureLayer("layer--bg"),
      media: this.#ensureLayer("layer--media"),
      text: this.#ensureLayer("layer--text"),
      fx: this.#ensureLayer("layer--fx")
    };
    this.safeArea = this.#ensureSafeArea();

    // playback state
    this._raf = null;
    this._t0 = 0;
    this._now = 0;
    this._running = false;

    // scene bookkeeping
    this._activeIndex = -1;
    this._sceneNodes = new Map(); // index -> DOM node container
    this._firedText = new Set();  // "sceneIndex#textIdx"
    this._firedCallout = new Set();

    // theme
    if (this.manifest.theme === "dark") {
      document.documentElement.classList.add("theme--dark");
    }

    // Debug helpers
    if (this.debug) {
      this.mount.classList.add("debug-safe");
      // eslint-disable-next-line no-console
      console.info("[ZdkCore] Manifest:", this.manifest);
    }
  }

  /** Public: start playback (from 0) */
  async start() {
    // preload first + next scene media
    await this.#preloadAhead(0);

    this._running = true;
    this._t0 = performance.now();
    this._now = 0;
    this._activeIndex = -1;
    this._firedText.clear();
    this._firedCallout.clear();

    const loop = (ts) => {
      if (!this._running) return;
      this._now = (ts - this._t0) / 1000;

      // Determine active scene by time
      const idx = this.#findSceneIndexAt(this._now);
      if (idx !== this._activeIndex) {
        this.#onSceneChange(this._activeIndex, idx);
        this._activeIndex = idx;
      }

      // Within-scene scheduled reveals (text/callouts)
      if (idx >= 0) {
        this.#tickScene(idx, this._now);
      }

      // Stop when past last scene (plus a tiny grace)
      const last = this.manifest.scenes[this.manifest.scenes.length - 1];
      if (this._now > last.t + last.d + 0.25) {
        this.stop(true);
        return;
      }

      this._raf = requestAnimationFrame(loop);
    };

    this._raf = requestAnimationFrame(loop);
    document.body.classList.add("recording-mode"); // helps screen recording
  }

  /** Public: stop playback; optionally flush to final frame */
  stop(toEnd = false) {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._running = false;
    document.body.classList.remove("recording-mode");

    if (toEnd) {
      // Force finalize: show last scene in steady state
      const lastIdx = this.manifest.scenes.length - 1;
      this.#ensureSceneMounted(lastIdx, true);
    }
  }

  /** Compute continuous 't' if missing and clamp invalid values */
  #normalizeManifest(manifest) {
    const m = structuredClone(manifest);
    let cursor = 0;
    m.scenes.forEach((s, i) => {
      if (typeof s.d !== "number" || s.d <= 0) {
        throw new Error(`Manifest: scene[${i}] missing positive duration 'd'`);
      }
      if (typeof s.t !== "number") {
        s.t = cursor;
      }
      cursor = s.t + s.d;
    });
    return m;
  }

  /** Create or get a layer inside mount */
  #ensureLayer(className) {
    let el = this.mount.querySelector(`.${className}`);
    if (!el) {
      el = document.createElement("div");
      el.className = `layer ${className}`;
      this.mount.appendChild(el);
    }
    return el;
  }

  /** Ensure .safe-area exists (used for text/captions when helpful) */
  #ensureSafeArea() {
    let el = this.mount.querySelector(".safe-area");
    if (!el) {
      el = document.createElement("div");
      el.className = "safe-area";
      this.mount.appendChild(el);
    }
    return el;
  }

  /** Return index of scene active at time t (sec) or -1 if none */
  #findSceneIndexAt(t) {
    const arr = this.manifest.scenes;
    for (let i = 0; i < arr.length; i++) {
      const s = arr[i];
      if (t >= s.t && t < s.t + s.d) return i;
    }
    return -1;
  }

  /** Scene change handler: exit previous, enter next, preload next-next */
  async #onSceneChange(prevIdx, nextIdx) {
    if (this.debug) console.info("[ZdkCore] Scene change:", prevIdx, "→", nextIdx);

    // Exit previous
    if (prevIdx >= 0) {
      this.#exitScene(prevIdx);
    }

    // Enter next
    if (nextIdx >= 0) {
      await this.#ensureSceneMounted(nextIdx);
      this.#enterScene(nextIdx);
      // Preload next scene ahead
      this.#preloadAhead(nextIdx + 1);
    }
  }

  /** Create DOM for a given scene if not mounted yet */
  async #ensureSceneMounted(index, finalize = false) {
    if (this._sceneNodes.has(index)) return this._sceneNodes.get(index);

    const scene = this.manifest.scenes[index];

    // CONTAINER: keeps all elements for the scene (media + text + callouts)
    const container = document.createElement("div");
    container.className = "scene";
    container.style.position = "absolute";
    container.style.inset = "0";
    container.style.pointerEvents = "none"; // no UI
    container.dataset.index = String(index);

    // MEDIA
    const media = document.createElement("figure");
    media.className = "photo";
    const img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    img.loading = "eager";
    img.src = scene.media?.src || "";
    media.appendChild(img);

    if (scene.media?.credit) {
      const cred = document.createElement("figcaption");
      cred.className = "credit";
      cred.textContent = scene.media.credit;
      media.appendChild(cred);
    }

    // TEXT & CAPTIONS
    const textLayer = document.createElement("div");
    textLayer.className = "text-layer";
    textLayer.style.position = "absolute";
    textLayer.style.inset = "var(--safe-top) var(--pad) var(--safe-bottom) var(--pad)";

    const textNodes = [];
    if (Array.isArray(scene.text)) {
      scene.text.forEach((block, i) => {
        const el = this.#elForRole(block.role);
        el.innerHTML = block.html || "";
        // effects (enter reveals will be toggled later by timeline)
        this.#applyEffects(el, block.effects);
        el.style.opacity = "0"; // start hidden until "is-in"
        textLayer.appendChild(el);
        textNodes.push({ el, at: block.at ?? 0, role: block.role, idx: i });
      });
    }

    // CALLOUTS
    const calloutNodes = [];
    if (Array.isArray(scene.callouts)) {
      scene.callouts.forEach((c, i) => {
        const wrap = document.createElement("div");
        wrap.className = "callout";
        // position as % relative to frame
        const px = Math.max(0, Math.min(1, Number(c.x ?? 0.1)));
        const py = Math.max(0, Math.min(1, Number(c.y ?? 0.85)));
        wrap.style.left = `${px * 100}%`;
        wrap.style.top = `${py * 100}%`;
        wrap.style.transform = "translate(-0%, -0%)"; // anchor top-left; tweak if needed

        const line = document.createElement("div");
        line.className = "callout__line";

        const bubble = document.createElement("div");
        bubble.className = "callout__bubble";
        bubble.innerHTML = c.html || "";

        wrap.appendChild(line);
        wrap.appendChild(bubble);

        // start hidden (no .is-in)
        container.appendChild(wrap);
        calloutNodes.push({ el: wrap, at: c.at ?? 0, idx: i });
      });
    }

    // append media last so it sits under text by z-index order (CSS layers handle too)
    container.appendChild(media);
    container.appendChild(textLayer);

    // initial Ken Burns (applied at enter)
    if (scene.media?.kenburns) {
      img.dataset.kb = scene.media.kenburns; // read on enter
    }

    // stash
    this.layers.media.appendChild(container);
    this._sceneNodes.set(index, {
      container,
      mediaEl: media,
      imgEl: img,
      textNodes,
      calloutNodes
    });

    // If finalize flag set (stop-to-end), reveal all without transitions
    if (finalize) {
      textNodes.forEach(({ el }) => {
        el.style.opacity = "1";
        el.classList.add("is-in");
      });
      calloutNodes.forEach(({ el }) => el.classList.add("is-in"));
    }

    // ensure image loaded before entering (best-effort)
    await this.#waitImage(img);
    return this._sceneNodes.get(index);
  }

  /** Enter animations for a scene */
  #enterScene(index) {
    const scene = this.manifest.scenes[index];
    const node = this._sceneNodes.get(index);
    if (!node) return;

    // Reset fired sets for this scene
    node.textNodes.forEach(({ idx }) => this._firedText.delete(`${index}#${idx}`));
    node.calloutNodes.forEach(({ idx }) => this._firedCallout.delete(`${index}#${idx}`));

    // Transition IN
    this.#applyTransition(node.container, scene.transitionIn, true);

    // Ken Burns on image
    const kb = node.imgEl.dataset.kb || "center";
    this.#applyKenBurns(node.imgEl, kb, scene.d);

    // Make sure everything starts hidden (effects.css will reveal on .is-in)
    node.textNodes.forEach(({ el }) => {
      // Keep layout steady for titles; opacity managed by CSS effect classes
      el.classList.remove("is-in");
    });
    node.calloutNodes.forEach(({ el }) => el.classList.remove("is-in"));
  }

  /** Exit animations for a scene (and schedule removal) */
  #exitScene(index) {
    const scene = this.manifest.scenes[index];
    const node = this._sceneNodes.get(index);
    if (!node) return;

    this.#applyTransition(node.container, scene.transitionOut || scene.transitionIn, false);

    // Remove after transition ends (fallback timeout)
    const timeout = 900; // matches fx-dur-3 default
    setTimeout(() => {
      if (node.container?.parentNode) {
        node.container.parentNode.removeChild(node.container);
      }
      this._sceneNodes.delete(index);
    }, timeout);
  }

  /** Per-frame scheduler: reveal text/callouts at offsets within the active scene */
  #tickScene(index, now) {
    const s = this.manifest.scenes[index];
    const tLocal = now - s.t;

    const node = this._sceneNodes.get(index);
    if (!node) return;

    // text
    node.textNodes.forEach(({ el, at, idx }) => {
      const key = `${index}#${idx}`;
      if (!this._firedText.has(key) && tLocal >= at) {
        el.classList.add("is-in"); // triggers effect reveal
        el.style.opacity = "";     // let CSS handle it
        this._firedText.add(key);
      }
    });

    // callouts
    node.calloutNodes.forEach(({ el, at, idx }) => {
      const key = `${index}#c${idx}`;
      if (!this._firedCallout.has(key) && tLocal >= at) {
        el.classList.add("is-in");
        this._firedCallout.add(key);
      }
    });
  }

  /* ---------------------------- helpers ---------------------------------- */

  #elForRole(role = "body") {
    switch (role) {
      case "title":   return this.#el("h1", "title fx-fade-up");
      case "subtitle":return this.#el("h2", "subtitle fx-fade-up");
      case "lead":    return this.#el("p",  "lead fx-fade-up");
      case "caption": return this.#el("div","caption fx-fade");
      case "body":
      default:        return this.#el("p",  "body fx-fade");
    }
  }

  #el(tag, className) {
    const el = document.createElement(tag);
    el.className = className;
    return el;
  }

  #applyEffects(el, effects = []) {
    if (!Array.isArray(effects)) return;
    effects.forEach(cls => el.classList.add(cls));
  }

  #applyKenBurns(img, preset = "center", durSec = 6) {
    // Remove previous kb classes
    img.classList.remove("kb-slow","kb-center","kb-left","kb-right","kb-up","kb-down","kb-strong");
    // Map presets to classes
    const map = {
      slow: "kb-slow",
      center: "kb-center",
      left: "kb-left",
      right: "kb-right",
      up: "kb-up",
      down: "kb-down"
    };
    const cls = map[preset] || "kb-center";
    img.classList.add(cls);
    // Strong variant
    if (/strong/.test(preset)) img.classList.add("kb-strong");
    // Adjust duration via inline style for this run (matches scene length)
    img.style.animationDuration = `${Math.max(3, durSec)}s`;
  }

  #applyTransition(container, kind = "crossfade", isEnter = true) {
    // Clear previous transition classes
    container.classList.remove(
      "fx-crossfade-enter","fx-crossfade-exit",
      "fx-swipe-enter","fx-swipe-exit",
      "fx-zoom-in","fx-zoom-out",
      "fx-light-wipe"
    );
    switch (kind) {
      case "swipe":
        container.style.setProperty("--dir", "1");
        container.classList.add(isEnter ? "fx-swipe-enter" : "fx-swipe-exit");
        break;
      case "zoom":
        container.classList.add(isEnter ? "fx-zoom-in" : "fx-zoom-out");
        break;
      case "light-wipe":
        if (isEnter) container.classList.add("fx-light-wipe");
        else container.classList.add("fx-crossfade-exit");
        break;
      case "crossfade":
      default:
        container.classList.add(isEnter ? "fx-crossfade-enter" : "fx-crossfade-exit");
    }
  }

  async #preloadAhead(startIndex) {
    const urls = [];
    for (let i = startIndex; i < Math.min(startIndex + 2, this.manifest.scenes.length); i++) {
      const u = this.manifest.scenes[i]?.media?.src;
      if (u) urls.push(u);
    }
    await Promise.all(urls.map(u => this.#preloadImage(u).catch(() => null)));
  }

  #preloadImage(src) {
    return new Promise((res, rej) => {
      const i = new Image();
      i.decoding = "async";
      i.onload = () => res(true);
      i.onerror = rej;
      i.src = src;
    });
  }

  #waitImage(imgEl) {
    if (imgEl.complete && imgEl.naturalWidth > 0) return Promise.resolve(true);
    return new Promise((res) => {
      imgEl.addEventListener("load", () => res(true), { once: true });
      imgEl.addEventListener("error", () => res(false), { once: true });
    });
  }
}

/* UMD-style fallback (optional): exposes ZdkCore on window when not using ES modules) */
if (typeof window !== "undefined" && !window.ZdkCore) {
  window.ZdkCore = ZdkCore;
}
