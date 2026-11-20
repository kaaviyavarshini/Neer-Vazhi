/**
 * web/js/main.js
 * Narrative controller, dynamic rain inspector, and interactive viewer for OMR Floods.
 *
 * Features:
 * 1. Compact control panel at top-right:
 *    - Preset dropdown loaded from web/data/rain.json
 *    - Rainfall slider (0 to 500 mm) with live value label
 *    - Hourly precipitation bar chart with animated playhead during REPLAY / time-step playhead
 *    - Live road flood km stat badge and depth legend
 * 2. Real-time updates (<1s):
 *    - Changing rain or preset re-runs pooling in Web Worker and updates
 *      the draped water layer, flooded road colors, and km stat within ~70ms.
 * 3. 7-Step cinematic REPLAY timeline:
 *    - Word-by-word kinetic captions at bottom
 *    - Smooth camera orbits and fly-downs with quadratic easing
 *    - REPLAY button restarts from step 1
 *    - Esc key skips to end
 * 4. Time-stepping model (MODE toggle: STATIC ↔ TIME-STEP):
 *    - Runs flow.worker.js, streams hourly depth snapshots
 *    - Time slider + play/pause button ("Hour 0 … N")
 *    - Rain chart playhead tracks current hour
 *    - Roads and water layers update each hour
 */

import {
  createViewer,
  addBoundingBoxOutline,
  animateBoundingBoxOutline,
  flyToStudyArea,
} from './viewer.js';
import {
  initTerrain,
  showFlat,
  show as showTerrain,
  hide as hideTerrain,
  tweenExaggeration,
  setExaggeration,
  isVisible as isTerrainVisible,
} from './terrain.js';
import {
  initRain,
  start as startRain,
  stop as stopRain,
  isRainRunning,
} from './rain.js';
import {
  initPooling,
  showPooling,
  hidePooling,
} from './pooling.js';
import { initValidation, refreshValidation, toggleValidation } from './validation.js';
import {
  initRoads,
  showRealMapScene,
  updateRainfall,
  toggleWaterLayer,
  toggleRoadsLayer,
  clearDrapedLayers,
  isWaterVisible,
  isRoadsVisible,
} from './roads.js';

let viewer = null;
let bbox = { south: 12.890, west: 80.190, north: 12.990, east: 80.270 };
let studyCentre = { lat: 12.940, lon: 80.230 };
let activeOutlineEntity = null;

// Rain presets & simulation state
let rainPresets = {};
let currentPresetKey = 'michaung_2023';
let currentRainfallMm = 150;
let runoffCoeff = 0.8;
let updateDebounceTimer = null;

// ── Time-step mode ─────────────────────────────────────────────────────────
// 'static' = Priority-Flood (default), 'timestep' = flow.worker.js
let simMode = 'static';
let loadedAreaConfig = null;

// Snapshots received from flow.worker.js — one Float32Array per kept hour
let flowSnapshots = [];
let flowHourCount = 0;
let currentHour = 0;
let flowWorker = null;
let flowWorkerBusy = false;

// Play state
let playIntervalId = null;
let playSpeedMs = 1000; // ms per hour in playback

// Timeline engine state
let currentTimelineId = 0;
let isTimelineRunning = false;
let activeTimers = [];
let chartPlayheadAnimId = null;
let playheadFraction = 0.0;

function showErrorMessage(msg) {
  let errBox = document.getElementById('scene-error-banner');
  if (!errBox) {
    errBox = document.createElement('div');
    errBox.id = 'scene-error-banner';
    errBox.style.cssText = `
      position: absolute;
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 1000;
      background: rgba(185, 28, 28, 0.95);
      border: 1px solid #ef4444;
      color: #fff;
      padding: 12px 20px;
      border-radius: 6px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      max-width: 600px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.6);
    `;
    document.body.appendChild(errBox);
  }
  errBox.textContent = msg;
}

/**
 * Centred cinematic caption with word-by-word reveal.
 */
