"use strict";
/* Every formula here is transcribed from game source. Line refs are to src/. */

/* ---- skill level curve ------------------------------------------------ *
 * skills.js add_xp: total_xp_to_next_lvl = base*(1 - scaling^(L+1))/(1-scaling)
 * so total XP required to REACH level L is base*(1 - scaling^L)/(1-scaling).
 * CLASS DEFAULTS ARE base_xp_cost=40, xp_scaling=1.8, max_level=60
 * (skills.js:35-42). Do NOT assume 10/1.6 - those are what the *gathering*
 * skills happen to declare, and generalising them inflates every
 * default-curve skill by ~10 levels.                                       */
const totalXpToReach = (d, L) => d.base * (1 - Math.pow(d.scaling, L)) / (1 - d.scaling);

/** skills.js `names` map: pick the highest level-threshold name the character
 *  has reached. Falls back to the object's dict-key id if `names` is empty. */
function skillDisplayName(def, level) {
  const thresholds = Object.keys(def.names || {}).map(Number).sort((a, b) => a - b);
  let name = def.id;
  for (const t of thresholds) if (level >= t) name = def.names[t];
  return name;
}

function levelFromXp(d, xp) {
  let L = 0;
  while (L < d.max && totalXpToReach(d, L + 1) <= xp) L++;
  return L;
}
function xpToNextLevel(d, xp) {
  const L = levelFromXp(d, xp);
  if (L >= d.max) return null;
  return totalXpToReach(d, L + 1) - xp;
}

/* ---- rarity ----------------------------------------------------------- *
 * items.js:133 getItemRarity + items.js:47 rarity_multipliers              */
function rarityOf(quality) {
  if (quality < 50) return { name: "trash", mult: 1 };
  if (quality <= 100) return { name: "common", mult: 1 };
  if (quality < 130) return { name: "uncommon", mult: 1.1 };
  if (quality < 160) return { name: "rare", mult: 1.3 };
  if (quality < 200) return { name: "epic", mult: 1.6 };
  if (quality < 246) return { name: "legendary", mult: 2 };
  return { name: "mythical", mult: 2.5 };
}

/* ---- crafting quality roll -------------------------------------------- *
 * crafting_recipes.js:70 get_quality_range, :28 get_crafting_quality_caps  */
function qualityRange({ skillLevel, skillMaxLevel, tierDiff, componentQuality = null, isEquipment = false }) {
  const cap = isEquipment
    ? Math.min(Math.round(100 + 2.8 * skillLevel), 250)
    : Math.min(Math.round(100 + 2 * skillLevel), 200);
  const clamp = v => Math.max(10, Math.min(cap, Math.round(v)));
  if (componentQuality != null) {
    const q = (3 * skillLevel - skillMaxLevel) + 50 + componentQuality + 10 * tierDiff;
    return [clamp(q - 15), clamp(q + 15)];
  }
  const q = (3 * skillLevel - skillMaxLevel) + 130 + 15 * tierDiff;
  return [clamp(q - 15), clamp(q + 10)];
}

/* ---- crafting XP: THREE branches -------------------------------------- *
 * crafting_recipes.js:365 get_recipe_xp_value.
 * Applying the `items` branch to a quality-bearing craft is a known trap -
 * it has no rarity term and a completely different penalty key.            */

/** subcategory "items": no quality, keyed on recipe_level[1]. */
function xpItems(recipeLevelMax, skillLevel) {
  let e = Math.pow(Math.max(4, 1.5 * recipeLevelMax), 1.1);
  if (recipeLevelMax < skillLevel) {
    e = Math.max(1, e * Math.max(0, Math.min(5, recipeLevelMax + 6 - skillLevel)) / 5);
  }
  return round1(e);
}

/** components / component / componentless: quality-bearing, keyed on result tier. */
function xpComponent({ resultTier, materialCount, rarityMult, skillLevel }) {
  const resultLevel = 8 * resultTier;
  const base = Math.max(Math.pow(4, 1.2), Math.pow(resultTier * 4, 1.1) * materialCount);
  const floor = 0.5 * materialCount;
  if (resultLevel > skillLevel * Math.sqrt(rarityMult)) return round1(Math.max(floor, base * rarityMult));
  const taper = Math.max(0, Math.min(5, resultLevel * Math.sqrt(rarityMult) + 5 - skillLevel)) / 5;
  return round1(Math.max(floor, base * rarityMult * taper));
}

/** equipment assembly: keyed on summed component tiers, gated on max tier. */
function xpAssembly({ totalTier, maxTier, rarityMult, skillLevel }) {
  const e = Math.pow(Math.max(4, totalTier * 4), 1.1);
  const resultLevel = maxTier * 8;
  if (resultLevel > skillLevel * Math.sqrt(rarityMult)) return round1(Math.max(1, e * rarityMult));
  const taper = Math.max(0, Math.min(5, resultLevel * Math.sqrt(rarityMult) + 5 - skillLevel)) / 5;
  return round1(Math.max(1, e * rarityMult * taper));
}

/** Level at which a component recipe bottoms out at its floor. */
const componentDiesAt = (resultTier, rarityMult) => 8 * resultTier * Math.sqrt(rarityMult) + 5;
/** Level at which an items recipe bottoms out. */
const itemsDiesAt = recipeLevelMax => recipeLevelMax + 6;

