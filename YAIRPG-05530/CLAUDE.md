# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Yet Another Idle RPG" (YAIRPG) — a browser-based, text/idle RPG. Vanilla JS (ES modules), no framework, no backend. `index.html` + `style.css` + a JS bundle is the entire deployed game; all persistence is `localStorage` (plus manual export/import to file).

Upstream project: https://github.com/miktaew/yet-another-idle-rpg (this working copy is a fork/local checkout — folder name `YAIRPG-05530`, git user `ccx2`). Upstream convention: `master`/`main` branch is source, `gh-pages` is what's actually hosted and may lag behind. Check the [dev repo](https://github.com/miktaew/yet-another-idle-rpg-dev) for content/fixes that may already exist before reimplementing something.

## Commands

```bash
npm run build   # esbuild bundles src/main.js -> dist/bundle.js (minified, sourcemapped),
                 # then rewrites the ?version=... query strings for dist/bundle.js and
                 # style.css inside index.html using the version string from src/game_version.js
```

- No lint config and no test suite (`npm test` is a stub that just exits 1).
- To run locally you need a static file server (CORS) — any works, e.g. `npx live-server`.
- `dist/bundle.js` is committed (not gitignored) — after editing anything in `src/`, run `npm run build` and commit the rebuilt `dist/bundle.js`/`dist/bundle.js.map` too, or the deployed game won't reflect the change.
- `index.html` loads `dist/bundle.js` by default. For quick source-level iteration without building, swap the commented-out `<script type="module" src="src/main.js">` line in for the `dist/bundle.js` one (near the top of `index.html`) — but revert before committing.
- In the browser console, `Verify_Game_Objects()` is a built-in content linter (defined in [src/verifier.js](src/verifier.js)) that checks cross-references between items/recipes/locations/enemies/etc. Run it after adding or editing content.

## Big-picture architecture

### The module split is: orchestrator, view, and content-data files

- **[src/main.js](src/main.js)** (~6000 lines) is the central controller. It imports from almost every other module, owns the top-level mutable game state (`character`, `current_location`, `current_enemies`, `global_flags`, `game_options`), runs the game loop, and does save/load. Because it's loaded as an ES module (no implicit globals) but `index.html` uses old-style inline `onclick="..."` handlers, **main.js re-exposes ~80 of its functions as `window.foo = foo` at the bottom of the file** — that's how the HTML wires up to the game logic. If you add a new UI action invoked from `index.html`, it needs a `window.x = x` line here.
- **[src/display.js](src/display.js)** (~5700 lines) is the view layer: all DOM creation/updates (inventory grids, tooltips, skill bars, location choices, crafting UI, trade UI). It holds no game logic and is called by main.js after state changes.
- **[index.html](index.html)** (~2000 lines) itself also contains a large inline `<script>` block (`prepareGame()`, called on `<body onload>`) that wires up misc UI event listeners (tooltips, mouse tracking, options panel) — UI logic is split between this inline script and `dist/bundle.js`.

### Game loop / timing

`main.js` runs everything off a single `setInterval` in `update()` (search `tickrate`) at `1000/tickrate` ms (tickrate = 10/sec). In-game time, enemy attack cooldowns, and the player's own attack cooldown are each tracked with a drift-accumulator pattern (compare intended vs actual elapsed time each tick and nudge the next interval) rather than trusting `setInterval`'s timing directly — see `enemy_timer_variance_accumulator`, `character_timer_variance_accumulator`, `time_variance_accumulator` in main.js. If you touch timing-sensitive code, follow the existing accumulator pattern rather than assuming ticks are exact.

Calendar/season logic (30-day months, 4 seasons, day/night) lives in [src/game_time.js](src/game_time.js); weather/temperature simulation built on top of it is in [src/weather.js](src/weather.js).

### Content is data, defined via class registries

Most "content" (as opposed to logic) files export a big lookup object populated at module-load time by instantiating classes, e.g. `item_templates["Sword"] = new Weapon({...})`. This is where the majority of each file's line count comes from:

