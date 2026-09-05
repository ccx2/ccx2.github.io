#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const CFG = require("./lib/config");
const P = require("./lib/parse");
const S = require("./lib/save");
const F = require("./lib/formulas");
const A = require("./lib/analysis");
const D = require("./lib/damage");
const G = require("./lib/anchors");
const M = require("./lib/milestones");

const ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const LAST_RUN = path.join(CFG.SKILL_DIR, ".last-run.json");

const n1 = x => (x == null ? "-" : (Math.round(x * 10) / 10).toLocaleString("en-US"));
const n3 = x => (x == null ? "-" : (Math.round(x * 1000) / 1000).toLocaleString("en-US"));
const pad = (s, w) => String(s == null ? "" : s).padEnd(w);
const hr = (c = "-") => console.log(c.repeat(78));

/* ---------------- bootstrap ---------------- */
function boot({ requireGate = true } = {}) {
  const cfg = CFG.load();
  const game = P.parseAll(ROOT);

  if (requireGate) {
    const gate = G.runGate(cfg.anchors, game);
    printGate(gate);
    if (!gate.passed) {
      console.log("\nABORTED. A failing anchor means a formula or the parser has drifted from the");
      console.log("game source. Emitting numbers now would produce confident wrong answers, which");
      console.log("is exactly what this gate exists to prevent. Fix the isolated cause above, or");
      console.log("re-record the anchor if the game itself changed.");
      process.exit(2);
    }
  }

  const found = S.findLatestSave(ROOT);
  if (!found) { console.log("No save found under save/. Export one from the game first."); process.exit(1); }
  const saveData = S.decode(found.chosen.full);
  const character = S.buildCharacter(saveData, game.skills);
  return { cfg, game, saveData, character, found };
}

function printGate(gate) {
  console.log("SELF-CHECK GATE  (ordered; stops at first failure to isolate the cause)");
  hr();
  for (const r of gate.results) {
    if (r.status === "ERROR") { console.log(`  [${r.status}] ${r.anchor.id}: ${r.detail}`); continue; }
    console.log(`  ${r.status === "PASS" ? "[PASS]" : "[FAIL]"} ${pad(r.anchor.order + ". " + r.anchor.id, 26)}` +
      `expected ${n1(r.expected)}  actual ${n1(r.actual)}  (delta ${n3(r.delta)})`);
    console.log(`         isolates: ${r.isolates}`);
    console.log(`         inputs:   ${JSON.stringify(r.inputs)}`);
    if (r.warn) console.log(`         WARN:     ${r.warn}`);
  }
  hr();
}

function printSaveHeader(found, character) {
  const age = (Date.now() - found.chosen.stamp) / 36e5;
  console.log(`SAVE   ${found.chosen.file}`);
  console.log(`       ${found.all.length} save(s) present; newest chosen ` +
    `(${found.chosen.fromName ? "timestamp from filename" : "mtime fallback"}), ${n1(age)} real hours old`);
  if (age > 24) console.log(`       NOTE: this export is over a day old - levels below may lag the live game.`);
  console.log(`HERO   level ${character.heroLevel}   money ${character.money.toLocaleString("en-US")}   ` +
    `kills ${character.kills.toLocaleString("en-US")}`);
}

/* ASSUMPTION[A1]: reconstructed, never read - character.xp_bonuses is
   runtime-only. Folds in xp_multipliers from milestones the character has
   ALREADY reached, which is where most of the real multiplier lives (a past
   session used the hero term alone and was ~10x low). Book-granted
   multipliers are NOT yet modelled - see the caveat printed alongside. */
