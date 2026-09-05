"use strict";
const fs = require("fs");
const path = require("path");

/* ------------------------------------------------------------------ *
 * Source parsing. Two hard-won rules:
 *  1. Strip BOTH block and line comments first. src/items.js carries
 *     ~1800 lines inside /* *\/ blocks; reading them as live definitions
 *     produced a whole session of wrong conclusions.
 *  2. Absence from items.js does NOT mean absence from the game -
 *     crafting_component_filling.js generates ~200 components and
 *     clothing at load time. See memory: yairpg-generated-items.
 * ------------------------------------------------------------------ */

function strip(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "))
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Extract the balanced {...} that follows `key:` starting at or after `from`. */
function balancedAfter(text, key, from = 0) {
  const at = text.indexOf(key, from);
  if (at < 0) return null;
  const open = text.indexOf("{", at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) return { body: text.slice(open + 1, i), start: open, end: i }; }
  }
  return null;
}

function read(root, rel) { return strip(fs.readFileSync(path.join(root, "src", rel), "utf8")); }

/* ---------------- skills ---------------- */
function parseSkills(root) {
  const src = read(root, "skills.js");
  const marks = [];
  const re = /skills\[\s*"([^"]+)"\s*\]\s*=\s*new Skill\(\{/g;
  let m; while ((m = re.exec(src))) marks.push({ name: m[1], at: m.index });

  const out = {};
  for (let i = 0; i < marks.length; i++) {
    const body = src.slice(marks[i].at, i + 1 < marks.length ? marks[i + 1].at : src.length);
    const num = k => { const r = body.match(new RegExp("\\b" + k + ":\\s*([0-9.]+)")); return r ? Number(r[1]) : undefined; };
    /* Read the category from BEFORE the milestones block: milestone recipe
       unlocks carry their own `category: "smelting"` fields, which otherwise
       win and mislabel the skill (Forging landed in a "smelting" category). */
    const beforeMilestones = body.split(/\bmilestones:/)[0];
    let cat = /category:\s*skill_category_crafting/.test(beforeMilestones) ? "Crafting"
      : (beforeMilestones.match(/category:\s*"([^"]+)"/) || [])[1];

    // milestones: level -> what it grants
    const milestones = {};
    const ms = balancedAfter(body, "milestones:");
    if (ms) {
      const lre = /(?:^|\n)\s{0,40}(\d+)\s*:\s*\{/g;
      const levels = []; let lm;
      while ((lm = lre.exec(ms.body))) levels.push({ lvl: Number(lm[1]), at: lm.index });
      for (let j = 0; j < levels.length; j++) {
        const seg = ms.body.slice(levels[j].at, j + 1 < levels.length ? levels[j + 1].at : ms.body.length);
        const grants = [];
        const stats = balancedAfter(seg, "stats:");
        if (stats) {
          const names = [...stats.body.matchAll(/"?([a-z_]+)"?\s*:\s*\{/g)].map(x => x[1]);
          if (names.length) grants.push({ kind: "stats", detail: [...new Set(names)].join(", ") });
        }
        for (const k of ["skills", "recipes", "quests"]) {
          const u = seg.match(new RegExp(k + ":\\s*\\[([\\s\\S]*?)\\]"));
          if (u) {
            const names = [...u[1].matchAll(/"([^"]+)"/g)].map(x => x[1]);
            if (names.length) grants.push({ kind: k, detail: names.join(", ") });
          }
        }
        const xpm = seg.match(/xp_multipliers:\s*\{([^}]*)\}/);
        if (xpm) grants.push({ kind: "xp_multipliers", detail: xpm[1].replace(/\s+/g, " ").trim() });
        milestones[levels[j].lvl] = grants;
      }
    }

    out[marks[i].name] = {
      id: marks[i].name,
      base: num("base_xp_cost") ?? 40,        // class default, skills.js:37
      scaling: num("xp_scaling") ?? 1.8,      // class default, skills.js:42
      max: num("max_level") ?? 60,
      coefficient: num("max_level_coefficient") ?? 1,
      category: cat || "(uncategorised)",
      parent: (body.match(/parent_skill:\s*"([^"]+)"/) || [])[1] || null,
      milestones
    };
  }
  return out;
}