| File | Registry | Class hierarchy |
|---|---|---|
| [src/items.js](src/items.js) | `item_templates` | `Item` → `OtherItem`/`Material`; `Equippable` → `Weapon`/`Armor`/`Shield`/`Tool`/`Cape`/`Amulet`/`Ring`/`Artifact`; `ItemComponent` → `WeaponComponent`/`ShieldComponent`/`ArmorComponent`; `UsableItem`; `Book`/`BookData` |
| [src/locations.js](src/locations.js) | `locations`, `location_types` | `Location` → `Combat_zone` → `Challenge_zone`; `LocationActivity` → `LocationGatheringActivity`; `LocationType` |
| [src/skills.js](src/skills.js) | `skills` | `Skill` |
| [src/enemies.js](src/enemies.js) | `enemy_templates`, `droplist` | `Enemy` |
| [src/dialogues.js](src/dialogues.js) | `dialogues` | `Dialogue`/`Textline`/`DialogueAction` (extends `GameAction`) |
| [src/crafting_recipes.js](src/crafting_recipes.js) | `recipes` | `Recipe` → `ItemRecipe` → `ComponentRecipe`/`ComponentlessEquipRecipe`; `EquipmentRecipe` |
| [src/quests.js](src/quests.js) | `quests`, via `questManager` | `QuestTask`, `Quest` |
| [src/combat_stances.js](src/combat_stances.js) | `stances` | `Stance` |
| [src/active_effects.js](src/active_effects.js) | `effect_templates` | `ActiveEffect` (buffs/debuffs) |
| [src/races.js](src/races.js) | `playable_races` | `Race` |
| [src/traders.js](src/traders.js) | `traders`, `inventory_templates` | `Trader` (extends `InventoryHaver`), `TradeItem` |

Shared base classes: `InventoryHaver` ([src/inventory.js](src/inventory.js)) is the common base for anything holding an inventory (`Person`, `Trader`); `Person` ([src/person.js](src/person.js)) → `Hero` ([src/character.js](src/character.js), the singleton `character` = the player); `GameAction` ([src/actions.js](src/actions.js)) is the base for timed/progress-bar UI actions (dialogue actions etc.).

### Other systems worth knowing about

- **[src/crafting_component_filling.js](src/crafting_component_filling.js)** (`crafting_component_manager`) — the logic for picking materials/components when crafting, separate from the recipe definitions themselves.
- **[src/market_saturation.js](src/market_saturation.js)** — selling items depresses their price (per region/tier), recovering over time; used by trade.js.
- **[src/trade.js](src/trade.js)** — trading UI/session logic (buy/sell lists, totals) that operates on `traders.js` data.
- **[src/storage.js](src/storage.js)** — `player_storage`, a bank/chest inventory separate from `character.inventory`.
- **[src/pathfinding.js](src/pathfinding.js)** — `Pathfinder` + `PriorityQueue`, used to compute travel times between locations.
- **[src/reputation.js](src/reputation.js)** — `ReputationManager`.
- **[src/conditions.js](src/conditions.js)** — generic `process_conditions()` used to gate unlocks/dialogue options/etc. against arbitrary conditions.
- **[src/character_creation.js](src/character_creation.js)** — `CharacterCreator`, the new-game character builder flow (gated by the `do_hero_creation` flag in main.js).
- **[src/translation.js](src/translation.js)** + **[locales/english.js](locales/english.js)** — `TranslationManager`/`translations`; only `english` is actually wired up in main.js's `languages` map right now, so treat this as effectively single-locale.
- **[src/verifier.js](src/verifier.js)** — `Verify_Game_Objects()`, see Commands above.
- **[src/mods/glassmaking.js](src/mods/glassmaking.js)** — an example/reference "mod" (reaches into `locations`/`item_templates`/`recipes` from outside the core files) kept as a proof of concept. It is **not** imported by main.js/index.html — it's not live in the game, just a template for how external content additions could be structured.
- **[src/game_version.js](src/game_version.js)** — single source of truth for the version string; consumed by `build.js` for cache-busting and by main.js's save-migration version comparisons (`compare_game_version`/`is_a_older_than_b`).

### Save data

`main.js` builds a `save_data` object (search `function load(save_data)` and the `save_data["..."] = ...` assignments) and writes it to `localStorage` under one of several keys depending on `is_on_dev()` (`window.location.href` ending in `-dev/`) and normal-vs-backup: `save_key`, `dev_save_key`, `backup_key`, `dev_backup_key`. There's also file-based export/import (`save_to_file`/`load_from_file`) and cross-release import (`load_other_release_save`) for migrating a save from the other release channel. The save embeds `game_version`, so loading code can branch on version for migrations.

### Leftover files

`src/main.js.bak`, `src/game_time.js.bak`, `package.json.bak` are stray backup copies sitting in the tree — not imported/used by anything; don't confuse them with the real files.
