'use strict';
// =============================================================================
//  FPL weekly decision tool
//  Run:   node fpl.js            (or double-click run.bat)
//  Then:  open dashboard.html
//
//  It fetches the official public FPL data, projects points for the next few
//  gameweeks from expected goals, expected assists, minutes, defensive actions,
//  bonus and fixtures, and writes one HTML page. Everything it produces is an
//  ESTIMATE.
// =============================================================================

// ----------------------------- SETTINGS --------------------------------------
// Change these numbers to tune the tool. The README explains each one.
// "Tested" notes are from replaying gameweeks 4-10 of 2026/27. The page shows
// how the current settings would have done, so you can test changes yourself.
const CONFIG = {
  teamId: 5798790,

  // The public API does not publish free transfers, so the tool works them out
  // from your transfer history. If it ever disagrees with the FPL site, put the
  // right number here (e.g. 2). null = work it out automatically.
  freeTransfersOverride: null,
  // Same idea for the bank, in £m (e.g. 0.5). null = use the API figure.
  bankOverride: null,

  // How many gameweeks ahead to look, and how much each one counts.
  // First number = next gameweek. Add or remove numbers to change the horizon.
  horizonWeights: [1, 0.8, 0.65, 0.5, 0.4],

  form: {
    // Each player is judged in three layers: his record last season -> his record
    // this season -> his recent form. The numbers say how much each layer counts.
    // How much each older match counts compared with the one after it, for recent form.
    // 1 = all matches equal, 0.6 = last week counts 60% as much as this week.
    decay: 0.6,
    // Matches' worth of his whole-season rate mixed into his recent form.
    seasonWeight: 6,
    // Matches' worth of last season's rate mixed into this season's.
    lastSeasonWeight: 15,
    // For players with no Premier League minutes last season: matches' worth of
    // "average player in his position" mixed in instead.
    averageWeight: 6,
    // Set to false to ignore last season and pull everyone towards the position average.
    // In the replay of gameweeks 4-10 the two were level within the noise (see README).
    useLastSeason: true,
  },

  teams: {
    // Team strength comes from expected goals; this share comes from real goals instead.
    // Tested 0, 0.5 and 1 (with an earlier version of the player model): 0 and 0.5 were level, 1 was worse.
    realGoalsWeight: 0.5,
    priorGames: 6,          // pulls team ratings towards average while few games are played
    homeAdvantage: 1.1,     // home teams create 10% more, away teams 10% less. Tested 1.0-1.2.
    fixtureStrength: 1,     // 0 = ignore who the opponent is, 1 = full effect
  },

  // Defensive-contribution actions needed for the 2 points (from FPL's rules).
  defensive: { threshold: { GKP: 0, DEF: 10, MID: 12, FWD: 12 } },

  bench: {
    // What a bench player's projected points are worth compared with a starter's.
    // A typical figure would be about 0.1. It is set high on purpose: you want
    // a bench of regular starters, so bench quality counts for a lot.
    outfieldWeight: 0.3,
    keeperWeight: 0.05,
  },

  transfers: {
    minStartChance: 0.65,    // never suggest buying anyone less likely than this to play 60+ minutes
    minAvailability: 0.75,   // ...or below this chance of playing next gameweek
    minMatches: 3,           // ...or with fewer Premier League matches than this this season
    minGain: 1.5,            // a move must gain at least this many points (over the horizon) to be recommended
    hitCost: 4,              // points per transfer beyond your free ones
    poolDepth: 3,            // candidates kept per position and price level
    alternativesShown: 8,
    defaultView: 'ALL',      // which tab the page opens on: 'ALL', 'GKP', 'DEF', 'MID' or 'FWD'
  },

  odds: {
    // Bookmaker odds from The Odds API. The key is read from the ODDS_API_KEY
    // environment variable, or from key.txt in the same folder as this script.
    // With no key, the tool runs on its own model as before.
    enabled: true,
    // Share of each team's expected goals in a match taken from the match odds
    // (the rest comes from the model). Not tested on past gameweeks: historical
    // odds cost extra, so this is a judgement. 0 = ignore match odds.
    matchOddsWeight: 0.75,
    // Share of each player's goal threat taken from anytime goalscorer odds.
    // Also untested. 0 = ignore goalscorer odds.
    goalscorerWeight: 0.5,
    matchRegion: 'uk',          // bookmakers for match odds
    goalscorerRegion: 'us',     // goalscorer odds are only offered by US bookmakers on this service
    cacheHours: 6,              // reuse odds fetched within this many hours, to save credits
  },

  lowStartFlag: 0.6,         // squad players below this chance of playing 60+ get a warning
  backtestFrom: 4,           // first gameweek used when checking the model against real results
};

// ----------------------------- FETCHING --------------------------------------
// FPL_API_BASE is only used for testing against a local copy of the data.
const API = (typeof process !== 'undefined' && process.env && process.env.FPL_API_BASE) ||
  'https://fantasy.premierleague.com/api/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) fpl-weekly-tool';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (msg) => { if (typeof process !== 'undefined' && process.stdout && process.stdout.write) process.stdout.write(msg); };

async function getJson(path) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(API + path, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) {
        const err = new Error('FPL returned HTTP ' + res.status + ' for ' + path);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } catch (err) {
      if (attempt >= 3 || err.status === 404) throw err;
      await sleep(1000 * attempt);
    }
  }
}

async function fetchBase(teamId) {
  const [boot, fixtures, entry, history, transfers] = await Promise.all([
    getJson('bootstrap-static/'),
    getJson('fixtures/'),
    getJson('entry/' + teamId + '/'),
    getJson('entry/' + teamId + '/history/'),
    getJson('entry/' + teamId + '/transfers/'),
  ]);
  const current = boot.events.find((e) => e.is_current);
  const next = boot.events.find((e) => e.is_next);
  if (!current) throw new Error('No gameweek has been played yet, so there are no picks to read.');
  if (!next) throw new Error('The season has finished: there is no next gameweek to plan for.');

  let picks = await getJson('entry/' + teamId + '/event/' + current.id + '/picks/');
  let freeHitReverted = false;
  if (picks.active_chip === 'freehit' && current.id > 1) {
    // A Free Hit squad is thrown away after the gameweek, so read the squad from the week before.
    picks = await getJson('entry/' + teamId + '/event/' + (current.id - 1) + '/picks/');
    freeHitReverted = true;
  }
  return { boot, fixtures, entry, history, transfers, picks, current, next, freeHitReverted };
}

// Match-by-match history for every player who has played this season
// (about 450 players), plus their previous seasons' totals. 8 at a time to be
// polite. Takes 10-30 seconds.
async function fetchHistories(ids) {
  const histories = {}, past = {};
  for (let i = 0; i < ids.length; i += 8) {
    const batch = ids.slice(i, i + 8);
    const results = await Promise.all(batch.map((id) => getJson('element-summary/' + id + '/').catch(() => null)));
    batch.forEach((id, k) => {
      if (!results[k]) return;
      histories[id] = results[k].history || [];
      past[id] = results[k].history_past || [];
    });
    if (i % 80 === 0) log('.');
  }
  log('\n');
  return { histories, past };
}

// ----------------------------- SMALL HELPERS ---------------------------------
const POS = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const sum = (arr) => arr.reduce((a, b) => a + b, 0);
const num = (v) => Number(v) || 0;
const money = (tenths) => '£' + (tenths / 10).toFixed(1) + 'm';
const r1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
const r2 = (x) => (Math.round(x * 100) / 100).toFixed(2);
const pct = (x) => Math.round(x * 100) + '%';
const signed = (x) => (x >= 0 ? '+' : '') + r1(x);   // +1.5 or -0.4

// Free transfers for the NEXT gameweek, replayed from the season's history.
// Rules used: 1 per gameweek, unused ones roll up to the cap, and a Wildcard or
// Free Hit week neither spends nor adds any.
function countFreeTransfers(historyRows, chips, cap) {
  const chipInWeek = {};
  chips.forEach((c) => { chipInWeek[c.event] = c.name; });
  let ft = 0;
  historyRows.forEach((row, index) => {
    if (index === 0) { ft = 1; return; }                    // first week: unlimited, then 1
    const chip = chipInWeek[row.event];
    if (chip === 'wildcard' || chip === 'freehit') return;  // kept as they were
    ft = Math.min(cap, Math.max(0, ft - row.event_transfers) + 1);
  });
  return ft;
}

// Selling price: you keep half of any profit, rounded down to £0.1m.
function sellPrice(element, transfers, freeHitWeeks) {
  const bought = transfers.find((t) => t.element_in === element.id && !freeHitWeeks.has(t.event));
  const paid = bought ? bought.element_in_cost : element.now_cost - element.cost_change_start;
  const profit = element.now_cost - paid;
  return { paid, sell: profit > 0 ? paid + Math.floor(profit / 2) : element.now_cost };
}

// ----------------------------- THE MODEL -------------------------------------
// Everything in this section works only from data passed in, so the same code
// is used for the weekly projections and for replaying past gameweeks.

// Expected value of floor(count / per) when the count is random around `mean`
// (a Poisson count). Used for "1 point per 3 saves" and "-1 per 2 goals conceded".
function expectedPerBlock(mean, per) {
  let total = 0, p = Math.exp(-mean), cdf = 0;
  for (let x = 0; x <= 40; x++) {
    if (x > 0) p *= mean / x;
    cdf += p;
    if ((x + 1) % per === 0) total += 1 - cdf;   // adds P(count >= x + 1)
  }
  return total;
}

// A player's matches before `beforeRound`, oldest first.
function earlierMatches(rows, beforeRound) {
  return (rows || []).filter((m) => m.round < beforeRound)
    .sort((a, b) => a.round - b.round || String(a.kickoff_time).localeCompare(String(b.kickoff_time)));
}

// Team ratings from expected goals (blended with real goals) in finished matches.
// attack > 1 = creates more than average. leak > 1 = allows more than average.
function rateTeams(data, cfg, beforeRound) {
  const fixtureById = new Map(data.fixtures.map((f) => [f.id, f]));
  const xgIn = {};                                   // xgIn[fixtureId][teamId] = team xG in that match
  Object.values(data.histories).forEach((rows) => rows.forEach((m) => {
    const f = fixtureById.get(m.fixture);
    if (!f || m.round >= beforeRound) return;
    const team = m.was_home ? f.team_h : f.team_a;
    xgIn[f.id] = xgIn[f.id] || {};
    xgIn[f.id][team] = (xgIn[f.id][team] || 0) + num(m.expected_goals);
  }));

  const w = cfg.teams.realGoalsWeight;
  const tally = {};
  data.teams.forEach((t) => { tally[t.id] = { made: 0, allowed: 0, played: 0 }; });
  let total = 0, teamGames = 0;
  data.fixtures.forEach((f) => {
    if (!f.finished || f.event >= beforeRound || !xgIn[f.id] || f.team_h_score === null) return;
    const home = (1 - w) * (xgIn[f.id][f.team_h] || 0) + w * f.team_h_score;
    const away = (1 - w) * (xgIn[f.id][f.team_a] || 0) + w * f.team_a_score;
    tally[f.team_h].made += home; tally[f.team_h].allowed += away; tally[f.team_h].played++;
    tally[f.team_a].made += away; tally[f.team_a].allowed += home; tally[f.team_a].played++;
    total += home + away; teamGames += 2;
  });
  const average = teamGames ? total / teamGames : 1.4;
  const prior = cfg.teams.priorGames;
  const ratings = {};
  data.teams.forEach((t) => {
    const s = tally[t.id];
    ratings[t.id] = {
      played: s.played,
      attack: (s.made + prior * average) / (s.played + prior) / average,
      leak: (s.allowed + prior * average) / (s.played + prior) / average,
    };
  });
  return { ratings, average };
}

