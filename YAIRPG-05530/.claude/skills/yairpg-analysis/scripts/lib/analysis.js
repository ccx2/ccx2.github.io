"use strict";
const F = require("./formulas");
const { rateToReal, TICK_MIN_PER_REAL_MIN, BROKEN_ENEMIES } = require("./config");

/* All rates below are returned in BOTH clocks:
 *   perTickMin - the game's own nominal "minutes" (what tooltips count)
 *   perRealMin - real wall-clock minutes  (= perTickMin * 600)
 * Never hand a bare number to the user; label the clock.
 * See memory: yairpg-time-conventions / yairpg-tick-time-scaling.        */
const both = perTickMin => ({ perTickMin, perRealMin: rateToReal(perTickMin) });

/* ---------------- training + gathering activities ---------------- */
function activityRates(game, character) {
  const training = [], gathering = [];
  for (const a of game.locations.activities) {
    const skillNames = activitySkills(game, a);
    for (const skillId of skillNames) {
      const sk = character.skills[skillId];
      if (!sk) continue;
      if (!a.gathering) {
        training.push({ skill: skillId, location: a.location, key: a.key, display: a.display, seasons: a.seasons, ...both(a.xpPerTick) });
      } else {
        if (!a.timePeriod) continue;
        const { tickMinutes } = F.gatheringCycle({
          timePeriod: a.timePeriod, skillRequired: a.skillRequired, effectiveLevel: sk.effective
        });
        if (!tickMinutes) continue;
        gathering.push({
          skill: skillId, location: a.location, key: a.key, display: a.display, seasons: a.seasons,
          cycleTickMinutes: tickMinutes, cycleRealMinutes: tickMinutes / TICK_MIN_PER_REAL_MIN,
          ...both(a.xpPerTick / tickMinutes)
        });
      }
    }
  }
  return { training, gathering };
}

/** Which skill(s) an activity trains: explicit gained_skills, else the activity's base skill. */
function activitySkills(game, a) {
  if (a.gainedSkills) return [...a.gainedSkills.matchAll(/"([^"]+)"\s*:/g)].map(x => x[1]);
  const map = {
    fieldwork: ["Farming"], patrolling: ["Spatial awareness"], running: ["Running"],
    weightlifting: ["Weightlifting"], balancing: ["Equilibrium"], swimming: ["Swimming"],
    meditating: ["Meditation"], climbing: ["Climbing"], enduring: ["Persistence"],
    mining: ["Mining"], digging: ["Digging"], woodcutting: ["Woodcutting"],
    herbalism: ["Herbalism"], "animal care": ["Animal handling"], fishing: ["Fishing"]
  };
  return map[a.activity] || [];
}

/* ---------------- passive location-type XP ---------------- */
function locationTypeRates(game) {
  const rows = [];
  for (const z of Object.values(game.locations.zones)) {
    for (const t of z.types) {
      const skill = (game.locations.typeSkills[t.type] || {})[t.stage];
      if (!skill || !t.xp_gain) continue;
      rows.push({ skill, zone: z.name, type: t.type, stage: t.stage, ...both(t.xp_gain) });
    }
  }
  return rows;
}

/* ---------------- combat ---------------- */
/** One swing per tick-minute when you are the fastest participant. */
function combatRates(game, { playerSpeed = null } = {}) {
  const rows = [];
  for (const z of Object.values(game.locations.zones)) {
    if (z.challenge) continue;   // one-time gate, not a repeatable training/farming zone
    if (!z.enemies.length) continue;
    const pool = z.enemies.map(n => game.enemies[n]).filter(Boolean).filter(e => !BROKEN_ENEMIES[e.name]);
    if (!pool.length) continue;
    const meanXp = pool.reduce((s, e) => s + e.xp_value, 0) / pool.length;
    const meanGroup = (z.groupSize[0] + z.groupSize[1]) / 2;
    const maxEnemySpeed = Math.max(...pool.map(e => e.attack_speed || 0));
    const throttle = playerSpeed ? Math.min(1, playerSpeed / Math.max(playerSpeed, maxEnemySpeed)) : 1;
    const perSwing = F.combatXpPerSwing(meanXp, meanGroup);
    rows.push({
      zone: z.name, key: z.key, challenge: z.challenge, enemies: z.enemies,
      meanXpValue: Math.round(meanXp * 10) / 10, meanXpRaw: meanXp, meanGroup, maxEnemySpeed,
      throttle: Math.round(throttle * 1000) / 1000,
      perSwing: Math.round(perSwing * 10) / 10,
      ...both(perSwing * throttle),
      sizes: [...new Set(pool.map(e => e.size))],
      tags: [...new Set(pool.flatMap(e => e.tags))]
    });
  }
  return rows.sort((a, b) => b.perRealMin - a.perRealMin);
}

