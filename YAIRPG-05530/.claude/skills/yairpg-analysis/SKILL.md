---
name: yairpg-analysis
description: Recompute YAIRPG skill-training rates, crafting chains and outstanding milestones from the current game source and the newest save. Use when asked where to train a skill, what to craft, how long a level or milestone will take, whether one-hit-kills still hold, or to re-check the numbers after editing src/ or exporting a new save.
---

# YAIRPG analysis

Re-derives everything from `src/` and the newest `save/*.txt` on every run. Nothing is
carried over between runs, so editing game files or exporting a new save is enough to
get fresh numbers.

```bash
node .claude/skills/yairpg-analysis/scripts/run.js full
```

## Commands

| Command | Does |
|---|---|
| `full` *(default)* | Best XP method for every unmaxed skill at the character's current level & bonuses. Skills are grouped into sections purely for presentation - each unmaxed skill sits under its own skill-definition category (Activity, Crafting, Combat, etc., from `skills.js` `category`), never under save-specific or ad-hoc groupings |
| `milestones` | Outstanding milestones, split into "unlocks content" and "stat bumps only" |
| `skill <name>` | One skill: every source ranked, plus its own outstanding milestones |
| `ohk [zone]` | Verifies the one-hit-kill premise per stance and flags attack-speed drag |
| `station [name]` | Lists crafting stations found in source; sets the one used for quality rolls |
| `damage-anchor <ap> [speed]` | Records attack power from the character sheet so OHK verdicts stop being indicative |
| `assumptions` | Prints the assumption registry with risk, rationale and how to settle each |
| `anchors` | Runs the self-check gate alone |
| `diff` | What changed since the last `full` run — levels, and rates that moved >5% |

## How to read the output

**Rates are XP per REAL minute.** The game's own "minutes" are tick counts: 1 tick =
100 ms, so **600 game-minutes pass per real minute**. A tooltip saying "120 minutes"
means 12 real seconds. Every rate here is already converted; the `perTickMin` figure is
available in the library if you need to compare against a tooltip.

**The XP multiplier is PER SKILL, never one number for everything.** A "named" bonus
only applies to the skill it names; a category bonus only applies to skills sharing
that category (the game stores those under a `category_`-prefixed key). This formula
was live-verified 2026-09-05 against `character.xp_bonuses` in a running instance — see
`scripts/lib/formulas.js` `deriveXpMultiplier`. The per-skill table shows the **final**
rate (raw source rate × that skill's own multiplier), with the multiplier printed as a
trailing `(x…)` so it stays auditable. Milestone and `skill <name>` estimates use the
same per-skill multiplier.

**`[not computed - static guidance]`** marks a skill the rate engine structurally cannot
price — its XP comes from a combat event it can't yet model (e.g. Fortitude, which
scales with damage *taken*, not enemies fought) rather than an activity. Those lines are
hand-written notes, not derived numbers, and are labelled so they are never mistaken for
one. Gluttony, Medicine (use), and Haggling are **not** in this bucket — they're priced
by chaining the consumable/sell formula onto the same gathering/crafting pipeline used
for crafting XP, since supply (not the use/sell action) is what actually throttles them.

**Location and activity labels are the player-facing text**, not the internal dict key
(`locations.js` `starting_text`, e.g. "Mine the atratan vein", never `mining3`).

## The self-check gate

Every run starts with two anchors that execute **in order and stop at the first
failure**, so a mismatch points at one suspect rather than leaving two to check:

1. **`reduction-curve`** — an `items` recipe with no quality tag, at a level sitting
   *inside* the taper (`recipe_level < skill < recipe_level + 6`). Nothing but the
   reduction curve can move this number.
2. **`rarity-multiplier`** — a component recipe *with* a quality tag. Runs only once
   anchor 1 passes, so the reduction curve is known-good and any mismatch isolates to
   the rarity term layered on top.

Anchors pin their recorded skill level rather than the character's current one — they
test the code, not the save, so levelling up must never fail the gate. **A failure
aborts the run.** That is deliberate: this analysis has previously produced confident
wrong answers from a silently drifted formula, and no output beats plausible output.

Re-record an anchor in `config.json` only when the *game* changed, never to make a
failure go away.