/* ---------------- enemies ---------------- */
function parseEnemies(root) {
  const src = read(root, "enemies.js");
  const out = {};
  const re = /enemy_templates\[\s*"([^"]+)"\s*\]\s*=\s*new Enemy\(\{/g;
  const marks = []; let m;
  while ((m = re.exec(src))) marks.push({ name: m[1], at: m.index });
  for (let i = 0; i < marks.length; i++) {
    const body = src.slice(marks[i].at, i + 1 < marks.length ? marks[i + 1].at : src.length);
    const stats = (body.match(/stats:\s*\{([^}]*)\}/) || [])[1] || "";
    const s = k => { const r = stats.match(new RegExp("\\b" + k + ":\\s*([\\d.]+)")); return r ? Number(r[1]) : undefined; };
    const loot = [...body.matchAll(/item_name:\s*"([^"]+)"\s*,\s*chance:\s*([\d.]+)/g)]
      .map(x => ({ item: x[1], chance: Number(x[2]) }));
    out[marks[i].name] = {
      name: marks[i].name,
      xp_value: Number((body.match(/xp_value:\s*([\d.]+)/) || [])[1] || 0),
      size: ((body.match(/size:\s*(?:enemy_sizes\.)?"?(\w+)"?/) || [])[1] || "").toLowerCase(),
      tags: [...(body.match(/tags:\s*\[([^\]]*)\]/) || ["", ""])[1].matchAll(/"([^"]+)"/g)].map(x => x[1]),
      health: s("health"), attack: s("attack"), defense: s("defense"),
      attack_speed: s("attack_speed"), attack_count: s("attack_count") ?? 1,
      agility: s("agility"), intuition: s("intuition"),
      loot
    };
  }
  // ASSUMPTION[A3]: report the live tag->skill drop mapping so a new tag is visible.
  const dropMap = {};
  const dm = src.match(/droprate_modifier_skills_for_tags\s*=\s*\{([^}]*)\}/);
  if (dm) for (const p of dm[1].matchAll(/"([^"]+)"\s*:\s*"([^"]+)"/g)) dropMap[p[1]] = p[2];
  return { enemies: out, dropMap };
}

