// scripts/app.js
import { detectProjectFromURL, loadProject, getStageMount, showErrorOverlay } from "../engine/loader.js";
import { ZdkCore } from "../engine/core.js";
import { applyTheme } from "../engine/presets.js";

async function bootstrap() {
  const params = new URLSearchParams(window.location.search);

  const project   = detectProjectFromURL("demo");
  const debug     = isTrue(params.get("debug"));
  const loop      = isTrue(params.get("loop"));     // optional replay
  const preload   = params.get("preload") || "all"; // "all" | "none"
  const themeQ    = params.get("theme");            // "light" | "dark" | null
  const delay     = Math.max(0, Number(params.get("delay") || 0)) * 1000;

  try {
    const mount = getStageMount();

    // Optional FX overlays (enabled by default; disable with ?grain=0&vignette=0)
    if (params.get("grain") !== "0") {
      const grain = document.createElement("div");
      grain.className = "fx-grain";
      mount.appendChild(grain);
    }
    if (params.get("vignette") !== "0") {
      const vignette = document.createElement("div");
      vignette.className = "fx-vignette";
      mount.appendChild(vignette);
    }

    // Load project + assets
    const { manifest } = await loadProject(project, {
      preload,
      injectPreload: true,
      concurrency: 4,
      retry: 2,
      timeoutMs: 12000,
      debug
    });

    // Theme override via URL
    const chosenTheme = themeQ === "dark" ? "dark" : themeQ === "light" ? "light" : manifest.theme;
    const finalManifest = applyTheme(manifest, chosenTheme);

    // Wait for fonts (to avoid reflow mid-capture)
    if (document.fonts && document.fonts.ready) {
      try { await document.fonts.ready; } catch {}
    }

    // Optional start delay (seconds)
    if (delay) await sleep(delay);

    // Start playback
    let core = new ZdkCore({ mount, manifest: finalManifest, debug });
    core.start();

    // Optional loop (useful for repeated takes)
    if (loop) {
      const total = calcTotalDuration(finalManifest);
      scheduleLoop(total, () => {
        core.stop(true);
        core = new ZdkCore({ mount, manifest: finalManifest, debug });
        core.start();
        scheduleLoop(total, arguments.callee); // reschedule
      });
    }

    // Expose for quick console pokes
    window.__zdk = { core, manifest: finalManifest, project, debug };
  } catch (err) {
    console.error(err);
    const mount = document.querySelector(".frame-916") || document.body;
    showErrorOverlay(err?.message || String(err), mount);
  }
}

/* ----------------------------- helpers ----------------------------------- */

function isTrue(v) {
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function calcTotalDuration(manifest) {
  const scenes = manifest?.scenes || [];
  let end = 0;
  for (let i = 0; i < scenes.length; i++) {
    const t = Number(scenes[i].t ?? end);
    const d = Number(scenes[i].d || 0);
    end = Math.max(end, t + d);
  }
  return end;
}

function scheduleLoop(totalSeconds, cb) {
  // small grace so the last frame breathes before restarting
  const ms = Math.max(0, (totalSeconds + 0.8) * 1000);
  setTimeout(cb, ms);
}

document.addEventListener("DOMContentLoaded", bootstrap);