// What one fixture looks like for a team: expected goals for and against,
// plus how much easier than usual it is to attack (attackFactor).
// If bookmaker odds for the match are available (`oddsGoals`), they are blended in.
function fixtureOutlook(teamInfo, cfg, team, opp, home, oddsGoals) {
  const { ratings, average } = teamInfo;
  const s = cfg.teams.fixtureStrength;
  const h = home ? cfg.teams.homeAdvantage : 1 / cfg.teams.homeAdvantage;
  const oppLeak = Math.pow(ratings[opp].leak, s), oppAttack = Math.pow(ratings[opp].attack, s);
  const modelFor = average * ratings[team].attack * oppLeak * h;
  const modelAgainst = average * oppAttack * ratings[team].leak / h;
  let goalsFor = modelFor, goalsAgainst = modelAgainst;
  if (oddsGoals) {
    const w = cfg.odds.matchOddsWeight;
    goalsFor = (1 - w) * modelFor + w * oddsGoals.for;
    goalsAgainst = (1 - w) * modelAgainst + w * oddsGoals.against;
  }
  return {
    goalsFor, goalsAgainst, modelFor, modelAgainst, odds: oddsGoals || null,
    attackFactor: goalsFor / (average * ratings[team].attack),       // multiplies the player's own xG and xA
    pressureFactor: goalsAgainst / (average * ratings[team].leak),   // multiplies a keeper's usual saves
  };
}

// League-wide averages per position: what an unknown player is assumed to be like.
function positionAverages(data, cfg, beforeRound) {
  const acc = {};
  Object.values(POS).forEach((p) => { acc[p] = { nineties: 0, xg: 0, xa: 0, saves: 0, full: 0, dc: 0, bonus: 0, played: 0, yellow: 0 }; });
  Object.entries(data.histories).forEach(([id, rows]) => {
    const e = data.elements.get(Number(id));
    if (!e) return;
    const pos = POS[e.element_type], a = acc[pos], need = cfg.defensive.threshold[pos];
    rows.forEach((m) => {
      if (m.round >= beforeRound || m.minutes === 0) return;
      a.nineties += Math.min(m.minutes, 90) / 90; a.xg += num(m.expected_goals); a.xa += num(m.expected_assists); a.saves += m.saves;
      a.played++; a.yellow += m.yellow_cards;
      if (m.minutes >= 60) { a.full++; a.bonus += m.bonus; if (need && m.defensive_contribution >= need) a.dc++; }
    });
  });
  const out = {};
  Object.entries(acc).forEach(([pos, a]) => {
    out[pos] = {
      xg90: a.nineties ? a.xg / a.nineties : 0, xa90: a.nineties ? a.xa / a.nineties : 0, saves90: a.nineties ? a.saves / a.nineties : 0,
      dcRate: a.full ? a.dc / a.full : 0, bonus60: a.full ? a.bonus / a.full : 0, yellowRate: a.played ? a.yellow / a.played : 0,
    };
  });
  return out;
}

// Chance a Poisson count with this mean reaches `need` (for defensive contributions).
function chanceAtLeast(mean, need) {
  let p = Math.exp(-mean), below = 0;
  for (let x = 0; x < need; x++) { if (x > 0) p *= mean / x; below += p; }
  return 1 - below;
}

// The most recent past season anyone has data for (e.g. '2025/26').
function latestPastSeason(past) {
  let latest = '';
  Object.values(past).forEach((seasons) => seasons.forEach((s) => { if (s.season_name > latest) latest = s.season_name; }));
  return latest;
}

// A player's rates from last season's totals, or null if he barely played.
// Last season only has totals, so his defensive-contribution hit rate is
// estimated from his average actions per 90.
function lastSeasonRates(seasons, lastSeason, pos, cfg) {
  const s = (seasons || []).find((x) => x.season_name === lastSeason);
  if (!s || s.minutes < 270) return null;
  const nineties = s.minutes / 90, need = cfg.defensive.threshold[pos];
  return {
    xg90: num(s.expected_goals) / nineties, xa90: num(s.expected_assists) / nineties, saves90: s.saves / nineties,
    bonus60: s.bonus / Math.max(1, s.starts), yellowRate: s.yellow_cards / nineties,
    dcRate: need ? chanceAtLeast(s.defensive_contribution / nineties, need) : 0,
  };
}

// A player's underlying rates, in three layers:
//   1. a starting point: his rates last season (or the position average if he has none),
//   2. this season's matches, which move him away from that starting point,
//   3. recent matches (newer ones count more), which move him again.
// Minutes come from recent matches only, so a player who has lost his place drops fast.
function playerRates(e, rows, seasons, lastSeason, posAverage, cfg, beforeRound) {
  const pos = POS[e.element_type];
  const need = cfg.defensive.threshold[pos];
  const matches = earlierMatches(rows, beforeRound);
  const tally = () => ({ weight: 0, full: 0, short: 0, nineties: 0, xg: 0, xa: 0, saves: 0, dc: 0, bonus: 0, played: 0, yellow: 0 });
  const recent = tally(), season = tally();
  matches.forEach((m, i) => {
    [[recent, Math.pow(cfg.form.decay, matches.length - 1 - i)], [season, 1]].forEach(([t, w]) => {
      t.weight += w;
      t.nineties += w * Math.min(m.minutes, 90) / 90;
      t.xg += w * num(m.expected_goals); t.xa += w * num(m.expected_assists); t.saves += w * m.saves;
      if (m.minutes > 0) { t.played += w; t.yellow += w * m.yellow_cards; }
      if (m.minutes >= 60) { t.full += w; t.bonus += w * m.bonus; if (need && m.defensive_contribution >= need) t.dc += w; }
      else if (m.minutes > 0) t.short += w;
    });
  });

  const last = cfg.form.useLastSeason ? lastSeasonRates(seasons, lastSeason, pos, cfg) : null;
  const startWeight = last ? cfg.form.lastSeasonWeight : cfg.form.averageWeight;
  const k = cfg.form.seasonWeight;
  // `key` names the rate; `count` and `base` say what to divide by (e.g. xG per 90 minutes).
  const layered = (key, count, base) => {
    const start = last ? last[key] : posAverage[key];
    const seasonRate = (season[count] + startWeight * start) / (season[base] + startWeight);
    return (recent[count] + k * seasonRate) / (recent[base] + k);
  };
  return {
    matches: matches.length,
    hasLastSeason: !!last,
    p60: recent.weight ? recent.full / recent.weight : 0,           // chance he plays 60+ minutes
    pShort: recent.weight ? recent.short / recent.weight : 0,       // chance he plays 1-59 minutes
    pPlay: recent.weight ? (recent.full + recent.short) / recent.weight : 0,
    mins90: recent.weight ? recent.nineties / recent.weight : 0,    // expected share of 90 minutes
    xg90: layered('xg90', 'xg', 'nineties'),
    xa90: layered('xa90', 'xa', 'nineties'),
    saves90: layered('saves90', 'saves', 'nineties'),
    dcRate: layered('dcRate', 'dc', 'full'),        // chance of defensive contribution points when he plays 60+
    bonus60: layered('bonus60', 'bonus', 'full'),
    yellowRate: layered('yellowRate', 'yellow', 'played'),
  };
}

// Expected points for one fixture, split into the parts FPL scores.
// `scorer` (optional) carries anytime goalscorer odds: his expected goals if he plays.
function fixturePoints(r, pos, sc, look, scorer) {
  let goalsInMatch = r.xg90 * r.mins90 * look.attackFactor;   // the model's expected goals for him
  if (scorer && r.pPlay > 0) {
    // Goalscorer bets are void if he doesn't play, so compare like with like: goals per appearance.
    const modelPerAppearance = goalsInMatch / r.pPlay;
    goalsInMatch = r.pPlay * ((1 - scorer.weight) * modelPerAppearance + scorer.weight * scorer.goalsPerAppearance);
  }
  const parts = {
    appearance: r.p60 * sc.long_play + r.pShort * sc.short_play,
    goals: goalsInMatch * sc.goals_scored[pos],
    assists: r.xa90 * r.mins90 * look.attackFactor * sc.assists,
    cleanSheet: r.p60 * Math.exp(-look.goalsAgainst) * sc.clean_sheets[pos],
    conceded: r.p60 * expectedPerBlock(look.goalsAgainst, 2) * sc.goals_conceded[pos],
    saves: pos === 'GKP' ? expectedPerBlock(r.saves90 * r.mins90 * look.pressureFactor, 3) * sc.saves : 0,
    defensive: r.p60 * r.dcRate * sc.defensive_contribution[pos],
    bonus: r.p60 * r.bonus60,
    cards: r.pPlay * r.yellowRate * sc.yellow_cards,
  };
  return { parts, total: sum(Object.values(parts)) };
}

// Chance of playing next gameweek from the FPL injury flag.
function availability(e) {
  let avail = e.status === 'a' ? 1 : e.status === 'd' ? 0.5 : 0;
  if (e.chance_of_playing_next_round !== null && e.chance_of_playing_next_round !== undefined) avail = e.chance_of_playing_next_round / 100;
  return avail;
}

// ----------------------------- BOOKMAKER ODDS --------------------------------
// Optional. Turns bookmaker prices into numbers the model understands:
//   match odds      -> each team's expected goals in that match
//   goalscorer odds -> each player's expected goals if he plays
const ODDS_API = (typeof process !== 'undefined' && process.env && process.env.ODDS_API_BASE) ||
  'https://api.the-odds-api.com/v4/sports/soccer_epl/';

// The key comes from the ODDS_API_KEY environment variable or key.txt next to this script.
function readOddsKey() {
  if (typeof process === 'undefined' || typeof require === 'undefined') return null;
  if (process.env.ODDS_API_KEY) return process.env.ODDS_API_KEY.trim();
  const fs = require('fs'), path = require('path');
  const file = path.join(__dirname, 'key.txt');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() || null : null;
}

async function getOdds(pathAndQuery) {
  const res = await fetch(ODDS_API + pathAndQuery, { signal: AbortSignal.timeout(20000) });
  const left = res.headers.get('x-requests-remaining');
  if (!res.ok) {
    // The service explains itself in the reply, e.g. when the month's credits are used up.
    let said = '';
    try { const body = await res.json(); said = [body.error_code, body.message].filter(Boolean).join(' '); } catch (err) { /* no details */ }
    const outOfCredits = /quota|credit|usage/i.test(said) || left === '0';
    const why = outOfCredits ? 'this month\'s free credits are used up (they reset at the start of your next monthly cycle)'
      : res.status === 401 ? 'the key was rejected' : res.status === 429 ? 'too many requests at once' : 'HTTP ' + res.status;
    throw new Error('The Odds API: ' + why + (said && !outOfCredits ? ' (' + said + ')' : ''));
  }
  return { body: await res.json(), left: left === null ? null : Number(left) };
}

// Team names differ between FPL ("Man City") and bookmakers ("Manchester City").
const TEAM_ALIASES = {
  'man city': 'manchester city', 'man utd': 'manchester united', 'spurs': 'tottenham hotspur',
  "nott'm forest": 'nottingham forest', 'wolves': 'wolverhampton wanderers',
};
const LETTERS = { 'ø': 'o', 'æ': 'ae', 'ß': 'ss', 'ł': 'l', 'đ': 'd', 'ı': 'i', 'þ': 'th' };   // letters accents-stripping misses
const cleanName = (s) => String(s || '').toLowerCase().replace(/[øæßłđıþ]/g, (c) => LETTERS[c]).normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ').replace(/[^a-z ]/g, ' ').replace(/\b(fc|afc)\b/g, ' ').replace(/\s+/g, ' ').trim();
function sameTeam(fplTeam, oddsName) {
  const a = cleanName(TEAM_ALIASES[fplTeam.name.toLowerCase()] || fplTeam.name), b = cleanName(oddsName);
  return a === b || b.startsWith(a + ' ') || a.startsWith(b + ' ');
}

// Pair each bookmaker event with an FPL fixture: same teams, kick-off within two days.
function matchEvents(events, fixtures, teams) {
  const byId = new Map(teams.map((t) => [t.id, t]));
  const paired = {}, unmatched = [];
  events.forEach((ev) => {
    const f = fixtures.find((fx) => fx.kickoff_time && !fx.finished &&
      sameTeam(byId.get(fx.team_h), ev.home_team) && sameTeam(byId.get(fx.team_a), ev.away_team) &&
      Math.abs(new Date(fx.kickoff_time) - new Date(ev.commence_time)) < 2 * 864e5);
    if (f) paired[f.id] = ev; else unmatched.push(ev.home_team + ' v ' + ev.away_team);
  });
  return { paired, unmatched };
}