## Assumptions

Four unverified premises are registered in `scripts/lib/config.js`. Each has a stable
id, and every dependent code site carries an `ASSUMPTION[Ax]` comment:

```bash
grep -rn "ASSUMPTION\[A5\]" .claude/skills/yairpg-analysis/scripts/
node .claude/skills/yairpg-analysis/scripts/run.js assumptions
```

The highest-risk one left is **A7** (the damage model), which affects OHK/time
estimates rather than rankings.

Three premises that used to live here were promoted out of the registry after being
settled for the current game version (**v0.5.5.30**) rather than left as open
questions — each still carries a plain code comment (no `ASSUMPTION[Ax]` tag) at its
dependent site so the reasoning stays visible:
- **XP multiplier formula** — live-verified 2026-09-05 against `character.xp_bonuses`
  in a running instance (`scripts/lib/formulas.js`).
- **Milestone scope** — "milestone" deliberately means only the `milestones` map on a
  Skill; a scope choice, not evidence, so it's a decision on record rather than a gap.
- **Butchering applies to `beast` only** — read straight from
  `droprate_modifier_skills_for_tags` in `enemies.js`, confirmed to have exactly one
  entry today.

All three are version-specific facts, not universal truths — a future game version
could add a tag, change milestone semantics, or alter the XP formula, so re-check them
(the same way they were originally settled) after a `game_version` bump rather than
assuming they still hold.

## Damage and the one-hit-kill premise

`ohk` checks whether one-hit-kills actually hold per stance, and whether any enemy is
fast enough to throttle your attack rate. Deriving attack power from scratch means
walking race → hero level → equipment → skill coefficients → effects, which is exactly
the kind of long reconstruction that goes wrong quietly. So it doesn't: record the
value once from the character sheet and every other loadout is computed as a **ratio**
against it, cancelling all the character-side unknowns.

```bash
node .claude/skills/yairpg-analysis/scripts/run.js damage-anchor 1450 2.4
```

Without an anchor, verdicts print as `INDICATIVE`. Re-record it whenever the loadout
changes.

## Notes for whoever maintains this

- `src/items.js` carries ~1800 lines inside block comments, and
  `crafting_component_filling.js` **generates** ~200 components and clothing at load
  time. Absence from `items.js` is not absence from the game. The parser strips
  comments and reads the generator.
- Skill cost-curve class defaults are `base_xp_cost = 40`, `xp_scaling = 1.8`. The
  gathering skills declare `10 / 1.6` and the crafting family `40 / 1.5`; generalising
  either as the default inflates every other skill by roughly ten levels.
- Parent ("mastery") skills are not persisted in the save. They converge on their best
  child's `total_xp` and are estimated that way.
- `scripts/package.json` pins CommonJS, because the game's own `package.json` sets
  `type: module`.
- Category XP bonuses live under a `"category_"+name` key (`character.js:298,336,913`),
  never the bare category name. Looking up `bonuses["Combat"]` for a Combat-category
  skill silently returns the *named* bonus for the skill literally called "Combat" and
  misapplies it to the whole category — a past session did exactly this.
  `hero_level` XP bonuses and skill XP bonuses read different `total_multiplier` keys
  (`get_hero_xp_gain` vs `get_skill_xp_gain`, `character.js:903-924`); a bonus keyed
  `"hero"` never speeds up skill training.
- Stance-related-skill XP (`main.js:1587`) is the mean target `xp_value` with **no**
  group-size multiplier — a genuinely different formula from Combat/weapon-skill XP
  (`main.js:1788/1811`, which multiplies by `groupsize_xp_multiplier`). They only read
  as the same number when a zone's group size is 1; don't "fix" an apparent mismatch by
  making them share a formula, and don't introduce spurious rounding into the shared
  case either (reuse the unrounded mean, not a display-rounded copy of it).
- The `"recycled at 100% on use"` synthetic cost (`ASSUMPTION[A6]`, glass containers)
  prices an item as free **as a crafting input you already hold** — it is not a
  production rate. Anything that ranks items by real-world acquisition speed (the
  consumable/sell pipelines) must exclude it, or a recyclable container looks like it
  can be produced infinitely fast.
