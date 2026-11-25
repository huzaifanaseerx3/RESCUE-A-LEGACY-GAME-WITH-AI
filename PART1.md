# STILLFRAME — Part 1: Understand the Code

> **Scope and evidence.** This report is based on the 7,421-line `index.html` source. Line numbers below are approximate and refer to that file. Statements about the browser session are identified as user-reported observations; they are not independently reproduced here.

## 1. GAME OVERVIEW

STILLFRAME is a single-file, first-person action game rendered with WebGPU. The page contains its UI and CSS as well as an inline JavaScript module. It defines 15 levels in three acts: Transit, Office Tower, and Rooftops (`ACT1`, `ACT2`, `ACT3`, then `LEVELS`, around lines 2,837–3,388). The first level is `1-1`, “PLATFORM” (around lines 2,611–2,640).

The player fights waves of enemies in enclosed or rooftop environments. The source defines three enemy types—`walker`, `rusher`, and `marksman`—and weapons including a pistol, scatter gun, carbine, and blade (around lines 4,796–4,800 and 4,846 onward). Pick-up items such as bottles, bricks, and mugs can also be handled and thrown. Enemies can shoot, pursue or approach the player, and be stunned, disarmed, or killed.

**Distinctive intended mechanic — time dilation.** The title tagline is “time moves only when you move” (`Ui.showTitle`, around lines 3,545–3,551). `TimeScaleDriver` (around lines 6,161–6,185) is intended to make simulation time respond to the player’s movement, mouse-look speed, actions, and airborne state. The loop applies that scale to its fixed-step simulation. In other words, the design is a first-person combat game in which movement and combat actions accelerate the world while standing still slows it dramatically.

There is an important implementation caveat: `Game.frame` calls `TimeScaleDriver.update` with the movement-speed and max-speed arguments reversed (around line 6,998; see **Design Problems**). As a result, the source does not implement the intended movement-based time scaling correctly: at rest, its `moveInput` calculation becomes `4 / 0`, clamped to 1.0; at normal speeds up to the nominal 4-unit walk speed, the reversed ratio also clamps to 1. The source therefore supports the mechanic as an intended design, but also contains a defect that undermines it.

**Winning a level.** `World.checkWin` (around lines 5,778–5,791) considers all waves spawned once the wave list and spawn queue are exhausted. For levels without an `exit`, the player clears the level after all spawned enemies are dead. For levels with an `exit`, the player must enter the defined rectangular exit zone; the level definition controls whether the exit additionally requires all enemies to be dead. The game then enters its cleared state, records the run, and presents results (`Game.enterCleared` and `Game.showResults`, around lines 6,896–6,927). Results offer a replay, retry, and—when another level exists—a next-level action.

## 2. PLAYER CONTROLS

The default bindings are declared in `DEFAULT_BINDINGS` (around lines 1,876–1,892); the title screen also displays the principal controls (`Ui.showTitle`, around lines 3,545–3,551).