/* ---------------- locations ---------------- */
function parseLocations(root) {
  const src = read(root, "locations.js");

  const zones = {};
  {
    const re = /locations\[\s*"([^"]+)"\s*\]\s*=\s*new (Combat_zone|Challenge_zone)\(\{([\s\S]*?)\n    \}\);/g;
    let m;
    while ((m = re.exec(src))) {
      const body = m[3];
      const gs = body.match(/enemy_group_size:\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]/);
      zones[m[1]] = {
        key: m[1], challenge: m[2] === "Challenge_zone",
        name: (body.match(/name:\s*"([^"]+)"/) || [])[1] || m[1],
        enemies: [...(body.match(/enemies_list:\s*\[([\s\S]*?)\]/) || ["", ""])[1].matchAll(/"([^"]+)"/g)].map(x => x[1]),
        groupSize: gs ? [Number(gs[1]), Number(gs[2])] : [1, 1],
        types: [...body.matchAll(/\{\s*type:\s*"([^"]+)"\s*,\s*stage:\s*(\d+)\s*(?:,\s*xp_gain:\s*(\d+))?/g)]
          .map(x => ({ type: x[1], stage: Number(x[2]), xp_gain: x[3] ? Number(x[3]) : 0 }))
      };
    }
  }

  // location types -> which skill each stage trains
  const typeSkills = {};
  {
    const re = /location_types\[\s*"([^"]+)"\s*\]\s*=\s*new LocationType\(\{([\s\S]*?)\n    \}\);/g;
    let m;
    while ((m = re.exec(src))) {
      const stages = {};
      const sre = /(\d+)\s*:\s*\{/g; let sm;
      const marks = []; while ((sm = sre.exec(m[2]))) marks.push({ n: Number(sm[1]), at: sm.index });
      for (let i = 0; i < marks.length; i++) {
        const seg = m[2].slice(marks[i].at, i + 1 < marks.length ? marks[i + 1].at : m[2].length);
        const rs = (seg.match(/related_skill:\s*"([^"]+)"/) || [])[1];
        if (rs) stages[marks[i].n] = rs;
      }
      typeSkills[m[1]] = stages;
    }
  }

  // activities per location
  const activities = [];
  {
    const re = /locations\[\s*"([^"]+)"\s*\]\.activities\s*=\s*\{/g;
    let m;
    while ((m = re.exec(src))) {
      const blk = balancedAfter(src, ".activities", m.index);
      if (!blk) continue;
      const are = /"([^"]+)"\s*:\s*new (LocationActivity|LocationGatheringActivity)\(\{/g;
      const marks = []; let am;
      while ((am = are.exec(blk.body))) marks.push({ key: am[1], cls: am[2], at: am.index });
      for (let i = 0; i < marks.length; i++) {
        const body = blk.body.slice(marks[i].at, i + 1 < marks.length ? marks[i + 1].at : blk.body.length);
        const tp = body.match(/time_period:\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]/);
        const sr = body.match(/skill_required:\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]/);
        activities.push({
          location: m[1], key: marks[i].key,
          activity: (body.match(/activity_name:\s*"([^"]+)"/) || [])[1],
          gathering: marks[i].cls === "LocationGatheringActivity",
          xpPerTick: Number((body.match(/skill_xp_per_tick:\s*([\d.]+)/) || [])[1] || 1),
          gainedSkills: (body.match(/gained_skills:\s*\{([^}]*)\}/) || [])[1] || null,
          timePeriod: tp ? [Number(tp[1]), Number(tp[2])] : null,
          skillRequired: sr ? [Number(sr[1]), Number(sr[2])] : null,
          rollQuality: /roll_quality:\s*true/.test(body),
          seasons: (body.match(/availability_seasons:\s*\[([^\]]*)\]/) || [])[1] || null,
          /* (?<![a-z_]) keeps `activity_name:` from matching as a resource -
             without it the first resource of every gathering activity came
             back as the activity's own name. */
          resources: [...body.matchAll(/(?<![a-z_])name:\s*"([^"]+)"[^}]*?chance:\s*\[\s*([\d.]+)\s*,\s*([\d.]+)\s*\]/g)]
            .map(x => ({ item: x[1], chance: [Number(x[2]), Number(x[3])] }))
        });
      }
    }
  }

  /* Bound each Location's body at the NEXT locations[...] statement.
     A fixed character window bleeds into the following location and
     invents crafting stations that do not exist. */
  const locMarks = [];
  {
    const re = /locations\[\s*"([^"]+)"\s*\]\s*=\s*new Location\(\{/g;
    let m; while ((m = re.exec(src))) locMarks.push({ name: m[1], at: m.index });
  }
  /* Brace-match the constructor object itself. A textual scan to the next
     `locations[` truncates early, because connected_locations references
     other locations by that same token. */
  const stations = {};
  const housing = {};
  for (const mark of locMarks) {
    const ctor = balancedAfter(src, "new Location(", mark.at);
    const body = ctor ? ctor.body : "";
    const blk = balancedAfter(body, "crafting:");
    if (blk) {
      const tiers = {};
      const t = balancedAfter(blk.body, "tiers:");
      if (t) for (const p of t.body.matchAll(/(\w+)\s*:\s*(\d+)/g)) tiers[p[1]] = Number(p[2]);
      if (Object.keys(tiers).length) stations[mark.name] = tiers;
    }
    const x = body.match(/sleeping_xp_per_tick:\s*([\d.]+)/);
    if (x) housing[mark.name] = Number(x[1]);
  }

  return { zones, typeSkills, activities, stations, housing };
}

/* ---------------- items ---------------- */
function parseItems(root) {
  const src = read(root, "items.js");
  const out = {};
  const re = /item_templates\[\s*"([^"]+)"\s*\]\s*=\s*new (\w+)\(\{/g;
  const marks = []; let m;
  while ((m = re.exec(src))) marks.push({ name: m[1], cls: m[2], at: m.index });
  for (let i = 0; i < marks.length; i++) {
    const body = src.slice(marks[i].at, i + 1 < marks.length ? marks[i + 1].at : src.length);
    out[marks[i].name] = {
      name: marks[i].name, cls: marks[i].cls,
      value: Number((body.match(/\bvalue:\s*(\d+)/) || [])[1] || 0),
      tier: Number((body.match(/component_tier:\s*(\d+)/) || [])[1] || 0) || null,
      componentType: (body.match(/component_type:\s*"([^"]+)"/) || [])[1] || null,
      materialType: (body.match(/material_type:\s*"([^"]+)"/) || [])[1] || null,
      baseDefense: Number((body.match(/base_defense:\s*(\d+)/) || [])[1] || 0),
      tags: [...(body.match(/tags:\s*\{([^}]*)\}/) || ["", ""])[1].matchAll(/"?([\w ]+)"?\s*:\s*true/g)].map(x => x[1].trim()),
      effects: [...body.matchAll(/effect:\s*"([^"]+)"\s*,\s*duration:\s*(\d+)/g)].map(x => ({ effect: x[1], duration: Number(x[2]) })),
      recovery: [...body.matchAll(/recovery_chances:\s*\{\s*"([^"]+)"\s*:\s*([\d.]+)/g)].map(x => ({ item: x[1], chance: Number(x[2]) })),
      bonusSkillLevels: (body.match(/base_bonus_skill_levels:\s*\{([^}]*)\}/) || [])[1] || null
    };
  }
  return out;
}

