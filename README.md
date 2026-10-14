# Aero Lab

A web lab for experimenting with aerodynamics, load transfer, and slipstream in sim racing.
You can compare F1 (2021 and 2022 rules), LMH/LMDh hypercars, GT3, and high-performance road cars under the same conditions.

## Run

ES modules don't load from `file://`, so serve the folder from a local server.

```bash
python3 -m http.server 8000
# open http://localhost:8000 in a browser
```

Tests (Node 18+):

```bash
node --test tests/*.test.mjs
```

## Experiments

| Tab | What it shows |
| --- | --- |
| Speed sweep | Downforce/drag split front and rear, ride height, max braking and lateral G, required power, and top speed versus speed |
| Braking | Full braking: deceleration G, load transfer, nose dive versus downforce change, aero balance shift, limiting axle, ideal bias, compared with rigid aero, plus a car-attitude replay |
| Slipstream | Drag reduction and downforce loss versus gap (front and rear separately), cornering G in dirty air, and a straight-line drag race (overtake point, DRS) |
| Car comparison | All presets compared on the same conditions |

## Model

The model is quasi-static and coefficient-based, not CFD. It combines a ride-height aero map with load transfer and a load-sensitive tire model, the same approach sim racing physics engines use. See the "Model" tab in the app for the equations and what is left out.

- `js/physics.js`: the physics model (pure functions, no DOM dependency)
- `js/cars.js`: car presets and the parameter schema
- `js/chart.js`, `js/carview.js`: canvas charts and the side-view car diagram
- `js/app.js`: the UI

All preset values are estimates based on public sources. Treat them as a starting point for seeing the direction and relative size of changes, not as absolute values.