| Action | Control | Source behavior |
|---|---|---|
| Move forward/back/left/right | **W/A/S/D** or **arrow keys** | `Input.moveAxes()` combines the held directions and normalizes diagonal input (around lines 1,958–1,982). |
| Look / aim | **Mouse movement** | `Input.onMouseMove` accumulates movement only while the canvas has pointer lock (around lines 2,012–2,016). `PlayerController.look` turns that into yaw and pitch, with sensitivity and optional Y inversion (around lines 6,040–6,053). |
| Fire / primary action | **Left mouse button** | `Mouse0` maps to `fire`. `World.primaryAction()` shoots a held gun, slashes with the blade, throws a held non-weapon item, or punches when unarmed. If unarmed and aiming at a nearby prop, the primary action can instead pick it up (around lines 5,334–5,370). An empty gun produces a dry-fire event and is thrown. |
| Throw held item | **Right mouse button** | `Mouse2` maps to `throw`; `World.applyPlayerFrame()` throws the held item when this action is pressed (around lines 1,881–1,885 and 5,313–5,327). |
| Pick up / interact | **E** | `KeyE` maps to `interact`; it picks up the aimed prop or a nearby prop (around lines 1,884 and 5,313–5,321). |
| Jump | **Space** | `PlayerController.update()` jumps only when movement is allowed and the player is grounded (around lines 6,108–6,113). |
| Restart | **R** | In the playing state, `Game.frame()` restarts the current level when `restart` is pressed (around lines 6,984–6,990). In the dead state, R or fire can restart after a short delay; otherwise the game automatically restarts after 1.4 seconds (around lines 7,002–7,006). |
| Pause / resume | **Escape**, then click **RESUME** | The input binding names Escape as `pause`, but `Game.frame()` does not directly consume that action. Instead, Escape normally exits browser pointer lock; `Game` listens for `pointerlockchange` and calls `pause()` when a playing/intro session loses the lock (around lines 6,775–6,778 and 6,867–6,872). Resume is a pause-menu button and requests pointer lock again. |
| Request mouse capture | **Click the canvas** | `Input` requests pointer lock on canvas click (around lines 1,926–1,940). Losing pointer lock while playing pauses the game. |
| Debug time freeze / real-time toggle / overlay | **F2 / F3 / F4** | These are explicitly checked in `Game.frame()` (around lines 6,963–6,968). |
| Declared but not confirmed active | **F1, Space, Shift, left Ctrl** | `debugToggleCamera`, `flyUp`, and `flyDown` are listed in the bindings (around lines 1,886–1,892), but the source does not show corresponding gameplay handling for them. Space is also the normal jump key. Do not treat the camera/fly behavior as verified. |

`Input` also supports a standard-mapped gamepad (around lines 1,893–1,905 and 2,028–2,055): left stick moves, right stick looks, and standard buttons map to jump, interact, restart, fire, throw, and pause. Caveat: `Game.frame()` does not consume the `pause` action, so the declared gamepad pause binding is not shown triggering the pause menu. This support is in the source; it is not evidence that a controller was tested in the reported browser session.

## 3. GAME ARCHITECTURE

### WebGPU graphics initialization

`boot()` locates the `#gfx` canvas and `#overlay`, then awaits `Gfx.create()` (around lines 7,394–7,421). `Gfx.create()` checks `navigator.gpu`, requests a high-performance adapter and device, obtains a `"webgpu"` canvas context, selects the preferred canvas format, configures the context, sizes the canvas, and observes resizes (`Gfx.create`, around lines 509–581). It logs adapter information and reports unsupported WebGPU or device-loss errors. `Game` is constructed only after successful graphics initialization.

### Rendering and shaders

The renderer is `Renderer` (beginning around line 1,163). It builds WebGPU render pipelines from WGSL shader modules (around lines 1,290–1,380), batches mesh instances, writes uniform and instance data, and encodes GPU passes in `Renderer.render()` (around lines 1,467–1,605). The passes include shadows, opaque scene geometry, optional glass, line effects, a viewmodel, outlines, bloom, and the final canvas image. The scene and post-processing shaders are source strings embedded in the same file.

`Game.render()` builds the camera and viewmodel camera, draws the world and visual effects, updates post-processing values, calls `renderer.render()`, and updates the HUD (around lines 7,040–7,270). `drawWorld()` queues the level mesh, props, enemies, projectiles, and telegraph lines (around lines 7,100–7,160).

### Camera and player movement

`Camera` stores position, yaw, pitch, field of view, and view/projection matrices (around lines 1,837–1,874). `PlayerController` owns the player’s position, velocity, orientation, grounded state, and movement update (around lines 6,033–6,155). It applies acceleration, gravity, jumping, and collision movement through `StaticWorld.moveCharacter()`. The camera pose is subsequently formed from the player pose in `Game.render()`.

### Input handling

`Input` registers keyboard, mouse, window-blur, and canvas-click listeners (around lines 1,906–2,020). It tracks held keys separately from per-frame presses/releases, accumulates pointer-locked mouse movement, and polls gamepads (`Input.update()` and `pollGamepad()`). `Game.frame()` calls `input.update()` before it interprets actions (around lines 6,949–6,962).

