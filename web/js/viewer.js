/**
 * web/js/viewer.js
 * Configures the CesiumJS Viewer with Google Photorealistic 3D Tiles.
 * Provides resilient fallback to globe/imagery if 3D Tiles API is unavailable or returns 403.
 */

import { GOOGLE_MAPS_KEY } from './config.js';

/**
 * Small, non-blocking notification pill (bottom-centre, above the action buttons).
 * Auto-dismisses after 6 s; never intercepts clicks except on its own close button.
 */
function showApiNotice() {
  if (document.getElementById('api-notice-banner')) return;
  const pill = document.createElement('div');
  pill.id = 'api-notice-banner';
  pill.style.cssText = `
    position: absolute; bottom: ${window.innerWidth <= 720 ? 112 : 72}px; left: 50%; transform: translateX(-50%);
    max-width: min(560px, calc(100vw - 24px)); text-align: center;
    z-index: 50; display: flex; align-items: center; gap: 8px;
    padding: 6px 8px 6px 14px; border-radius: 18px;
    background: rgba(10, 14, 23, 0.72); border: 1px solid rgba(255, 152, 0, 0.45);
    color: #cbd5e1; font: 12px/1.3 -apple-system, "Segoe UI", Roboto, sans-serif;
    backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
    opacity: 0; transition: opacity 0.4s ease; pointer-events: none;
  `;
  pill.innerHTML = `
    <span>3D buildings unavailable (Map Tiles API not enabled) &middot; showing satellite imagery</span>
    <button aria-label="Dismiss" style="pointer-events:auto;background:transparent;border:none;color:#ff9800;font-size:16px;cursor:pointer;line-height:1;padding:0 6px;">&times;</button>
  `;
  const close = () => {
    pill.style.opacity = '0';
    setTimeout(() => pill.remove(), 400);
  };
  pill.querySelector('button').addEventListener('click', close);
  document.body.appendChild(pill);
  requestAnimationFrame(() => { pill.style.opacity = '1'; });
  setTimeout(close, 6000);
}

export async function createViewer(containerId = 'cesiumContainer') {
  if (!window.CESIUM_BASE_URL) {
    window.CESIUM_BASE_URL = 'https://cdn.jsdelivr.net/npm/cesium@1.117.0/Build/Cesium/';
  }

  Cesium.Ion.defaultAccessToken = '';
  Cesium.GoogleMaps.defaultApiKey = GOOGLE_MAPS_KEY;

  const viewer = new Cesium.Viewer(containerId, {
    // NOTE: `globe` accepts a Globe instance or `false` only — `true` crashes
    // CesiumWidget ("reading 'addEventListener'"). Omit it for the default globe.
    baseLayer: false,
    baseLayerPicker: false,
    geocoder: false,
    timeline: false,
    animation: false,
    fullscreenButton: false,
    vrButton: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    infoBox: false,
    selectionIndicator: false,
    skyBox: false,
    skyAtmosphere: false,
  });

  // Cap render resolution on high-DPI screens: big GPU/main-thread saving, barely visible on a map.
  viewer.resolutionScale = Math.min(window.devicePixelRatio || 1, 1.25);
  viewer.scene.msaaSamples = 1;
  viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#0a0e17');
  if (viewer.scene.globe) {
    viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#0f172a');
  }

  // Fallback basemap used when Google 3D Tiles are unavailable: Esri World Imagery
  // (satellite) suits the dark flood overlay far better than the OSM street map.
  // Never throws; falls back to OSM only if Esri itself cannot be reached.
  let fallbackStarted = false;
  async function enableFallbackImagery() {
    if (fallbackStarted) return;
    fallbackStarted = true;
    if (viewer.scene.globe) viewer.scene.globe.show = true; // fallback needs the globe back
    try {
      if (viewer.imageryLayers.length > 0) return;
      const esri = await Cesium.ArcGisMapServerImageryProvider.fromUrl(
        'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
        { enablePickFeatures: false }
      );
      viewer.imageryLayers.addImageryProvider(esri);
    } catch (e) {
      console.warn('Esri imagery unavailable, using OpenStreetMap:', e);
      try {
        viewer.imageryLayers.addImageryProvider(
          new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' })
        );
      } catch (e2) {
        console.warn('Fallback imagery provider error:', e2);
      }
    }
  }

  // Probe Google Map Tiles API key permission before loading tileset
  let isGoogleTilesSupported = false;
  if (GOOGLE_MAPS_KEY) {
    try {
      const probeRes = await fetch(
        `https://tile.googleapis.com/v1/3dtiles/root.json?key=${GOOGLE_MAPS_KEY}`,
        { method: 'GET', mode: 'cors' }
      );
      if (probeRes.ok) {
        isGoogleTilesSupported = true;
      } else {
        console.warn(`Google Map Tiles returned HTTP ${probeRes.status}. Using Esri satellite fallback.`);
      }
    } catch (probeErr) {
      console.warn('Google Map Tiles probe check failed:', probeErr);
    }
  }

  let tileset = null;
  if (isGoogleTilesSupported) {
    try {
      tileset = await Cesium.createGooglePhotorealistic3DTileset();
      if (tileset && tileset.errorEvent) {
        tileset.errorEvent.addEventListener((err) => {
          console.warn('Google 3D Tiles runtime error:', err);
          try { viewer.scene.primitives.remove(tileset); } catch (_) { /* already removed */ }
          enableFallbackImagery();
          showApiNotice();
        });
      }
      viewer.scene.primitives.add(tileset);

      // ── Performance tuning ────────────────────────────────────────────
      // Coarser LOD target (default 16): far fewer tiles to fetch/draw, visually
      // near-identical at the 6-8 km viewing range this app uses.
      tileset.maximumScreenSpaceError = 24;
      // Keep the GPU/RAM tile cache modest (defaults are ~1.6 GB) to avoid GC/stalls.
      tileset.cacheBytes = 512 * 1024 * 1024;
      tileset.maximumCacheOverflowBytes = 256 * 1024 * 1024;
      // The Google tiles already include terrain. Rendering the globe underneath
      // is a wasted full terrain/imagery pass, so hide it while the tiles are active.
      if (viewer.scene.globe) viewer.scene.globe.show = false;
    } catch (err) {
      console.warn('Google 3D Tiles creation error:', err);
      enableFallbackImagery();
      showApiNotice();
    }
  } else {
    enableFallbackImagery();
    showApiNotice();
  }

  return { viewer, tileset };
}