// Downloads odds (or reuses a recent copy saved in odds-cache.json).
// Costs about 2 credits for match odds plus 1 per match with goalscorer odds.
async function fetchOdds(cfg, base) {
  if (!cfg.odds.enabled) return { status: 'off', reason: 'switched off in CONFIG' };
  const key = readOddsKey();
  if (!key) return { status: 'off', reason: 'no key found (set ODDS_API_KEY, or put key.txt next to fpl.js)' };
  const fs = require('fs'), path = require('path');
  const cacheFile = path.join(__dirname, 'odds-cache.json');
  try {
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cache.nextGw === base.next.id && Date.now() - cache.savedAt < cfg.odds.cacheHours * 36e5) return Object.assign(cache, { status: 'ok', fromCache: true });
  } catch (err) { /* no usable cache */ }

  try {
    const q = '&oddsFormat=decimal&apiKey=' + encodeURIComponent(key);
    const matches = await getOdds('odds/?regions=' + cfg.odds.matchRegion + '&markets=h2h,totals' + q);
    let left = matches.left;
    // Goalscorer odds only for next gameweek's matches (they are priced one match at a time).
    const { paired } = matchEvents(matches.body, base.fixtures, base.boot.teams);
    const scorers = {};
    for (const [fixtureId, ev] of Object.entries(paired)) {
      const fx = base.fixtures.find((f) => f.id === Number(fixtureId));
      if (fx.event !== base.next.id) continue;
      try {
        const r = await getOdds('events/' + ev.id + '/odds/?regions=' + cfg.odds.goalscorerRegion + '&markets=player_goal_scorer_anytime' + q);
        scorers[ev.id] = r.body;
        if (r.left !== null) left = r.left;
      } catch (err) { /* one match missing is fine */ }
    }
    const result = { savedAt: Date.now(), nextGw: base.next.id, matches: matches.body, scorers, left };
    fs.writeFileSync(cacheFile, JSON.stringify(result));
    return Object.assign(result, { status: 'ok', fromCache: false });
  } catch (err) {
    return { status: 'error', reason: err.message };
  }
}