### Game world and physics

Level geometry is described with `LevelBuilder` helpers and stored in each level definition as boxes (around lines 2,500–2,640). `buildLevelMesh()` turns the level definition into render meshes and shared static data (around lines 4,583–4,600). `StaticWorld` supplies collision queries, raycasts, character movement, and sphere resolution (around lines 4,204 onward). `NavGrid` provides enemy pathfinding (around lines 4,400–4,515).

`World` owns the per-run state: player, enemies, props, projectiles, wave queue, statistics, events, and clear/failure flags (around lines 5,220–5,270). `World.step()` advances that simulation; it processes waves, enemies, props, projectiles, collisions, cleanup, and win checks (around lines 5,680–5,720 and 5,721 onward).

### Enemies and combat

`ENEMY_PARAMS` sets walker, rusher, and marksman movement/combat parameters and hit points (around lines 4,809–4,820). `updateEnemy()` advances enemy state and behavior (around line 4,916); helper methods handle aiming, volleys, and melee (around lines 5,116–5,193). `World` implements player firing, punching, slashing, throwing, picking up, and killing enemies (around lines 5,298–5,680). Projectile collision checks include static geometry, enemy head/body, the player, and props (`World.stepProjectiles`, around lines 5,871–6,039).

### Level definitions and loading

`level(meta, build)` creates a level definition from metadata and geometry builder calls (around line 2,606). Each definition includes identifiers, player start pose, props, enemy waves, and sometimes an exit. `LEVELS` concatenates five levels from each of three acts (around lines 2,837, 3,062, 3,386–3,388). `Game.loadLevel()` selects a definition, caches its built scene, updates lighting/shadow bounds, and resets the world (around lines 6,800–6,825). The constructor loads a level before presenting the title screen, which explains how level geometry can be built even if a later Start action is refused.

### Audio

`AudioEngine` creates an `AudioContext` after a user gesture, routes sound through master/SFX/music gain nodes, synthesizes sound buffers, and starts procedural music (around lines 2,233–2,395). It adjusts sound playback and music filtering according to the time scale (`setTimeScale`, around lines 2,263–2,279). `Game.handleEvents()` and `handleEvent()` translate world events—shots, impacts, deaths, pickups, and others—into sound and visual effects (around lines 7,272–7,342).

### User interface

`Ui` creates the HUD, title card, menu screens, settings, pause screen, results screen, and replay bar (around lines 3,400 onward). UI actions call handlers supplied by `Game` in its constructor (around lines 6,747–6,765). HUD content includes the item, ammo, hint, level name, remaining enemies, and time-scale feedback (`Game.updateHud`, around lines 7,245–7,262).

### Save system and progression

The save key is `"stillframe.save"` and the default data is version 1, with settings and per-level records (`KEY`, `defaultSettings`, and `loadSave`, around lines 3,736–3,771). `writeSave()` stores JSON in `localStorage` and logs read/write errors (around lines 3,771–3,780). Settings are persisted when applied; a successful clear records `cleared`, best real time, and best simulation time in `Game.showResults()` (around lines 6,907–6,927).

Level unlocking is checked by `Ui.isUnlocked()` (around lines 3,717–3,722). Its current implementation contains the confirmed first-level bug described below.

### Game loop and timing

`Loop.tick()` runs once per `requestAnimationFrame`: it begins a real-time frame, calls the game’s frame callback, advances scaled simulation time, runs fixed steps, calculates interpolation alpha, renders, and schedules the next animation frame (around lines 2,058–2,137). `Time` uses `FIXED_STEP = 1 / 120`, caps real delta at 0.1 seconds, and allows at most eight simulation steps per rendered frame (around lines 2,056–2,110). `Game.frame()` processes input and state; `Game.fixedStep()` calls `world.step(FIXED_STEP)` while playing, dead, or cleared (around lines 7,020–7,025).

### Replay / recording