/* ---------------- base material costs ---------------- *
 * Gathered materials are priced from the parsed activities at the
 * character's own effective level - NOT hardcoded. Combat drops are priced
 * from the OHK kill rate (ASSUMPTION[A6]) x drop chance x Butchering
 * (beast-tagged only - confirmed against droprate_modifier_skills_for_tags
 * in enemies.js for v0.5.5.30; recheck that map after a game version bump). */
function baseCosts(game, character, { butcheringMult = 1, playerSpeed = null, freeGlass = true } = {}) {
  const cost = {};                       // item -> {realMinutes, source}
  const put = (item, realMinutes, source) => {
    if (!isFinite(realMinutes) || realMinutes <= 0) return;
    if (!cost[item] || realMinutes < cost[item].realMinutes) cost[item] = { realMinutes, source };
  };

  for (const a of game.locations.activities) {
    if (!a.gathering || !a.timePeriod || !a.resources.length) continue;
    const skillIds = activitySkills(game, a);
    const sk = character.skills[skillIds[0]];
    if (!sk) continue;
    const { t, tickMinutes } = F.gatheringCycle({
      timePeriod: a.timePeriod, skillRequired: a.skillRequired, effectiveLevel: sk.effective
    });
    if (!tickMinutes) continue;
    const cycleReal = tickMinutes / TICK_MIN_PER_REAL_MIN;
    for (const r of a.resources) {
      const chance = F.slerp(r.chance, t);
      if (chance <= 0) continue;
      put(r.item, cycleReal / chance, `${a.location} / ${a.key}`);
    }
  }

  const killsPerRealMin = TICK_MIN_PER_REAL_MIN;   // OHK: one kill per swing per tick-minute
  for (const z of Object.values(game.locations.zones)) {
    /* Challenge_zone (main.js/display.js: is_finished gates it out of
       available_challenges once cleared) is a one-time gate, not a
       repeatable farm - a steady-state cost must never source a material
       from one. Verified 2026-09-06: without this, Warthog (challenge,
       0.10/0.08 Boar meat/hide) undercuts the real repeatable source
       (Forest clearing's "Boar", 0.02/0.04) as "cheapest". */
    if (z.challenge) continue;
    /* BROKEN_ENEMIES (config.js): coded but confirmed non-functional in the
       live game via the dev's own source comment - e.g. "Enraged giant crab"
       (enemies.js:588). No structural flag catches these; each was found by
       hand, so treat this filter as a floor, not a guarantee. */
    const pool = z.enemies.map(n => game.enemies[n]).filter(Boolean).filter(e => !BROKEN_ENEMIES[e.name]);
    if (!pool.length) continue;
    const maxEnemySpeed = Math.max(...pool.map(e => e.attack_speed || 0));
    const throttle = playerSpeed ? Math.min(1, playerSpeed / Math.max(playerSpeed, maxEnemySpeed)) : 1;
    for (const e of pool) {
      const share = 1 / pool.length;
      const mult = e.tags.includes("beast") ? butcheringMult : 1;   // beast-tagged only, confirmed v0.5.5.30
      for (const l of e.loot) {
        const perMin = killsPerRealMin * throttle * share * l.chance * mult;
        put(l.item, 1 / perMin, `${z.name} / ${e.name}`);
      }
    }
  }

  /* Glass recycles at 100% on USE (items.js recovery_chances, main.js:3167),
     so in steady state a container is free. ASSUMPTION[A6]. Callers that want
     the container's real acquisition cost instead (freeGlass: false) skip
     this block entirely, so chainCost() falls through to the container's own
     producer/gathering chain rather than short-circuiting on this entry. */
  if (freeGlass) {
    for (const it of Object.values(game.items)) {
      for (const rec of it.recovery) if (rec.chance >= 1) put(rec.item, 1e-9, "recycled at 100% on use");
    }
  }
  return cost;
}

