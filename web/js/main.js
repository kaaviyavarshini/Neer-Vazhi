/**
 * web/js/main.js
 * Entry point for Scene 1 (Google Photorealistic 3D).
 */

import { createViewer, addBoundingBoxOutline, flyToStudyArea } from './viewer.js';

async function initScene() {
  // Fetch bbox configuration
  let areaConfig = null;
  try {
    const res = await fetch('data/area.json');
    areaConfig = await res.json();
  } catch (e) {
    console.warn('Falling back to default bbox configuration');
    areaConfig = {
      south: 12.925,
      west: 80.205,
      north: 12.975,
      east: 80.250,
    };
  }

  const south = areaConfig.bbox?.south ?? areaConfig.south;
  const west = areaConfig.bbox?.west ?? areaConfig.west;
  const north = areaConfig.bbox?.north ?? areaConfig.north;
  const east = areaConfig.bbox?.east ?? areaConfig.east;

  const centreLat = (south + north) / 2.0;
  const centreLon = (west + east) / 2.0;

  // Initialize Cesium viewer & Google 3D Tiles
  const { viewer } = await createViewer('cesiumContainer');

  // Draw thin white bounding box hugging terrain/tiles
  addBoundingBoxOutline(viewer, { west, south, east, north });

  // Fly camera: heading ~20°, pitch ~ -35°, ~3 km away
  flyToStudyArea(viewer, centreLat, centreLon);

  // TEMPORARY: press T to toggle the elevation slab (replace with scene manager)
  const terrain = await import('./terrain.js');
  await terrain.initTerrain(viewer);
  window.viewer = viewer; window.terrain = terrain;   // TEMPORARY: console debugging
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyT' && !e.repeat) terrain.isVisible() ? terrain.hide() : terrain.show();
  });

  // TEMPORARY: press R to toggle rain (needs slab; T first to see it)
  const rain = await import('./rain.js');
  await rain.initRain(viewer);
  window.rain = rain;
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyR' && !e.repeat) rain.isRunning() ? rain.stop() : rain.start();
  });

  // Wire up button handlers
  const btnCollects = document.getElementById('btn-collects');
  const btnRoads = document.getElementById('btn-roads');
  const btnReplay = document.getElementById('btn-replay');

  if (btnCollects) {
    btnCollects.addEventListener('click', () => {
      console.log('COLLECTS button clicked (Scene 4/5 trigger stub)');
    });
  }

  if (btnRoads) {
    btnRoads.addEventListener('click', () => {
      console.log('ROADS button clicked (Scene 5 trigger stub)');
    });
  }

  if (btnReplay) {
    btnReplay.addEventListener('click', () => {
      console.log('REPLAY button clicked (Refly camera to study area)');
      flyToStudyArea(viewer, centreLat, centreLon);
    });
  }
}

// Bootstrap
window.addEventListener('DOMContentLoaded', initScene);