function xpMultiplier(character) {
  const bonuses = {};
  let milestoneSources = 0;
  for (const sk of Object.values(character.skills)) {
    for (const [lvlStr, grants] of Object.entries(sk.def.milestones || {})) {
      if (sk.level < Number(lvlStr)) continue;
      for (const g of grants) {
        if (g.kind !== "xp_multipliers") continue;
        for (const p of g.detail.matchAll(/([\w]+)\s*:\s*([\d.]+)/g)) {
          bonuses[p[1]] = (bonuses[p[1]] || 1) * Number(p[2]);
          milestoneSources++;
        }
      }
    }
  }
  const m = F.deriveXpMultiplier({ heroLevel: character.heroLevel, skillId: null, category: null, bonuses });
  m.milestoneSources = milestoneSources;
  m.bonuses = bonuses;
  m.caveat = "book-granted multipliers not modelled; measure live to settle";
  return m;
}

/* ---------------- best source per skill ---------------- */
function bestSources(game, character, cfg) {
  const playerSpeed = cfg.damage_anchor && cfg.damage_anchor.attack_speed;
  const butchering = character.skills.Butchering
    ? Math.pow(character.skills.Butchering.def.coefficient || 2, character.skills.Butchering.level / character.skills.Butchering.def.max)
    : 1;

  const acts = A.activityRates(game, character);
  const types = A.locationTypeRates(game);
  const combat = A.combatRates(game, { playerSpeed });
  const costs = A.baseCosts(game, character, { butcheringMult: butchering, playerSpeed });
  const craft = A.craftingRates(game, character, costs);

  const best = {};
  const offer = (skill, perRealMin, label, kind) => {
    if (!skill || !isFinite(perRealMin) || perRealMin <= 0) return;
    if (!best[skill] || perRealMin > best[skill].perRealMin) best[skill] = { perRealMin, label, kind };
  };

  for (const r of acts.training) offer(r.skill, r.perRealMin, `${r.location} - ${r.key}`, "training");
  for (const r of acts.gathering) offer(r.skill, r.perRealMin, `${r.location} - ${r.key}`, "gathering");
  for (const r of types) offer(r.skill, r.perRealMin, `${r.zone} (${r.type} st.${r.stage})`, "passive");
  for (const r of craft.rows) for (const [sk, v] of Object.entries(r.xp)) {
    if (v > 0) offer(sk, (v / r.realMinutes), `craft ${r.product}`, "crafting");
  }
  const live = combat.filter(c => !c.challenge);
  const topCombat = live[0];
  if (topCombat) {
    for (const sk of ["Combat", "Evasion", "Iron skin", "Fortitude", "Shield blocking", "Unarmed"])
      offer(sk, topCombat.perRealMin, topCombat.zone, "combat");
    // Weapon skills: same swing, gated on having that weapon type equipped.
    for (const sk of ["Swords", "Axes", "Spears", "Hammers", "Daggers", "Wands", "Staffs"]) {
      offer(sk, topCombat.perRealMin, `${topCombat.zone} with a ${sk.replace(/s$/, "").toLowerCase()} equipped`, "combat");
    }
    // Stance skills use the MEAN target xp_value with no group-size bonus.
    for (const st of Object.values(D.parseStances(ROOT))) {
      if (!st.relatedSkill) continue;
      const unlocked = character.stances && character.stances[st.id] === true;
      offer(st.relatedSkill, A.both(topCombat.meanXpValue).perRealMin,
        `${topCombat.zone} in ${st.name}` + (unlocked ? "" : "  [STANCE NOT UNLOCKED]"), "stance");
    }
    for (const c of live) {
      if (c.sizes.includes("small")) offer("Pest killer", c.perRealMin, c.zone, "combat");
      if (c.sizes.includes("large")) offer("Giant slayer", c.perRealMin, c.zone, "combat");
    }
  }
  return { best, combat, craft, costs, acts, types, butchering };
}

