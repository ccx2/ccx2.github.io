"use strict";
const fs = require("fs");
const path = require("path");
const { strip } = require("./parse");

/* ------------------------------------------------------------------ *
 * ASSUMPTION[A7] - damage model. HIGH RISK.
 *
 * character.js:627  armed:   attack_power = (strength/10) * weapon.getAttack() * total_multiplier.attack_power
 * character.js:631  unarmed: attack_power = (strength/10) * total_multiplier.attack_power * unarmed_power
 * main.js:1777      hero_base_damage = attack_power * stamina_multiplier
 * main.js:1835      per hit: max(dmg - max(0, defense - armor_pen), dmg*0.1, 1)
 *
 * `strength` and `total_multiplier` are themselves deep chains (race base ->
 * hero level -> equipment -> skill coefficients -> active effects). Deriving
 * them statically is exactly the kind of many-step reconstruction that has
 * produced silent errors before, so this module does NOT try.
 *
 * Instead it works ANCHOR-RELATIVE: you record attack_power (and optionally
 * attack_speed) once from the character sheet for a known loadout, and every
 * other loadout is computed as a RATIO against it. All character-side unknowns
 * cancel out; only the loadout-dependent terms are modelled.
 *
 * With no anchor recorded, every verdict is reported as INDICATIVE.
 * ------------------------------------------------------------------ */

function parseStances(root) {
  const src = strip(fs.readFileSync(path.join(root, "src", "combat_stances.js"), "utf8"));
  const out = {};
  const re = /stances\[\s*"([^"]+)"\s*\]\s*=\s*new Stance\(\{/g;
  const marks = []; let m;
  while ((m = re.exec(src))) marks.push({ id: m[1], at: m.index });
  for (let i = 0; i < marks.length; i++) {
    const body = src.slice(marks[i].at, i + 1 < marks.length ? marks[i + 1].at : src.length);
    const num = k => { const r = body.match(new RegExp("\\b" + k + ":\\s*([\\d.]+)")); return r ? Number(r[1]) : 1; };
    out[marks[i].id] = {
      id: marks[i].id,
      name: (body.match(/name:\s*"([^"]+)"/) || [])[1] || marks[i].id,
      attackPower: num("attack_power"),
      attackSpeed: num("attack_speed"),
      targetCount: Number((body.match(/target_count:\s*(\d+)/) || [])[1] || 1),
      staminaCost: Number((body.match(/stamina_cost:\s*(\d+)/) || [])[1] || 0),
      relatedSkill: (body.match(/related_skill:\s*"([^"]+)"/) || [])[1] || null
    };
  }
  return out;
}

/** Constant tables from crafting_component_filling.js. */
function parseCombatConstants(root) {
  const src = strip(fs.readFileSync(path.join(root, "src", "crafting_component_filling.js"), "utf8"));
  const table = name => {
    const m = src.match(new RegExp(name + "\\s*=\\s*\\{([^}]*)\\}"));
    const o = {};
    if (m) for (const p of m[1].matchAll(/"([^"]+)"\s*:\s*([\d.]+)/g)) o[p[1]] = Number(p[2]);
    return o;
  };
  return {
    baseAttack: Number((src.match(/const base_attack\s*=\s*([\d.]+)/) || [])[1] || 3),
    weightImpact: table("weight_impact_per_type"),
    weightImpactOnSpeed: table("weight_impact_on_speed_per_type"),
    strengthImpact: table("strength_impact_per_type"),
    counts: table("material_count_per_type")
  };
}

