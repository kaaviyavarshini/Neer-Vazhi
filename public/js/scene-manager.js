/**
 * web/js/scene-manager.js
 * Drives the 5-scene narrative.
 * Scene 0 – Google 3D Map (baseline)
 * Scene 1 – Elevation slab (10× exaggerated, teal→yellow)
 * Scene 2 – Rain drops falling & rolling
 * Scene 3 – Water pooling in depressions
 * Scene 4 – Flood depth draped on 3D city
 */

import { uiSetScene } from './ui.js';

const TRANSITION_MS = 1800;

export class SceneManager {
  constructor(viewer, cfg, googleTileset, elevLayer, rainSim, floodLayer, onStats) {
    this._v         = viewer;
    this._cfg       = cfg;
    this._tiles     = googleTileset;
    this._elev      = elevLayer;
    this._rain      = rainSim;
    this._flood     = floodLayer;
    this._onStats   = onStats;
    this._current   = -1;
    this._statsTimer = null;

    // Expose globally so ui.js can call goTo
    window.__sceneManager = this;
  }

  async goTo(idx) {
    if (idx === this._current) return;
    await this._teardown(this._current);
    this._current = idx;
    uiSetScene(idx);
    await this._setup(idx);
  }

  // ── Teardown previous scene ──────────────────────────────────────────────
  async _teardown(idx) {
    if (idx < 0) return;
    clearInterval(this._statsTimer);
    switch (idx) {
      case 1: this._elev.hide();  break;
      case 2: this._rain.stop();  break;
      case 3: this._rain.stop(); this._flood.hide(); break;
      case 4: this._flood.hide(); break;
    }
    // Show google tiles on all scenes
    if (this._tiles) this._tiles.show = true;
  }

  // ── Setup incoming scene ─────────────────────────────────────────────────
  async _setup(idx) {
    const cfg = this._cfg;

    switch (idx) {

      // ── Scene 0: Google Photorealistic 3D ────────────────────────────────
      case 0: {
        this._flyTo(cfg.cesium_camera, 3000);
        this._onStats({ rain: '—', particles: '—', depth: '—' });
        break;
      }

      // ── Scene 1: Elevation slab rises 10× ────────────────────────────────
      case 1: {
        // Hide tiles so coloured DEM stands alone
        if (this._tiles) this._tiles.show = false;
        this._flyTo({ ...cfg.cesium_camera, height: 12000, pitch: -45 }, 3000);
        await this._elev.show();
        this._onStats({ rain: '—', particles: '—', depth: '—' });
        break;
      }

      // ── Scene 2: Rain drops falling ───────────────────────────────────────
      case 2: {
        if (this._tiles) this._tiles.show = true;
        this._flyTo({ ...cfg.cesium_camera, height: 6000, pitch: -30 }, 2000);
        this._rain.start(this._v);
        this._startStats(() => ({
          rain:      this._rain.totalMm.toFixed(1) + ' mm',
          particles: this._rain.activeCount,
          depth:     '—',
        }));
        break;
      }

      // ── Scene 3: Water pools in depressions ──────────────────────────────
      case 3: {
        if (this._tiles) this._tiles.show = true;
        this._flyTo({ ...cfg.cesium_camera, height: 5000, pitch: -40 }, 2000);
        this._rain.start(this._v);
        this._flood.showPooling();
        this._startStats(() => ({
          rain:      this._rain.totalMm.toFixed(1) + ' mm',
          particles: this._rain.activeCount,
          depth:     this._flood.maxDepthM.toFixed(2) + ' m',
        }));
        break;
      }

      // ── Scene 4: Flood depth draped on 3D city ───────────────────────────
      case 4: {
        if (this._tiles) this._tiles.show = true;
        this._flyTo({ ...cfg.cesium_camera, height: 5500, pitch: -35 }, 2500);
        this._flood.showDraped();
        this._startStats(() => ({
          rain:      '72 mm (Nov 2021 ref.)',
          particles: '—',
          depth:     this._flood.maxDepthM.toFixed(2) + ' m',
        }));
        break;
      }
    }
  }

  // ── Camera helper ─────────────────────────────────────────────────────────
  _flyTo(cam, duration = TRANSITION_MS) {
    this._v.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        cam.lon ?? this._cfg.cesium_camera.lon,
        cam.lat ?? this._cfg.cesium_camera.lat,
        cam.height,
      ),
      orientation: {
        heading: Cesium.Math.toRadians(cam.heading ?? 0),
        pitch:   Cesium.Math.toRadians(cam.pitch   ?? -35),
        roll:    0,
      },
      duration: duration / 1000,
    });
  }

  // ── Stats polling ─────────────────────────────────────────────────────────
  _startStats(fn) {
    clearInterval(this._statsTimer);
    this._statsTimer = setInterval(() => this._onStats(fn()), 500);
  }
}
