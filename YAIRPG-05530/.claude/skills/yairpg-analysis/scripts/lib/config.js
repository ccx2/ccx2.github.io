"use strict";
const fs = require("fs");
const path = require("path");

const SKILL_DIR = path.resolve(__dirname, "..", "..");
const CONFIG_PATH = path.join(SKILL_DIR, "config.json");

function load() { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
function save(cfg) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n"); }

/* ------------------------------------------------------------------ *
 * ASSUMPTION REGISTRY
 * Every unverified premise this skill relies on is listed here with a
 * stable id. Code that depends on one carries an `ASSUMPTION[Ax]`
 * comment, so `grep -rn "ASSUMPTION\[A3\]" scripts/` finds every site.
 * `run.js assumptions` prints this table.
 * ------------------------------------------------------------------ */
/* A1 (XP multiplier formula), A2 (milestone scope) and A3 (Butchering ==
 * beast-only) were dropped from this registry on 2026-09-05: A1 was
 * live-verified against character.xp_bonuses in a running instance, and A2/
 * A3 were settled as deliberate/confirmed facts for the current game version
 * (v0.5.5.30) rather than left as open questions. Each still carries a plain
 * code comment (no ASSUMPTION[Ax] tag) at its dependent site - see
 * formulas.js (A1), milestones.js (A2), analysis.js/parse.js (A3). All three
 * are version-specific, not universal - re-check them after a game_version
 * bump rather than assuming they still hold. Ids are not reused/renumbered
 * so old references stay meaningful. */
const ASSUMPTIONS = {
  A4: {
    title: "Crafting station",
    risk: "low",
    claim: "Crafting happens at the station named in config.station.",
    why_unverified: "Station tier feeds the quality roll (station_tier - result_tier), which feeds rarity, " +
                    "which feeds crafting XP and item value. A better station changes numbers, not rankings.",
    how_to_settle: "run.js station <location name>  - re-reads tiers from src/locations.js.",
    affects: "crafting XP and monetary value"
  },
  A5: {
    title: "Chain-model gaps",
    risk: "medium",
    claim: "material_type wildcards resolve to a hand-picked cheapest member, and some drops are priced " +
           "from zones that were never rated for combat throughput.",
    why_unverified: "Hand-mapped. A recipe that accepts `raw wood` is assumed to take the cheapest wood; " +
                    "if the game ever restricts that, chains silently mis-price.",
    how_to_settle: "The parser reports unresolved materials each run; check that list is empty-ish.",
    affects: "crafting chain costs"
  },
  A6: {
    title: "Play-state constants",
    risk: "medium",
    claim: "One-hit kills, free travel, saturation neutralised by stockpiling, traders not a source, glass recycles.",
    why_unverified: "User-stated play style. Not derivable from save or source, and all five stop holding " +
                    "if the character or routine changes.",
    how_to_settle: "one_hit_kill is verified by the damage module once a damage anchor exists. " +
                   "The rest are edited in config.json play_state.",
    affects: "combat rates, gathering rates, Haggling"
  },
  A7: {
    title: "Damage model",
    risk: "high",
    claim: "attack_power = (strength/10) x weapon.getAttack() x total_multiplier.attack_power, " +
           "unarmed substituting unarmed_power for the weapon term.",
    why_unverified: "The formula is read straight from character.js:627-631, but every input is itself " +
                    "a deep chain (race base -> hero level -> equipment -> skill coefficients -> effects) " +
                    "that this skill reconstructs statically. One missed multiplier makes OHK verdicts wrong.",
    how_to_settle: "run.js damage-anchor <value from the character sheet>.",
    affects: "OHK verification and speed-drag warnings"
  }
};

/* ------------------------------------------------------------------ *
 * MECHANIC-DRIVEN SKILLS
 * Some skills are not fed by an activity, a location type or a recipe, so
 * the rate engine structurally cannot price them - their XP comes from a
 * combat event, a consumable, or a trade. These entries are STATIC GUIDANCE,
 * not computed output, and are labelled as such wherever they appear so a
 * hand-written note is never mistaken for a derived number.
 * ------------------------------------------------------------------ */
const MECHANIC_SOURCES = {
  "Poison resistance": "Infested woods - 6 dragonflies, training shield (never fully blocks, so every attack lands), slowed to speed <= 1.5. XP = base_xp_value * duration^0.333 per proc.",
  "Gluttony":          "Eat the highest-value food you can sustain. XP = (value/10)^0.667 per item; items suppress the duration term, so supply rate is the real limit.",
  "Medicine":          "Craft medicine-tagged items: Medicine gets alchemy_recipe_xp/2 on craft, which dwarfs the (value/10)^0.667 from using it. Dies entirely once Alchemy exceeds the recipe level by 6.",
  "Perception":        "Land critical hits: flat 1/target_count per crit, independent of the enemy. Single target, maximum crit rate.",
  "Regeneration":      "XP equals HP actually healed - rest or sleep from as low as you dare.",
  "Cold resistance":   "0.2/tick per cold threshold crossed (14 / 8 / 2 / -4 C). Winter, and Wet accelerates it.",
  "Haggling":          "(sell_value + buy_value)/10, uncapped. Value-driven, not XP-driven - see the value ranking rather than an XP rate.",
  "Persistence":       "Fight at 0 stamina: XP equals stamina spent, doubled below 20% HP and up to ~2x again with cold debuffs.",
  "Iron skin":         "Requires !wears_armor(). Combat rate applies, but only while wearing no defensive piece.",
  "Fortitude":         "Scales with damage_taken^0.6 per landed hit, so it wants the biggest hits available rather than the most.",
  "Breathing":         "0.1/tick baseline, 0.5/tick during any training activity, plus the thin-air location type.",
  "Weapon mastery":    "Parent skill - accrues automatically from whichever weapon skill is ahead of it.",
  "Crafting mastery":  "Parent skill - accrues automatically from Crafting / Butchering / Woodworking.",
  "Stance mastery":    "Parent skill - accrues automatically from the individual stance skills."
};

/* ------------------------------------------------------------------ *
 * BROKEN / NON-FUNCTIONAL ENEMIES
 * Enemies that are wired into a location's enemies_list (so the parser
 * can't tell them apart from a real, farmable enemy) but are confirmed
 * non-functional in the live game via the developer's OWN source comment.
 * There is no structural flag for this (unlike Challenge_zone, which has
 * `is_challenge`) - each entry here was found by hand, so this list is a
 * floor, not a guarantee that no other broken enemy exists uncaught.
 * Combat-drop costs and combat-XP ranking must both skip these.
 * ------------------------------------------------------------------ */
const BROKEN_ENEMIES = {
  "Enraged giant crab": "enemies.js:588, dev comment: 'not working at present, not sure where the problem is'. " +
    "Its guaranteed (chance:1) Giant crab claw drop otherwise makes \"Crab trophy\" look ~60-100x cheaper than " +
    "every real crafting recipe. Confirmed 2026-09-05."
};

/* Time. See memory: yairpg-tick-time-scaling / yairpg-time-conventions. */
const TICKRATE = 10;                      // main.js:260
const TICK_MIN_PER_REAL_MIN = 600;        // 10 ticks/real-sec x 60
const REAL_SEC_PER_TICK = 1 / TICKRATE;   // 0.1s

/** Nominal ("tick") minutes -> real minutes. */
const toRealMin = tickMin => tickMin / TICK_MIN_PER_REAL_MIN;
/** A per-tick-minute rate -> the same rate per real minute. */
const rateToReal = ratePerTickMin => ratePerTickMin * TICK_MIN_PER_REAL_MIN;

module.exports = {
  SKILL_DIR, CONFIG_PATH, load, save, ASSUMPTIONS, MECHANIC_SOURCES, BROKEN_ENEMIES,
  TICKRATE, TICK_MIN_PER_REAL_MIN, REAL_SEC_PER_TICK, toRealMin, rateToReal
};