`ReplayRecorder` saves each player frame and the number of fixed simulation steps taken for that frame (`push()` and `setLastSteps()`, around lines 6,571–6,584). `ReplayPlayer` re-applies those frames and steps a newly constructed `World` to reproduce a run (around lines 6,585–6,620). The results screen can start replay; its progress is shown in the replay bar, and a key press or click can skip it (`Game.startReplay()` / `endReplay()` around lines 6,930–6,944; `Ui.showReplayBar()` around lines 3,690–3,706).

### How the systems depend on one another

`boot()` creates `Gfx` before `Game`. `Game` constructs the renderer, input, UI, save state, mesh library, camera, and loop. A level definition feeds both scene construction and `World`; its static collision/navigation data is shared between those systems. Input updates the `PlayerController`, which supplies a player frame to `World`. The time driver controls how frequently world fixed steps run. World events are consumed by `Game` to drive audio and visual effects. Finally, `Game.render()` queues world and effects into `Renderer`, which submits WebGPU commands, while the UI presents the current game state and progression.

## 4. ONE FRAME EXPLAINED

The main execution path is `Loop.tick()` → `Game.frame()` → zero or more `Game.fixedStep()` calls → `Game.render()`:

1. **The browser schedules a frame.** `Loop.start()` requests an animation frame; `Loop.tick(now)` begins timing with `Time.beginFrame(now)` (around lines 2,125–2,137).
2. **Input is collected and normalized.** `Game.frame(t)` calls `input.update(dt)`. That transfers raw keyboard presses to per-frame sets, collects mouse deltas, and polls a gamepad (`Input.update()`, around lines 1,940–1,956; `Game.frame()`, around lines 6,949–6,953).
3. **The player is updated.** In the `"playing"` state, if pointer lock is active, `PlayerController.update()` reads look and movement input, changes velocity/position, applies gravity/jumping, and resolves static and enemy collisions. `Game.frame()` then packages the pose and pressed actions with `toFrame()` and calls `world.applyPlayerFrame(f)` (around lines 6,978–7,000 and 6,078–6,155). The frame is appended to the replay recorder.
4. **Actions and world simulation run.** `World.applyPlayerFrame()` applies interactions, throws, and primary actions immediately (around lines 5,298–5,370). The game selects a time scale. `Loop.tick()` then advances the scaled accumulator and repeatedly calls `Game.fixedStep()`, which calls `world.step(1/120)` in active world states. That step updates waves, enemies, props and projectiles, resolves collisions, and checks for clear/failure (around lines 2,073–2,103 and 7,020–7,025).
5. **The frame is prepared for drawing.** After fixed steps, `Loop.tick()` calculates interpolation alpha and calls `Game.render()`. The game handles queued events, updates effects, calculates the camera, draws world objects and the first-person viewmodel, and sets post-processing and HUD state (around lines 2,101–2,137 and 7,040 onward).
6. **WebGPU executes the render.** `Renderer.render()` writes frame/instance data, creates a command encoder, adds shadow/scene/effect/post-processing passes, finishes the command buffer, and submits it with `device.queue.submit([encoder.finish()])` (around lines 1,467–1,605).
7. **The next frame is requested.** `Loop.tick()` schedules the next `requestAnimationFrame` after rendering.

**Timing caveat:** the above is the execution flow, not proof that the intended slow-time effect works as designed. The time-scale call in step 4 has its movement-speed arguments reversed (details below).

## 5. DESIGN PROBLEMS

### 5.1 Confirmed: the first level is locked, so Start is a no-op

- **What and where:** `Ui.isUnlocked(index)` returns true for negative indices, then reads `this.levels[index - 1]` and returns true only if that previous level exists and is marked cleared (`index < 0` and `const prev = this.levels[index - 1]`, around lines 3,717–3,722). For index `0`, `this.levels[-1]` is undefined, so the method returns false. `Game.startLevel(index, lock)` immediately returns when `isUnlocked(index)` is false (around lines 6,837–6,840).
- **Why harmful:** a new save has no cleared levels. The first level (`index === 0`) is therefore locked, and every later level is also locked because its predecessor has not been cleared. The title’s Play action selects the first uncleared index, which is 0 for a fresh save; `startLevel(0, true)` then returns before requesting pointer lock, loading the level, or hiding the screen. Level buttons are rendered disabled when `isUnlocked()` is false (`Ui.showLevels`, around lines 3,562–3,578).
- **Observed behavior:** the user reports that clicking Start currently does nothing and all levels appear locked. This is consistent with the source path above. The browser behavior itself is reported by the user, not independently tested for this report.
- **Later improvement:** explicitly allow index 0 (or define unlock state in a way that does not require a previous level), and add focused tests for fresh-save level 0, later locked levels, and a level unlocked by clearing its predecessor.