/* ---------------- modes ---------------- */
function modeFull() {
  const { cfg, game, character, found } = boot();
  printSaveHeader(found, character);
  const mult = xpMultiplier(character);
  console.log(`XPMUL  x${n3(mult.value)}  from hero x${n3(mult.parts.hero)} and ` +
    `${mult.milestoneSources} achieved milestone multiplier(s) ${JSON.stringify(mult.bonuses)}`);
  console.log(`       [ASSUMPTION[A1] - ${mult.caveat}]`);
  console.log(`DROPS  Butchering tag map: ${JSON.stringify(game.dropMap)}  [ASSUMPTION[A3]]`);
  console.log(`STATION ${cfg.station.name}  ${JSON.stringify(cfg.station.tiers)}  [ASSUMPTION[A4]]`);
  hr("=");

  const { best, craft } = bestSources(game, character, cfg);
  const order = character.categoryOrder.length ? character.categoryOrder : ["(uncategorised)"];
  const byCat = {};
  for (const sk of Object.values(character.skills)) (byCat[sk.def.category] = byCat[sk.def.category] || []).push(sk);
  const cats = [...order.filter(c => byCat[c]), ...Object.keys(byCat).filter(c => !order.includes(c))];

  console.log("BEST XP SOURCE PER SKILL   (rates are XP per REAL minute, before the x" +
    n3(mult.value) + " multiplier)\n");
  for (const cat of cats) {
    const rows = byCat[cat].filter(s => !s.maxed).sort((a, b) => b.level - a.level);
    if (!rows.length) continue;
    console.log(`== ${cat} ==`);
    for (const s of rows) {
      const b = best[s.id];
      const mech = CFG.MECHANIC_SOURCES[s.id];
      const shown = b ? `${b.label} [${b.kind}]`
        : mech ? `${mech}  [not computed - static guidance]`
        : "no source found - may be trained by a mechanic the rate engine does not model";
      console.log("   " + pad(s.id, 22) + pad(s.level + "/" + s.def.max, 9) +
        pad(b ? n1(b.perRealMin) : "-", 12) + shown);
    }
    const maxed = byCat[cat].filter(s => s.maxed).map(s => s.id);
    if (maxed.length) console.log(`   (maxed, omitted: ${maxed.join(", ")})`);
    console.log("");
  }

  if (craft.unresolved.length) {
    console.log(`ASSUMPTION[A5] unresolved chain inputs (${craft.unresolved.length}): ` +
      craft.unresolved.slice(0, 12).join(", ") + (craft.unresolved.length > 12 ? " ..." : ""));
  }
  writeLastRun(character, best);
}

function modeMilestones() {
  const { cfg, game, character, found } = boot();
  printSaveHeader(found, character);
  const mult = xpMultiplier(character);
  const { best } = bestSources(game, character, cfg);
  const rates = {}; for (const [k, v] of Object.entries(best)) rates[k] = v.perRealMin;
  const ms = M.findMilestones(character, { bestRates: rates, xpMultiplier: mult.value });
  hr("=");
  console.log(`MILESTONES   ${ms.counts.achieved} achieved, ${ms.counts.pending} outstanding` +
    `   [ASSUMPTION[A2]: skill milestones only]`);
  console.log(`Times assume the best source above and x${n3(mult.value)} XP multiplier ` +
    `(ASSUMPTION[A1] - provisional).\n`);

  const show = (title, rows) => {
    console.log(`-- ${title} --`);
    if (!rows.length) { console.log("   (none)\n"); return; }
    for (const r of rows.slice(0, 20)) {
      console.log("   " + pad(r.skill + " " + r.level, 26) +
        pad("+" + r.levelsAway + " lvl", 9) +
        pad(n1(r.xpRemaining) + " xp", 16) +
        pad(r.realHours != null ? n1(r.realHours) + " real h" : "no rate", 14) +
        r.grants.map(g => `${g.kind}: ${g.detail}`).join(" | "));
    }
    console.log("");
  };
  show("Unlocks content (skills / recipes / quests / xp multipliers)", ms.unlocks);
  show("Stat bumps only", ms.statsOnly);
}