function setCaption(text, durationMs) {
  clearCaption();
  const container = document.getElementById('timeline-caption');
  if (!container) return;

  const wrapper = document.createElement('div');
  wrapper.className = 'caption-text';

  const words = text.trim().split(/\s+/);
  const wordSpans = words.map((w) => {
    const span = document.createElement('span');
    span.className = 'caption-word';
    span.textContent = w;
    wrapper.appendChild(span);
    return span;
  });

  container.appendChild(wrapper);

  const revealDuration = Math.min(durationMs * 0.55, words.length * 240);
  const wordInterval = revealDuration / Math.max(words.length, 1);

  wordSpans.forEach((span, idx) => {
    const timer = setTimeout(() => {
      span.classList.add('visible');
    }, Math.round(idx * wordInterval));
    activeTimers.push(timer);
  });
}

function clearCaption() {
  for (const t of activeTimers) clearTimeout(t);
  activeTimers = [];
  const container = document.getElementById('timeline-caption');
  if (container) container.innerHTML = '';
}

/**
 * Updates live telemetry badge.
 */
function updateStatsBadge(stats) {
  refreshValidation(); // re-score the reality-check rings against the new water depth
  const statRoadKm = document.getElementById('stat-road-km');
  if (statRoadKm && stats?.floodedRoadKm !== undefined) {
    statRoadKm.textContent = `${stats.floodedRoadKm} km`;
  }
}

/**
 * Renders the hourly rain bar chart on canvas with an optional playhead.
 */