### 5.2 Confirmed: the time-scale movement arguments are reversed

- **What and where:** `TimeScaleDriver.update(realDt, planarSpeed, maxSpeed, ...)` computes `planarSpeed / maxSpeed` (around lines 6,177–6,184). `Game.frame()` calls it as `update(dt, WALK_SPEED, this.player.planarSpeed, ...)` (around line 6,998), placing the maximum speed where current planar speed is expected and vice versa.
- **Why harmful:** at rest, the calculation is `4 / 0`, which becomes infinity and clamps to 1. When the player moves at or below the nominal 4-unit speed, the reversed ratio is also at least 1 and clamps to 1. Thus the intended slow-motion-while-stationary / faster-time-while-moving behavior is largely defeated by this call, despite the driver’s minimum scale being 0.015. This conflicts with the title tagline and is separate from the level-lock bug.
- **Later improvement:** pass `this.player.planarSpeed` before `WALK_SPEED`, then test stationary, walking, looking, and airborne scale targets.

### 5.3 Fixed-step overload discards accumulated simulation time

- **What and where:** `Time.consumeStep()` permits at most `MAX_STEPS_PER_FRAME` (8) and sets `accumulator = 0` when the cap is reached (around lines 2,058 and 2,082–2,093).
- **Why harmful:** this protects against an unbounded “spiral of death” after a slow frame, but discards any remaining accumulated simulation time. Under sustained slow rendering or a large frame hitch, simulation time can fall behind real time, affecting enemy timing, movement, and the number of simulation steps recorded for replay.
- **Later improvement:** retain a bounded remainder or explicitly document and measure the time-drop policy; test behavior under simulated frame hitches and check replay consistency.

### 5.4 A large inline game module raises maintenance and testability costs

- **What and where:** the whole page, including UI styles, WGSL shader strings, graphics setup, input, physics, levels, audio, saves, replay, and game logic, is in one 7,421-line `index.html` file. For example, `Renderer`, input/timing, level definitions, `World`, and `Game` occur at widely separated locations in the same inline module.
- **Why harmful:** unrelated systems share one large source unit, making focused review, isolated testing, and safe changes harder. Bugs such as the two argument/order errors above are harder to catch when important contracts are separated across thousands of lines.
- **Later improvement:** after preserving the single-file original as required, consider extracting subsystems into modules with clear interfaces and adding small tests for unlock rules, time-scale calculations, and level completion.

## 6. SOURCE CODE EVIDENCE

