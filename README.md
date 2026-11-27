# FPL weekly decision tool

One script, no installs beyond Node.js (version 18 or newer). It reads the official
public FPL data for team 5798790 and writes `dashboard.html`.

## Run it

Keep `fpl.js` and `run.bat` in the same folder, then either:

- double-click `run.bat` (builds the page and opens it), or
- in a terminal in that folder: `node fpl.js`, then open `dashboard.html`.

It takes 10-30 seconds: it downloads the match history of every player who has played
this season (about 450). Run it after a gameweek has finished and before the next
deadline. Another team: `node fpl.js 1234567`.

If it says FPL returned HTTP 503, the game is updating (usual around deadlines). Try later.

## Running it from your phone (GitHub)

The same script can run on GitHub's servers and publish the dashboard as a web page,
so you don't need the laptop. It only runs when you ask:

1. On your iPhone, open the GitHub app → your repository → Actions → "Build FPL dashboard"
   → Run workflow (or the same on github.com).
2. Wait about a minute, then open the page: `https://<your-username>.github.io/<repository>/`.
   In Safari, Share → Add to Home Screen gives you an app-style icon for it.

The odds key is kept in the repository's secrets as `ODDS_API_KEY`; it's never in the
page or the code. The workflow saves `odds-cache.json` in GitHub Actions' private cache,
so running it again within 6 hours for the same gameweek reuses the saved odds (0 extra
credits). Tick **Fetch fresh odds** on the Run workflow screen if you ever want to ignore
the 6-hour cache and pay for fresh odds (about 12 credits). The page is public to anyone
who has the link; it only shows what FPL already makes public about your team.

`.gitignore` stops `key.txt`, `odds-cache.json` and `dashboard.html` from ever being
uploaded.

## Why a script and not a page that fetches the data itself

The FPL API sends no cross-origin permission header (checked 14 Nov 2026), so a web
page can't fetch the data itself in a browser. A script (on your laptop or on GitHub)
has no such restriction, so it fetches the data and writes a finished page.

## What it fetches

| Endpoint | Used for |
|---|---|
| `bootstrap-static/` | players, prices, injury flags, gameweeks, and FPL's scoring rules |
| `fixtures/` | upcoming fixtures and this season's results |
| `entry/{id}/` | team name, points, rank |
| `entry/{id}/event/{gw}/picks/` | your squad and bank at the last deadline |
| `entry/{id}/history/` and `entry/{id}/transfers/` | free transfers, selling prices, transfers already made |
| `element-summary/{player}/` | each player's matches this season (minutes, xG, xA, saves, defensive actions, bonus) and last season's totals |

## How the scoring works

Each player's projection for a fixture is built from the parts FPL actually scores,
using FPL's own points values (read from the API, so a rule change is picked up):

| Part | How it's estimated |
|---|---|
| Minutes | chance he plays 60+ minutes (2 pts) or 1-59 (1 pt), from recent matches |
| Goals | his expected goals per 90 x his usual minutes x how leaky the opponent is x home/away |
| Assists | the same with expected assists |
| Clean sheet / goals conceded | from his team's expected goals against in that fixture |
| Saves (keepers) | his saves per 90, scaled by how strong the opponent's attack is |
| Defensive contributions | how often he reaches the 10 (DEF) or 12 (MID/FWD) action threshold in a full game |
| Bonus, cards | how often he has earned them |

That is multiplied by **availability** (FPL's chance-of-playing flag; a doubt of 50% or
better is assumed to clear after the next gameweek).

**Player rates come in three layers**, so neither a hot streak nor one bad month fools it:

1. A starting point: his rates last season (worth 15 matches). Players with no Premier
   League minutes last season start from the average for their position (worth 6 matches).
2. This season's matches move him away from that starting point.
3. Recent form moves him again: the latest match counts most, and each one before it
   counts 60% as much as the next. His whole season is worth 6 matches against that.