function modeSkill(name) {
  const { cfg, game, character, found } = boot();
  const sk = character.skills[name];
  if (!sk) {
    const near = Object.keys(character.skills).filter(k => k.toLowerCase().includes(String(name).toLowerCase()));
    console.log(`No skill "${name}".` + (near.length ? " Did you mean: " + near.join(", ") : ""));
    process.exit(1);
  }
  printSaveHeader(found, character);
  hr("=");
  console.log(`${sk.id}   level ${sk.level}/${sk.def.max}` +
    (sk.bonus ? `  (+${sk.bonus} from equipment -> effective ${sk.effective})` : "") +
    `\n  category ${sk.def.category}   curve base ${sk.def.base} scaling ${sk.def.scaling}` +
    `\n  total_xp ${n1(sk.totalXp)}` + (sk.xpToNext != null ? `   to next level ${n1(sk.xpToNext)}` : "   MAXED"));

  const { best, combat, craft, acts, types } = bestSources(game, character, cfg);
  console.log("\nSOURCES (XP per real minute)");
  const rows = [];
  for (const r of acts.training) if (r.skill === sk.id) rows.push([r.perRealMin, `${r.location} - ${r.key}`, "training"]);
  for (const r of acts.gathering) if (r.skill === sk.id) rows.push([r.perRealMin, `${r.location} - ${r.key} (cycle ${r.cycleTickMinutes} tick-min)`, "gathering"]);
  for (const r of types) if (r.skill === sk.id) rows.push([r.perRealMin, `${r.zone} (${r.type} st.${r.stage})`, "passive"]);
  for (const r of craft.rows) if (r.xp[sk.id] > 0) rows.push([r.xp[sk.id] / r.realMinutes, `craft ${r.product} (${n1(r.realMinutes)} real min/unit)`, "crafting"]);
  if (["Combat", "Evasion", "Iron skin", "Fortitude", "Shield blocking", "Unarmed", "Pest killer", "Giant slayer"].includes(sk.id))
    for (const c of combat.slice(0, 5)) rows.push([c.perRealMin, `${c.zone} (${c.enemies.join("/")})`, "combat"]);
  rows.sort((a, b) => b[0] - a[0]);
  for (const [v, label, kind] of rows.slice(0, 15)) console.log("   " + pad(n1(v), 12) + pad(kind, 11) + label);
  if (!rows.length) console.log("   no computed source - this skill may be trained by a mechanic outside the rate engine");

  const msAll = sk.def.milestones || {};
  const pend = Object.keys(msAll).map(Number).filter(l => l > sk.level).sort((a, b) => a - b);
  if (pend.length) {
    console.log("\nOUTSTANDING MILESTONES");
    for (const l of pend) console.log("   lvl " + pad(l, 5) + msAll[l].map(g => `${g.kind}: ${g.detail}`).join(" | "));
  }
}