function drawRainChart(presetKey, playhead = null) {
  const canvas = document.getElementById('rain-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);

  const preset = rainPresets[presetKey];
  if (!preset || !preset.mm || preset.mm.length === 0) return;

  const mm = preset.mm;
  const n = mm.length;
  let maxMm = 0;
  for (let i = 0; i < n; i++) {
    if (mm[i] > maxMm) maxMm = mm[i];
  }
  maxMm = Math.max(maxMm, 1.0);

  // Update peak label
  const peakLabel = document.getElementById('chart-peak-info');
  if (peakLabel) {
    peakLabel.textContent = `Peak: ${maxMm.toFixed(1)} mm/h`;
  }

  // Draw background subtle baseline
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h - 1);
  ctx.lineTo(w, h - 1);
  ctx.stroke();

  // Draw hourly bars
  const barWidth = Math.max(1, w / n);
  for (let i = 0; i < n; i++) {
    const barH = (mm[i] / maxMm) * (h - 6);
    const x = (i / n) * w;
    const y = h - barH;

    const t = mm[i] / maxMm;
    if (t > 0.6) {
      ctx.fillStyle = '#00e5ff';
    } else if (t > 0.2) {
      ctx.fillStyle = '#00b0ff';
    } else {
      ctx.fillStyle = 'rgba(0, 176, 255, 0.45)';
    }

    ctx.fillRect(x, y, Math.max(1, barWidth - 0.5), barH);
  }

  // Draw vertical playhead line during REPLAY
  if (playhead !== null && playhead >= 0.0 && playhead <= 1.0) {
    const px = Math.min(Math.max(playhead * w, 1), w - 1);

    ctx.save();
    ctx.strokeStyle = '#00e5ff';
    ctx.lineWidth = 2.0;
    ctx.shadowColor = '#00e5ff';
    ctx.shadowBlur = 8;

    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(px, 3, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

/**
 * Starts continuous chart playhead animation linked to timeline progress.
 */
function startChartPlayhead(totalDurationMs) {
  stopChartPlayhead();
  const startTime = performance.now();

  function step(now) {
    const elapsed = now - startTime;
    playheadFraction = Math.min(elapsed / totalDurationMs, 1.0);
    drawRainChart(currentPresetKey, playheadFraction);

    if (playheadFraction < 1.0 && isTimelineRunning) {
      chartPlayheadAnimId = requestAnimationFrame(step);
    } else {
      drawRainChart(currentPresetKey, 1.0);
    }
  }

  chartPlayheadAnimId = requestAnimationFrame(step);
}

function stopChartPlayhead() {
  if (chartPlayheadAnimId) {
    cancelAnimationFrame(chartPlayheadAnimId);
    chartPlayheadAnimId = null;
  }
  playheadFraction = 1.0;
  drawRainChart(currentPresetKey, null);
}

/**
 * Defines the 7-step REPLAY timeline.
 */
function getTimelineSteps() {
  const targetCenter = Cesium.Cartesian3.fromDegrees(studyCentre.lon, studyCentre.lat, 0);

  return [
    // ── Step 1: Slow orbit over Google 3D city & Pallikaranai Marsh ──
    {
      caption: 'Old Mahabalipuram Road and Pallikaranai Marsh, Chennai.',
      durationMs: 4500,
      run: async () => {
        stopRain();
        hidePooling();
        hideTerrain();
        clearDrapedLayers();
        if (activeOutlineEntity) {
          viewer.entities.remove(activeOutlineEntity);
          activeOutlineEntity = null;
        }

        viewer.camera.flyToBoundingSphere(
          new Cesium.BoundingSphere(targetCenter, 800.0),
          {
            offset: new Cesium.HeadingPitchRange(
              Cesium.Math.toRadians(35.0),
              Cesium.Math.toRadians(-34.0),
              7500.0
            ),
            duration: 4.2,
            easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
          }
        );
      },
    },

    // ── Step 2: The white outline draws itself ──────────────────────
    {
      caption: 'This box is our study area: OMR corridor and Pallikaranai basin.',
      durationMs: 3800,
      run: async () => {
        if (activeOutlineEntity) {
          viewer.entities.remove(activeOutlineEntity);
        }
        activeOutlineEntity = animateBoundingBoxOutline(viewer, bbox, 2600);

        viewer.camera.flyToBoundingSphere(
          new Cesium.BoundingSphere(targetCenter, 800.0),
          {
            offset: new Cesium.HeadingPitchRange(
              Cesium.Math.toRadians(25.0),
              Cesium.Math.toRadians(-35.0),
              7000.0
            ),
            duration: 3.5,
            easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
          }
        );
      },
    },

    // ── Step 3: Flat slab fades in ──────────────────────────────────
    {
      caption: "Underneath is the land's real shape, mapped from space by radar.",
      durationMs: 4000,
      run: async () => {
        await showFlat();

        viewer.camera.flyToBoundingSphere(
          new Cesium.BoundingSphere(targetCenter, 800.0),
          {
            offset: new Cesium.HeadingPitchRange(
              Cesium.Math.toRadians(20.0),
              Cesium.Math.toRadians(-38.0),
              6800.0
            ),
            duration: 3.8,
            easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
          }
        );
      },
    },

    // ── Step 4: Stretch 10x while camera orbits 30° ─────────────────
    {
      caption: 'Stretch it 10x and the dips appear.',
      durationMs: 4600,
      run: async () => {
        tweenExaggeration(10.0, 4200);

        viewer.camera.flyToBoundingSphere(
          new Cesium.BoundingSphere(targetCenter, 800.0),
          {
            offset: new Cesium.HeadingPitchRange(
              Cesium.Math.toRadians(50.0),
              Cesium.Math.toRadians(-32.0),
              6400.0
            ),
            duration: 4.4,
            easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
          }
        );
      },
    },

    // ── Step 5: Rain.js on ──────────────────────────────────────────
    {
      caption: 'Let it rain. Every drop runs downhill.',
      durationMs: 5200,
      run: async () => {
        startRain();

        viewer.camera.flyToBoundingSphere(
          new Cesium.BoundingSphere(targetCenter, 800.0),
          {
            offset: new Cesium.HeadingPitchRange(
              Cesium.Math.toRadians(45.0),
              Cesium.Math.toRadians(-28.0),
              5800.0
            ),
            duration: 4.8,
            easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
          }
        );
      },
    },

    // ── Step 6: Water rises in low ground ───────────────────────────
    {
      caption: 'Low ground fills first — monsoonal runoff pools into the marsh basin.',
      durationMs: 5600,
      run: async () => {
        showPooling({ rainfallMm: currentRainfallMm, runoffCoeff });

        const marshTarget = Cesium.Cartesian3.fromDegrees(80.220, 12.940, 0);
        viewer.camera.flyToBoundingSphere(
          new Cesium.BoundingSphere(marshTarget, 800.0),
          {
            offset: new Cesium.HeadingPitchRange(
              Cesium.Math.toRadians(35.0),
              Cesium.Math.toRadians(-30.0),
              5200.0
            ),
            duration: 5.4,
            easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
          }
        );
      },
    },

    // ── Step 7: Roads scene and slow fly-down along OMR ─────────────
    {
      caption: 'Back on the real map, these arterial roads go under.',
      durationMs: 7600,
      run: async () => {
        stopRain();

        showRealMapScene({
          rainfallMm: currentRainfallMm,
          runoffCoeff,
          onStatsUpdate: updateStatsBadge,
        });

        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(80.235, 12.940, 2200.0),
          orientation: {
            heading: Cesium.Math.toRadians(18.0),
            pitch: Cesium.Math.toRadians(-24.0),
            roll: 0.0,
          },
          duration: 7.2,
          easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
        });
      },
    },
  ];
}

/**
 * Runs the REPLAY timeline.
 */
async function playTimeline() {
  if (!viewer) return;
  const timelineId = ++currentTimelineId;
  isTimelineRunning = true;

  const btnReplay = document.getElementById('btn-replay');
  if (btnReplay) btnReplay.classList.add('active');

  const steps = getTimelineSteps();
  const totalDurationMs = steps.reduce((acc, s) => acc + s.durationMs, 0);

  startChartPlayhead(totalDurationMs);

  for (let i = 0; i < steps.length; i++) {
    if (timelineId !== currentTimelineId) return;

    const step = steps[i];
    setCaption(step.caption, step.durationMs);
    await step.run();

    await new Promise((resolve) => {
      const timer = setTimeout(resolve, step.durationMs);
      activeTimers.push(timer);
    });
  }

  if (timelineId !== currentTimelineId) return;

  isTimelineRunning = false;
  clearCaption();
  stopChartPlayhead();
  if (btnReplay) btnReplay.classList.remove('active');

  const btnCollects = document.getElementById('btn-collects');
  const btnRoads = document.getElementById('btn-roads');
  if (btnCollects) btnCollects.classList.toggle('active', isWaterVisible());
  if (btnRoads) btnRoads.classList.toggle('active', isRoadsVisible());
}

/**
 * Skips immediately to the final scene (Esc shortcut).
 */
async function skipToEnd() {
  if (!viewer) return;
  currentTimelineId++;
  isTimelineRunning = false;
  clearCaption();
  stopChartPlayhead();

  const btnReplay = document.getElementById('btn-replay');
  if (btnReplay) btnReplay.classList.remove('active');

  stopRain();
  hidePooling();
  hideTerrain();

  if (!activeOutlineEntity) {
    activeOutlineEntity = addBoundingBoxOutline(viewer, bbox);
  }

  await showRealMapScene({
    rainfallMm: currentRainfallMm,
    runoffCoeff,
    onStatsUpdate: updateStatsBadge,
  });

  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(80.235, 12.940, 2200.0),
    orientation: {
      heading: Cesium.Math.toRadians(18.0),
      pitch: Cesium.Math.toRadians(-24.0),
      roll: 0.0,
    },
    duration: 1.5,
    easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
  });

  const btnCollects = document.getElementById('btn-collects');
  const btnRoads = document.getElementById('btn-roads');
  if (btnCollects) btnCollects.classList.toggle('active', isWaterVisible());
  if (btnRoads) btnRoads.classList.toggle('active', isRoadsVisible());
}

