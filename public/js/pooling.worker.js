/**
 * web/js/pooling.worker.js
 * Web Worker for running Priority-Flood depression filling
 * and level-pool water routing off the main browser thread.
 */

import { computeWaterDepth, priorityFlood } from './pooling-core.js';

let cachedFilled = null;
let cachedCols = 0;
let cachedRows = 0;

self.onmessage = function (e) {
  const {
    id,
    heights,
    cols,
    rows,
    cellSizeM,
    rainfallMm,
    runoffCoeff,
  } = e.data;

  try {
    const H = heights instanceof Float32Array ? heights : new Float32Array(heights);

    // Cache the Priority-Flood spill surface since terrain heights are static
    if (!cachedFilled || cachedCols !== cols || cachedRows !== rows) {
      cachedCols = cols;
      cachedRows = rows;
      cachedFilled = priorityFlood(H, cols, rows);
    }

    const depth = computeWaterDepth({
      heights: H,
      filled: cachedFilled,
      cols,
      rows,
      cellSizeM: cellSizeM || 30,
      rainfallMm: rainfallMm !== undefined ? rainfallMm : 100,
      runoffCoeff: runoffCoeff !== undefined ? runoffCoeff : 0.8,
    });

    // Transfer depth buffer back to main thread
    self.postMessage(
      {
        id,
        depth,
        status: 'ok',
      },
      [depth.buffer]
    );
  } catch (err) {
    self.postMessage({
      id,
      error: err.message,
      status: 'error',
    });
  }
};