function modeOhk(zoneArg) {
  const { cfg, game, character, found } = boot();
  printSaveHeader(found, character);
  const K = D.parseCombatConstants(ROOT);
  const stances = D.parseStances(ROOT);
  hr("=");
  console.log("ONE-HIT-KILL CHECK   [ASSUMPTION[A6] premise, ASSUMPTION[A7] model]\n");
  if (!cfg.damage_anchor || cfg.damage_anchor.attack_power == null) {
    console.log("  No damage anchor recorded, so every verdict below would be INDICATIVE only.");
    console.log("  Read 'Attack power' off the character sheet and record it:");
    console.log("      node scripts/run.js damage-anchor <attack_power> [attack_speed]");
    console.log("  The anchor absorbs strength / hero level / skill coefficients / effects, so");
    console.log("  other loadouts are then computed as ratios and stay correct.\n");
  }
  const zones = Object.values(game.locations.zones)
    .filter(z => !z.challenge && (!zoneArg || z.name.toLowerCase().includes(String(zoneArg).toLowerCase())));

  const cur = character.currentStance && character.currentStance.id;
  const loadouts = Object.values(stances).map(s => ({
    label: `${s.name}${s.id === cur ? " (current)" : ""}`,
    attackRatio: s.attackPower / ((stances[cur] || { attackPower: 1 }).attackPower || 1),
    speedRatio: s.attackSpeed / ((stances[cur] || { attackSpeed: 1 }).attackSpeed || 1)
  }));

  for (const z of zones.slice(0, 8)) {
    const res = D.checkZone({ zone: z, enemies: game.enemies, anchor: cfg.damage_anchor, loadouts });
    console.log(`-- ${res.zone} --  enemies: ${z.enemies.join(", ")}`);
    for (const r of res.rows) {
      const worst = r.perEnemy.filter(p => p.hitsNeeded).sort((a, b) => b.hitsNeeded - a.hitsNeeded)[0];
      console.log("   " + pad(r.loadout, 26) +
        pad(r.attackPower != null ? "AP " + n1(r.attackPower) : "AP ?", 14) +
        pad(r.allOhk === null ? "INDICATIVE" : (r.allOhk ? "OHK all" : "NOT OHK"), 13) +
        (worst ? `worst: ${worst.enemy} needs ${worst.hitsNeeded} hit(s)` : "") +
        (r.speedDrag.throttled ? `  SPEED DRAG x${n3(r.speedDrag.factor)} (enemy ${r.speedDrag.maxEnemySpeed})` : ""));
    }
    console.log("");
  }
  console.log(`Generator constants in use: base_attack=${K.baseAttack}, ` +
    `strength_impact=${JSON.stringify(K.strengthImpact)}`);
}

function modeStation(nameArg) {
  const cfg = CFG.load();
  const game = P.parseAll(ROOT);
  const stations = game.locations.stations;
  if (!nameArg) {
    console.log("Crafting stations found in src/locations.js:\n");
    for (const [loc, tiers] of Object.entries(stations))
      console.log("   " + pad(loc, 26) + JSON.stringify(tiers) + (loc === cfg.station.name ? "   <- current" : ""));
    console.log("\nSet with: node scripts/run.js station \"<location name>\"");
    return;
  }
  const match = Object.keys(stations).find(k => k.toLowerCase() === String(nameArg).toLowerCase())
    || Object.keys(stations).find(k => k.toLowerCase().includes(String(nameArg).toLowerCase()));
  if (!match) {
    console.log(`No crafting station at "${nameArg}". Known: ${Object.keys(stations).join(", ")}`);
    process.exit(1);
  }
  cfg.station = {
    name: match, tiers: stations[match],
    _updated: new Date().toISOString().slice(0, 10),
    _note: cfg.station._note
  };
  CFG.save(cfg);
  console.log(`Station set to "${match}" with tiers ${JSON.stringify(stations[match])}.`);
  console.log("Tiers were re-read from src/locations.js, so a newly added station works automatically.");
}

function modeDamageAnchor(ap, speed) {
  const cfg = CFG.load();
  if (ap == null) {
    console.log("Current damage anchor: " + JSON.stringify(cfg.damage_anchor, null, 2));
    console.log("\nSet with: node scripts/run.js damage-anchor <attack_power> [attack_speed]");
    return;
  }
  const { character } = boot({ requireGate: false });
  cfg.damage_anchor = {
    attack_power: Number(ap),
    attack_speed: speed != null ? Number(speed) : (cfg.damage_anchor || {}).attack_speed ?? null,
    recorded_at_hero_level: character.heroLevel,
    loadout: describeLoadout(character),
    _note: (cfg.damage_anchor || {})._note
  };
  CFG.save(cfg);
  console.log("Damage anchor recorded:\n" + JSON.stringify(cfg.damage_anchor, null, 2));
  console.log("\nOHK verdicts are now anchored rather than indicative.");
  console.log("Re-record it whenever the loadout above changes.");
}

