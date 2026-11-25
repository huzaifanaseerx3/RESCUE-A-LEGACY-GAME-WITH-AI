# STILLFRAME — Part 2: Vite + TypeScript Restructuring

## Original project structure

The original project was a single 7,421-line `index.html` containing the page markup, styles, one inline JavaScript module, WGSL shader template strings, level definitions, UI, audio synthesis, and the full game simulation. It imported `mat4` and `vec3` from the jsDelivr CDN URL for `wgpu-matrix` 3.4.2.

The original root `index.html` has been kept unchanged. The Vite application is rooted at `app/`, configured in `vite.config.ts`; this lets the original file remain available for comparison while `app/index.html` is the minimal Vite entry page.

## New project structure

```text
.
├── index.html                 # Original game source, unchanged
├── PART1.md
├── PART2.md
├── BUGS.md
├── package.json
├── package-lock.json
├── tsconfig.json
├── vite.config.ts             # Vite root is app/
└── app/
    ├── index.html             # Minimal HTML and Vite entry point
    └── src/
        ├── main.ts            # Styles import and application boot
        ├── game.ts            # Simulation, physics, combat, replay, and frame orchestration
        ├── graphics.ts        # WebGPU setup, meshes, renderer, and shader imports
        ├── camera.ts          # Camera matrices and projection
        ├── input.ts           # Keyboard, mouse, and gamepad input
        ├── timing.ts          # Fixed-step clock and animation-frame loop
        ├── audio.ts           # Web Audio engine and procedural sound generation
        ├── levels.ts          # Level geometry builder and all level definitions
        ├── ui.ts              # Menus, HUD, settings, and results
        ├── styles.css         # Styles extracted from the original page
        └── shaders/
            ├── common.wgsl
            ├── scene.wgsl
            ├── shadow.wgsl
            ├── glass.wgsl
            ├── fx.wgsl
            ├── post.wgsl
            ├── outline.wgsl
            ├── bloom.wgsl
            └── final.wgsl
```

Generated `node_modules/` and `dist/` folders are ignored by Git.

## Module boundaries

- `main.ts` imports the extracted stylesheet and starts the game.
- `graphics.ts` owns WebGPU initialization, GPU buffers, mesh support, render pipelines, and pass submission.
- `camera.ts`, `input.ts`, and `timing.ts` isolate the camera, input collection, and fixed-step loop.
- `audio.ts` contains the procedural Web Audio implementation and generated sound effects.
- `levels.ts` contains the original `LevelBuilder`, level geometry helpers, and campaign data.
- `ui.ts` contains the original UI and imports the campaign act names.
- `game.ts` retains the tightly connected world/physics/combat/effects/game-state implementation and coordinates the modules above.

The simulation and rendering internals in `game.ts` still share many small helpers and state conventions. Keeping those related routines together avoids changing their execution order or behavior during this migration; further decomposition should be done with focused tests rather than broad mechanical rewrites.

## Dependencies

- `wgpu-matrix` is a runtime dependency and replaces the original CDN import.
- `vite` serves the app and creates the production bundle.
- `typescript` provides the no-emit type-check command.
- `@webgpu/types` supplies WebGPU API type declarations.
- `@types/node` supplies types used by the Vite config's `node:url` import.

The migrated code type-checks with `strict: false` in `tsconfig.json`. This keeps the initial mechanical migration practical while allowing TypeScript to catch module, API, and declared-type errors; it is not a claim that the legacy game has been fully annotated or made strict-TypeScript clean.

## Shader migration

All nine original WGSL template strings were extracted into individual `.wgsl` files without changing their shader text. `graphics.ts` imports each file with Vite's `?raw` suffix and concatenates the same common/post-processing shader sources with their respective stage sources when creating shader modules. Shader compilation diagnostics continue to be logged by the existing renderer code.

## Responsive sizing

The original viewport-filling canvas and responsive UI styles were extracted to `styles.css`. `Gfx.observeResize()` still observes the canvas, updates the GPU canvas backing dimensions, and applies the configured resolution scale. `Game` still updates both camera aspect ratios and the horizontal field of view on graphics resize. This was exercised in the browser at 1280×720, 800×600, and 375×667 viewports; the canvas backing dimensions tracked each requested viewport size and the title screen remained present.

## Build and type-check

From the project root:

```powershell
npm install
npm run typecheck
npm run build
npm run dev
```

Verified in this migration:

- `npm install` — succeeded; dependencies were added to `package-lock.json`.
- `npm run typecheck` — succeeded (`tsc --noEmit`).
- `npm run build` — succeeded with Vite 6.4.6; emitted `dist/index.html`, CSS, and the bundled JavaScript.
- `npm run dev -- --host=127.0.0.1 --strictPort` — started successfully for browser verification.

For Part 4, the Vite build output is set to `app/dist/` so the GitHub Pages workflow can upload that directory.

## Behavior-preservation verification

- The root `index.html` remains unchanged (SHA-256: `4B1C57006D70AF281775028DC269BDB4E55FDAF44972C3BC56D8AEC55E009424`).
- The level-unlock expression and the `startLevel()` guard remain unchanged in meaning and location in the migrated modules. The reversed `TimeScaleDriver.update()` arguments also remain in the original order at the migrated call site. Both are documented in `BUGS.md`; neither was fixed.
- Chromium loaded the Vite title page and showed the STILLFRAME title, tagline, menu buttons, and control hints.
- The browser console reported WebGPU adapter `intel gen-8` and `[game] built level 1-1 ... (23 boxes)`. There were no console errors or page errors. Chromium emitted one warning that `powerPreference` is ignored on Windows.
- The browser viewport/canvas resize behavior was checked at three sizes as noted above.
- **Gameplay was not claimed or tested.** In particular, the preserved level-unlock bug prevents starting Level 1 from a fresh save, so combat, progression, and replay were not exercised.

## Migration limitations

The original root `index.html` is retained as the untouched source; run and build the migrated game through the Vite `app/` root, not by opening the original file. Strict TypeScript mode is not enabled yet, and the bulk of the closely coupled simulation remains in `game.ts`. The known fresh-save start blocker also limits browser testing of gameplay. No gameplay fix or new feature was introduced.
