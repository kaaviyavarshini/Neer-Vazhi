/**
 * scripts/compute_scores.mjs
 * Computes scores (wet cells > 5cm, flooded road km > 15cm, peak depth)
 * for both static and time-stepping models across all presets.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { priorityFlood, computeWaterDepth } from '../web/js/pooling-core.js';
import { runSimulation } from '../web/js/flow-core.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, '..');

const grid = JSON.parse(fs.readFileSync(path.join(root, 'web/data/grid.json'), 'utf8'));
const rain = JSON.parse(fs.readFileSync(path.join(root, 'web/data/rain.json'), 'utf8'));
const roadsData = JSON.parse(fs.readFileSync(path.join(root, 'web/data/roads.json'), 'utf8'));

const { heights, cols, rows, west, east, south, north, cellSizeM } = grid;
const H = new Float32Array(heights);
const n = cols * rows;

function haversineDistanceM(lon1, lat1, lon2, lat2) {
  const R = 6371008.8;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function getWaterDepthAt(lon, lat, depthArray) {
  if (lon < west || lon > east || lat < south || lat > north) return 0.0;
  const colF = ((lon - west) / (east - west)) * cols - 0.5;
  const rowF = ((north - lat) / (north - south)) * rows - 0.5;
  const c0 = Math.max(0, Math.min(cols - 1, Math.floor(colF)));
  const r0 = Math.max(0, Math.min(rows - 1, Math.floor(rowF)));
  return depthArray[r0 * cols + c0];
}

function computeFloodedRoadKm(depthArray) {
  let totalKm = 0.0;
  // roadsData is an Array of road segment objects: { id, name, highway, coords: [[lon,lat], ...] }
  const roadsList = Array.isArray(roadsData) ? roadsData : (roadsData.features || []);
  for (let f = 0; f < roadsList.length; f++) {
    const coords = roadsList[f].coords || roadsList[f].geometry?.coordinates || [];
    for (let i = 0; i < coords.length - 1; i++) {
      const [lon1, lat1] = coords[i];
      const [lon2, lat2] = coords[i + 1];
      const midLon = (lon1 + lon2) * 0.5;
      const midLat = (lat1 + lat2) * 0.5;
      const d = getWaterDepthAt(midLon, midLat, depthArray);
      if (d >= 0.15) {
        totalKm += haversineDistanceM(lon1, lat1, lon2, lat2) / 1000.0;
      }
    }
  }
  return totalKm;
}

console.log('Computing Static Priority-Flood base spill surface...');
const F = priorityFlood(H, cols, rows);

const results = {};

for (const [key, preset] of Object.entries(rain)) {
  console.log(`\nProcessing preset: ${key} (${preset.total_mm} mm)...`);
  const totalMm = preset.total_mm;

  // 1. Static model
  const staticDepth = computeWaterDepth({
    heights: H,
    filled: F,
    cols,
    rows,
    cellSizeM: cellSizeM || 30,
    rainfallMm: totalMm,
    runoffCoeff: 0.8,
  });

  let staticWet = 0;
  let staticPeak = 0;
  for (let i = 0; i < n; i++) {
    const d = staticDepth[i];
    if (d > 0.05) staticWet++;
    if (d > staticPeak) staticPeak = d;
  }
  const staticRoadKm = computeFloodedRoadKm(staticDepth);

  // 2. Time-stepping model
  console.log(`  Running time-stepping simulation (${preset.mm.length} hours)...`);
  const { snapshots } = runSimulation({
    heights: H,
    cols,
    rows,
    rainSeries: preset.mm,
    runoffCoeff: 0.8,
    outletCells: [],
    subSteps: 15, // Use 15 sub-steps for fast reality check across 120h
    marshFull: false,
  });

  const finalFlow = snapshots[snapshots.length - 1];
  let flowWet = 0;
  let flowPeak = 0;
  for (let i = 0; i < n; i++) {
    const d = finalFlow[i];
    if (d > 0.05) flowWet++;
    if (d > flowPeak) flowPeak = d;
  }
  const flowRoadKm = computeFloodedRoadKm(finalFlow);

  results[key] = {
    totalMm,
    hours: preset.mm.length,
    static: { wet: staticWet, roadKm: staticRoadKm.toFixed(2), peak: staticPeak.toFixed(2) },
    flow: { wet: flowWet, roadKm: flowRoadKm.toFixed(2), peak: flowPeak.toFixed(2) }
  };

  console.log(`  Static: wet=${staticWet}, roadKm=${staticRoadKm.toFixed(2)}km, peak=${staticPeak.toFixed(2)}m`);
  console.log(`  Flow:   wet=${flowWet}, roadKm=${flowRoadKm.toFixed(2)}km, peak=${flowPeak.toFixed(2)}m`);
}

fs.writeFileSync(path.join(root, 'docs/scores.json'), JSON.stringify(results, null, 2));
console.log('\nScores saved to docs/scores.json');