| Subsystem or claim | Relevant function/class | Approx. line(s) | What the code demonstrates |
|---|---|---:|---|
| WebGPU setup and adapter reporting | `Gfx.create` | 509–581 | Requests adapter/device, configures the WebGPU canvas, sizes it, and logs adapter information. |
| Shader pipelines | `Renderer` initialization | 1,163–1,380 | Creates scene, shadow, glass, effects, outline, bloom, and final pipelines from WGSL modules. |
| GPU submission | `Renderer.render` | 1,467–1,605 | Encodes render passes and submits the finished command buffer. |
| Keyboard, mouse, gamepad bindings | `DEFAULT_BINDINGS`, `Input` | 1,876–2,055 | Lists controls, receives events, accumulates pointer-locked mouse motion, and polls gamepad input. |
| Fixed-step timing | `Time`, `Loop.tick` | 2,056–2,137 | Clamps real delta, scales simulation time, runs fixed steps, interpolates, and renders. |
| Procedural audio | `AudioEngine.unlock`, `startMusic`, `synthesizeAll` | 2,233–2,395 | Builds Web Audio nodes, procedural music, and sound buffers. |
| First level definition | `platform` | 2,606–2,640 | Defines `1-1 PLATFORM`, player spawn, props, geometry, and enemy waves. |
| Campaign structure | `ACT1`, `ACT2`, `ACT3`, `LEVELS` | 2,837; 3,062; 3,386–3,388 | Defines five levels per act and concatenates the campaign. |
| UI controls and menus | `Ui.showTitle`, `Ui.showLevels`, `Ui.showPause` | 3,545–3,578; 3,646 onward | Presents control hints, disabled level buttons, settings, and pause actions. |
| Save data | `KEY`, `loadSave`, `writeSave` | 3,736–3,780 | Stores versioned settings and level records in local storage. |
| Confirmed unlock condition | `Ui.isUnlocked` | 3,717–3,722 | Checks `levels[index - 1]`; index 0 therefore reads a missing level. |
| Level/world construction | `buildLevelMesh`, `World.constructor` | 4,583 onward; 5,220–5,298 | Builds render/static level data and initializes the runtime world. |
| Enemy AI and weapon types | `ENEMY_PARAMS`, `updateEnemy` | 4,809–4,820; 4,916 onward | Defines enemy behavior parameters and updates enemy state. |
| Completion conditions | `World.checkWin` | 5,778–5,791 | Clears no-exit levels when all waves are spawned and enemies dead; handles exit zones. |
| Player movement and jump | `PlayerController.update` | 6,078–6,155 | Applies mouse look, acceleration, jump/gravity, and collision-aware character movement. |
| Replay data model | `ReplayRecorder`, `ReplayPlayer` | 6,571–6,620 | Records player frames and fixed-step counts, then replays them in a new world. |
| Level loading and Start guard | `Game.loadLevel`, `Game.startLevel` | 6,800–6,840 | Builds/caches level and shows that a locked-level check returns before starting. |
| Pointer-lock pause behavior | `Game` constructor listener; `Game.pause` | 6,775–6,778; 6,867–6,872 | Pauses when pointer lock is lost while playing or in the intro. |
| Time-scale argument order | `TimeScaleDriver.update`; `Game.frame` | 6,177–6,184; 6,998 | Driver expects current speed then max speed, but caller passes `WALK_SPEED` then current speed. |
| World update order | `World.step`, `Game.fixedStep` | 5,680 onward; 7,020–7,025 | Advances enemies, waves, props, projectiles, collisions, and completion in fixed simulation steps. |
| User-reported GPU and level build | `Gfx.create` log; `Game.loadLevel` log | 556; 6,812 | Source logs adapter vendor/architecture/description and logs a built level ID/time/box count; it does not itself verify the specific reported Intel adapter. |

## 7. CONCLUSION

STILLFRAME initializes WebGPU, builds cached level scenes, and coordinates player input, a collision-aware world, enemy waves, combat, effects, audio, menus, saves, and replay from a single inline JavaScript module. Its frame loop processes input and player actions, advances world simulation in fixed steps, then queues and submits WebGPU rendering work. Levels are completed by eliminating all enemies or reaching their configured exit, after which the game saves results and offers progression or replay.

The most immediately visible source-confirmed defect is progression: `isUnlocked(0)` checks the nonexistent previous level, and `startLevel()` exits on that result. This explains the reported no-op Start button and all-locked level list for a fresh save. Separately, the call to `TimeScaleDriver.update()` reverses its speed arguments and undermines the game’s defining slow-time mechanic. The simulation also drops accumulated time after its fixed-step cap, and the all-in-one file structure makes focused maintenance and testing difficult.

**Browser-session note (user-reported):** WebGPU initialized successfully in the user’s browser, Intel Gen-8 was detected, and Level 1-1 was built. The user also reports that clicking Start currently does nothing and all levels appear locked. The source contains adapter and level-build logs that correspond to those first two observations; this analysis did not independently run the browser.
