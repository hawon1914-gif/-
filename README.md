# Aero Lab

A lab for testing aerodynamics, load transfer, and slipstream from a sim racing perspective.
It compares F1 (2021 and 2022 regulations), LMH/LMDh hypercars, Valkyrie- and Chiron-class road hypercars, GT3, and high-performance road cars under the same conditions.

## Running it

ES modules don't run when you open the file directly (`file://`), so you have to open it through a local server. No internet connection is needed (three.js is included in the repository).

- **Windows**: double-click `start.bat`
- **macOS / Linux**: run `./start.sh` in a terminal

Either one opens http://localhost:8000 in your browser. Python 3 is required. If it isn't installed, get it from https://www.python.org.

To run it manually:

```bash
python3 -m http.server 8000
```

Tests (Node 18+):

```bash
node --test tests/*.test.mjs
```

## Experiments

| Tab | Contents |
| --- | --- |
| 3D wind tunnel | Per-car 3D model + real-time 2D lattice Boltzmann flow solver (center section / side silhouette), 3D streamlines, full-braking attitude, leading car's wake, loading a .glb model |
| Speed sweep | Front/rear downforce and drag vs. speed, ride height, max braking and lateral G, required power, top speed |
| Braking | Deceleration G, load transfer, change in downforce and aero balance from nose dive, limiting axle, ideal bias, comparison with rigid aero, attitude replay |
| Slipstream | Drag reduction and downforce loss vs. gap (front and rear separately), cornering G in dirty air, straight-line drag race (overtaking point, DRS) |
| Car comparison | All presets under the same conditions |

## Model

- **Quasi-static model**: not CFD. It combines a coefficient-based aero map that depends on ride height, load transfer, and a tire load-sensitivity model, the same approach sim racing physics engines use.
- **3D wind tunnel**: solves the fluid equations on a 2D section of the car using the lattice Boltzmann method. The grid Reynolds number is thousands of times smaller than reality, so read the coefficients as relative trends, not real values.

All preset values are estimates based on public sources. The "Model" tab in the app lists the formulas used and what is left out.

## Files

- `js/physics.js`: physics model (pure functions)
- `js/cars.js`: car presets and the parameter schema
- `js/model3d.js`: procedural 3D models, glTF alignment, geometry-to-grid conversion
- `js/lbm-worker.js`: lattice Boltzmann fluid solver (Web Worker)
- `js/tunnel.js`: three.js scene, streamlines, measured values
- `js/chart.js`, `js/carview.js`: charts and side view
- `js/app.js`: UI
- `vendor/three/`: three.js r160 (MIT license)
- `assets/models/`: public 3D models (see the README in that folder for licenses)