/**
 * Dynamic Rain Controller: handles preset changes and slider adjustments.
 */
function setupRainControls() {
  const select = document.getElementById('rain-preset-select');
  const slider = document.getElementById('rain-slider');
  const sliderVal = document.getElementById('rain-slider-val');

  // 1. Populate Presets
  if (select) {
    select.innerHTML = '';
    for (const [key, p] of Object.entries(rainPresets)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = `${p.label.split(' - ')[0]} (${p.total_mm} mm)`;
      select.appendChild(opt);
    }

    if (rainPresets[currentPresetKey]) {
      select.value = currentPresetKey;
    }

    select.addEventListener('change', async () => {
      currentPresetKey = select.value;
      const p = rainPresets[currentPresetKey];
      if (p) {
        currentRainfallMm = Math.round(p.total_mm);
        if (slider) slider.value = currentRainfallMm;
        if (sliderVal) sliderVal.textContent = `${currentRainfallMm} mm`;
        drawRainChart(currentPresetKey, null);

        if (viewer) {
          await updateRainfall({
            rainfallMm: currentRainfallMm,
            runoffCoeff,
            onStatsUpdate: updateStatsBadge,
          });
        }
      }
    });
  }

  // 2. Setup Slider
  if (slider) {
    slider.value = currentRainfallMm;
    if (sliderVal) sliderVal.textContent = `${currentRainfallMm} mm`;

    slider.addEventListener('input', () => {
      currentRainfallMm = parseFloat(slider.value);
      if (sliderVal) sliderVal.textContent = `${currentRainfallMm} mm`;

      clearTimeout(updateDebounceTimer);
      updateDebounceTimer = setTimeout(async () => {
        if (viewer) {
          await updateRainfall({
            rainfallMm: currentRainfallMm,
            runoffCoeff,
            onStatsUpdate: updateStatsBadge,
          });
        }
      }, 160); // debounce: rebuild flood layers once the slider settles, not on every tick
    });
  }

  // Initial draw of chart
  drawRainChart(currentPresetKey, null);
}