/** Generated weapon component: its attack_value, attack_multiplier and speed. */
function componentProfile({ mat, type, K }) {
  const count = K.counts[type] || 1;
  const isHead = ["short blade", "long blade", "axe head", "hammer head"].includes(type);
  if (isHead) {
    const attackValue = K.baseAttack
      * (1 + (K.strengthImpact[type] || 0) * (mat.strength / 100))
      * mat.tier
      * (1 + (K.weightImpact[type] || 0) * (mat.weight / 100)) / 8;
    const speed = Math.round(100 *
      (1 + (mat.tier - 1) / 10) / (1 + (K.weightImpactOnSpeed[type] || 0) * mat.weight / 1000)) / 100;
    return { attackValue, attackMultiplier: 1, speed, tier: mat.tier, count };
  }
  // handle
  const attackMultiplier = Math.floor(100 *
    (1 + (1 + mat.tier / 20) * (1 + (K.weightImpact[type] || 0) * (mat.weight - 40)) / 1000)) / 100;
  const speed = Math.floor(100 *
    ((1 + mat.tier / 20) / (1 + (K.weightImpactOnSpeed[type] || 0) * (mat.weight - 50) / 1000))) / 100;
  return { attackValue: 0, attackMultiplier, speed, tier: mat.tier, count };
}

/** Full weapon = head + handle. items.js:975 calculateAttackPower. */
function weaponProfile({ headMat, headType, handleMat, handleType, quality, rarityMult, K }) {
  const h = componentProfile({ mat: headMat, type: headType, K });
  const g = componentProfile({ mat: handleMat, type: handleType, K });
  const raw = (h.attackValue + g.attackValue) * h.attackMultiplier * g.attackMultiplier
    * (quality / 100) * rarityMult;
  const attack = Math.abs(raw) < 10 ? Math.ceil(10 * raw) / 10 : Math.ceil(raw);
  return { attack, speedMultiplier: h.speed * g.speed, totalTier: h.tier + g.tier, maxTier: Math.max(h.tier, g.tier) };
}

/** main.js:1835 - a landed hit always deals at least 1. */
function damageAfterDefense(raw, defense, armorPen = 0) {
  return Math.ceil(10 * Math.max(raw - Math.max(0, defense - armorPen), raw * 0.1, 1)) / 10;
}

/**
 * Verify the one-hit-kill premise (ASSUMPTION[A6]) and flag speed drag.
 * `loadouts` are {label, attackRatio, speedRatio} relative to the anchor.
 */
function checkZone({ zone, enemies, anchor, loadouts, armorPen = 0 }) {
  const anchored = anchor && anchor.attack_power != null;
  const rows = [];
  for (const lo of loadouts) {
    const ap = anchored ? anchor.attack_power * lo.attackRatio : null;
    const speed = anchor && anchor.attack_speed != null ? anchor.attack_speed * lo.speedRatio : null;

    const perEnemy = zone.enemies.map(name => {
      const e = enemies[name];
      if (!e) return { enemy: name, status: "unknown enemy" };
      if (!anchored) return { enemy: name, status: "INDICATIVE - no damage anchor", health: e.health };
      const worst = ap * 0.8;                       // main.js:1809 damage varies 0.8..1.2
      const dealt = damageAfterDefense(worst, e.defense || 0, armorPen);
      return {
        enemy: name, health: e.health, worstCaseHit: Math.round(dealt * 10) / 10,
        ohk: dealt >= e.health,
        hitsNeeded: Math.ceil(e.health / dealt)
      };
    });

    const maxEnemySpeed = Math.max(...zone.enemies.map(n => (enemies[n] || {}).attack_speed || 0));
    const drag = speed != null && speed < maxEnemySpeed
      ? { throttled: true, factor: Math.round((speed / maxEnemySpeed) * 1000) / 1000, maxEnemySpeed }
      : { throttled: false, maxEnemySpeed };

    rows.push({
      loadout: lo.label, attackPower: ap, attackSpeed: speed,
      allOhk: anchored ? perEnemy.every(p => p.ohk) : null,
      perEnemy, speedDrag: drag,
      confidence: anchored ? "anchored" : "INDICATIVE - run `damage-anchor <value>` first"
    });
  }
  return { zone: zone.name || zone.key, rows };
}

module.exports = { parseStances, parseCombatConstants, componentProfile, weaponProfile, damageAfterDefense, checkZone };