/**
 * Adds a thin white bounding box outline that hugs 3D tiles using ground polyline
 */
export function addBoundingBoxOutline(viewer, bbox) {
  const { west, south, east, north } = bbox;

  // Closed rectangle coordinates: SW -> NW -> NE -> SE -> SW
  const degreesArray = [
    west, south,
    west, north,
    east, north,
    east, south,
    west, south,
  ];

  return viewer.entities.add({
    polyline: {
      positions: Cesium.Cartesian3.fromDegreesArray(degreesArray),
      width: 2.0,
      material: new Cesium.ColorMaterialProperty(Cesium.Color.WHITE.withAlpha(0.85)),
      clampToGround: true,
      classificationType: Cesium.ClassificationType.BOTH,
    },
  });
}

/**
 * Animates the white bounding box outline drawing itself around the 4 edges.
 */
export function animateBoundingBoxOutline(viewer, bbox, durationMs = 2800) {
  const { west, south, east, north } = bbox;
  const corners = [
    [west, south],
    [west, north],
    [east, north],
    [east, south],
    [west, south],
  ];

  const segLens = [
    north - south,
    east - west,
    north - south,
    east - west,
  ];
  const totalPerimeter = segLens.reduce((a, b) => a + b, 0);

  const t0 = performance.now();
  let completed = false;

  const positionsCallback = new Cesium.CallbackProperty(() => {
    if (completed) {
      return Cesium.Cartesian3.fromDegreesArray([
        west, south,
        west, north,
        east, north,
        east, south,
        west, south,
      ]);
    }

    const elapsed = performance.now() - t0;
    const progress = Math.min(elapsed / durationMs, 1.0);
    const targetDist = progress * totalPerimeter;

    const coords = [corners[0][0], corners[0][1]];
    let accumulated = 0;

    for (let i = 0; i < 4; i++) {
      const segLen = segLens[i];
      if (accumulated + segLen <= targetDist) {
        coords.push(corners[i + 1][0], corners[i + 1][1]);
        accumulated += segLen;
      } else {
        const segRemain = targetDist - accumulated;
        const frac = segLen > 0 ? segRemain / segLen : 0;
        const curLon = corners[i][0] + frac * (corners[i + 1][0] - corners[i][0]);
        const curLat = corners[i][1] + frac * (corners[i + 1][1] - corners[i][1]);
        coords.push(curLon, curLat);
        break;
      }
    }

    if (progress >= 1.0) {
      completed = true;
    }

    return Cesium.Cartesian3.fromDegreesArray(coords);
  }, false);

  return viewer.entities.add({
    polyline: {
      positions: positionsCallback,
      width: 2.0,
      material: new Cesium.ColorMaterialProperty(Cesium.Color.WHITE.withAlpha(0.9)),
      clampToGround: true,
      classificationType: Cesium.ClassificationType.BOTH,
    },
  });
}

/**
 * Flies camera to the study box centre with heading ~20°, pitch ~ -35°, range ~6 km
 */
export function flyToStudyArea(viewer, centreLat, centreLon) {
  const target = Cesium.Cartesian3.fromDegrees(centreLon, centreLat, 0);
  const heading = Cesium.Math.toRadians(20.0);
  const pitch = Cesium.Math.toRadians(-35.0);
  const range = 6500.0;

  viewer.camera.flyToBoundingSphere(
    new Cesium.BoundingSphere(target, 800.0),
    {
      offset: new Cesium.HeadingPitchRange(heading, pitch, range),
      duration: 2.5,
    }
  );
}
