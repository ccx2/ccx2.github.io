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
const ASSUMPTIONS = {
  A1: {
    title: "XP multiplier formula",
    risk: "high",
    claim: "total_multiplier(skill) = named(skill) x all_skill x all x category(skill), " +
           "with sources race / skills / books / levels, and a 1.03^hero_level term.",
    why_unverified: "Reconstructed from memory + a read of character.js, never measured end to end. " +
                    "character.xp_bonuses is runtime-only and absent from the save, so it cannot be " +
                    "read back for comparison. A past session assumed x1 here and was ~30x wrong.",
    how_to_settle: "Load the save in a browser, trigger one known XP gain, diff the skill's total_xp " +
                   "in localStorage, and compare against the raw formula for that action.",
    affects: "every time-to-level and time-to-milestone estimate (not the rankings)"
  },
  A2: {
    title: "Milestone scope",
    risk: "low",
    claim: "'Milestones' means the `milestones` map on Skill objects only.",
    why_unverified: "The game also has quest completions, location clear rewards and hero-level gates " +
                    "that a player might reasonably call milestones. Excluded by choice, not by evidence.",
    how_to_settle: "Ask whether quests / location rewards / hero levels should be folded in.",
    affects: "milestone report completeness"
  },
  A3: {
    title: "Butchering applies to `beast` only",
    risk: "low",
    claim: "The Butchering drop multiplier 2^(level/60) applies to enemies tagged `beast` and nothing else.",
    why_unverified: "droprate_modifier_skills_for_tags maps only beast -> Butchering today. A future tag " +
                    "(insect, aquatic) would silently change every drop-rate figure downstream.",
    how_to_settle: "Re-read droprate_modifier_skills_for_tags in enemies.js; the parser reports it each run.",
    affects: "all combat-drop costs, hence every crafting chain fed by drops"
  },
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

/* Time. See memory: yairpg-tick-time-scaling / yairpg-time-conventions. */
const TICKRATE = 10;                      // main.js:260
const TICK_MIN_PER_REAL_MIN = 600;        // 10 ticks/real-sec x 60
const REAL_SEC_PER_TICK = 1 / TICKRATE;   // 0.1s

/** Nominal ("tick") minutes -> real minutes. */
const toRealMin = tickMin => tickMin / TICK_MIN_PER_REAL_MIN;
/** A per-tick-minute rate -> the same rate per real minute. */
const rateToReal = ratePerTickMin => ratePerTickMin * TICK_MIN_PER_REAL_MIN;

module.exports = {
  SKILL_DIR, CONFIG_PATH, load, save, ASSUMPTIONS, MECHANIC_SOURCES,
  TICKRATE, TICK_MIN_PER_REAL_MIN, REAL_SEC_PER_TICK, toRealMin, rateToReal
};