/* ---------------- crafting chains ---------------- */
/**
 * @returns {producers, componentTypeIndex} - componentTypeIndex maps a
 * component SLOT type (e.g. "shield base") to every concrete result name
 * that can fill it, so an equipment-assembly producer (below) can pick the
 * cheapest one instead of being fixed to a single hardcoded material.
 */
function buildProducers(game) {
  const producers = {};
  const componentTypeIndex = {};
  for (const r of game.recipes) {
    if (r.variants.length) {
      for (const v of r.variants)
        producers[v.result] = { kind: "component", skill: r.skill, inputs: [{ id: v.mat, count: v.count }], outCount: 1, count: v.count };
      if (r.componentType) {
        const bucket = (componentTypeIndex[r.componentType] = componentTypeIndex[r.componentType] || []);
        for (const v of r.variants) bucket.push(v.result);
      }
    } else if (r.sub === "items" && r.result) {
      producers[r.result] = { kind: "items", skill: r.skill, inputs: r.inputs, outCount: r.outCount, recipeLevelMax: r.recipeLevelMax };
    } else if (r.sub === "equipment" && r.equipComponents && r.equipComponents.length === 2) {
      /* EquipmentRecipe (crafting_recipes.js:210) - glues two components
         (e.g. shield base + shield handle) into a full item. Previously
         had NO producer at all, so full equipment (Shield, Sword, Helmet,
         Chestplate, Leg armor, Gauntlets, Armored shoes) could never appear
         as a crafting-rate candidate, no matter how cheap - see memory
         yairpg-sanity-check-rankings for the same class of gap found once
         before (Haggling/componentBaseValue). Keyed by the recipe's own id
         ("Shield", not an item name) since the concrete result item is
         built dynamically from whichever components get chosen. */
      producers[r.id] = { kind: "equipment", skill: r.skill, componentTypes: r.equipComponents, outCount: r.outCount || 1 };
    }
  }
  return { producers, componentTypeIndex };
}

/** Cheapest concrete member of a material_type wildcard. ASSUMPTION[A5]. */
function typePicker(game, costs, producers = {}) {
  const byType = {};
  for (const it of Object.values(game.items)) {
    if (!it.materialType) continue;
    (byType[it.materialType] = byType[it.materialType] || []).push(it.name);
  }
  return type => {
    const members = byType[type] || [];
    // Prefer the cheapest member with a known base cost...
    let best = null;
    for (const m of members) if (costs[m] && (!best || costs[m].realMinutes < costs[best].realMinutes)) best = m;
    if (best) return best;
    // ...otherwise any member the chain can produce (Charcoal, ingots, bread).
    return members.find(m => producers[m]) || null;
  };
}

/** Longest-matching `game.generated.mats` entry for a generated item name
 *  (e.g. "Simple wooden short handle" -> the "rough wood" material, whose
 *  displayName is "simple wooden"). Shared by tierOf() and componentBaseValue()
 *  so the two never disagree on which material produced an item. */
function matOf(game, name) {
  const lower = name.toLowerCase();
  let best = null, bestLen = 0;
  for (const mat of Object.values(game.generated.mats)) {
    const label = (mat.displayName || mat.key).toLowerCase();
    if (lower.startsWith(label) && label.length > bestLen) { best = mat; bestLen = label.length; }
  }
  return best;
}

function tierOf(game, name) {
  const it = game.items[name];
  if (it && it.tier) return it.tier;
  const mat = matOf(game, name);
  return mat ? mat.tier : null;
}

/** crafting_component_filling.js:624 - the value baked into a GENERATED
 *  component (handles, blades, armor pieces, ...) that never got a literal
 *  items.js entry, so game.items[name].value is undefined for it. Without
 *  this, sellRates()/craftingRates() silently price every such component at
 *  0 and it can never win a Haggling/crafting-value comparison regardless of
 *  how cheap it is to produce - confirmed missing 2026-09-06 (Simple wooden
 *  short handle: producer exists, chainCost resolves it, but had no value). */
function componentBaseValue(game, producers, name) {
  const p = producers[name];
  if (!p || p.kind !== "component") return null;
  const mat = matOf(game, name);
  if (!mat) return null;
  return F.componentValue({ matValue: mat.value, tier: mat.tier, count: p.count });
}

/** Station tier for a skill from config.station.tiers (keys are lowercase skill names), or null when no
 *  station table was supplied (falls back to the flat rarity). A skill the station lacks counts as tier 1
 *  - recorded in qm.missing so the caller can surface it. ASSUMPTION[A4]. */
