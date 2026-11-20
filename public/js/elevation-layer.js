/**
 * web/js/elevation-layer.js
 * Renders the DEM as a coloured elevation slab above the map.
 * Heights are exaggerated by cfg.dem.exaggeration (default 10×).
 * Colour: teal (low) → yellow (high) — matches --low-col / --high-col in CSS.
 *
 * Uses Cesium PointPrimitiveCollection so it works without WebGL extensions.
 * Falls back to a synthetic DEM if data/dem.json is absent.
 */

const TEAL   = Cesium.Color.fromCssColorString('#00bcd4');
const YELLOW = Cesium.Color.fromCssColorString('#ffeb3b');

export class ElevationLayer {
  constructor(viewer, cfg, demData) {
    this._v       = viewer;
    this._cfg     = cfg;
    this._demData = demData;
    this._prim    = null;   // PointPrimitiveCollection
    this._exag    = cfg.dem?.exaggeration ?? 10;
    this._visible = false;
  }

  async show() {
    if (this._prim) {
      this._prim.show = true;
      return;
    }

    const grid = this._buildGrid();
    const { cols, rows, west, south, cellLon, cellLat,
            elevMin, elevMax, heights } = grid;

    const pts = this._v.scene.primitives.add(
      new Cesium.PointPrimitiveCollection()
    );
    this._prim = pts;

    const baseHeight = 10;   // metres above WGS84 to float the slab

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const rawH = heights[r * cols + c];
        // Normalise 0–1
        const t = elevMax > elevMin ? (rawH - elevMin) / (elevMax - elevMin) : 0;
        // Exaggerated height: start at baseHeight, add exaggerated delta
        // Datum note: DEM is EGM2008-referenced; we add directly above WGS84
        // ellipsoid at the base height — this is artistic exaggeration only.
        const dispH = baseHeight + rawH * this._exag;

        const lon = west  + (c + 0.5) * cellLon;
        const lat = south + (r + 0.5) * cellLat;

        pts.add({
          position: Cesium.Cartesian3.fromDegrees(lon, lat, dispH),
          color: Cesium.Color.lerp(TEAL, YELLOW, t, new Cesium.Color()),
          pixelSize: 4,
        });
      }
    }

    // Animate rise
    const startTime = performance.now();
    const duration  = 2000;
    const riseH     = 1500;   // metres total rise animation

    let removeListener = null;
    const onPostRender = () => {
      const elapsed = performance.now() - startTime;
      const frac    = Math.min(elapsed / duration, 1);
      const eased   = 1 - Math.pow(1 - frac, 3);   // cubic ease-out

      // Shift entire collection upward then settle
      const offset  = riseH * (1 - eased);
      pts.modelMatrix = Cesium.Matrix4.fromTranslation(
        new Cesium.Cartesian3(0, 0, offset)
      );

      if (frac >= 1 && removeListener) {
        removeListener();   // detach listener once animation completes
        removeListener = null;
      }
    };

    removeListener = this._v.scene.postRender.addEventListener(onPostRender);

    this._visible = true;
  }

  hide() {
    if (this._prim) this._prim.show = false;
    this._visible = false;
  }

  // ── Build grid from demData or synthesise ─────────────────────────────────
  _buildGrid() {
    if (this._demData?.heights) {
      return this._demData;
    }

    // Synthetic DEM: gentle slope south→north with Pallikaranai marsh depression
    const cfg  = this._cfg;
    const bb   = cfg.bbox;
    const cols = 60, rows = 50;
    const cellLon = (bb.east - bb.west)   / cols;
    const cellLat = (bb.north - bb.south) / rows;

    const heights = new Float32Array(cols * rows);
    // Base elevation ~6 m above sea level in this area
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const lon = bb.west  + (c + 0.5) * cellLon;
        const lat = bb.south + (r + 0.5) * cellLat;

        // General very slight slope northward along OMR ridge
        let h = 6 + (lat - bb.south) / (bb.north - bb.south) * 4;

        // Pallikaranai marsh — centred ~12.918°N, 80.218°E — depression
        const dLon = (lon - 80.218) / 0.03;
        const dLat = (lat - 12.918) / 0.025;
        const dist  = Math.sqrt(dLon * dLon + dLat * dLat);
        if (dist < 1) h -= 3.5 * Math.pow(1 - dist, 1.8);   // bowl shape

        // OMR road embankment ridge (lon ~80.233) — slight rise
        const roadD = Math.abs(lon - 80.233) / 0.004;
        if (roadD < 1) h += 1.2 * Math.pow(1 - roadD, 2);

        // Perungudi low-lying south-east
        const pDLon = (lon - 80.247) / 0.015;
        const pDLat = (lat - 12.934) / 0.015;
        const pDist  = Math.sqrt(pDLon * pDLon + pDLat * pDLat);
        if (pDist < 1) h -= 2 * Math.pow(1 - pDist, 1.5);

        // Thoraipakkam slight hollow south
        const tDLon = (lon - 80.223) / 0.012;
        const tDLat = (lat - 12.912) / 0.012;
        const tDist  = Math.sqrt(tDLon * tDLon + tDLat * tDLat);
        if (tDist < 1) h -= 1.5 * Math.pow(1 - tDist, 1.5);

        // Noise for realism
        h += 0.3 * Math.sin(lon * 500) * Math.cos(lat * 400);
        heights[r * cols + c] = Math.max(0, h);
      }
    }

    const elevMin = Math.min(...heights);
    const elevMax = Math.max(...heights);

    return {
      cols, rows,
      west: bb.west, south: bb.south,
      cellLon, cellLat,
      elevMin, elevMax,
      heights,
    };
  }
}
