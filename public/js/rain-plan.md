# Rain Simulation Plan (`web/js/rain.js`)

## Objective
Implement an interactive, high-performance raindrop simulation that runs smoothly (target $\ge 45\text{ FPS}$) over the exaggerated terrain slab in CesiumJS with $3,000$ simultaneous particles.

---

## 1. Mathematical & Physical Principles
- **Grid Coordinates & Dimensions:**
  - $163\text{ columns} \times 184\text{ rows} = 29,992\text{ cells}$.
  - Bounds: $W=80.205^\circ, S=12.925^\circ, E=80.250^\circ, N=12.975^\circ$.
  - Row order: North-to-South ($r=0$ at North, $r=183$ at South).
- **Steepest Descent (D8 Directional Graph):**
  - For any internal cell $(r, c)$, evaluate the 8-connected Moore neighborhood:
    $$\Delta r \in \{-1, 0, 1\}, \quad \Delta c \in \{-1, 0, 1\}, \quad (\Delta r, \Delta c) \neq (0,0)$$
  - Calculate slope:
    $$S_i = \frac{h(r, c) - h(r + \Delta r, c + \Delta c)}{d_i}$$
    where $d_i = 1$ for orthogonal neighbors and $d_i = \sqrt{2}$ for diagonal neighbors.
  - Precompute a downstream transition lookup table `nextCell[nCells]` in TypedArray ($O(1)$ lookup per tick):
    - Points to neighbor index with maximum positive slope $S_i > 0$.
    - Set to $-1$ if cell is a pit ($S_i \le 0$ for all neighbors) or border cell.
- **Two-Phase Particle Lifecyle:**
  1. **Phase 1: Falling (Freefall):**
     - Drops spawn at a random cell $(r, c)$ at an altitude $400\text{ m}$ above the terrain slab.
     - Fall vertically towards the exaggerated surface elevation:
       $$Z_{\text{surface}} = \text{baseHeight} + (h - \text{minH}) \times \text{exaggeration}$$
     - Fall speed tuned so drops reach the ground in $\approx 0.5 - 0.8\text{ s}$.
  2. **Phase 2: Rolling (Marble Sliding):**
     - Once touching the surface, the drop slides smoothly towards `nextCell[idx]`.
     - Rolling speed: $1\text{ cell per } 80\text{ ms}$ (interpolating position smoothly via parametric $t \in [0, 1]$).
     - Upon reaching the cell center:
       - If `nextCell == -1` (pit/depression or grid exit): drop halts, increments `arrivals[cellIdx]`, and after a small settling delay, respawns while rain is active.
       - Otherwise, advances to the next cell downhill.

---

## 2. Zero-Allocation Rendering Architecture
- **Single Cesium Primitive Collection:**
  - One `Cesium.PointPrimitiveCollection` managing $N=3,000$ points.
  - Pre-allocated TypedArrays for all particle states:
    - `phase`: `Uint8Array(N)` ($0=\text{inactive}, 1=\text{falling}, 2=\text{rolling}, 3=\text{pooled}$)
    - `currR`, `currC`, `nextR`, `nextC`: `Int16Array(N)`
    - `progress`: `Float32Array(N)` ($t \in [0, 1]$)
    - `fallHeight`: `Float32Array(N)`
    - `settleTime`: `Float32Array(N)`
    - `arrivals`: `Uint32Array(rows * cols)` (exported via `getArrivals()`)
- **Animation Loop (`requestAnimationFrame`):**
  - No heap object or vector allocations inside `tick()`:
  - Updates point coordinates directly using preallocated scratch variables (`scratchCartesian3`).
  - Measures live FPS over a 1-second rolling window and reports performance metrics.

---

## 3. Public API
- `initRain(viewer, options)`: Precomputes D8 flow graph, creates primitive collection.
- `start()`: Activates spawning and the `requestAnimationFrame` loop.
- `stop()`: Halts spawning, clears active points.
- `getArrivals()`: Returns reference to `Uint32Array(rows * cols)`.
- `getFps()`: Returns current rendering FPS.
