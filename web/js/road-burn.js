/**
 * web/js/road-burn.js
 * "Road burning": lowers the terrain along OSM roads so rain runs down streets
 * and collects in street-level dips, which a 30 m surface DEM (rooftops, trees)
 * cannot show. Pure functions, browser + Node. Uses NO validation data.
 *
 * Heights are metres above sea level (same datum as grid.heights); the burn is a
 * depth in metres subtracted from every cell a road passes through.
 */

/**
 * @param {ArrayLike<number>} heights  grid.heights (row-major, row 0 = north)
 * @param {Object} grid  {west,east,south,north,cols,rows}
 * @param {Array} roads  roads.json: [{coords:[[lon,lat],...]}]
 * @param {number} burnM  metres to lower road cells (0 = off)
 * @returns {Float32Array} new heights array (input untouched)
 */
export function burnRoads(heights, grid, roads, burnM) {
  const out = Float32Array.from(heights);
  if (!(burnM > 0) || !roads) return out;
  const { west, east, south, north, cols, rows } = grid;
  const seen = new Uint8Array(cols * rows); // burn each cell once, however many roads cross it
  const toC = (lon) => Math.floor(((lon - west) / (east - west)) * cols);
  const toR = (lat) => Math.floor(((north - lat) / (north - south)) * rows);
  const mark = (lon, lat) => {
    const c = toC(lon), r = toR(lat);
    if (c < 0 || c >= cols || r < 0 || r >= rows) return;
    const i = r * cols + c;
    if (!seen[i]) { seen[i] = 1; out[i] -= burnM; }
  };
  for (const road of roads) {
    const pts = road.coords || [];
    for (let k = 0; k + 1 < pts.length; k++) {
      const [x0, y0] = pts[k], [x1, y1] = pts[k + 1];
      // sample every ~1/3 cell so no cell along the segment is skipped
      const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0) / (east - west) * cols,
                                                 Math.abs(y1 - y0) / (north - south) * rows) * 3));
      for (let s = 0; s <= n; s++) mark(x0 + ((x1 - x0) * s) / n, y0 + ((y1 - y0) * s) / n);
    }
  }
  return out;
}