/**
 * Application Bootstrap.
 */
async function initScene() {
  // 1. Fetch bbox configuration & rain presets with strict error checking
  let areaConfig = null;
  try {
    const res = await fetch('data/area.json');
    if (!res.ok) throw new Error(`HTTP ${res.status} loading data/area.json`);
    areaConfig = await res.json();
    loadedAreaConfig = areaConfig;
  } catch (e) {
    console.warn('Falling back to default bbox configuration:', e);
    showErrorMessage(`Could not load data/area.json (${e.message}); using the default study area.`);
    areaConfig ={ south: 12.890, west: 80.190, north: 12.990, east: 80.270 };
    loadedAreaConfig = areaConfig;
  }

  bbox.south = areaConfig.bbox?.south ?? areaConfig.south ?? 12.890;
  bbox.west  = areaConfig.bbox?.west  ?? areaConfig.west  ?? 80.190;
  bbox.north = areaConfig.bbox?.north ?? areaConfig.north ?? 12.990;
  bbox.east  = areaConfig.bbox?.east  ?? areaConfig.east  ?? 80.270;

  studyCentre.lat = (bbox.south + bbox.north) / 2.0;
  studyCentre.lon = (bbox.west + bbox.east) / 2.0;

  try {
    const rainRes = await fetch('data/rain.json');
    if (!rainRes.ok) throw new Error(`HTTP ${rainRes.status} loading data/rain.json`);
    rainPresets = await rainRes.json();
  } catch (e) {
    console.warn('Failed to load rain.json:', e);
    // Without this the Rain Event dropdown and hourly chart are silently empty.
    showErrorMessage(`Could not load data/rain.json (${e.message}) — the Rain Event list and hourly chart will be empty.`);
  }

  const presetKeys = Object.keys(rainPresets);
  if (presetKeys.length > 0) {
    currentPresetKey = presetKeys[0];
    const firstP = rainPresets[currentPresetKey];
    if (firstP && firstP.total_mm) {
      currentRainfallMm = Math.round(firstP.total_mm);
    }
  } else {
    currentRainfallMm = areaConfig.rainfall_mm ?? 150;
  }
  runoffCoeff = areaConfig.runoffCoeff ?? areaConfig.runoff_coeff ?? 0.8; // area.json uses camelCase

  // Immediately populate rain inspector controls & chart
  setupRainControls();

  // 2. Initialize Cesium viewer & Google 3D Tiles
  try {
    const vResult = await createViewer('cesiumContainer');
    viewer = vResult.viewer;
    window.viewer = viewer;

    const target = Cesium.Cartesian3.fromDegrees(studyCentre.lon, studyCentre.lat, 0);
    viewer.camera.lookAt(
      target,
      new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(15.0),
        Cesium.Math.toRadians(-35.0),
        7500.0
      )
    );
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);

    // 3. Pre-initialize simulation subsystems
    await initTerrain(viewer);
    await initRain(viewer, areaConfig.drops || 3000);
    initPooling(viewer);
    await initRoads(viewer);
    await initValidation(viewer);

    // Trigger initial calculation of road flooding km stat
    await updateRainfall({
      rainfallMm: currentRainfallMm,
      runoffCoeff,
      onStatsUpdate: updateStatsBadge,
    });

    // 4. Button controls
    const btnCollects = document.getElementById('btn-collects');
    const btnRoads = document.getElementById('btn-roads');
    const btnReplay = document.getElementById('btn-replay');

    if (btnCollects) {
      btnCollects.addEventListener('click', () => {
        const visible = toggleWaterLayer();
        btnCollects.classList.toggle('active', visible);
      });
    }

    if (btnRoads) {
      btnRoads.addEventListener('click', () => {
        const visible = toggleRoadsLayer();
        btnRoads.classList.toggle('active', visible);
      });
    }

    const btnValidate = document.getElementById('btn-validate');
    if (btnValidate) {
      btnValidate.addEventListener('click', () => {
        btnValidate.classList.toggle('active', toggleValidation());
      });
    }

    if (btnReplay) {
      btnReplay.addEventListener('click', () => {
        playTimeline();
      });
    }

    // 5. Keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') {
        skipToEnd();
      } else if (e.code === 'KeyT' && !e.repeat) {
        isTerrainVisible() ? hideTerrain() : showTerrain();
      } else if (e.code === 'KeyW' && btnCollects) {
        btnCollects.click();
      } else if (e.code === 'KeyP' && btnRoads) {
        btnRoads.click();
      }
    });

    window.playTimeline = playTimeline;
    window.skipToEnd = skipToEnd;
    window.toggleWater = toggleWaterLayer;
    window.toggleRoads = toggleRoadsLayer;
    if (location.hash.includes('validate') && btnValidate) btnValidate.click(); // deep link: google3d.html#validate

    // 6. Setup time-step controls
    setupTimestepControls();

    // 7. Render initial state immediately so the page is NOT empty on load
    if (!activeOutlineEntity) {
      activeOutlineEntity = addBoundingBoxOutline(viewer, bbox);
    }

    // (The flood layers were already built above; a second updateRainfall() here
    //  just rebuilt everything twice on load.)

    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(studyCentre.lon, studyCentre.lat - 0.035, 7800.0),
      orientation: {
        heading: Cesium.Math.toRadians(10.0),
        pitch: Cesium.Math.toRadians(-34.0),
        roll: 0.0,
      },
      duration: 1.5,
      easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
    });
    if (window.__bootReady) window.__bootReady(); // loading finished: stand the watchdog down
  } catch (err) {
    console.error('Failed to initialize 3D scene:', err);
    showErrorMessage(`Visualization Error: ${err.message}`);
    if (window.__bootFail) window.__bootFail(`3D scene failed to start: ${err.message}`);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initScene);
} else {
  initScene();
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIME-STEP MODEL — flow.worker.js integration
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Returns the grid heights and dimensions from the terrain module's grid object.
 * We lazy-import { grid } from terrain.js to avoid circular dependency.
 */
async function getTerrainGrid() {
  const { grid } = await import('./terrain.js');
  return grid;
}

/**
 * Starts the flow worker with the current rain preset and streams hourly snapshots.
 * Shows progress in the time-step panel.
 */
async function runFlowSimulation() {
  if (flowWorkerBusy) return;

  const terrainGrid = await getTerrainGrid();
  if (!terrainGrid || !terrainGrid.heights) {
    showErrorMessage('Terrain grid not ready — cannot run time-stepping model.');
    return;
  }

  const preset = rainPresets[currentPresetKey];
  if (!preset || !preset.mm) {
    showErrorMessage('No rain preset loaded for time-stepping model.');
    return;
  }

  // Reset state
  flowSnapshots = [];
  flowHourCount = 0;
  currentHour = 0;
  stopPlay();

  setTimeStepStatus('Running…');
  setHourLabel(0, preset.mm.length);

  if (flowWorker) {
    flowWorker.terminate();
  }
  flowWorker = new Worker('js/flow.worker.js', { type: 'module' });
  flowWorkerBusy = true;

  flowWorker.addEventListener('message', (evt) => {
    const msg = evt.data;
    if (msg.type === 'hour') {
      flowSnapshots[msg.hour] = msg.depth;
      // Update slider max live as hours arrive
      const slider = document.getElementById('ts-slider');
      if (slider) slider.max = msg.hour;
    } else if (msg.type === 'done') {
      flowWorkerBusy = false;
      flowHourCount = msg.totalHours;
      const slider = document.getElementById('ts-slider');
      if (slider) slider.max = flowSnapshots.length - 1;
      setTimeStepStatus(`Ready — ${flowSnapshots.length} snapshots`);
      // Show hour 0 immediately
      showHourSnapshot(0);
    } else if (msg.type === 'error') {
      flowWorkerBusy = false;
      setTimeStepStatus('Error: ' + msg.message);
    }
  });

  flowWorker.addEventListener('error', (err) => {
    flowWorkerBusy = false;
    setTimeStepStatus('Worker error: ' + err.message);
  });

  const outletCells = loadedAreaConfig?.outletCells || [];
  const marshFullCheckbox = document.getElementById('ts-marsh-full');
  const marshFull = marshFullCheckbox ? marshFullCheckbox.checked : (loadedAreaConfig?.marshFull || false);

  // Transfer heights buffer for zero-copy
  const heightsCopy = new Float32Array(terrainGrid.heights);
  flowWorker.postMessage({
    type: 'run',
    heights: heightsCopy,
    cols: terrainGrid.cols,
    rows: terrainGrid.rows,
    rainSeries: preset.mm,
    runoffCoeff,
    outletCells,
    subSteps: 60,
    marshFull,
  }, [heightsCopy.buffer]);
}

/**
 * Shows a specific hour's depth snapshot on the draped layers.
 * Uses updateRainfall's underlying depth-to-roads/water logic via a temporary
 * override — for now we re-use the static roads layer's updateRainfall path
 * but feed it a pre-computed depth array.
 */
async function showHourSnapshot(hour) {
  const snap = flowSnapshots[hour];
  if (!snap) return;

  currentHour = hour;
  setHourLabel(hour, flowHourCount);

  // Sync rain chart playhead
  if (flowHourCount > 0) {
    const frac = hour / Math.max(flowHourCount - 1, 1);
    drawRainChart(currentPresetKey, frac);
  }

  // Update the slider position
  const slider = document.getElementById('ts-slider');
  if (slider) slider.value = hour;

  // Push depth snapshot to the roads/water layer
  // We import updateFromDepth which accepts a pre-computed Float32Array
  try {
    const { updateFromDepth } = await import('./roads.js');
    if (typeof updateFromDepth === 'function') {
      await updateFromDepth({ depth: snap, onStatsUpdate: updateStatsBadge });
    } else {
      // Fallback: static update with equivalent total mm (approximate)
      const preset = rainPresets[currentPresetKey];
      const fractionDone = (hour + 1) / Math.max(flowHourCount, 1);
      const partialMm = preset ? preset.total_mm * fractionDone : currentRainfallMm;
      await updateRainfall({ rainfallMm: partialMm, runoffCoeff, onStatsUpdate: updateStatsBadge });
    }
  } catch (e) {
    console.warn('[TimeStep] showHourSnapshot fallback:', e.message);
  }
}

/** Start playback at 1 s/hour. */
function startPlay() {
  if (playIntervalId) return;
  const btnPlay = document.getElementById('ts-play');
  if (btnPlay) { btnPlay.textContent = '⏸'; btnPlay.title = 'Pause'; }

  playIntervalId = setInterval(() => {
    const nextHour = currentHour + 1;
    if (nextHour >= flowSnapshots.length) {
      stopPlay();
      return;
    }
    showHourSnapshot(nextHour);
  }, playSpeedMs);
}

/** Stop playback. */
function stopPlay() {
  if (playIntervalId) {
    clearInterval(playIntervalId);
    playIntervalId = null;
  }
  const btnPlay = document.getElementById('ts-play');
  if (btnPlay) { btnPlay.textContent = '▶'; btnPlay.title = 'Play'; }
}

function setHourLabel(hour, total) {
  const lbl = document.getElementById('ts-hour-label');
  if (lbl) lbl.textContent = `Hour ${hour} / ${Math.max(total - 1, 0)}`;
}

function setTimeStepStatus(msg) {
  const el = document.getElementById('ts-status');
  if (el) el.textContent = msg;
}

/**
 * Wires up the time-step panel controls.
 * Called once after the viewer is ready.
 */
function setupTimestepControls() {
  const btnMode = document.getElementById('btn-mode-toggle');
  const tsPanel = document.getElementById('ts-panel');
  const btnPlay = document.getElementById('ts-play');
  const tsSlider = document.getElementById('ts-slider');
  const btnRun = document.getElementById('ts-run');

  if (btnMode) {
    btnMode.addEventListener('click', () => {
      if (simMode === 'static') {
        simMode = 'timestep';
        btnMode.textContent = 'MODE: TIME-STEP';
        btnMode.classList.add('active');
        if (tsPanel) tsPanel.hidden = false;
      } else {
        simMode = 'static';
        btnMode.textContent = 'MODE: STATIC';
        btnMode.classList.remove('active');
        if (tsPanel) tsPanel.hidden = true;
        stopPlay();
        // Restore static view
        updateRainfall({ rainfallMm: currentRainfallMm, runoffCoeff, onStatsUpdate: updateStatsBadge });
      }
    });
  }

  if (btnRun) {
    btnRun.addEventListener('click', () => {
      runFlowSimulation();
    });
  }

  if (btnPlay) {
    btnPlay.addEventListener('click', () => {
      if (playIntervalId) {
        stopPlay();
      } else {
        if (flowSnapshots.length === 0) {
          runFlowSimulation().then(() => {
            setTimeout(startPlay, 500);
          });
        } else {
          if (currentHour >= flowSnapshots.length - 1) {
            showHourSnapshot(0);
          }
          startPlay();
        }
      }
    });
  }

  if (tsSlider) {
    tsSlider.min = 0;
    tsSlider.max = 0;
    tsSlider.value = 0;
    tsSlider.addEventListener('input', () => {
      stopPlay();
      const h = parseInt(tsSlider.value, 10);
      showHourSnapshot(h);
    });
  }

  const marshFullCheckbox = document.getElementById('ts-marsh-full');
  if (marshFullCheckbox) {
    marshFullCheckbox.addEventListener('change', () => {
      runFlowSimulation();
    });
  }
}
