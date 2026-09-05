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
| `full` *(default)* | Best XP source per skill, grouped by the in-game skill categories, maxed skills omitted |
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

**The XP multiplier is applied separately.** The per-skill table shows raw rates; the
header shows the multiplier. Milestone time estimates have it applied.

**`[not computed - static guidance]`** marks a skill the rate engine structurally cannot
price — its XP comes from a combat event, a consumable or a trade rather than an
activity. Those lines are hand-written notes, not derived numbers, and are labelled so
they are never mistaken for one.

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

Seven unverified premises are registered in `scripts/lib/config.js`. Each has a stable
id, and every dependent code site carries an `ASSUMPTION[Ax]` comment:

```bash
grep -rn "ASSUMPTION\[A3\]" .claude/skills/yairpg-analysis/scripts/
node .claude/skills/yairpg-analysis/scripts/run.js assumptions
```

The two high-risk ones are **A1** (the XP multiplier is reconstructed, not read —
`character.xp_bonuses` is runtime-only and absent from the save) and **A7** (the damage
model). Both affect time estimates rather than rankings.

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