function stationTier(qm, skill) {
  if (!qm || !qm.stationTiers) return null;
  const t = qm.stationTiers[String(skill).toLowerCase()];
  if (t == null) { (qm.missing = qm.missing || new Set()).add(skill); return 1; }
  return t;
}

/** crafting_recipes.js:227 - equipment quality rolls around the TIER-weighted mean of its components'
 *  qualities (get_component_stats.weighted_quality). We feed in each component's expected quality, so
 *  the spread of the component rolls is not carried through (only the assembly roll's own spread is). */
function assemblyQuality(skillMax, qm, p, lv, tiers, qualities, maxTier) {
  const st = stationTier(qm, p.skill);
  if (st == null || qualities.some(x => x == null)) return null;
  const totalTier = tiers.reduce((a, b) => a + b, 0);
  const weighted = tiers.reduce((a, t, i) => a + t * qualities[i], 0) / totalTier;
  return { range: F.qualityRange({ skillLevel: lv, skillMaxLevel: skillMax, tierDiff: st - maxTier, componentQuality: weighted, isEquipment: true }) };
}

/**
 * Resolve a craftable down to base resources.
 * @param componentTypeIndex slot-type -> candidate result names (equipment only)
 * @returns {realMinutes, xp:{skill:amount}, ownXp:{skill:amount}, ok, why}
 *   xp    - rolled up across the WHOLE chain (this craft's own xp PLUS every
 *           upstream sub-craft's xp), for "real minutes to produce X from
 *           base resources" style costing (sellRates/consumableRates).
 *   ownXp - ONLY what a single craft() action of this recipe itself awards
 *           (main.js craft(): one call grants xp to exactly one skill, plus
 *           the "medicine" tag half-share) - for ranking individual craft
 *           actions as a training source per skill. Never sum ownXp across
 *           the chain; it deliberately excludes recursed sub-craft xp.
 */