**Team strength** comes from expected goals for and against in every match this season,
half-blended with real goals, and pulled towards average while few games are played.
FPL's own team-strength numbers are empty this season, so they are not used.

**Eleven and captain**: the best legal formation by next-gameweek projection. Captain,
vice and the "close behind" list are ranked by an upside-weighted score: floor points
(appearance, clean sheet, goals conceded, saves, defensive contributions and cards) count
at face value, while goals, assists and bonus are multiplied by `captain.upsideWeight`
(1.25 by default) so high-ceiling attackers beat floor-heavy defenders on a similar
average. Displayed projections stay plain expected points.

**Transfers**: every one- and two-player swap you can afford is scored by the change in
whole-squad value over the next 5 gameweeks (starters + captain's extra + bench players
at 0.3 of a starter) plus a small credit for extra bank freed (`transfers.moneyValue`, 0.5
points per £1m by default, capped at `transfers.moneyValueCap` = £3.0m so hoarding cash
can't win). A transfer is never recommended purely to free cash: the player-projection
part alone must be at least `transfers.minPlayerGain` (-0.5 points by default). Buys must
play 60+ minutes at least 65% of the time, have a 75% chance of playing and at least 3
matches this season, so a non-playing budget filler can never be suggested. A move is
only recommended if it gains 1.5 points or more; otherwise the advice is to save the
transfer. Extra transfers beyond your free ones cost 4 points.

## The page

Three tabs:

- **This week**: the captain pick, the recommended transfers (with buttons for Best overall,
  GKP, DEF, MID and FWD, each with a "Why, and the inputs" drop-down) and your eleven on a pitch
  with the bench. Tap **Lock in** on any transfer (or in "Compare a transfer") to update the
  starting eleven, bench, armband and bank right in the browser without re-running the script;
  it is remembered in your browser for the current gameweek, with a **Reset squad** button to undo.
- **Fixtures & targets**: a heat map of your squad and the model's shortlist over the next five
  gameweeks (blue = easier, orange = harder; each cell shows the team's expected goals
  for–against). Above it, "Compare a transfer": pick anyone in your squad and any regular
  starter in the game, and it shows their fixtures side by side, the difference in their
  projections and your bank afterwards (plus a **Lock in this transfer** button). It warns
  about mismatched positions or a fourth player from one club. That figure compares the two
  players' own projections only; the recommendations on the first tab also count bench and
  captaincy effects.
- **How it works**: the full inputs for every squad player, the track record, the odds status
  and how the numbers are made.

The page works on a phone; wide tables scroll sideways with names pinned.

## Bookmaker odds

If The Odds API key is set (the `ODDS_API_KEY` environment variable, or `key.txt` next to
`fpl.js`), each run also uses bookmaker prices:

- **Match odds** (UK bookmakers, all upcoming games, about 2 credits): the win/draw/loss and
  over/under 2.5 prices, with the bookmaker margin removed and averaged across bookmakers,
  are turned into each team's expected goals. These are blended 75% with the model's own
  figure, which then drives clean sheets, goals conceded, and how easy the fixture is to
  attack. Fixtures using odds are underlined on the page; hover to see bookmaker v model.
- **Anytime goalscorer odds** (US bookmakers, the only ones this service has for player
  odds; next gameweek only, about 1 credit per match): each player's chance of scoring
  becomes his expected goals if he plays. The bookmaker margin is removed by scaling each
  team's players so that, allowing for who usually plays, they add up to the team's
  expected goals. This is blended 50% with his own expected goals. The squad table shows
  "Odds: scores X% if he plays".

If the month's credits run out, or the odds service is down, the run carries on with the
model alone and the page says why under How it works. Credits reset at the start of your
next monthly cycle.

Goalscorer odds usually appear only a few days before kick-off, so run the tool again
closer to the deadline. Odds are saved in `odds-cache.json` and reused for 6 hours, so
running it twice in an afternoon costs nothing extra. A normal week costs about 12 credits
of the 500 free each month; the page shows how many are left.

The two blend weights (`odds.matchOddsWeight`, `odds.goalscorerWeight`) are judgement:
testing them on past gameweeks would need historical odds, which cost extra. Set either to
0 to switch that part off. If a bookmaker name can't be matched to an FPL player, the page
lists it.

## How well it works

Every run replays this season's finished gameweeks (from gameweek 4), projecting each
one using only what was known beforehand, and shows the result at the top of the page.

When this version was built (gameweeks 4-10 of 2026/27, about 1,350 matches by regular
starters):

- The 20 regular starters it rated highest each week averaged **4.8 points**, against
  **3.2** for regular starters in general.
- The correlation between projected and real scores was **0.28** (1 would be perfect).
  That sounds low, but single FPL scores are mostly luck; the previous version of this
  tool scored 0.23 on the same test.

One judgement call to know about: a version that ignores last season and pulls every
player hard towards his position's average scored very slightly higher in the replay
(0.29). The difference was well within the noise, and that version rates elite players
as close to average, for example suggesting Haaland be sold for a £5.7m forward. So the
tool uses last season by default. To compare yourself, set `form.useLastSeason` to
`false`, run it, and look at the replay figures at the top of the page.

## What to distrust

- It knows nothing about team news, tactics, penalty takers changing or a new manager
  beyond what the FPL data shows. Ten matches is still a small sample.
- Players new to the Premier League start from the position average.
- **Free transfers** are not in the public data. They are replayed from your history
  (1 a week, roll to 5, Wildcard and Free Hit weeks keep the count unchanged).
- **Selling prices** are worked out from what you paid (half of any rise, rounded down).
- If either disagrees with the FPL site, set `freeTransfersOverride` or `bankOverride`.

## Tuning

Edit the `CONFIG` block at the top of `fpl.js`, save, run again. The replay figures at
the top of the page update too, so you can see whether a change helped.

| Setting | Effect |
|---|---|
| `horizonWeights` | how many gameweeks ahead and how much each counts. `[1]` = next gameweek only |
| `form.decay` | lower reacts faster to recent form; 1 treats every match the same |
| `form.seasonWeight` | higher trusts his whole season over his last few games |
| `form.lastSeasonWeight` | higher trusts last season more |
| `form.averageWeight` | for players new to the league: how strongly they start at the position average |
| `form.useLastSeason` | `false` ignores last season entirely |
| `teams.realGoalsWeight` | 0 = team strength purely from expected goals, 1 = purely real goals |
| `teams.homeAdvantage` | 1.1 = home teams 10% better |
| `teams.fixtureStrength` | 0 ignores who the opponent is, 1 takes it at face value |
| `bench.outfieldWeight` | how much bench quality matters. Raise for a stronger bench, 0.1 for a typical approach |
| `captain.upsideWeight` | multiplier on goals, assists and bonus when ranking captain candidates (1 = plain expected points) |
| `transfers.minStartChance` | the "regular starter" bar for buys |
| `transfers.minGain` | how big a gain justifies using a transfer |
| `transfers.moneyValue` | points credited per £1m of extra bank freed over the horizon (0 = ignore bank freed) |
| `transfers.moneyValueCap` | maximum extra £m freed that earns credit, so hoarding cash can't win |
| `transfers.minPlayerGain` | minimum player-projection gain required so a move is never recommended purely for cash |
| `transfers.defaultView` | which transfer view the page opens on: `ALL`, `GKP`, `DEF`, `MID`, `FWD` |
| `odds.matchOddsWeight` | share of each team's expected goals taken from match odds (0 = off) |
| `odds.goalscorerWeight` | share of each player's goal threat taken from goalscorer odds (0 = off) |
| `odds.cacheHours` | how long fetched odds are reused before paying for fresh ones |
| `lowStartFlag` | when your own players get a "not a reliable starter" warning |
