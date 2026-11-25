# STILLFRAME - Bug Fixes and Known Issues

## 1. First level locked on a fresh save

- **Description:** A fresh save incorrectly treated Level 1-1 as locked, so the Play action did not start a level.
- **Reproduction steps (before the fix):**
  1. Open the app with no `stillframe.save` entry (for example, in a fresh browser profile).
  2. Click **PLAY** on the title screen.
  3. Observe that the title screen remains visible; opening **LEVELS** also shows levels locked.
- **Observed behavior (before the fix):** Clicking Play left the title screen unchanged. This was also reproduced by calling `Ui.isUnlocked()` with a fresh-save fixture: indices 0 and 1 both returned false.
- **Root cause:** `Ui.isUnlocked(index)` in `app/src/ui.ts` used to treat only negative indices as automatically unlocked, then read `this.levels[index - 1]`. At index 0, that reads `this.levels[-1]`, which is undefined. `Game.startLevel(index, lock)` in `app/src/game.ts` returns immediately when this check is false.
- **Fix applied:** `Ui.isUnlocked()` now returns true for `index <= 0`. For later indices it still requires the preceding level's `cleared` record.
- **Verification result:** In Chrome at `http://127.0.0.1:5173/`, the title screen loaded and clicking Play entered the Level 1-1 intro; the HUD showed `1-1 PLATFORM 4 LEFT` and `CLICK TO CONTINUE`. A fresh-save fixture returned true for index 0 and false for index 1; after marking 1-1 cleared, index 1 returned true while index 2 remained false. The level was entered but not completed; movement and further progression were not verified.
- **Status:** **Fixed.** Level-start behavior was confirmed in Chrome; gameplay verification beyond the intro remains incomplete.
- **Source locations:** `app/src/ui.ts`, `Ui.isUnlocked()` (around lines 325-329); `app/src/game.ts`, `Game.startLevel()` (around lines 3187-3190).

## 2. Time-scale driver received movement arguments in reverse order

- **Description:** The time-scale driver treated its maximum movement speed as the player's current speed, keeping time at or near full speed while stationary instead of slowing it.
- **Reproduction steps (before the fix):**
  1. Start a level after bypassing the first-level lock.
  2. Stand still and observe the time-scale behavior.
  3. Compare the original driver call's movement ratio with the corrected ratio.
- **Observed behavior (before the fix):** `TimeScaleDriver.update()` computed `planarSpeed / maxSpeed`, but its caller supplied `WALK_SPEED` (4) as `planarSpeed` and the player's actual speed (0 at rest) as `maxSpeed`. The stationary calculation was `clamp(4 / 0, 0, 1)`, which is 1.
- **Root cause:** The call in `Game.frame()` passed the movement arguments in the opposite order to the `TimeScaleDriver.update(realDt, planarSpeed, maxSpeed, ...)` signature.
- **Fix applied:** `Game.frame()` now passes `this.player.planarSpeed` first and `WALK_SPEED` second. With the corrected arguments, idle movement contributes `clamp(0 / 4, 0, 1) = 0`, subject to the driver's minimum time scale; movement at the 4-unit walk speed contributes 1.
- **Verification result:** The signature, formula, and corrected call site were checked in source. The old and corrected stationary calculations were reproduced; the corrected movement ratio is consistent with the driver's minimum scale and movement behavior. `npm run typecheck` and `npm run build` both pass. Live in-level timing could not be verified because the Chrome interaction was interrupted before controls could be tested.
- **Status:** **Fixed in source; in-game timing verification incomplete.**
- **Source locations:** `app/src/game.ts`, `TimeScaleDriver.update()` (around lines 2527-2537); `Game.frame()` call site (around line 3348).

## Remaining verification limitations

- No Act 1 level was completed during verification.
- Player movement, attacks, live time-scale behavior, level-clear progression, unlock persistence after a clear, and game-save persistence after a clear were not verified.
- Level 1-2 and 1-3 remained locked in the fresh-save browser session and could not be played without completing their prerequisites.
- The Vite development URL is `http://127.0.0.1:5173/`.

## Follow-up browser verification (2026-11-25)

- The Vite server was already running and returned HTTP 200 at the URL above.
- A fresh page load showed the STILLFRAME title and the Play, Levels, and Settings buttons.
- The Levels screen showed 1-1 PLATFORM enabled and 1-2 CARRIAGE / 1-3 TURNSTILES disabled as expected before 1-1 is cleared.
- Selecting 1-1 reached its intro: the HUD displayed `1-1 PLATFORM 4 LEFT`, the title card was active, and the game showed `CLICK TO CONTINUE`. This verifies level selection/start through the UI, not that active gameplay controls work.
- The browser-console capture found no `console.error` or uncaught page error during reload. It did show the expected Windows `powerPreference` warning. Starting the level also produced `[input] pointer lock failed: WrongDocumentError: The root document of this element is not valid for pointer lock.` The shared embedded browser therefore could not grant pointer lock; this is recorded as a test-environment limitation, not diagnosed as a game-code bug.
- Without pointer lock, `Game.frame()` does not update the player while in the playing state. Consequently movement, mouse look, jump, combat/item actions, time-scale response during play, enemy waves, and level completion could not be meaningfully tested in this browser.
- Source inspection confirms `loadSave()` reads `stillframe.save` from local storage and `showResults()` writes the clear record, but persistence across a completed level and refresh remains unverified because no level was completed.
- No additional gameplay bug was confirmed in this verification attempt. Complete Levels 1-1 through 1-3, test progression/save persistence, and observe live time scaling manually in a top-level browser that permits pointer lock.
