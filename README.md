# Hit The Cyclist 2

A first-person, two-phase launch game that runs in the browser (three.js, no build step).

## Run it
Open `index.html` in Chrome or Edge. From Windows the path is
`\\wsl$\Ubuntu-22.04\home\rufus\projects\htc2\index.html`.
(Or run `python3 -m http.server` in this folder and go to http://localhost:8000.)

## Play online
https://rufusgray2003.github.io/htc2/ (works on desktop and phones)

## On a phone
The same file works on phones and tablets, in landscape only. Held upright, it shows a "turn sideways" screen and pauses.
- **Hitter:** tap anywhere to swing.
- **Rider:** hold the left or right half of the screen to steer. Tap a powerup slot to use it, and tap the follow cam to resize it.
- On Android, pressing Play goes fullscreen and locks to landscape. iPhones don't allow that, so just turn the phone.
- To try touch mode on a computer, add `?touch` to the end of the URL.

## How it plays
1. **Hitter**: you stand on a dirt cliff, 50 m high, at 45° to the oncoming cyclist. The view turns to follow
   them as they pass. There's no aiming and no timing meter. The two grass patches across the track are your
   only guide. Swing (click or Space) while the cyclist is in or between them:
   - **Early** (first patch) launches them higher and slower. Too early and they'll splut on landing.
   - **Late** (second patch) launches them flatter and faster.
   - **Dead centre**, in the dirt gap between the patches, goes furthest and earns a free Rocket.
   Launch angle = 22° + 30° × timing, where timing runs from +1 (earliest) to -1 (latest). The angle and speed
   are shown briefly after the hit.
   Each cyclist rides in at 40–50 km/h, and their speed surges and eases a little (±7%) as they pedal.
   If you miss, they ride off the edge slowly and steeply. The warning sign at the edge hands you a Brolly
   Glide, so you have a small chance of surviving.
2. **Rider**: the hit knocks them off the bike. You see through their eyes as they fly off the cliff and
   bounce along the dirt on their belly. Steer with A/D.
   - Molehills launch you up and forward. Hit them **in a row** without touching flat ground and each one
     is 50% stronger than the last.
   - A **splut** ends the run. Whether a landing splats depends on **height + angle**:
     falling speed × (0.6 for a flat landing, up to 1.4 straight down) must stay under 37.
     You can splut into the dirt (mud on screen), into a molehill (the mole whiffles at you), or by hitting a rock
     fast (blood splat). Landing on **top** of a boulder gets you **PANCAKED!** Slowly sliding into a rock
     just stops you, with no splat.
   - Stop within 3 m of a molehill and the mole pops out to give you the finger.
   - Mud comes in five kinds, in irregular shapes. Obstacles thin out smoothly to half by 1000 m.
   - Some low clouds (10–24 m up, roughly one every 140 m) hide a **🪂 wingsuit**. Fly through to grab it and
     you glide for up to 20 s at 65 km/h or more. It ends as soon as you touch the ground.
   - **Height haze:** above 40 m, everything below (ground, trees, signs, molehills) starts fading into the sky.
     By 65 m it's completely faded out, and it fades back in as you drop. You can't line up a landing from way
     up high. Wingsuit clouds and the sky clouds stay visible.
   - Speed and height are shown on **dials** at the top of the screen.
   - The **follow cam** in the bottom-left shows the rider from behind. Click it to enlarge or shrink it.

## Powerups (3 slots, use with 1 / 2 / 3, or Space for slot 1)
| Powerup | Effect |
|---|---|
| 🚀 Rocket | 1.2 s of thrust up and forward |
| 🟢 Jelly Belly | Next 4 landings bounce with no speed loss, no sluts, and rocks bounce you over |
| ☂️ Brolly Glide | 5 s of floaty low gravity, which also makes landings gentle |
| ⛰️ Mole Call | Spawns 4 molehills in your path |

**Powerups are rare.** The only sources are **?** boxes on the ground, a perfect hit, a 5-molehill chain, and some
easter eggs.

## Easter eggs (spoilers!)
There are 10. Nine are placed in the rider's path, one every 500–1000 m each run. **Crash into them** to find them:
| Egg | What it does |
|---|---|
| Snowman | 🧊 Icy Belly: a quarter of the sliding friction, and bounces keep their speed, for 30 s |
| Rubber duck (in a puddle) | 🦆 Mud can't slow you for 30 s |
| Mole family picnic | 🍰 Sugar rush: molehills 50% stronger for 30 s |
| Garden gnome | 🍄 Your next splut is cancelled and you bounce instead |
| Dinosaur bones | 🦴 Fossil fuel: +54 km/h |
| Sofa and telly | 🛋️ The springs launch you upward |
| UFO (fly into the beam) | 🛸 You're abducted, lifted up, then flung forward |
| Golden molehill | A molehill launch 2.5× as strong |
| X marks the spot | Buried treasure: a free powerup |
| Warning sign at the cliff edge | Only found by missing the cyclist. Gives you a Brolly Glide |

The results screen shows how many you found in the run and all-time.

## Sounds
`sounds.js` holds the 7 sounds extracted from the original game file (swing, bat thud, belly thud, splat, mole,
sparkle, button). They're in the public domain. Delete `sounds.js` and the game falls back to its own synthesized sounds.

## Sharing as one file
`Hit The Cyclist 2.html` is the whole game in a single file (about 1.9 MB), with the page, styles, three.js,
3D models, sounds and game code all inside. Send that file on its own; it opens by double-clicking.
After changing the code, rebuild it with `python3 build.py`.

## 3D models
Dave, Bob and the bike are proper 3D models, packed into `models.js` (base64 GLB files) and loaded at start-up.
If they fail to load, the game falls back to its simple built-in shapes.
- **Characters:** Quaternius, [Universal Base Characters](https://quaternius.com/packs/universalbasecharacters.html) (CC0).
  One base body for both. Their clothes are painted on in a shader by body region (see `DAVE_LOOK` / `BOB_LOOK` in
  `game.js`), and their poses (pedalling, belly flop, swing) are set bone by bone in code each frame.
- **Bike:** "Bicycle" by jeremy, [Poly Pizza](https://poly.pizza/m/axc03j3xKfz),
  [CC-BY 3.0](https://creativecommons.org/licenses/by/3.0/). The credit on the title screen is required by its licence.
- To rebuild `models.js`: `python3 tools/pack_models.py "<Universal Base Characters[Standard] folder>" <bike.glb>`.
  It strips unused data, shrinks textures and splits the bike's wheels and crank out so they can spin.

## Files
- `game.js`: all game logic (world generation, hitter phase, cyclist physics, powerups)
- `style.css`, `index.html`: HUD and menus
- `sounds.js`: the original game's sounds (see above)
- `vendor/three.min.js`: three.js r149, included so the game works offline
- `vendor/GLTFLoader.js`: three.js r149 model loader, converted to use the global `THREE`
- `models.js`: the packed 3D models (generated by `tools/pack_models.py`)

Tuning constants (cliff height, splut angle, run-up length, gravity, drag, belly friction, bounce, hit window, steering limits) are at the top of `game.js`.