function chainCost(game, character, costs, producers, pick, componentTypeIndex, name, qm, depth = 0, memo = {}, unresolved = new Set()) {
  if (costs[name]) return { realMinutes: costs[name].realMinutes, xp: {}, ownXp: {}, ok: true };
  if (memo[name]) return memo[name];
  if (depth > 8) return { ok: false, why: "recursion depth" };
  const p = producers[name];
  if (!p) { unresolved.add(name); return { ok: false, why: "no producer: " + name }; }

  const out = { realMinutes: 0, xp: {}, ownXp: {}, ok: true };
  const sk = character.skills[p.skill];
  const lv = sk ? sk.level : 0;
  let own = 0;

  if (p.kind === "equipment") {
    /* Two component SLOTS (e.g. "shield base" + "shield handle"), each
       filled by whichever concrete candidate is cheapest to produce right
       now - the game lets you pick any material for either slot, and a
       real player picks the cheap one, not a fixed example. */
    const chosenTiers = [], chosenQ = [];
    let componentValueSum = 0;   // items.js:146 getEquipmentValue sums each component's LISTED value
    for (const slotType of p.componentTypes) {
      const candidates = componentTypeIndex[slotType] || [];
      let best = null, bestTier = null, bestName = null;
      for (const cand of candidates) {
        const cc = chainCost(game, character, costs, producers, pick, componentTypeIndex, cand, qm, depth + 1, memo, unresolved);
        if (cc.ok && (!best || cc.realMinutes < best.realMinutes)) { best = cc; bestTier = tierOf(game, cand); bestName = cand; }
      }
      if (!best) { unresolved.add("component_type:" + slotType); return { ok: false, why: "no candidate for component type: " + slotType }; }
      out.realMinutes += best.realMinutes;
      for (const [s, v] of Object.entries(best.xp)) out.xp[s] = (out.xp[s] || 0) + v;
      chosenTiers.push(bestTier || 1);
      chosenQ.push(best.meanQuality);
      componentValueSum += (game.items[bestName] || {}).value || componentBaseValue(game, producers, bestName) || 0;
    }
    const totalTier = chosenTiers.reduce((a, b) => a + b, 0);
    const maxTier = Math.max(...chosenTiers);
    const q = assemblyQuality(sk ? sk.def.max : 60, qm, p, lv, chosenTiers, chosenQ, maxTier);
    if (q) {
      const e = F.expectedOverQuality(q.range, m => F.xpAssembly({ totalTier, maxTier, rarityMult: m, skillLevel: lv }));
      own = e.xp; out.meanQuality = e.meanQuality; out.meanRarityMult = e.meanRarityMult; out.quality = q.range; out.qualityDist = F.qualityDistribution(q.range);
      out.equipBaseValue = 1.25 * componentValueSum;
    } else {
      own = F.xpAssembly({ totalTier, maxTier, rarityMult: qm.flat, skillLevel: lv });
    }
  } else {
    for (const inp of p.inputs) {
      const id = inp.id || pick(inp.type);
      if (!id) { unresolved.add(inp.type); return { ok: false, why: "unmapped material_type: " + inp.type }; }
      const c = chainCost(game, character, costs, producers, pick, componentTypeIndex, id, qm, depth + 1, memo, unresolved);
      if (!c.ok) return c;
      out.realMinutes += c.realMinutes * inp.count;
      for (const [s, v] of Object.entries(c.xp)) out.xp[s] = (out.xp[s] || 0) + v * inp.count;
    }

    if (p.kind === "items") own = F.xpItems(p.recipeLevelMax || 1, lv);
    else {
      const t = tierOf(game, name);
      if (t) {
        const tierDiff = stationTier(qm, p.skill);
        if (tierDiff != null) {
          const range = F.qualityRange({ skillLevel: lv, skillMaxLevel: sk ? sk.def.max : 60, tierDiff: tierDiff - t });
          const e = F.expectedOverQuality(range, m => F.xpComponent({ resultTier: t, materialCount: p.count, rarityMult: m, skillLevel: lv }));
          own = e.xp; out.meanQuality = e.meanQuality; out.meanRarityMult = e.meanRarityMult; out.quality = range; out.qualityDist = F.qualityDistribution(range);
        } else own = F.xpComponent({ resultTier: t, materialCount: p.count, rarityMult: qm.flat, skillLevel: lv });
      }
    }
  }
  if (p.skill) {
    out.xp[p.skill] = (out.xp[p.skill] || 0) + own;
    out.ownXp[p.skill] = (out.ownXp[p.skill] || 0) + own;
  }

  /* main.js:2798-2801 crafting_tags_to_skills: crafting ANY item tagged
     "medicine" (by any producer skill, not just Alchemy) grants Medicine
     half of that craft's own recipe xp, on top of the producing skill's
     own xp above. This is the "Medicine from crafting" pipeline - it is
     awarded on THIS craft action itself, so it belongs in ownXp too. */
  const producedItem = game.items[name];
  if (p.skill !== "Medicine" && producedItem && producedItem.tags && producedItem.tags.includes("medicine")) {
    out.xp["Medicine"] = (out.xp["Medicine"] || 0) + own / 2;
    out.ownXp["Medicine"] = (out.ownXp["Medicine"] || 0) + own / 2;
  }

  out.realMinutes /= p.outCount;
  for (const s of Object.keys(out.xp)) out.xp[s] /= p.outCount;
  for (const s of Object.keys(out.ownXp)) out.ownXp[s] /= p.outCount;
  memo[name] = out;
  return out;
}

function craftingRates(game, character, costs, { rarity = 1.1, stationTiers = null } = {}) {
  /* stationTiers (config.station.tiers) switches XP from the flat `rarity` to the quality-roll weighted
     mean (see chainCost). Without it the old flat-rarity behaviour is kept, so a caller that has no
     station configured still gets a number rather than a crash. */
  const qm = { flat: rarity, stationTiers };
  const { producers, componentTypeIndex } = buildProducers(game);
  const pick = typePicker(game, costs, producers);
  const memo = {}, unresolved = new Set();
  const rows = [];
  for (const name of Object.keys(producers)) {
    const c = chainCost(game, character, costs, producers, pick, componentTypeIndex, name, qm, 0, memo, unresolved);
    if (!c.ok || !isFinite(c.realMinutes) || c.realMinutes <= 0) continue;
    const total = Object.values(c.xp).reduce((a, b) => a + b, 0);
    if (total <= 0) continue;
    // A literal items.js value wins if present; otherwise price a generated
    // component by its real sale formula, averaged over the same quality roll
    // its XP used: round(value * quality/100 * rarityMult) per roll. Flat
    // `rarity` only when no station table was supplied (no distribution).
    const literalValue = (game.items[name] || {}).value;
    const compBase = literalValue ? null : componentBaseValue(game, producers, name);
    const value = literalValue ||
      (compBase != null ? (c.qualityDist ? F.expectedSalePrice(compBase, c.qualityDist) : compBase * rarity)
        // Assembled equipment: 1.25 x summed component values x quality/100 x rarity (getEquipmentValue)
        : c.equipBaseValue && c.qualityDist ? F.expectedSalePrice(c.equipBaseValue, c.qualityDist) : 0);
    rows.push({
      product: name, realMinutes: c.realMinutes, totalXp: total,
      perRealMin: total / c.realMinutes, xp: c.xp, ownXp: c.ownXp, value,
      quality: c.quality, meanQuality: c.meanQuality, meanRarityMult: c.meanRarityMult
    });
  }
  rows.sort((a, b) => b.perRealMin - a.perRealMin);
  return { rows, unresolved: [...unresolved], stationMissing: qm.missing ? [...qm.missing] : [] };
}

