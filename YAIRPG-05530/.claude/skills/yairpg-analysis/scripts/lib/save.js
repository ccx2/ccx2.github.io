"use strict";
const fs = require("fs");
const path = require("path");
const F = require("./formulas");

/* Hero XP curve: character.js:21 base_xp_cost=10, :169 xp_scaling=1.6, no cap. */
const HERO = { base: 10, scaling: 1.6, max: Infinity };

/**
 * Newest save wins. Filenames look like
 *   "yet-another-idle-rpg 2026-09-05 07_19_22.txt"
 * so the embedded timestamp is authoritative; mtime is the fallback for
 * files that were renamed or copied.
 */
function findLatestSave(root) {
  const dir = path.join(root, "save");
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith(".txt"));
  if (!files.length) return null;

  const scored = files.map(f => {
    const m = f.match(/(\d{4})-(\d{2})-(\d{2})[ _](\d{2})[_:](\d{2})[_:](\d{2})/);
    const full = path.join(dir, f);
    const stamp = m
      ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()
      : fs.statSync(full).mtimeMs;
    return { file: f, full, stamp, fromName: !!m, mtime: fs.statSync(full).mtimeMs };
  }).sort((a, b) => b.stamp - a.stamp);

  return { chosen: scored[0], all: scored };
}

function decode(fullPath) {
  const raw = fs.readFileSync(fullPath, "utf8").trim();
  try { return JSON.parse(raw); } catch (_) { /* fall through */ }
  try { return JSON.parse(Buffer.from(raw, "base64").toString("utf8")); }
  catch (e) { throw new Error("Save at " + fullPath + " is neither JSON nor base64-JSON: " + e.message); }
}

/** Sum equipment bonus_skill_levels into {skillId: bonus}. */
function equipmentSkillBonuses(saveData) {
  const bonuses = {};
  const eq = saveData.character && saveData.character.equipment || {};
  for (const slot of Object.keys(eq)) {
    const item = eq[slot];
    if (!item) continue;
    const b = item.bonus_skill_levels || item.base_bonus_skill_levels;
    if (!b) continue;
    for (const [skill, n] of Object.entries(b)) bonuses[skill] = (bonuses[skill] || 0) + Number(n || 0);
  }
  return bonuses;
}

/**
 * Derive the whole character view. Levels are ALWAYS derived from total_xp -
 * the save stores no levels, and a persisted level goes stale silently.
 */
function buildCharacter(saveData, skillDefs) {
  const bonuses = equipmentSkillBonuses(saveData);
  const skills = {};
  for (const [id, def] of Object.entries(skillDefs)) {
    const entry = saveData.skills && saveData.skills[id];
    const totalXp = entry ? entry.total_xp : 0;
    const level = F.levelFromXp(def, totalXp);
    skills[id] = {
      id, def, totalXp, level,
      bonus: bonuses[id] || 0,
      effective: level + (bonuses[id] || 0),
      maxed: level >= def.max,
      inSave: !!entry,
      xpToNext: F.xpToNextLevel(def, totalXp)
    };
  }

  /* Parent ("mastery") skills are absent from the save - they are runtime
     state. add_xp_to_skill tops a parent up by min(child.total - parent.total,
     gain) on every child gain, so the parent converges on its best child's
     total_xp. Estimate rather than report 0, which would otherwise invent
     phantom milestones for a skill the game shows as levelled. */
  for (const [id, sk] of Object.entries(skills)) {
    if (sk.inSave || sk.totalXp > 0) continue;
    const children = Object.values(skills).filter(c => c.def.parent === id && c.totalXp > 0);
    if (!children.length) continue;
    const est = Math.max(...children.map(c => c.totalXp));
    sk.totalXp = est;
    sk.level = F.levelFromXp(sk.def, est);
    sk.effective = sk.level + sk.bonus;
    sk.maxed = sk.level >= sk.def.max;
    sk.xpToNext = F.xpToNextLevel(sk.def, est);
    sk.estimated = "derived from best child (" +
      children.sort((a, b) => b.totalXp - a.totalXp)[0].id + "); parents are not persisted in the save";
  }

  const heroXp = (saveData.character && saveData.character.xp && saveData.character.xp.total_xp) || 0;
  const heroLevel = F.levelFromXp(HERO, heroXp);

  return {
    skills,
    heroLevel,
    heroXp,
    money: (saveData.character && saveData.character.money) || 0,
    equipment: (saveData.character && saveData.character.equipment) || {},
    equipmentSkillBonuses: bonuses,
    stances: saveData.stances || {},
    currentStance: saveData.current_stance || null,
    categoryOrder: saveData.skill_category_order || [],
    gameTime: saveData["current time"] || null,
    playtimeSec: saveData.total_playtime || 0,
    kills: saveData.total_kills || 0,
    /* ASSUMPTION[A1]: character.xp_bonuses is runtime-only and absent here.
       An empty object is NOT evidence of multiplier 1. */
    xpBonusesPresent: !!(saveData.character && saveData.character.xp_bonuses)
  };
}

module.exports = { findLatestSave, decode, buildCharacter, equipmentSkillBonuses, HERO };