/* ---------------- generated components ---------------- */
function parseGenerated(root) {
  const src = read(root, "crafting_component_filling.js");
  const counts = {};
  const cb = balancedAfter(src, "material_count_per_type");
  if (cb) for (const p of cb.body.matchAll(/"([^"]+)"\s*:\s*(\d+)/g)) counts[p[1]] = Number(p[2]);

  const mats = {};
  const re = /"([a-z0-9 ]+)":\s*\{([\s\S]*?)\n    \},/g;
  let m;
  while ((m = re.exec(src))) {
    const b = m[2];
    const tier = Number((b.match(/\btier:\s*(\d+)/) || [])[1]);
    if (!tier) continue;
    const types = [];
    if (/ALL_INTERIORS/.test(b)) types.push("helmet interior", "chestplate interior", "leg armor interior", "glove interior", "shoes interior");
    if (/ALL_EXTERIORS/.test(b)) types.push("helmet exterior", "chestplate exterior", "leg armor exterior", "glove exterior", "shoes exterior");
    if (/ALL_WEAPON_HEADS/.test(b)) types.push("short blade", "long blade", "axe head", "hammer head");
    if (/ALL_WEAPON_HANDLES/.test(b)) types.push("short handle", "medium handle", "long handle");
    if (/SHIELD_BASE/.test(b)) types.push("shield base");
    if (/SHIELD_HANDLE/.test(b)) types.push("shield handle");
    if (!types.length) continue;
    mats[m[1]] = {
      key: m[1], tier,
      weight: Number((b.match(/\bweight:\s*(\d+)/) || [])[1]) || null,
      strength: Number((b.match(/\bstrength:\s*(\d+)/) || [])[1]) || null,
      value: Number((b.match(/\bvalue:\s*(\d+)/) || [])[1]) || null,
      displayName: (b.match(/name:\s*"([^"]+)"/) || [])[1] || m[1],
      types
    };
  }
  return { counts, mats };
}

/* ---------------- recipes ---------------- */
function parseRecipes(root) {
  const src = read(root, "crafting_recipes.js");
  const out = [];
  const re = /(\w+)_recipes\.(items|components|equipment)\[\s*"([^"]+)"\s*\]\s*=\s*new (\w+)\(\{([\s\S]*?)\n    \}\);/g;
  let m;
  while ((m = re.exec(src))) {
    const [, fam, sub, id, cls, body] = m;
    const rl = body.match(/recipe_level:\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]/);
    const res = body.match(/result:\s*\{\s*result_id:\s*"([^"]+)"\s*,\s*count:\s*(\d+)/);
    const inputs = [];
    for (const x of body.matchAll(/material_id:\s*"([^"]+)"\s*,\s*count:\s*(\d+)(?!\s*,\s*result_id)/g))
      inputs.push({ id: x[1], count: Number(x[2]) });
    for (const x of body.matchAll(/material_type:\s*"([^"]+)"\s*,\s*count:\s*(\d+)/g))
      inputs.push({ type: x[1], count: Number(x[2]) });
    const variants = [...body.matchAll(/material_id:\s*"([^"]+)"\s*,\s*count:\s*(\d+)\s*,\s*result_id:\s*"([^"]+)"/g)]
      .map(x => ({ mat: x[1], count: Number(x[2]), result: x[3] }));
    out.push({
      family: fam, sub, id, cls,
      skill: (body.match(/recipe_skill:\s*"([^"]+)"/) || [])[1] || (cls === "EquipmentRecipe" ? "Crafting" : null),
      recipeLevelMax: rl ? Number(rl[2]) : null,
      result: res ? res[1] : null,
      outCount: res ? Number(res[2]) : 1,
      componentType: (body.match(/component_type:\s*"([^"]+)"/) || [])[1] || null,
      inputs, variants
    });
  }
  return out;
}

function parseAll(root) {
  const { enemies, dropMap } = parseEnemies(root);
  return {
    root,
    skills: parseSkills(root),
    enemies, dropMap,
    locations: parseLocations(root),
    items: parseItems(root),
    generated: parseGenerated(root),
    recipes: parseRecipes(root)
  };
}

module.exports = { strip, balancedAfter, parseAll, parseSkills, parseEnemies, parseLocations, parseItems, parseGenerated, parseRecipes };
