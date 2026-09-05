"use strict";
const F = require("./formulas");

/* ------------------------------------------------------------------ *
 * ASSUMPTION[A2]: "milestone" here means the `milestones` map on a Skill
 * (skills.js). The game also has quest completions, location clear
 * rewards and hero-level gates that a player might reasonably call
 * milestones; those are deliberately out of scope.
 * ------------------------------------------------------------------ */

/**
 * @param bestRates {skillId: xpPerRealMin} - optional; enables time estimates.
 * @param xpMultiplier applied to rates. ASSUMPTION[A1] - provisional.
 */
function findMilestones(character, { bestRates = {}, xpMultiplier = 1 } = {}) {
  const achieved = [], pending = [];

  for (const sk of Object.values(character.skills)) {
    const ms = sk.def.milestones || {};
    for (const lvlStr of Object.keys(ms)) {
      const lvl = Number(lvlStr);
      const grants = ms[lvlStr] || [];
      const row = {
        skill: sk.id, category: sk.def.category, level: lvl,
        currentLevel: sk.level, maxLevel: sk.def.max,
        grants,
        unlocksSomething: grants.some(g => g.kind !== "stats")
      };
      if (sk.level >= lvl) { achieved.push(row); continue; }

      row.levelsAway = lvl - sk.level;
      row.xpRemaining = Math.max(0, F.totalXpToReach(sk.def, lvl) - sk.totalXp);
      row.reachable = lvl <= sk.def.max;

      const rate = bestRates[sk.id];
      if (rate && rate > 0) {
        const effective = rate * xpMultiplier;
        row.realMinutes = row.xpRemaining / effective;
        row.realHours = row.realMinutes / 60;
        row.rateUsed = { rawPerRealMin: rate, xpMultiplier, effectivePerRealMin: effective };
      }
      pending.push(row);
    }
  }

  const cheapest = [...pending].sort((a, b) => {
    if (a.realMinutes != null && b.realMinutes != null) return a.realMinutes - b.realMinutes;
    if (a.realMinutes != null) return -1;
    if (b.realMinutes != null) return 1;
    return a.xpRemaining - b.xpRemaining;
  });

  return {
    achieved, pending, cheapest,
    /* Stat bumps and content unlocks are not comparable, so they get
       separate cuts rather than one blended ranking. */
    unlocks: cheapest.filter(r => r.unlocksSomething),
    statsOnly: cheapest.filter(r => !r.unlocksSomething),
    counts: { achieved: achieved.length, pending: pending.length }
  };
}

module.exports = { findMilestones };