function describeLoadout(character) {
  const eq = character.equipment || {};
  const part = k => (eq[k] && (eq[k].name || eq[k].id)) || null;
  return {
    weapon: part("weapon") || "unarmed", offhand: part("off-hand"),
    amulet: part("amulet"), artifact: part("artifact"), ring: part("ring"),
    armor: ["head", "torso", "arms", "legs", "feet", "cape"].map(part).filter(Boolean),
    stance: character.currentStance && character.currentStance.name
  };
}

function modeAssumptions() {
  console.log("ASSUMPTION REGISTRY\n");
  console.log("Every entry is an unverified premise. Code that relies on one carries an");
  console.log("`ASSUMPTION[Ax]` comment - grep for the id to find every dependent site.\n");
  for (const [id, a] of Object.entries(CFG.ASSUMPTIONS)) {
    console.log(`${id}  ${a.title}   [risk: ${a.risk}]`);
    console.log(`    claim:   ${a.claim}`);
    console.log(`    why:     ${a.why_unverified}`);
    console.log(`    settle:  ${a.how_to_settle}`);
    console.log(`    affects: ${a.affects}\n`);
  }
}

function modeAnchors() {
  const cfg = CFG.load();
  const game = P.parseAll(ROOT);
  printGate(G.runGate(cfg.anchors, game));
}

function writeLastRun(character, best) {
  const snap = {
    at: new Date().toISOString(),
    heroLevel: character.heroLevel,
    levels: Object.fromEntries(Object.values(character.skills).map(s => [s.id, s.level])),
    best: Object.fromEntries(Object.entries(best).map(([k, v]) => [k, Math.round(v.perRealMin * 100) / 100]))
  };
  fs.writeFileSync(LAST_RUN, JSON.stringify(snap, null, 1));
}

function modeDiff() {
  if (!fs.existsSync(LAST_RUN)) { console.log("No previous run recorded. Run the full analysis once first."); return; }
  const prev = JSON.parse(fs.readFileSync(LAST_RUN, "utf8"));
  const { cfg, game, character, found } = boot();
  printSaveHeader(found, character);
  const { best } = bestSources(game, character, cfg);
  hr("=");
  console.log(`CHANGES since ${prev.at}\n`);
  if (prev.heroLevel !== character.heroLevel) console.log(`   hero level ${prev.heroLevel} -> ${character.heroLevel}`);
  let any = false;
  for (const s of Object.values(character.skills)) {
    const before = prev.levels[s.id];
    if (before != null && before !== s.level) { console.log("   " + pad(s.id, 24) + `${before} -> ${s.level}`); any = true; }
  }
  if (!any) console.log("   no skill levels changed");
  console.log("");
  for (const [skill, b] of Object.entries(best)) {
    const before = prev.best[skill];
    if (before != null && Math.abs(before - b.perRealMin) / Math.max(before, 1e-9) > 0.05)
      console.log("   rate " + pad(skill, 22) + `${n1(before)} -> ${n1(b.perRealMin)} /real min   (${b.label})`);
  }
  writeLastRun(character, best);
}

/* ---------------- dispatch ---------------- */
const [cmd, ...rest] = process.argv.slice(2);
switch ((cmd || "full").toLowerCase()) {
  case "full": modeFull(); break;
  case "milestones": modeMilestones(); break;
  case "skill": modeSkill(rest.join(" ")); break;
  case "ohk": modeOhk(rest.join(" ")); break;
  case "station": modeStation(rest.join(" ")); break;
  case "damage-anchor": modeDamageAnchor(rest[0], rest[1]); break;
  case "assumptions": modeAssumptions(); break;
  case "anchors": modeAnchors(); break;
  case "diff": modeDiff(); break;
  default:
    console.log("usage: node scripts/run.js [full|milestones|skill <name>|ohk [zone]|station [name]|" +
      "damage-anchor <ap> [speed]|assumptions|anchors|diff]");
}
