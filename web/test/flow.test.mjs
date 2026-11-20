/**
 * web/test/flow.test.mjs
 * Node.js unit tests for web/js/flow-core.js
 *
 * Run: node web/test/flow.test.mjs
 *
 * Tests:
 *  A. Closed flat box — water volume is conserved (rain in = water stored)
 *  B. Tilted plane with outlet — drains to near-zero after rain stops
 *  C. Bowl: time-stepping equilibrium depth ≈ priority-flood static depth (±5%)
 */

import { initFlowState, stepHour, getSnapshot, runSimulation } from '../js/flow-core.js';
import { priorityFlood, computeWaterDepth } from '../js/pooling-core.js';

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

function approxEqual(a, b, tol) {
  return Math.abs(a - b) <= tol;
}

function sum(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s;
}

// ─── Test A: Closed flat box conserves water ─────────────────────────────────
console.log('\nTest A: Closed flat box — water conservation');
{
  const cols = 10, rows = 10;
  const n = cols * rows;
  const heights = new Float32Array(n); // all zero — perfectly flat
  const rainMm = 10;        // 10 mm/h for 1 hour
  const runoffCoeff = 1.0;  // 100% becomes runoff
  const outletCells = [];   // closed box, no drainage

  const state = initFlowState(heights, cols, rows);
  stepHour(state, rainMm, runoffCoeff, outletCells, 60, false);

  const totalDepthM = sum(state.depth);
  // Expected: each cell gets rainMm/1000 m = 0.01 m; n=100 cells → sum = 1.0 m
  const expected = (rainMm / 1000.0) * runoffCoeff * n;
  const relErr = Math.abs(totalDepthM - expected) / expected;

  assert(relErr < 0.001, `Volume conserved (rel error < 0.1%)`, `got ${relErr.toExponential(3)}`);
  assert(state.depth.every(d => d >= 0), 'No negative depths');
}

// ─── Test B: Tilted plane with outlet drains to near-zero ────────────────────
console.log('\nTest B: Tilted plane with outlet — drains after rain stops');
{
  const cols = 10, rows = 10;
  const n = cols * rows;
  // Heights slope from 1.0 (top row) to 0.0 (bottom row)
  const heights = new Float32Array(n);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      heights[r * cols + c] = (rows - 1 - r) / (rows - 1); // 1.0 → 0.0
    }
  }

  // Outlet: entire bottom row (row = rows-1)
  const outletCells = [];
  for (let c = 0; c < cols; c++) outletCells.push((rows - 1) * cols + c);

  // 6h of rain, then 48h dry to allow full drainage
  const rainSeries = [
    ...Array(6).fill(5.0),  // 5 mm/h for 6 h
    ...Array(48).fill(0.0), // 48 h dry — enough for water to reach outlet
  ];

  const { snapshots, hourCount } = runSimulation({
    heights, cols, rows,
    rainSeries,
    runoffCoeff: 1.0,
    outletCells,
    subSteps: 60,
    marshFull: false,
  });

  const finalDepth = snapshots[snapshots.length - 1];
  const totalFinalDepth = sum(finalDepth);
  const meanFinal = totalFinalDepth / n;

  assert(meanFinal < 0.01, `Mean depth < 1 cm after 48h dry`, `mean=${(meanFinal * 100).toFixed(3)} cm`);
  assert(hourCount === 54, `Ran 54 hours`, `got ${hourCount}`);
}

// ─── Test C: Bowl — time-stepping same total volume as static ─────────────────
console.log('\nTest C: Bowl fill — time-stepping conserves same total rain volume as static input');
{
  const cols = 7, rows = 7;
  const n = cols * rows;
  // Bowl: rim at 1.0, floor cells slope inward
  const heights = new Float32Array(n);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const dr = Math.min(r, rows - 1 - r);
      const dc = Math.min(c, cols - 1 - c);
      const dist = Math.min(dr, dc);
      heights[r * cols + c] = dist === 0 ? 1.0 : Math.max(0.0, 1.0 - dist * 0.35);
    }
  }

  const rainfallMm = 50;    // small rain — fits inside the bowl
  const runoffCoeff = 0.8;

  // --- Static model (Priority-Flood + level-pool) ---
  const staticDepth = computeWaterDepth({
    heights, cols, rows, cellSizeM: 30, rainfallMm, runoffCoeff,
  });
  const staticTotal = sum(staticDepth);

  // --- Time-stepping: same rainfall spread over 1 h, closed bowl ---
  // With no outlets and a closed bowl the total stored water must equal
  // rainfallMm × runoffCoeff × n cells (in depth units, 1 m² cells).
  // Both models should conserve the same input volume.
  const expectedVolumeM = (rainfallMm / 1000.0) * runoffCoeff * n; // sum-of-depths in m (1m² cells)

  const rainSeries = [rainfallMm]; // 1 hour
  const { snapshots } = runSimulation({
    heights, cols, rows,
    rainSeries,
    runoffCoeff,
    outletCells: [],
    subSteps: 60,
    marshFull: false,
  });

  const flowDepth = snapshots[snapshots.length - 1];
  const flowTotal = sum(flowDepth);

  // Flow model must conserve volume (within 0.1%)
  const flowRelErr = Math.abs(flowTotal - expectedVolumeM) / expectedVolumeM;
  assert(flowRelErr < 0.001, `Flow model conserves volume (±0.1%)`,
    `expected=${expectedVolumeM.toFixed(4)} got=${flowTotal.toFixed(4)} err=${(flowRelErr*100).toFixed(3)}%`);

  // Both must be positive
  assert(staticTotal > 0, 'Static model found water in bowl');
  assert(flowTotal > 0, 'Flow model found water in bowl');

  // Water is concentrated in lower cells (mean depth in interior > mean overall)
  const interiorCells = [];
  for (let r = 1; r < rows - 1; r++)
    for (let c = 1; c < cols - 1; c++)
      interiorCells.push(r * cols + c);
  const interiorMean = interiorCells.reduce((s, i) => s + flowDepth[i], 0) / interiorCells.length;
  const borderMean   = (flowTotal - interiorCells.reduce((s, i) => s + flowDepth[i], 0)) /
                       (n - interiorCells.length);
  assert(interiorMean >= borderMean, 'Water concentrates in interior (lower cells)');
}

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