/* ---------------- consumable / sell pipelines -------------------------- *
 * Gluttony, Medicine (use), and Haggling are not activities or recipes -
 * their XP comes from USING or SELLING an item. But "how fast can you get
 * that item" is exactly the gathering/crafting chain already built above,
 * so reuse it: merge gathered-item times (costs) with crafted-item times
 * (craft.rows), then rank items by the consumable/sell formula divided by
 * that acquisition time. Supply, not the use/sell action itself, is the
 * throttle (misc.js skill_consumable_tags / trade.js:151).             */
function itemTimeTable(costs, craftRows) {
  const timeFor = {};
  for (const [item, c] of Object.entries(costs)) {
    /* The "recycles at 100% on use" entry (ASSUMPTION[A6]) prices a
       container as free WHEN CONSUMED AS A CRAFTING INPUT you already hold -
       it is not a rate at which new units can be produced to sell or eat,
       and must not leak into either pipeline below as a near-infinite rate. */
    if (c.source === "recycled at 100% on use") continue;
    timeFor[item] = c.realMinutes;
  }
  for (const r of craftRows) if (!timeFor[r.product] || r.realMinutes < timeFor[r.product]) timeFor[r.product] = r.realMinutes;
  return timeFor;
}

/** items.js use_item: xp_to_add = (value/10)^0.6667 per use (main.js:3177), gated on `tag`. */
function consumableRates(game, costs, craftRows, tag) {
  const timeFor = itemTimeTable(costs, craftRows);
  const rows = [];
  for (const [name, it] of Object.entries(game.items)) {
    if (!it.tags || !it.tags.includes(tag)) continue;
    const realMinutes = timeFor[name];
    if (!realMinutes || !it.value) continue;
    const xpPerUse = F.xpConsumable(it.value);
    rows.push({ item: name, realMinutes, perRealMin: xpPerUse / realMinutes, value: it.value });
  }
  return rows.sort((a, b) => b.perRealMin - a.perRealMin);
}

/** trade.js:151 Haggling xp = (sell_value + buy_value)/10. ASSUMPTION[A6]:
 *  traders are not a source, so this only prices SELLING what you already
 *  produce (buy_value = 0), not buy-low/sell-high trader arbitrage. */
function sellRates(game, costs, craftRows) {
  const timeFor = itemTimeTable(costs, craftRows);
  const valueFor = {};
  for (const [name, it] of Object.entries(game.items)) if (it.value) valueFor[name] = it.value;
  /* Generated components (handles, blades, armor pieces, ...) have no
     items.js literal and so no entry in game.items at all - without this,
     every one of them prices at 0 and can never be a sell candidate no
     matter how cheap it is to produce, silently favouring raw drops/gathers
     over crafted components. craftingRates() now computes their value
     too (componentBaseValue), so pull it from there instead of recomputing. */
  for (const r of craftRows) if (r.value > 0 && !valueFor[r.product]) valueFor[r.product] = r.value;
  const rows = [];
  for (const [name, value] of Object.entries(valueFor)) {
    const realMinutes = timeFor[name];
    if (!realMinutes) continue;
    rows.push({ item: name, realMinutes, perRealMin: (value / 10) / realMinutes, value });
  }
  return rows.sort((a, b) => b.perRealMin - a.perRealMin);
}

module.exports = {
  both, activityRates, activitySkills, locationTypeRates, combatRates,
  baseCosts, craftingRates, buildProducers, typePicker, chainCost, tierOf,
  matOf, componentBaseValue, itemTimeTable, consumableRates, sellRates
};