/* ---- gathering -------------------------------------------------------- *
 * locations.js getActivityEfficiency + character.js:937 + misc.js:70.
 * XP lands once per COMPLETED CYCLE (locations.js:441), never per tick,
 * so the real rate is xp_per_tick / cycle_length.                          */
const slerp = (arr, t) => arr[0] * Math.pow(arr[1] / arr[0], t);
const skillModifier = (level, range) =>
  Math.min(1, Math.max(0, (level - range[0] + 1) / (range[1] - range[0] + 1)));

function gatheringCycle({ timePeriod, skillRequired, effectiveLevel }) {
  const t = skillRequired ? skillModifier(effectiveLevel, skillRequired) : 1;
  return { tickMinutes: Math.floor(slerp(timePeriod, t)), t };
}

/* ---- combat ----------------------------------------------------------- *
 * main.js:1778 groupsize multiplier is current_enemies.length AS SPAWNED
 * (deliberately not filtered by is_alive). One swing per tick-minute when
 * you are the fastest participant (main.js:1393-1405 normalisation).       */
const combatXpPerSwing = (xpValue, groupSize) => xpValue * Math.pow(groupSize, 0.3334);

/** Your swings per tick-minute, and the enemies' - the throttle cuts both ways. */
function attackRates(playerSpeed, maxEnemySpeed) {
  const fastest = Math.max(playerSpeed, maxEnemySpeed);
  const scale = fastest > 1 ? fastest : 1;
  return {
    playerCooldown: (1 / playerSpeed) * scale,
    playerPerTickMin: playerSpeed / scale,
    enemyPerTickMin: e => e / scale
  };
}

/* ---- consumables ------------------------------------------------------ *
 * main.js:3177 items / main.js:3316 effects from non-item sources.
 * use_item passes was_xp_added=true, suppressing the duration term.        */
const xpConsumable = value => Math.pow(value / 10, 0.6667);
const xpEffect = (baseXpValue, duration) => baseXpValue * Math.pow(duration, 0.3333);

/* ---- component value -------------------------------------------------- *
 * crafting_component_filling.js:624. The flat +10 is why many cheap
 * components beat few expensive ones.                                      */
const componentValue = ({ matValue, tier, count }) =>
  (matValue ? Math.round(matValue * count) : Math.round(tier * 35 * count)) + 10;

/* ---- XP multiplier ---------------------------------------------------- *
 * character.xp_bonuses is runtime-only and is NOT in the save, so this is
 * reconstructed, not read. Never default to 1: a past session did and was
 * ~30x wrong. See memory yairpg-xp-multiplier-trap. VERIFIED LIVE 2026-09-05
 * against character.xp_bonuses for v0.5.5.30 (loaded the save in a running
 * instance, exposed xp_bonuses via a window hook, diffed key-for-key) -
 * re-verify the same way after any skills.js/items.js edit.
 *
 * PER-SKILL, not global: character.js:903-916 get_skill_xp_gain(skill) =
 *   total_multiplier[skill_name] * total_multiplier.all_skill
 *   * total_multiplier.all * total_multiplier["category_"+category]
 * Two traps this must not repeat:
 *  1. The hero-level XP gain (get_hero_xp_gain, character.js:923) and the
 *     SKILL xp gain (get_skill_xp_gain) read DIFFERENT total_multiplier keys
 *     ("hero" vs the skill's own name / category). A skill is never boosted
 *     by a race/milestone "hero" bonus - that only speeds up hero leveling.
 *  2. Category bonuses are stored under a "category_"+name KEY
 *     (character.js:298,336,565,913), not the bare category name - looking
 *     up bonuses["Combat"] silently returns the SKILL-named bonus for the
 *     skill literally called "Combat" and applies it to every skill in that
 *     category, while the real "category_Combat" bonus is never read.
 *
 * The `heroLevel` pow(1.03, L) term below is NOT the "hero" bucket above -
 * it reconstructs character.js:217-243 get_level_bonus(), which multiplies
 * xp_bonuses.multiplier.levels.all_skill by 1.03 once per hero level gained.
 * That folds into all_skill for every skill uniformly; grouping it as a
 * separate factor here is mathematically identical (multiplication commutes)
 * as long as it is never applied a second time via a "hero"-named bonus.
 * ------------------------------------------------------------------ */
function deriveXpMultiplier({ heroLevel, skillId, category, bonuses = {} }) {
  const levelScaling = Math.pow(1.03, heroLevel || 0);  // folds into all_skill, see above
  const named = bonuses[skillId] || 1;
  const allSkill = bonuses.all_skill || 1;
  const all = bonuses.all || 1;
  const cat = (category && bonuses["category_" + category]) || 1;
  return {
    value: levelScaling * named * allSkill * all * cat,
    parts: { hero: levelScaling, named, all_skill: allSkill, all, category: cat },
    confidence: "derived - verified live 2026-09-05, still excludes active_effects (temporary buffs)"
  };
}

function round1(x) { return Math.round(10 * x) / 10; }

module.exports = {
  totalXpToReach, levelFromXp, xpToNextLevel, skillDisplayName,
  rarityOf, qualityRange,
  xpItems, xpComponent, xpAssembly, componentDiesAt, itemsDiesAt,
  slerp, skillModifier, gatheringCycle,
  combatXpPerSwing, attackRates,
  xpConsumable, xpEffect, componentValue,
  deriveXpMultiplier, round1
};
