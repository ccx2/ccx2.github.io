"use strict";
const F = require("./formulas");

/* ------------------------------------------------------------------ *
 * ORDERED SELF-CHECK GATE
 *
 * Anchors run in `order` and STOP AT THE FIRST FAILURE, so a mismatch
 * points at one suspect instead of leaving two to check in parallel:
 *
 *   order 1  an items-branch recipe with NO quality tag, at a level that
 *            sits INSIDE the reduction curve (recipe_level < skill <
 *            recipe_level+6, so the taper is active but not floored).
 *            Nothing but the reduction curve can move this number.
 *
 *   order 2  a component-branch recipe WITH a quality tag. Runs only once
 *            order 1 has passed, so the reduction curve is known-good and
 *            any mismatch isolates to the rarity term layered on top.
 *
 * Anchors pin the recorded skill_level, not the character's current one -
 * they test the CODE, not the save. A level change must not fail the gate.
 * ------------------------------------------------------------------ */

function evaluate(anchor, game) {
  if (anchor.kind === "items") {
    const recipe = game.recipes.find(r => r.result === anchor.recipe && r.sub === "items")
      || game.recipes.find(r => r.id === anchor.recipe && r.sub === "items");
    if (!recipe) return { ok: false, reason: "recipe not found in parsed source", inputs: null };
    if (recipe.recipeLevelMax == null) return { ok: false, reason: "recipe has no recipe_level", inputs: null };
    const inCurve = recipe.recipeLevelMax < anchor.skill_level
      && anchor.skill_level < recipe.recipeLevelMax + 6;
    const actual = F.xpItems(recipe.recipeLevelMax, anchor.skill_level);
    return {
      ok: true, actual,
      inputs: { recipe_level_max: recipe.recipeLevelMax, skill_level: anchor.skill_level, inside_reduction_curve: inCurve },
      warn: inCurve ? null : "anchor no longer sits inside the reduction curve - it has stopped testing the taper"
    };
  }

  if (anchor.kind === "component") {
    // Resolve tier/count from parsed source where possible so a parse
    // regression is visible, but report which source each input came from.
    const item = game.items[anchor.recipe];
    let tier = item && item.tier, tierFrom = "items.js";
    if (!tier) { tier = anchor.result_tier; tierFrom = "anchor (not found in source)"; }

    let count = null, countFrom = "anchor";
    const variant = game.recipes
      .flatMap(r => (r.variants || []).map(v => ({ r, v })))
      .find(x => x.v.result === anchor.recipe);
    if (variant) { count = variant.v.count; countFrom = "crafting_recipes.js"; }
    if (count == null) count = anchor.material_count;

    const actual = F.xpComponent({
      resultTier: tier, materialCount: count,
      rarityMult: anchor.rarity, skillLevel: anchor.skill_level
    });
    return {
      ok: true, actual,
      inputs: { result_tier: tier, tier_from: tierFrom, material_count: count, count_from: countFrom,
                rarity: anchor.rarity, skill_level: anchor.skill_level }
    };
  }

  return { ok: false, reason: "unknown anchor kind: " + anchor.kind, inputs: null };
}

/**
 * @returns {passed, results[], failure|null}
 * On failure the caller MUST abort rather than emit numbers - a silently
 * wrong formula is worse than no answer.
 */
function runGate(anchors, game) {
  const ordered = [...anchors].sort((a, b) => a.order - b.order);
  const results = [];
  for (const a of ordered) {
    const ev = evaluate(a, game);
    if (!ev.ok) {
      const r = { anchor: a, status: "ERROR", detail: ev.reason };
      results.push(r);
      return { passed: false, results, failure: r };
    }
    const tol = a.tolerance != null ? a.tolerance : 0.15;
    const delta = Math.abs(ev.actual - a.expected_xp);
    const pass = delta <= tol;
    const r = {
      anchor: a, status: pass ? "PASS" : "FAIL",
      expected: a.expected_xp, actual: ev.actual, delta: Math.round(delta * 1000) / 1000,
      inputs: ev.inputs, warn: ev.warn || null,
      isolates: a.order === 1
        ? "the XP reduction curve (no rarity term is involved at this anchor)"
        : "the rarity term - order 1 passed, so the reduction curve is known-good"
    };
    results.push(r);
    if (!pass) return { passed: false, results, failure: r };
  }
  return { passed: true, results, failure: null };
}

module.exports = { runGate, evaluate };