// --- turning prices into goals ---
const poissonChance = (k, mean) => { let p = Math.exp(-mean); for (let i = 1; i <= k; i++) p *= mean / i; return p; };
function chanceOver(line, mean) {
  let below = 0;
  for (let k = 0; k <= Math.floor(line); k++) below += poissonChance(k, mean);
  return 1 - below;
}
// Chance the home side wins minus chance the away side wins, for given expected goals.
function winEdge(homeGoals, awayGoals) {
  let edge = 0;
  for (let h = 0; h <= 10; h++) for (let a = 0; a <= 10; a++) {
    if (h === a) continue;
    edge += (h > a ? 1 : -1) * poissonChance(h, homeGoals) * poissonChance(a, awayGoals);
  }
  return edge;
}
// Simple search for the x where f(x) = target, f increasing between lo and hi.
function solve(f, target, lo, hi) {
  for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (f(mid) < target) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

// One match's odds -> expected goals for each side.
// Prices are turned into chances with the bookmaker's margin removed, averaged
// over bookmakers. The over/under price fixes the total goals; the win/draw/loss
// prices fix how that total splits between the teams.
function goalsFromMatchOdds(ev, fallbackTotal) {
  const results = [], overs = {};
  (ev.bookmakers || []).forEach((bk) => (bk.markets || []).forEach((mk) => {
    if (mk.key === 'h2h') {
      const price = (name) => (mk.outcomes.find((o) => o.name === name) || {}).price;
      const ph = price(ev.home_team), pa = price(ev.away_team), pd = price('Draw');
      if (!ph || !pa || !pd) return;
      const total = 1 / ph + 1 / pa + 1 / pd;
      results.push({ home: 1 / ph / total, away: 1 / pa / total });
    }
    if (mk.key === 'totals') {
      const over = mk.outcomes.find((o) => o.name === 'Over'), under = mk.outcomes.find((o) => o.name === 'Under');
      if (!over || !under || over.point !== under.point) return;
      (overs[over.point] = overs[over.point] || []).push((1 / over.price) / (1 / over.price + 1 / under.price));
    }
  }));
  if (!results.length) return null;
  const pHome = sum(results.map((r) => r.home)) / results.length, pAway = sum(results.map((r) => r.away)) / results.length;
  // Use the most-quoted goals line (usually 2.5).
  const line = Object.keys(overs).sort((a, b) => overs[b].length - overs[a].length)[0];
  const total = line !== undefined
    ? solve((m) => chanceOver(Number(line), m), sum(overs[line]) / overs[line].length, 0.3, 7)
    : fallbackTotal;
  const share = solve((s) => winEdge(s * total, (1 - s) * total), pHome - pAway, 0.02, 0.98);
  return { home: share * total, away: (1 - share) * total, books: results.length };
}

// Which FPL player does a bookmaker name like "Erling Haaland" mean? Only players of the two teams are considered.
function findPlayer(name, candidates) {
  const n = cleanName(name), parts = n.split(' '), last = parts[parts.length - 1];
  const full = (e) => [cleanName(e.first_name + ' ' + e.second_name), cleanName(e.known_name), cleanName(e.web_name)];
  let hit = candidates.filter((e) => full(e).includes(n));
  if (hit.length === 1) return hit[0];
  hit = candidates.filter((e) => cleanName(e.second_name).split(' ').includes(last) || cleanName(e.web_name).split(' ').pop() === last);
  if (hit.length > 1) hit = hit.filter((e) => cleanName(e.first_name)[0] === n[0]);
  if (hit.length === 1) return hit[0];
  // Bookmakers often use full legal names ("Ogochukwu Onyeka Frank" for Frank Onyeka),
  // or drop hyphens ("Gannondoak"). Try those forms, accepting only a single clear match.
  const words = parts, squash = (s) => cleanName(s).replace(/ /g, '');
  hit = candidates.filter((e) => [squash(e.first_name + e.second_name), squash(e.known_name), squash(e.web_name)].includes(n.replace(/ /g, '')));
  if (hit.length === 1) return hit[0];
  hit = candidates.filter((e) => { const short = cleanName(e.web_name).split(' ').pop(); return short.length >= 4 && words.includes(short); });
  if (hit.length === 1) return hit[0];
  hit = candidates.filter((e) => cleanName(e.second_name).split(' ').some((t) => t.length >= 4 && words.includes(t)) &&
    cleanName(e.first_name).split(' ').some((t) => words.includes(t)));
  return hit.length === 1 ? hit[0] : null;
}

// Anytime goalscorer odds for one match -> each player's expected goals if he plays.
// The bookmaker's margin is removed by scaling each team's players down so that,
// allowing for who is likely to play, they add up to the team's expected goals.
function goalsFromScorerOdds(body, fx, teamGoals, players, ratesFor) {
  const chances = {};   // bookmaker name -> list of implied chances
  (body.bookmakers || []).forEach((bk) => (bk.markets || []).forEach((mk) => {
    if (mk.key !== 'player_goal_scorer_anytime') return;
    mk.outcomes.forEach((o) => {
      const yes = o.name === 'Yes' || (o.name === 'Over' && o.point === 0.5);
      if (yes && o.description && o.price > 1) (chances[o.description] = chances[o.description] || []).push(1 / o.price);
    });
  }));
  const candidates = players.filter((e) => e.team === fx.team_h || e.team === fx.team_a);
  const out = {}, missing = [], byTeam = {};
  Object.entries(chances).forEach(([name, list]) => {
    const e = findPlayer(name, candidates);
    if (!e) { missing.push(name); return; }
    const p = Math.min(0.95, sum(list) / list.length);
    out[e.id] = { name, rawChance: p, goals: -Math.log(1 - p) };   // chance of 1+ goals -> expected goals
    (byTeam[e.team] = byTeam[e.team] || []).push(e);
  });
  Object.entries(byTeam).forEach(([team, list]) => {
    const target = teamGoals[team] * 0.97;   // about 3% of goals are own goals
    const implied = sum(list.map((e) => out[e.id].goals * ratesFor(e).pPlay));
    const scale = implied > 0 ? clamp(target / implied, 0.6, 1) : 1;   // only ever removes margin
    list.forEach((e) => { out[e.id].goals *= scale; });
  });
  return { players: out, missing };
}

// Puts the odds into the shape the model uses, and writes a short status line for the page.
function interpretOdds(raw, ctx) {
  const empty = { goals: {}, scorers: {}, status: '' };
  if (raw.status === 'off') return Object.assign(empty, { status: 'Bookmaker odds are not used: ' + raw.reason + '.' });
  if (raw.status === 'error') return Object.assign(empty, { status: 'Bookmaker odds could not be fetched (' + raw.reason + '), so this run uses the model alone.' });

  const fixtures = ctx.data.fixtures, horizon = new Set(ctx.weeks.map((w) => w.gw));
  const { paired, unmatched } = matchEvents(raw.matches, fixtures, [...ctx.teams.values()]);
  const goals = {};
  Object.entries(paired).forEach(([id, ev]) => {
    const fx = fixtures.find((f) => f.id === Number(id));
    const model = fixtureOutlook(ctx.teamInfo, ctx.cfg, fx.team_h, fx.team_a, true);
    const g = goalsFromMatchOdds(ev, model.goalsFor + model.goalsAgainst);
    if (g) goals[id] = g;
  });

  const scorers = {}, missing = [];
  let scorerMatches = 0, scorerPlayers = 0;
  const players = [...ctx.elements.values()];
  const ratesFor = (e) => playerRates(e, ctx.data.histories[e.id], ctx.data.past[e.id], ctx.data.lastSeason, ctx.posAverages[POS[e.element_type]], ctx.cfg, ctx.next.id);
  Object.entries(paired).forEach(([id, ev]) => {
    const body = raw.scorers && raw.scorers[ev.id];
    if (!body) return;
    const fx = fixtures.find((f) => f.id === Number(id));
    const model = fixtureOutlook(ctx.teamInfo, ctx.cfg, fx.team_h, fx.team_a, true, goals[id] ? { for: goals[id].home, against: goals[id].away } : null);
    const teamGoals = { [fx.team_h]: model.goalsFor, [fx.team_a]: model.goalsAgainst };
    const res = goalsFromScorerOdds(body, fx, teamGoals, players, ratesFor);
    if (!Object.keys(res.players).length) return;
    scorers[id] = res.players; scorerMatches++; scorerPlayers += Object.keys(res.players).length; missing.push(...res.missing);
  });

  const notFound = [...new Set(missing)];
  const inHorizon = fixtures.filter((f) => horizon.has(f.event)).length;
  const withOdds = Object.keys(goals).filter((id) => horizon.has(fixtures.find((f) => f.id === Number(id)).event)).length;
  const nextCount = fixtures.filter((f) => f.event === ctx.next.id).length;
  const when = new Date(raw.savedAt).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
  let status = 'Bookmaker odds (fetched ' + when + (raw.fromCache ? ', reused from the saved copy' : '') + '): match odds for ' + withOdds + ' of ' + inHorizon + ' fixtures in the next ' + ctx.weeks.length + ' gameweeks';
  status += scorerMatches
    ? '; anytime goalscorer odds for ' + scorerMatches + ' of ' + nextCount + ' gameweek ' + ctx.next.id + ' matches (' + scorerPlayers + ' players' + (notFound.length ? '; not matched to an FPL player: ' + notFound.slice(0, 8).join(', ') + (notFound.length > 8 ? ' and ' + (notFound.length - 8) + ' more' : '') : '') + ')'
    : '; no anytime goalscorer odds yet for gameweek ' + ctx.next.id + ' (bookmakers usually publish them a few days before kick-off; run it again nearer the deadline)';
  if (unmatched.length) status += '. Bookmaker matches not paired with an FPL fixture: ' + unmatched.slice(0, 5).join(', ');
  if (raw.left !== null && raw.left !== undefined) status += '. Credits left this month: ' + raw.left;
  return { goals, scorers, status: status + '.' };
}

// ----------------------------- CHECKING THE MODEL ----------------------------
// Replays past gameweeks: for each one, projects every player using only the
// matches before it, then compares with what he actually scored.
// Injury news from the time isn't available, so everyone is treated as fit.
// Last season's totals are used too: they were known before this season began.
function backtest(data, cfg, rounds) {
  const fixtureById = new Map(data.fixtures.map((f) => [f.id, f]));
  const records = [];
  rounds.forEach((g) => {
    const teamInfo = rateTeams(data, cfg, g), posAvg = positionAverages(data, cfg, g);
    Object.entries(data.histories).forEach(([id, rows]) => {
      const e = data.elements.get(Number(id));
      const before = earlierMatches(rows, g);
      if (!e || before.length < 3) return;
      const pos = POS[e.element_type];
      const r = playerRates(e, rows, data.past[id], data.lastSeason, posAvg[pos], cfg, g);
      const regular = before.filter((m) => m.minutes >= 60).length / before.length >= 0.6;
      rows.filter((m) => m.round === g).forEach((m) => {
        const f = fixtureById.get(m.fixture);
        if (!f) return;
        const team = m.was_home ? f.team_h : f.team_a, opp = m.was_home ? f.team_a : f.team_h;
        const projected = fixturePoints(r, pos, data.scoring, fixtureOutlook(teamInfo, cfg, team, opp, m.was_home)).total;
        records.push({ g, regular, projected, actual: m.total_points });
      });
    });
  });
  return records;
}

// Two plain measures from the replay, both for regular starters (the players you'd actually pick):
// how well projections line up with real scores, and how the top 20 each week really did.
function summariseBacktest(records) {
  const reg = records.filter((r) => r.regular);
  if (reg.length < 50) return null;
  const n = reg.length, mp = sum(reg.map((r) => r.projected)) / n, ma = sum(reg.map((r) => r.actual)) / n;
  const cov = sum(reg.map((r) => (r.projected - mp) * (r.actual - ma)));
  const vp = sum(reg.map((r) => (r.projected - mp) ** 2)), va = sum(reg.map((r) => (r.actual - ma) ** 2));
  const weeks = [...new Set(reg.map((r) => r.g))];
  const top = sum(weeks.map((g) => {
    const best = reg.filter((r) => r.g === g).sort((a, b) => b.projected - a.projected).slice(0, 20);
    return sum(best.map((r) => r.actual)) / best.length;
  })) / weeks.length;
  return { weeks, n, correlation: cov / Math.sqrt(vp * va), topAverage: top, average: ma, projectedAverage: mp };
}

// ----------------------------- PREPARE ---------------------------------------
// Turns the raw API data into the facts the model needs.
function prepare(base, fetched, oddsRaw, cfg) {
  const { boot, fixtures, entry, history, transfers, picks, current, next } = base;
  const elements = new Map(boot.elements.map((e) => [e.id, e]));
  const teams = new Map(boot.teams.map((t) => [t.id, t]));
  const data = {
    fixtures, histories: fetched.histories, past: fetched.past, lastSeason: latestPastSeason(fetched.past),
    teams: boot.teams, elements, scoring: boot.game_config.scoring,
  };

  // Gameweeks in the horizon, and each team's fixtures in them.
  const lastWeek = Math.max(...boot.events.map((e) => e.id));
  const weeks = cfg.horizonWeights.map((w, i) => ({ gw: next.id + i, weight: w })).filter((x) => x.gw <= lastWeek);
  const fixturesFor = {};   // fixturesFor[gw][teamId] = [{ opp, home }]
  weeks.forEach((x) => { fixturesFor[x.gw] = {}; });
  fixtures.forEach((f) => {
    if (!fixturesFor[f.event]) return;
    const week = fixturesFor[f.event];
    (week[f.team_h] = week[f.team_h] || []).push({ opp: f.team_a, home: true, fixtureId: f.id });
    (week[f.team_a] = week[f.team_a] || []).push({ opp: f.team_h, home: false, fixtureId: f.id });
  });

  const { squadIds, bank, pendingCount } = currentSquad(base, cfg);
  const cap = 1 + ((boot.game_settings && boot.game_settings.max_extra_free_transfers) || 4);
  const derivedFt = Math.max(0, countFreeTransfers(history.current, history.chips, cap) - pendingCount);
  const freeTransfers = cfg.freeTransfersOverride !== null ? cfg.freeTransfersOverride : derivedFt;

  const freeHitWeeks = new Set(history.chips.filter((c) => c.name === 'freehit').map((c) => c.event));
  const prices = {};
  squadIds.forEach((id) => { prices[id] = sellPrice(elements.get(id), transfers, freeHitWeeks); });

  // Replay finished gameweeks to show how the model has done this season.
  const lastFinished = current.finished ? current.id : current.id - 1;
  const rounds = [];
  for (let g = cfg.backtestFrom; g <= lastFinished; g++) rounds.push(g);

  const ctx = {
    cfg, data, elements, teams, weeks, fixturesFor, squadIds, bank, freeTransfers, cap, prices,
    ftOverridden: cfg.freeTransfersOverride !== null, pendingCount,
    teamInfo: rateTeams(data, cfg, next.id), posAverages: positionAverages(data, cfg, next.id),
    track: summariseBacktest(backtest(data, cfg, rounds)),
    entry, current, next, freeHitReverted: base.freeHitReverted,
    teamLimit: (boot.game_settings && boot.game_settings.squad_team_limit) || 3,
  };
  ctx.odds = interpretOdds(oddsRaw || { status: 'off', reason: 'not requested' }, ctx);
  return ctx;
}

// Squad: last deadline's picks, plus any transfers already made for next week.
function currentSquad(base, cfg) {
  const pending = base.transfers.filter((t) => t.event === base.next.id).reverse();   // oldest first
  let squadIds = base.picks.picks.map((p) => p.element);
  let bank = base.picks.entry_history.bank;
  pending.forEach((t) => {
    squadIds = squadIds.filter((id) => id !== t.element_out).concat(t.element_in);
    bank += t.element_out_cost - t.element_in_cost;
  });
  if (cfg.bankOverride !== null) bank = Math.round(cfg.bankOverride * 10);
  return { squadIds, bank, pendingCount: pending.length };
}

// ----------------------------- PROJECTION ------------------------------------
// Projected points for one player over the horizon.
function project(ctx, e) {
  const pos = POS[e.element_type];
  const r = playerRates(e, ctx.data.histories[e.id], ctx.data.past[e.id], ctx.data.lastSeason, ctx.posAverages[pos], ctx.cfg, ctx.next.id);
  const avail = availability(e);
  const availLater = avail >= 0.5 ? 1 : avail;   // a knock is assumed to clear after next week
  const nextParts = {};
  let scorerOdds = null;

  const fixtures = ctx.weeks.map((week, i) => {
    const chance = i === 0 ? avail : availLater;
    const list = (ctx.fixturesFor[week.gw][e.team] || []).map((fx) => {
      const match = ctx.odds.goals[fx.fixtureId];
      const oddsGoals = match && (fx.home ? { for: match.home, against: match.away } : { for: match.away, against: match.home });
      const look = fixtureOutlook(ctx.teamInfo, ctx.cfg, e.team, fx.opp, fx.home, oddsGoals);
      const odds = ctx.odds.scorers[fx.fixtureId] && ctx.odds.scorers[fx.fixtureId][e.id];
      const scorer = odds && { goalsPerAppearance: odds.goals, weight: ctx.cfg.odds.goalscorerWeight };
      const pts = fixturePoints(r, pos, ctx.data.scoring, look, scorer);
      if (i === 0) {
        Object.entries(pts.parts).forEach(([k, v]) => { nextParts[k] = (nextParts[k] || 0) + v * chance; });
        if (odds) scorerOdds = odds;
      }
      return { opp: ctx.teams.get(fx.opp).short_name, home: fx.home, look, points: pts.total * chance };
    });
    return { gw: week.gw, list, x: sum(list.map((x) => x.points)) };   // blank = 0, double = two fixtures
  });
  const x = fixtures.map((f) => f.x);

  return {
    id: e.id, name: e.web_name, team: e.team, club: ctx.teams.get(e.team).short_name, pos,
    cost: e.now_cost, status: e.status, news: e.news || '', penalties: e.penalties_order,
    rates: r, avail, fixtures, nextParts, scorerOdds,
    x, xNext: x[0] || 0, xHorizon: sum(x.map((v, i) => v * ctx.weeks[i].weight)),
  };
}

// ----------------------------- TEAM SELECTION --------------------------------
// Best legal eleven for horizon week i: 1 GKP, 3-5 DEF, 2-5 MID, 1-3 FWD.
function bestEleven(squad, i) {
  const by = { GKP: [], DEF: [], MID: [], FWD: [] };
  squad.forEach((p) => by[p.pos].push(p));
  Object.values(by).forEach((list) => list.sort((a, b) => b.x[i] - a.x[i]));
  let best = null;
  for (let d = 3; d <= 5; d++) for (let m = 2; m <= 5; m++) {
    const f = 10 - d - m;
    if (f < 1 || f > 3) continue;
    const xi = [by.GKP[0], ...by.DEF.slice(0, d), ...by.MID.slice(0, m), ...by.FWD.slice(0, f)];
    const total = sum(xi.map((p) => p.x[i]));
    if (!best || total > best.total) best = { xi, total };
  }
  const bench = squad.filter((p) => !best.xi.includes(p)).sort((a, b) => b.x[i] - a.x[i]);
  return { xi: best.xi, bench, total: best.total };
}

// One number for a whole 15-man squad over the horizon:
// starters + captain's extra points + a weighted share of the bench.
function squadValue(ctx, squad) {
  const b = ctx.cfg.bench;
  let value = 0;
  ctx.weeks.forEach((week, i) => {
    const team = bestEleven(squad, i);
    const captain = Math.max(...team.xi.map((p) => p.x[i]));
    const bench = sum(team.bench.map((p) => p.x[i] * (p.pos === 'GKP' ? b.keeperWeight : b.outfieldWeight)));
    value += week.weight * (team.total + captain + bench);
  });
  return value;
}

// ----------------------------- TRANSFERS -------------------------------------
// Is this player allowed to be suggested as a buy at all?
function buyable(ctx, p) {
  const t = ctx.cfg.transfers;
  return p.status !== 'u' && p.rates.matches >= t.minMatches && p.rates.p60 >= t.minStartChance && p.avail >= t.minAvailability;
}

// Keep a player only if fewer than `depth` better players cost the same or less.
function efficientPool(players, depth) {
  const pool = { GKP: [], DEF: [], MID: [], FWD: [] };
  players.slice().sort((a, b) => b.xHorizon - a.xHorizon).forEach((p) => {
    if (pool[p.pos].filter((k) => k.cost <= p.cost).length < depth) pool[p.pos].push(p);
  });
  return pool;
}

function clubCounts(squad) {
  const counts = {};
  squad.forEach((p) => { counts[p.team] = (counts[p.team] || 0) + 1; });
  return counts;
}

function findTransfers(ctx, squad, pool) {
  const baseValue = squadValue(ctx, squad);
  const sell = (p) => ctx.prices[p.id].sell;
  const legalClubs = (newSquad) => Object.values(clubCounts(newSquad)).every((n) => n <= ctx.teamLimit);

  const singles = [];
  squad.forEach((out) => pool[out.pos].forEach((inn) => {
    const left = ctx.bank + sell(out) - inn.cost;
    if (left < 0) return;
    const newSquad = squad.map((p) => (p === out ? inn : p));
    if (!legalClubs(newSquad)) return;
    singles.push({ moves: [{ out, inn }], gain: squadValue(ctx, newSquad) - baseValue, left, newSquad });
  }));
  singles.sort((a, b) => b.gain - a.gain);

  // Best pair overall, and the best pair that buys at least one player in each position.
  const bestPairs = { ALL: null, GKP: null, DEF: null, MID: null, FWD: null };
  for (let a = 0; a < squad.length; a++) for (let b = a + 1; b < squad.length; b++) {
    const out1 = squad[a], out2 = squad[b];
    const funds = ctx.bank + sell(out1) + sell(out2);
    pool[out1.pos].forEach((in1) => pool[out2.pos].forEach((in2) => {
      if (in1 === in2) return;
      const left = funds - in1.cost - in2.cost;
      if (left < 0) return;
      const newSquad = squad.map((p) => (p === out1 ? in1 : p === out2 ? in2 : p));
      if (!legalClubs(newSquad)) return;
      const gain = squadValue(ctx, newSquad) - baseValue;
      ['ALL', in1.pos, in2.pos].forEach((key) => {
        if (bestPairs[key] && gain <= bestPairs[key].gain) return;
        bestPairs[key] = { moves: [{ out: out1, inn: in1 }, { out: out2, inn: in2 }], gain, left, newSquad };
      });
    }));
  }
  return { singles, bestPairs, baseValue };
}

// A sentence or two of reasoning for one swap, built from the same inputs the model used.
function explainMove(ctx, move, newSquad) {
  const { out, inn } = move;
  const run = (p) => p.fixtures.slice(0, 3).map((f) => f.list.map((x) => x.opp + (x.home ? ' (H)' : ' (A)')).join(' + ') || 'blank').join(', ');
  const ri = inn.rates, ro = out.rates;
  let why = inn.name + ' projects ' + r1(inn.xHorizon) + ' weighted points over the next ' + ctx.weeks.length + ' gameweeks against ' +
    r1(out.xHorizon) + ' for ' + out.name + '. He plays 60+ minutes ' + pct(ri.p60) + ' of the time (v ' + pct(ro.p60) + ')';
  if (inn.pos === 'GKP') why += ', makes ' + r1(ri.saves90) + ' saves per 90 (v ' + r1(ro.saves90) + ')';
  else why += ', with xG + xA of ' + r2(ri.xg90 + ri.xa90) + ' per 90 (v ' + r2(ro.xg90 + ro.xa90) + ')';
  if (inn.pos === 'DEF' || (ri.dcRate + ro.dcRate) > 0.4) why += ' and defensive contribution points in ' + pct(ri.dcRate) + ' of full games (v ' + pct(ro.dcRate) + ')';
  why += '.';
  if (out.avail < 1) why += ' ' + out.name + ' is flagged at ' + pct(out.avail) + ' to play.';
  why += ' Next fixtures: ' + run(inn) + ' (his) v ' + run(out) + '. ';
  why += bestEleven(newSquad, 0).xi.includes(inn) ? 'He would go straight into your eleven.' : 'He would be a playing option on your bench.';
  return why;
}

// ----------------------------- ANALYSE ---------------------------------------
const VIEW_KEYS = ['ALL', 'GKP', 'DEF', 'MID', 'FWD'];
const VIEW_NAMES = { ALL: 'Best overall', GKP: 'Goalkeeper', DEF: 'Defender', MID: 'Midfielder', FWD: 'Forward' };
function analyse(ctx) {
  const cfg = ctx.cfg, t = cfg.transfers;
  const squad = ctx.squadIds.map((id) => project(ctx, ctx.elements.get(id)));
  const candidates = Object.keys(ctx.data.histories).map(Number)
    .filter((id) => !ctx.squadIds.includes(id) && ctx.elements.has(id))
    .map((id) => project(ctx, ctx.elements.get(id)))
    .filter((p) => buyable(ctx, p));
  const pool = efficientPool(candidates, t.poolDepth);

  const team = bestEleven(squad, 0);
  const order = team.xi.slice().sort((a, b) => b.xNext - a.xNext);
  const keeperSub = team.bench.find((p) => p.pos === 'GKP');
  const bench = [keeperSub, ...team.bench.filter((p) => p !== keeperSub)].filter(Boolean);

  const found = findTransfers(ctx, squad, pool);
  const hit = (count) => Math.max(0, count - ctx.freeTransfers) * t.hitCost;
  const describe = (plan) => plan && {
    moves: plan.moves.map((m) => ({ out: m.out, inn: m.inn, sell: ctx.prices[m.out.id].sell, why: explainMove(ctx, m, plan.newSquad) })),
    gain: plan.gain, hit: hit(plan.moves.length), net: plan.gain - hit(plan.moves.length), left: plan.left,
  };
  // Decide what to recommend from a best single and a best pair: nothing, one move, or two.
  const atCap = ctx.freeTransfers >= ctx.cap;
  const decide = (one, two) => {
    let pick = 'roll', verdict;
    if (one && (one.net >= t.minGain || (atCap && one.gain > 0))) pick = 'one';
    if (two && two.net >= t.minGain && two.net >= (pick === 'one' ? one.net : 0) + t.minGain) pick = 'two';
    if (pick === 'roll') {
      verdict = 'No move clears the bar of +' + t.minGain + ' points, so the model would save the transfer' +
        (ctx.freeTransfers < ctx.cap ? ' and carry ' + Math.min(ctx.cap, ctx.freeTransfers + 1) + ' into the following week.' : '.');
    } else if (pick === 'one') {
      verdict = 'Make the single transfer.' + (one.hit ? ' It costs a ' + one.hit + '-point hit, already taken off the net gain.' : '') +
        (atCap && one.net < t.minGain ? ' The gain is small, but you are at the cap of ' + ctx.cap + ' free transfers, so saving one would waste it.' : '') +
        (two && ctx.freeTransfers >= 2 ? ' The second transfer adds less than +' + t.minGain + ' on top, so the model would keep it.' : '');
    } else {
      verdict = 'Make both transfers.' + (two.hit ? ' That includes a ' + two.hit + '-point hit, already taken off the net gain.' : '');
    }
    return { pick, verdict };
  };

  // One view for "best overall" and one per position you might want to buy.
  const views = {};
  VIEW_KEYS.forEach((key) => {
    const singles = key === 'ALL' ? found.singles : found.singles.filter((plan) => plan.moves[0].inn.pos === key);
    const one = describe(singles[0]);
    const two = describe(found.bestPairs[key]);
    views[key] = Object.assign({ one, two, alternatives: singles.slice(0, t.alternativesShown).map(describe) }, decide(one, two));
  });
  const { one, two, pick, verdict } = views.ALL;

  // Shortlist for the fixture grid: every player the transfer views suggested, best projection first.
  const seen = new Set();
  const shortlist = [];
  VIEW_KEYS.forEach((key) => {
    const v = views[key];
    [v.one, v.two, ...v.alternatives].filter(Boolean).forEach((plan) => plan.moves.forEach((mv) => {
      if (!seen.has(mv.inn.id)) { seen.add(mv.inn.id); shortlist.push(mv.inn); }
    }));
  });
  shortlist.sort((a, b) => b.xHorizon - a.xHorizon);

  return {
    ctx, squad, team, bench, captain: order[0], vice: order[1], captainOptions: order.slice(0, 4), one, two, pick, verdict, views,
    candidates, shortlist: shortlist.slice(0, 10), poolSize: candidates.length, generated: new Date(),
  };
}

// ----------------------------- HTML ------------------------------------------
// The page has three tabs: This week (captain, transfers, team on a pitch),
// Fixtures & targets (heat map plus a transfer comparison you can play with),
// and How it works (every input, the track record and the odds status).
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const jsonForScript = (v) => JSON.stringify(v).replace(/</g, '\\u003c');   // safe inside a <script> tag

// Fixture colours from the team's expected goals for minus against: blue = kinder, orange = harder.
function heat(look) {
  const edge = look.goalsFor - look.goalsAgainst;
  if (edge >= 0.8) return { bg: '#1D4E89', fg: '#FFFFFF' };
  if (edge >= 0.3) return { bg: '#9CC3E6', fg: '#0F2A4A' };
  if (edge > -0.3) return { bg: '#E6E1D4', fg: '#0B1F4D' };
  if (edge > -0.8) return { bg: '#F2B27A', fg: '#3A1A00' };
  return { bg: '#A84A0C', fg: '#FFFFFF' };
}
function fixtureTitle(gw, x) {
  let t = 'GW' + gw + ': expected goals ' + r1(x.look.goalsFor) + ' for, ' + r1(x.look.goalsAgainst) + ' against. Clean sheet chance ' + pct(Math.exp(-x.look.goalsAgainst)) + '.';
  if (x.look.odds) t += ' Bookmakers ' + r1(x.look.odds.for) + '–' + r1(x.look.odds.against) + ', model ' + r1(x.look.modelFor) + '–' + r1(x.look.modelAgainst) + '; shown blended.';
  return t;
}
// One player's fixtures as plain data, colours worked out here (used by the grid and the comparison).
function fixtureWeeks(p) {
  return p.fixtures.map((f) => ({
    gw: f.gw,
    list: f.list.map((x) => Object.assign({ t: x.opp + ' ' + (x.home ? 'H' : 'A'), g: r1(x.look.goalsFor) + '–' + r1(x.look.goalsAgainst), odds: !!x.look.odds, title: fixtureTitle(f.gw, x) }, heat(x.look))),
  }));
}
function gridCells(p) {
  return fixtureWeeks(p).map((w) => {
    if (!w.list.length) return '<td class="cell blank">Blank</td>';
    const c = w.list[0];
    return '<td class="cell' + (c.odds ? ' odds' : '') + '" style="background:' + c.bg + ';color:' + c.fg + '" title="' + esc(w.list.map((x) => x.title).join(' ')) + '">' +
      w.list.map((x) => '<b>' + esc(x.t) + '</b><span>' + x.g + '</span>').join('') + '</td>';
  }).join('');
}

// ---- details tab: the full inputs table (unchanged content from earlier versions) ----
function fixtureChips(p) {
  return fixtureWeeks(p).map((w) => !w.list.length ? '<span class="fx" style="background:#E6E1D4">blank</span>'
    : w.list.map((x) => '<span class="fx' + (x.odds ? ' odds' : '') + '" style="background:' + x.bg + ';color:' + x.fg + '" title="' + esc(x.title) + '">' + esc(x.t) + ' <b>' + x.g + '</b></span>').join('')).join(' ');
}
function inputCells(m, p) {
  const r = p.rates, flag = p.avail < 1 ? ' class="num warn"' : ' class="num"';
  const defence = p.pos === 'GKP' ? r1(r.saves90) + ' saves' : pct(r.dcRate);
  return '<td class="num">' + pct(r.p60) + ' <small>(' + r.matches + ')</small></td>' +
    '<td class="num">' + r2(r.xg90) + '</td><td class="num">' + r2(r.xa90) + '</td>' +
    '<td class="num">' + defence + '</td><td class="num">' + r2(r.bonus60) + '</td>' +
    '<td' + flag + '>' + pct(p.avail) + '</td>' +
    '<td class="fxs">' + fixtureChips(p) + '</td>' +
    '<td class="num strong">' + r1(p.xNext) + '</td><td class="num strong">' + r1(p.xHorizon) + '</td>';
}
const INPUT_HEAD = '<th class="num" title="Chance he plays 60+ minutes, from recent matches (matches played this season in brackets)">Plays 60+</th>' +
  '<th class="num" title="Expected goals per 90 minutes">xG/90</th>' +
  '<th class="num" title="Expected assists per 90 minutes">xA/90</th>' +
  '<th class="num" title="Outfield: how often he earns defensive contribution points in a full game. Keeper: saves per 90.">DC / saves</th>' +
  '<th class="num" title="Bonus points per full game">Bonus</th>' +
  '<th class="num" title="Chance of playing next gameweek, from the FPL injury flag">Avail</th>' +
  '<th>Fixtures (team goals for–against)</th>' +
  '<th class="num">Next GW</th><th class="num">5 GW</th>';
const PART_NAMES = { appearance: 'Mins', goals: 'Goals', assists: 'Assists', cleanSheet: 'CS', conceded: 'Conceded', saves: 'Saves', defensive: 'DC', bonus: 'Bonus', cards: 'Cards' };
function breakdown(p) {
  const parts = Object.entries(p.nextParts).filter(([, v]) => Math.abs(v) >= 0.05)
    .map(([k, v]) => PART_NAMES[k] + ' ' + (v < 0 ? '−' : '') + r1(Math.abs(v))).join(' · ') || '—';
  return p.scorerOdds ? '<span class="oddsnote">Odds: scores ' + pct(1 - Math.exp(-p.scorerOdds.goals)) + ' if he plays</span><br>' + parts : parts;
}
function trackRecord(ctx) {
  const t = ctx.track;
  if (!t) return 'Not enough finished gameweeks yet to check the model against real results.';
  return 'Checked against gameweeks ' + t.weeks[0] + '–' + t.weeks[t.weeks.length - 1] + ', using only what was known before each one: ' +
    'the 20 regular starters it rated highest each week went on to average <b>' + r1(t.topAverage) + ' points</b>, against <b>' + r1(t.average) + '</b> for regular starters in general. ' +
    'The link between projected and real scores is ' + r2(t.correlation) + ' on a scale where 1 would be perfect, which is normal for FPL: single-game scores are mostly luck.';
}

// ---- this week tab ----
function nextOpp(p) {
  return (p.fixtures[0] && p.fixtures[0].list.map((x) => x.opp + ' (' + (x.home ? 'H' : 'A') + ')').join(', ')) || 'Blank';
}
function pitchCard(m, p) {
  const badge = p === m.captain ? '<span class="badge">C</span>' : p === m.vice ? '<span class="badge">V</span>' : '';
  const flag = p.avail < 1 ? '<span class="doubt">' + pct(p.avail) + ' fit</span>' : '';
  return '<div class="card">' + badge + '<span class="pn">' + esc(p.name) + '</span><span class="po">' + esc(nextOpp(p)) + '</span><span class="px">' + r1(p.xNext) + '</span>' + flag + '</div>';
}
function armband(m) {
  const c = m.captain, f = c.fixtures[0] && c.fixtures[0].list[0];
  const others = m.captainOptions.filter((p) => p !== c && p !== m.vice).slice(0, 2).map((p) => esc(p.name) + ' ' + r1(p.xNext)).join(', then ');
  let line = (f ? esc(f.opp) + (f.home ? ' at home.' : ' away.') : 'No fixture.') + ' Projected ' + r1(c.xNext) + ' before doubling';
  line += c.scorerOdds ? '; bookmakers give him ' + pct(1 - Math.exp(-c.scorerOdds.goals)) + ' to score if he plays.' : '.';
  return '<div class="armband"><p class="kicker">The armband</p><h2>' + esc(c.name) + '</h2><p>' + line + '</p>' +
    '<div class="figs"><div><b>' + r1(c.xNext) + '</b><span>Projected</span></div>' +
    (c.scorerOdds ? '<div><b>' + pct(1 - Math.exp(-c.scorerOdds.goals)) + '</b><span>To score</span></div>' : '') +
    (f ? '<div><b>' + r1(f.look.goalsFor) + '–' + r1(f.look.goalsAgainst) + '</b><span>Expected goals</span></div>' : '') + '</div>' +
    '<p class="small">Vice: ' + esc(m.vice.name) + ' ' + r1(m.vice.xNext) + (others ? ' · close behind: ' + others : '') + '. When these are this close, the model has no real opinion.</p></div>';
}
function moveBlock(mv) {
  return '<div class="move"><div class="side"><span class="lab out">Out</span><span class="nm">' + esc(mv.out.name) + '</span><span class="sub">' + mv.out.club + ' ' + mv.out.pos + ' · sells ' + money(mv.sell) + '</span></div>' +
    '<div class="side"><span class="lab in">In</span><span class="nm">' + esc(mv.inn.name) + '</span><span class="sub">' + mv.inn.club + ' ' + mv.inn.pos + ' · ' + money(mv.inn.cost) + '</span></div></div>' +
    '<details><summary>Why, and the inputs</summary><p>' + esc(mv.why) + '</p><div class="scroll"><table class="mini"><tr><th>Player</th>' + INPUT_HEAD + '</tr>' +
    '<tr><td>' + esc(mv.out.name) + '</td>' + inputCells(null, mv.out) + '</tr><tr><td>' + esc(mv.inn.name) + '</td>' + inputCells(null, mv.inn) + '</tr></table></div></details>';
}
function transferView(m, key) {
  const v = m.views[key], pos = VIEW_NAMES[key].toLowerCase();
  const plan = v.pick === 'two' ? v.two : v.pick === 'one' ? v.one : null;
  let html = '';
  if (plan) {
    html += '<div class="planhead"><p class="kicker">' + (key === 'ALL' ? (plan.moves.length > 1 ? 'Transfers of the week' : 'Transfer of the week') : 'Best way to buy a ' + pos) + '</p><p class="gain">' + signed(plan.net) + ' pts</p></div>';
    html += plan.moves.map(moveBlock).join('');
    html += '<p class="small">' + (plan.hit ? 'Includes a ' + plan.hit + '-point hit. ' : 'No hit. ') + 'Leaves ' + money(plan.left) + ' in the bank. Gain over the next ' + m.ctx.weeks.length + ' gameweeks, bench counted at ' + m.ctx.cfg.bench.outfieldWeight + '.</p>';
  } else {
    html += '<div class="planhead"><p class="kicker">' + (key === 'ALL' ? 'Transfer advice' : 'Buying a ' + pos) + '</p><p class="gain">Save it</p></div><p>' + esc(v.verdict) + '</p>';
    if (v.one) html += '<p class="small">Best single move if you want one anyway (' + signed(v.one.gain) + '):</p>' + v.one.moves.map(moveBlock).join('');
  }
  if (key !== 'ALL' && m.views.ALL.one && v.one) html += '<p class="small">For comparison, the best single move in any position gains ' + signed(m.views.ALL.one.gain) + '.</p>';
  const alts = v.alternatives.slice(plan && plan.moves.length === 1 ? 1 : 0, 6);
  if (alts.length) {
    html += '<p class="kicker" style="margin-top:14px">' + (key === 'ALL' ? 'Other single moves' : 'Other ' + pos + ' buys') + '</p><ul class="alts">' +
      alts.map((a) => '<li><span>' + esc(a.moves[0].out.name) + ' → <b>' + esc(a.moves[0].inn.name) + '</b> <small>' + a.moves[0].inn.club + ' · ' + money(a.moves[0].inn.cost) + '</small></span><span class="' + (a.gain >= 0 ? 'pos' : 'neg') + '">' + signed(a.gain) + '</span></li>').join('') + '</ul>';
  }
  return '<div class="view view-' + key + '">' + html + '</div>';
}

// ---- fixtures tab ----
function gridRow(m, p, kind) {
  const role = p === m.captain ? 'C' : p === m.vice ? 'V' : kind === 'bench' ? 'Bench' : '';
  const price = kind === 'target' ? ' · ' + money(p.cost) : '';
  const button = kind === 'target'
    ? '<button type="button" class="btn dark" data-in="' + p.id + '" aria-label="Compare ' + esc(p.name) + '">Compare</button>'
    : '<button type="button" class="btn" data-out="' + p.id + '" aria-label="Swap out ' + esc(p.name) + '">Swap out</button>';
  return '<tr><td class="who"><b>' + esc(p.name) + '</b> <small>' + p.pos + ' · ' + p.club + price + '</small> <span class="role">' + role + '</span></td>' +
    gridCells(p) + '<td class="num strong">' + r1(p.xNext) + '</td><td class="num">' + r1(p.xHorizon) + '</td><td>' + button + '</td></tr>';
}
// Everything the comparison needs, for your squad and every regular starter who could be bought.
function compareData(m) {
  const ctx = m.ctx;
  const pack = (p, inSquad) => ({
    id: p.id, name: p.name, pos: p.pos, club: p.club, team: p.team, squad: inSquad,
    cost: p.cost, sell: inSquad ? ctx.prices[p.id].sell : p.cost,
    next: r1(p.xNext), horizon: Math.round(p.xHorizon * 10) / 10, weeks: fixtureWeeks(p).map((w) => w.list.map((x) => ({ t: x.t, g: x.g, bg: x.bg, fg: x.fg }))),
  });
  const best = m.views.ALL.one;   // the best single move: affordable on its own
  return {
    bank: ctx.bank, teamLimit: ctx.teamLimit, gws: ctx.weeks.map((w) => w.gw),
    players: m.squad.map((p) => pack(p, true)).concat(m.candidates.map((p) => pack(p, false))),
    start: best ? { out: best.moves[0].out.id, inn: best.moves[0].inn.id } : null,
  };
}
// Small script for the comparison panel. Plain JavaScript, runs in the browser.
const COMPARE_SCRIPT = `
(function () {
  var D = JSON.parse(document.getElementById('fpl-data').textContent);
  var byId = {}; D.players.forEach(function (p) { byId[p.id] = p; });
  var outSel = document.getElementById('cmp-out'), inSel = document.getElementById('cmp-in');
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function money(t) { return '£' + (t / 10).toFixed(1) + 'm'; }
  function row(p, tag) {
    var cells = p.weeks.map(function (w) {
      if (!w.length) return '<td class="cell blank">Blank</td>';
      return '<td class="cell" style="background:' + w[0].bg + ';color:' + w[0].fg + '">' + w.map(function (x) { return '<b>' + esc(x.t) + '</b><span>' + x.g + '</span>'; }).join('') + '</td>';
    }).join('');
    return '<tr><td class="who"><span class="tag ' + tag.toLowerCase() + '">' + tag + '</span> <b>' + esc(p.name) + '</b> <small>' + p.pos + ' · ' + p.club + '</small></td>' + cells +
      '<td class="num strong">' + p.next + '</td><td class="num big">' + p.horizon.toFixed(1) + '</td></tr>';
  }
  function update() {
    var o = byId[outSel.value], i = byId[inSel.value];
    if (!o || !i) return;
    var diff = i.horizon - o.horizon, left = D.bank + o.sell - i.cost;
    document.getElementById('cmp-rows').innerHTML = row(o, 'OUT') + row(i, 'IN');
    var d = document.getElementById('cmp-diff'); d.textContent = (diff >= 0 ? '+' : '−') + Math.abs(diff).toFixed(1); d.className = 'fig ' + (diff >= 0 ? 'pos' : 'neg');
    var b = document.getElementById('cmp-bank'); b.textContent = left >= 0 ? money(left) : 'Short ' + money(-left); b.className = 'fig ' + (left >= 0 ? '' : 'neg');
    var warn = [];
    if (o.pos !== i.pos) warn.push('Different positions (' + o.pos + ' out, ' + i.pos + ' in): FPL only allows like-for-like swaps.');
    if (i.squad) warn.push(i.name + ' is already in your squad.');
    var sameClub = D.players.filter(function (p) { return p.squad && p.team === i.team && p.id !== o.id; }).length;
    if (!i.squad && sameClub >= D.teamLimit) warn.push('You already have ' + D.teamLimit + ' ' + i.club + ' players.');
    document.getElementById('cmp-warn').textContent = warn.join(' ');
  }
  outSel.addEventListener('change', update); inSel.addEventListener('change', update);
  document.querySelectorAll('[data-out]').forEach(function (btn) { btn.addEventListener('click', function () { outSel.value = btn.getAttribute('data-out'); update(); document.getElementById('compare').scrollIntoView({ behavior: 'smooth' }); }); });
  document.querySelectorAll('[data-in]').forEach(function (btn) { btn.addEventListener('click', function () { inSel.value = btn.getAttribute('data-in'); update(); document.getElementById('compare').scrollIntoView({ behavior: 'smooth' }); }); });
  if (D.start) { outSel.value = D.start.out; inSel.value = D.start.inn; }
  update();
})();`;

function renderHtml(m) {
  const ctx = m.ctx, cfg = ctx.cfg, e = ctx.entry;
  const when = (d) => new Date(d).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
  const formation = ['DEF', 'MID', 'FWD'].map((pos) => m.team.xi.filter((p) => p.pos === pos).length).join('-');
  const line = (pos) => '<div class="line">' + m.team.xi.filter((p) => p.pos === pos).map((p) => pitchCard(m, p)).join('') + '</div>';
  const bench = m.bench.map((p, i) => '<div class="bp"><small>' + (p.pos === 'GKP' ? 'GK' : i) + '</small> <b>' + esc(p.name) + '</b>' + (p.avail < 1 ? ' <small class="doubtb">' + pct(p.avail) + ' fit</small>' : '') + ' <span>' + r1(p.xNext) + '</span></div>').join('');

  const startView = VIEW_KEYS.includes(cfg.transfers.defaultView) ? cfg.transfers.defaultView : 'ALL';
  const viewButtons = VIEW_KEYS.map((key) => '<input type="radio" name="view" id="v-' + key + '"' + (key === startView ? ' checked' : '') + '><label for="v-' + key + '">' + (key === 'ALL' ? 'Best overall' : key) + '</label>').join('');

  const squadOrder = [...['GKP', 'DEF', 'MID', 'FWD'].flatMap((pos) => m.team.xi.filter((p) => p.pos === pos)), ...m.bench];
  const option = (p, inSquad) => '<option value="' + p.id + '">' + esc(p.name) + ' · ' + p.pos + ' · ' + p.club + ' · ' + (inSquad ? 'sells ' + money(ctx.prices[p.id].sell) : money(p.cost)) + '</option>';
  const targetOptions = ['GKP', 'DEF', 'MID', 'FWD'].map((pos) => '<optgroup label="' + VIEW_NAMES[pos] + 's">' +
    m.candidates.filter((p) => p.pos === pos).sort((a, b) => b.xHorizon - a.xHorizon).map((p) => option(p, false)).join('') + '</optgroup>').join('');
  const gwHeads = ctx.weeks.map((w) => '<th class="c">GW' + w.gw + '</th>').join('');

  const squadRows = squadOrder.map((p) => {
    const notes = [];
    if (p.news) notes.push(esc(p.news));
    if (p.rates.matches === 0) notes.push('No Premier League matches yet this season, so the model has nothing to go on');
    else if (p.rates.p60 < cfg.lowStartFlag) notes.push('Rarely plays 60 minutes: not a reliable starter');
    const role = p === m.captain ? 'Captain' : p === m.vice ? 'Vice' : m.team.xi.includes(p) ? 'Start' : 'Bench';
    return '<tr' + (m.team.xi.includes(p) ? '' : ' class="benchrow"') + '><td>' + role + '</td><td><b>' + esc(p.name) + '</b>' + (p.penalties === 1 ? ' <span class="pens">Pens</span>' : '') +
      (notes.length ? '<div class="note">' + notes.join('. ') + '</div>' : '') + '</td><td>' + p.club + '</td><td>' + p.pos + '</td>' +
      '<td class="num">' + money(p.cost) + '</td><td class="num">' + money(ctx.prices[p.id].sell) + '</td>' + inputCells(m, p) + '<td class="parts">' + breakdown(p) + '</td></tr>';
  }).join('');

  const warnings = [];
  if (!ctx.current.finished) warnings.push('Gameweek ' + ctx.current.id + ' is still in progress, so the numbers will change before the deadline. Run this again once it has finished.');
  if (ctx.freeHitReverted) warnings.push('You played a Free Hit in gameweek ' + ctx.current.id + ', so the squad shown is the one you revert to.');
  if (ctx.pendingCount) warnings.push(ctx.pendingCount + ' transfer(s) you have already made for gameweek ' + ctx.next.id + ' are included in the squad, bank and free transfers.');
  const ftNote = ctx.ftOverridden ? 'set by you' : 'worked out, check FPL';

  const css = `
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:#F4F1EA;color:#0B1F4D;font:15px/1.45 Inter,"Segoe UI",system-ui,sans-serif}
.disp{font-family:Anton,Impact,"Arial Narrow",sans-serif;font-weight:400;text-transform:uppercase}
.wrap{max-width:1180px;margin:0 auto;padding:0 24px}
.tabs-in,.views>input{position:absolute;opacity:0;pointer-events:none}
header{background:#0B1F4D;color:#F4F1EA;padding-top:26px}
.top{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:16px}
.kick{margin:0;font-size:13px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:#F2C230}
h1{margin:4px 0 0;font-size:68px;line-height:.95}
.gw{margin:0;font-size:96px;line-height:.85;color:#F2C230;text-align:right}
.dl{margin:4px 0 0;font-size:14px;color:#D5DCEB;text-align:right}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-top:2px solid #F2C230;margin-top:20px}
.stats div{padding:12px 0;display:flex;flex-direction:column}
.stats span{font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#D5DCEB}
.stats b{font-family:Anton,Impact,sans-serif;font-weight:400;font-size:30px}
.stats small{font-size:11px;color:#D5DCEB}
nav.tabs{display:flex;gap:4px;flex-wrap:wrap}
nav.tabs label{font-weight:700;font-size:15px;min-height:48px;padding:0 20px;display:flex;align-items:center;cursor:pointer;color:#D5DCEB}
#t-week:checked~header label[for=t-week],#t-fix:checked~header label[for=t-fix],#t-how:checked~header label[for=t-how]{background:#F4F1EA;color:#0B1F4D}
.tabs-in:focus-visible~header nav.tabs{outline:2px solid #F2C230}
.panel{display:none}
#t-week:checked~main .p-week,#t-fix:checked~main .p-fix,#t-how:checked~main .p-how{display:flex}
main{padding:30px 0 56px}
.panel{flex-direction:column;gap:30px}
.alert{background:#FFF;border:2px solid #C8102E;padding:10px 14px;font-weight:600}
.row2{display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start}
.armband{flex:1 1 400px;background:#C8102E;color:#FFF;padding:26px;display:flex;flex-direction:column;gap:10px}
.armband h2{margin:0;font-family:Anton,Impact,sans-serif;font-weight:400;font-size:84px;line-height:.9;text-transform:uppercase}
.armband p{margin:0;font-size:16px}
.kicker{margin:0;font-size:13px;font-weight:700;letter-spacing:.14em;text-transform:uppercase}
.figs{display:flex;flex-wrap:wrap;gap:26px;margin-top:6px}
.figs div{display:flex;flex-direction:column}.figs b{font-family:Anton,Impact,sans-serif;font-weight:400;font-size:38px}
.figs span{font-size:12px;text-transform:uppercase;letter-spacing:.08em}
.small{font-size:14px!important;line-height:1.5}
.xfer{flex:1 1 400px;background:#FFF;border:2px solid #0B1F4D;padding:26px;display:flex;flex-direction:column;gap:12px}
.views>label{display:inline-flex;align-items:center;min-height:44px;padding:0 14px;margin:0 6px 6px 0;border:2px solid #0B1F4D;font-weight:600;font-size:14px;cursor:pointer}
.views>input:checked+label{background:#0B1F4D;color:#FFF}.views>input:focus-visible+label{outline:2px solid #C8102E;outline-offset:2px}
.view{display:none;margin-top:10px}
#v-ALL:checked~.view-ALL,#v-GKP:checked~.view-GKP,#v-DEF:checked~.view-DEF,#v-MID:checked~.view-MID,#v-FWD:checked~.view-FWD{display:block}
.planhead{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
.gain{margin:0;font-family:Anton,Impact,sans-serif;font-size:32px;color:#C8102E}
.move{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:10px 0;border-bottom:2px solid #E2DCCB}
.side{display:flex;flex-direction:column}.nm{font-family:Anton,Impact,sans-serif;font-size:30px;text-transform:uppercase;line-height:1.1}
.lab{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em}.lab.out{color:#7A2A16}.lab.in{color:#0B6E4F}
.sub{font-size:13px;color:#4A5878}
details{margin:6px 0 8px;font-size:14px}summary{cursor:pointer;font-weight:600;min-height:32px;display:flex;align-items:center}
.alts{list-style:none;margin:6px 0 0;padding:0}.alts li{display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid #E2DCCB;font-size:14px}
.pos{color:#0B6E4F;font-weight:700}.neg{color:#8A1A0E;font-weight:700}
.sect{display:flex;justify-content:space-between;align-items:baseline;border-bottom:4px solid #0B1F4D;padding-bottom:8px;gap:12px;flex-wrap:wrap}
.sect h2{margin:0;font-family:Anton,Impact,sans-serif;font-weight:400;font-size:42px;text-transform:uppercase}
.sect p{margin:0;font-size:14px;color:#4A5878}
.pitch{background:repeating-linear-gradient(180deg,#1F5A3A 0 70px,#23633F 70px 140px);border:6px solid #0B1F4D;padding:26px 10px 16px;display:flex;flex-direction:column;gap:22px}
.line{display:flex;justify-content:center;flex-wrap:wrap;gap:12px}
.card{width:124px;background:#F4F1EA;border-top:6px solid #0B1F4D;padding:8px 6px 10px;display:flex;flex-direction:column;align-items:center;position:relative;text-align:center}
.badge{position:absolute;top:-14px;right:-8px;min-width:26px;height:26px;background:#C8102E;color:#FFF;font-family:Anton,Impact,sans-serif;font-size:15px;display:flex;align-items:center;justify-content:center}
.pn{font-weight:700;font-size:14px}.po{font-size:12px;color:#4A5878}.px{font-family:Anton,Impact,sans-serif;font-size:30px;line-height:1.1}
.doubt{font-size:11px;font-weight:700;color:#8A1A0E}
.benchrow-p{border-top:2px solid rgba(244,241,234,.6);padding-top:14px;display:flex;flex-wrap:wrap;justify-content:center;gap:10px;align-items:center}
.benchrow-p .lbl{color:#F4F1EA;font-size:13px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}
.bp{background:#F4F1EA;padding:6px 12px;font-size:14px}.bp span{font-family:Anton,Impact,sans-serif;font-size:18px;margin-left:4px}.bp small{color:#4A5878}.doubtb{color:#8A1A0E!important;font-weight:700}
.box{background:#FFF;border:2px solid #0B1F4D;padding:20px;display:flex;flex-direction:column;gap:14px}
.box h2{margin:0;font-family:Anton,Impact,sans-serif;font-weight:400;font-size:34px;text-transform:uppercase}
.pick{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-end}
.pick label{display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em}
select{font:500 16px Inter,system-ui,sans-serif;min-height:44px;max-width:100%;padding:0 10px;border:2px solid #0B1F4D;background:#FFF;color:#0B1F4D}
.fig{font-family:Anton,Impact,sans-serif;font-size:34px}.figlab{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#4A5878}
#cmp-warn{margin:0;font-weight:600;color:#8A1A0E;min-height:1px}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{border-collapse:separate;border-spacing:3px;width:100%;font-size:13px}
.grid table{min-width:820px}.box table{min-width:720px}
th{font-size:12px;color:#4A5878;font-weight:600;text-transform:uppercase;letter-spacing:.05em;text-align:left;padding:4px 6px;white-space:nowrap}
th.c{text-align:center}td{padding:6px;vertical-align:middle}
.cell{text-align:center;padding:6px 4px;min-width:70px}.cell b{display:block;font-size:12px}.cell span{display:block;font-size:11px}.cell.odds b{text-decoration:underline dotted}
.cell.blank{background:#FFF;color:#4A5878;border:1px dashed #9AA3B5}
.who{white-space:nowrap;position:sticky;left:0;z-index:1;background:#FFF;box-shadow:-4px 0 0 #FFF,4px 0 0 #FFF}
th:first-child{position:sticky;left:0;z-index:1;background:#FFF}.who small{color:#4A5878}.role{font-size:11px;font-weight:700;color:#C8102E}
.tag{font-size:11px;font-weight:700;color:#FFF;padding:2px 6px}.tag.out{background:#8A1A0E}.tag.in{background:#0B6E4F}
.grid{background:#FFF;border:2px solid #0B1F4D;padding:10px}
.grouprow td{padding:14px 6px 4px;font-family:Anton,Impact,sans-serif;font-size:18px;text-transform:uppercase}
.btn{font:600 12px Inter,system-ui,sans-serif;min-height:44px;padding:0 10px;background:transparent;color:#0B1F4D;border:1px solid #0B1F4D;cursor:pointer}.btn.dark{background:#0B1F4D;color:#FFF}
.legend{display:flex;align-items:center;gap:6px;font-size:12px;color:#4A5878}.legend i{width:22px;height:14px;display:inline-block}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.strong{font-weight:700}.big{font-family:Anton,Impact,sans-serif;font-size:20px}
.note{color:#8A1A0E;font-size:12px}.warn{color:#8A1A0E;font-weight:700}.pens{border:1px solid #4A5878;color:#4A5878;font-size:11px;padding:0 4px}
.benchrow td{background:#F7F4EC}.parts{font-size:12px;color:#4A5878;min-width:170px}.oddsnote{color:#0B6E4F;font-weight:600}
.fx{display:inline-block;padding:1px 5px;margin:1px 0;font-size:12px}.fxs{white-space:nowrap}.fx.odds{text-decoration:underline dotted}
.mini{min-width:900px}.mini td,.mini th{padding:4px 6px}
.honest{background:#FFF;border:2px solid #0B1F4D;padding:16px 20px}.honest p{margin:0 0 8px}.honest p:last-child{margin:0}
ul.how{margin:6px 0;padding-left:20px}footer{font-size:13px;line-height:1.6;color:#4A5878;border-top:1px solid #D9D2BF;padding-top:14px}
@media (max-width:640px){
  .wrap{padding:0 14px}h1{font-size:44px}.gw{font-size:60px}
  .stats{grid-template-columns:repeat(2,minmax(0,1fr))}
  nav.tabs label{padding:0 12px;font-size:14px}
  .armband h2{font-size:60px}.armband,.xfer{padding:18px}
  .line{gap:5px;flex-wrap:nowrap}.card{width:auto;flex:0 1 94px;min-width:0;padding:6px 3px 8px}
  .pn{font-size:12px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.po{font-size:11px}.px{font-size:24px}
  .who small{display:block}
  .sect h2{font-size:32px}.nm{font-size:24px}
}`;

  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>FPL GW' + ctx.next.id + ' · ' + esc(e.name) + '</title>' +
    // Home-screen icon (apple-touch-icon.png sits next to the page) and the name shown under it.
    '<link rel="apple-touch-icon" href="apple-touch-icon.png"><link rel="icon" href="apple-touch-icon.png"><meta name="apple-mobile-web-app-title" content="FPL"><meta name="theme-color" content="#0B1F4D">' +
    '<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">' +
    '<style>' + css + '</style></head><body>' +
    '<input type="radio" name="tab" id="t-week" class="tabs-in" checked><input type="radio" name="tab" id="t-fix" class="tabs-in"><input type="radio" name="tab" id="t-how" class="tabs-in">' +

    '<header><div class="wrap"><div class="top"><div><p class="kick">Matchday notes · Team ' + e.id + '</p><h1 class="disp">' + esc(e.name) + '</h1></div>' +
    '<div><p class="gw disp">GW' + ctx.next.id + '</p><p class="dl">Deadline ' + when(ctx.next.deadline_time) + '</p></div></div>' +
    '<div class="stats"><div><span>Bank</span><b>' + money(ctx.bank) + '</b></div><div><span>Free transfers</span><b>' + ctx.freeTransfers + '</b><small>' + ftNote + '</small></div>' +
    '<div><span>Points</span><b>' + e.summary_overall_points + '</b></div><div><span>Rank</span><b>' + Number(e.summary_overall_rank).toLocaleString('en-GB') + '</b></div></div>' +
    '<nav class="tabs" aria-label="Sections"><label for="t-week">This week</label><label for="t-fix">Fixtures &amp; targets</label><label for="t-how">How it works</label></nav></div></header>' +

    '<main class="wrap">' +
    // ---- This week
    '<div class="panel p-week">' + warnings.map((w) => '<div class="alert">' + esc(w) + '</div>').join('') +
    '<section class="row2">' + armband(m) +
    '<div class="xfer"><div class="views">' + viewButtons + VIEW_KEYS.map((k) => transferView(m, k)).join('') + '</div>' +
    '<label for="t-fix" class="btn dark" style="display:inline-flex;align-items:center;align-self:flex-start;font-size:14px;padding:0 16px">Compare on the fixture grid</label></div></section>' +
    '<section style="display:flex;flex-direction:column;gap:14px"><div class="sect"><h2>Team sheet · ' + formation + '</h2><p>Projected points next gameweek</p></div>' +
    '<div class="pitch">' + line('FWD') + line('MID') + line('DEF') + line('GKP') + '<div class="benchrow-p"><span class="lbl">Bench</span>' + bench + '</div></div></section></div>' +

    // ---- Fixtures & targets
    '<div class="panel p-fix">' +
    '<section class="box" id="compare"><h2>Compare a transfer</h2><div class="pick">' +
    '<label>Swap out<select id="cmp-out">' + squadOrder.map((p) => option(p, true)).join('') + '</select></label>' +
    '<label>Bring in<select id="cmp-in">' + targetOptions + '</select></label>' +
    '<div style="display:flex;gap:24px"><div style="display:flex;flex-direction:column"><span class="figlab">5-GW difference</span><span id="cmp-diff" class="fig">–</span></div>' +
    '<div style="display:flex;flex-direction:column"><span class="figlab">Bank after</span><span id="cmp-bank" class="fig">–</span></div></div></div>' +
    '<p id="cmp-warn"></p><div class="scroll"><table><thead><tr><th>Player</th>' + gwHeads + '<th class="num">Next</th><th class="num">5 GW</th></tr></thead><tbody id="cmp-rows"></tbody></table></div>' +
    '<p class="small" style="margin:0;color:#4A5878">"Bring in" lists every regular starter you could buy (' + m.candidates.length + ' players), best projection first. The difference compares the two players\' own projections; the recommended moves on the first tab also count bench and captaincy effects.</p></section>' +
    '<section style="display:flex;flex-direction:column;gap:12px"><div class="sect"><h2>The fixture grid</h2><div class="legend"><span>Harder</span><i style="background:#A84A0C"></i><i style="background:#F2B27A"></i><i style="background:#E6E1D4"></i><i style="background:#9CC3E6"></i><i style="background:#1D4E89"></i><span>Easier</span></div></div>' +
    '<div class="grid scroll"><table><thead><tr><th>Player</th>' + gwHeads + '<th class="num">Next</th><th class="num">5 GW</th><th><span style="position:absolute;left:-9999px">Action</span></th></tr></thead><tbody>' +
    '<tr class="grouprow"><td colspan="' + (ctx.weeks.length + 4) + '">Your squad</td></tr>' +
    squadOrder.map((p) => gridRow(m, p, m.team.xi.includes(p) ? 'xi' : 'bench')).join('') +
    '<tr class="grouprow"><td colspan="' + (ctx.weeks.length + 4) + '">Shortlist · the model\'s top targets</td></tr>' +
    m.shortlist.map((p) => gridRow(m, p, 'target')).join('') +
    '</tbody></table></div><p class="small" style="margin:0;color:#4A5878">Each cell: opponent, then the team\'s expected goals for–against. Underlined = bookmaker odds blended in. Tap or hover a cell for details.</p></section></div>' +

    // ---- How it works
    '<div class="panel p-how"><div class="honest"><p><b>What this is.</b> An estimate, not a forecast. Each projection is built from the parts FPL scores: minutes, goals (from expected goals), assists (from expected assists), clean sheets and goals conceded, saves, defensive contributions, bonus and cards. It knows nothing about team news, tactics or a new manager beyond what the FPL data shows.</p>' +
    '<p>' + trackRecord(ctx) + '</p><p>' + esc(ctx.odds.status) + (Object.keys(ctx.odds.goals).length ? ' The odds weightings (' + pct(cfg.odds.matchOddsWeight) + ' match odds, ' + pct(cfg.odds.goalscorerWeight) + ' goalscorer odds) are judgement, not tested on past gameweeks.' : '') + '</p></div>' +
    '<section style="display:flex;flex-direction:column;gap:12px"><div class="sect"><h2>Your squad and the inputs</h2></div><div class="scroll"><table class="mini"><tr><th>Role</th><th>Player</th><th>Club</th><th>Pos</th><th class="num">Price</th><th class="num">Sells for</th>' + INPUT_HEAD + '<th>Next GW points from</th></tr>' + squadRows + '</table></div></section>' +
    '<section><div class="sect"><h2>How the numbers are made</h2></div><ul class="how">' +
    '<li><b>Minutes</b>: how often he has played 60+ minutes (2 points) or less (1 point), from recent matches: each match back counts ' + pct(cfg.form.decay) + ' as much as the one after. This keeps non-players off your bench.</li>' +
    '<li><b>Player rates</b> are built in three layers: ' + (cfg.form.useLastSeason ? 'his record last season (worth ' + cfg.form.lastSeasonWeight + ' matches; the position average for players new to the league), ' : 'the position average (worth ' + cfg.form.averageWeight + ' matches), ') + 'then this season\'s matches, then recent form.</li>' +
    '<li><b>Goals and assists</b>: his rates × usual minutes × how leaky the opponent is × home or away.</li>' +
    '<li><b>Team strength</b>: expected goals in every match this season, ' + pct(cfg.teams.realGoalsWeight) + ' blended with real goals.</li>' +
    '<li><b>Bookmaker odds</b> (when available): match odds blended ' + pct(cfg.odds.matchOddsWeight) + ' into each team\'s expected goals; anytime goalscorer odds, margin removed, blended ' + pct(cfg.odds.goalscorerWeight) + ' into each player\'s goal threat.</li>' +
    '<li><b>Horizon</b>: gameweeks ' + ctx.weeks.map((w) => w.gw).join(', ') + ', weighted ' + ctx.weeks.map((w) => w.weight).join(', ') + '.</li>' +
    '<li><b>Transfers</b>: every one- and two-player swap you can afford from ' + m.candidates.length + ' regular starters, scored by the change in whole-squad value (eleven + captain + bench at ' + cfg.bench.outfieldWeight + ').</li>' +
    '<li><b>Selling prices and free transfers</b> aren\'t in the public data: both are worked out from your transfer history.</li></ul></section></div>' +

    '<footer>Generated ' + when(m.generated) + ' from the official FPL data' + (Object.keys(ctx.odds.goals).length ? ' and The Odds API' : '') + '. Estimates, not forecasts.</footer></main>' +
    '<script type="application/json" id="fpl-data">' + jsonForScript(compareData(m)) + '</script><script>' + COMPARE_SCRIPT + '</script>' +
    '</body></html>';
}

// ----------------------------- RUN -------------------------------------------
async function run(overrides) {
  const cfg = Object.assign({}, CONFIG, overrides || {});
  log('Fetching your team and this season\'s data');
  const base = await fetchBase(cfg.teamId);
  const squadIds = currentSquad(base, cfg).squadIds;
  const ids = base.boot.elements.filter((e) => e.minutes > 0 || squadIds.includes(e.id)).map((e) => e.id);
  log('\nFetching match histories for ' + ids.length + ' players');
  const fetched = await fetchHistories(ids);
  const oddsRaw = await fetchOdds(cfg, base);
  const ctx = prepare(base, fetched, oddsRaw, cfg);
  const model = analyse(ctx);
  return { model, html: renderHtml(model) };
}

async function main() {
  if (typeof fetch !== 'function') {
    console.error('This needs Node.js 18 or newer (you have ' + process.version + '). Get the current LTS from nodejs.org.');
    process.exit(1);
  }
  const fs = require('fs'), path = require('path');
  const arg = Number(process.argv[2]);
  try {
    const { model: m, html } = await run(arg ? { teamId: arg } : null);
    const file = path.join(__dirname, 'dashboard.html');
    fs.writeFileSync(file, html);
    const c = m.ctx;
    console.log(c.entry.name + ' | Gameweek ' + c.next.id + ' | bank ' + money(c.bank) + ' | free transfers ' + c.freeTransfers);
    console.log('Captain: ' + m.captain.name + ' (vice ' + m.vice.name + ')');
    const plan = m.pick === 'one' ? m.one : m.pick === 'two' ? m.two : null;
    console.log(plan ? 'Transfers: ' + plan.moves.map((mv) => mv.out.name + ' -> ' + mv.inn.name).join(', ') : 'Transfers: save it this week');
    console.log(c.odds.status);
    if (c.track) console.log('Past gameweeks check: top 20 picks averaged ' + r1(c.track.topAverage) + ' pts v ' + r1(c.track.average) + ' for regular starters');
    console.log('Wrote ' + file);
  } catch (err) {
    console.error('\nCould not build the dashboard: ' + err.message);
    if (err.status === 503) console.error('FPL is usually offline for a while around each deadline while the game updates. Try again later.');
    process.exit(1);
  }
}

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) main();

// For testing only: lets a test script load these functions.
if (typeof module !== 'undefined') module.exports = { goalsFromMatchOdds, goalsFromScorerOdds, findPlayer, sameTeam, winEdge, chanceOver };
