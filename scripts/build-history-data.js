const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const RESULTS_URL = "https://raw.githubusercontent.com/martj42/international_results/master/results.csv";
const SHOOTOUTS_URL = "https://raw.githubusercontent.com/martj42/international_results/master/shootouts.csv";
const START_DATE = "2022-12-19";
const SEED_DATE = "2018-01-01";
const END_DATE = new Date().toISOString().slice(0, 10);

const datasetNames = {
  ALG: "Algeria", ARG: "Argentina", AUS: "Australia", AUT: "Austria", BEL: "Belgium",
  BIH: "Bosnia and Herzegovina", BRA: "Brazil", CAN: "Canada", CPV: "Cape Verde",
  COL: "Colombia", COD: "DR Congo", CRO: "Croatia", CUW: "Curaçao", CZE: "Czech Republic",
  ECU: "Ecuador", EGY: "Egypt", ENG: "England", FRA: "France", GER: "Germany", GHA: "Ghana",
  HAI: "Haiti", IRN: "Iran", IRQ: "Iraq", CIV: "Ivory Coast", JPN: "Japan", JOR: "Jordan",
  MEX: "Mexico", MAR: "Morocco", NED: "Netherlands", NZL: "New Zealand", NOR: "Norway",
  PAN: "Panama", PAR: "Paraguay", POR: "Portugal", QAT: "Qatar", KSA: "Saudi Arabia",
  SCO: "Scotland", SEN: "Senegal", RSA: "South Africa", KOR: "South Korea", ESP: "Spain",
  SWE: "Sweden", SUI: "Switzerland", TUN: "Tunisia", TUR: "Turkey", USA: "United States",
  URU: "Uruguay", UZB: "Uzbekistan"
};

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { value += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(value); value = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(value); value = "";
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
    } else value += char;
  }
  if (value || row.length) { row.push(value); rows.push(row); }
  const headers = rows.shift();
  return rows.map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])));
}

function tournamentWeight(name) {
  if (name === "FIFA World Cup") return 1.45;
  if (/World Cup qualification/i.test(name)) return 1.2;
  if (/UEFA Euro|Copa América|African Cup of Nations|AFC Asian Cup|CONCACAF Gold Cup|Oceania Nations Cup/i.test(name)) return 1.3;
  if (/qualification/i.test(name)) return 1.08;
  if (/Nations League/i.test(name)) return 1.02;
  if (/Friendly/i.test(name)) return 0.62;
  return 0.9;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function marginMultiplier(diff) {
  if (diff <= 1) return 1;
  return Math.min(2.5, Math.log(diff + 1) * 1.3);
}

function dateFraction(date) {
  const start = new Date(`${START_DATE}T00:00:00Z`).getTime();
  const end = new Date(`${END_DATE}T23:59:59Z`).getTime();
  return clamp((new Date(`${date}T12:00:00Z`).getTime() - start) / Math.max(1, end - start), 0, 1);
}

function daysAgo(date) {
  return Math.max(0, (new Date(`${END_DATE}T23:59:59Z`) - new Date(`${date}T12:00:00Z`)) / 86400000);
}

function matchKey(date, home, away) {
  return `${date}|${home}|${away}`;
}

async function download(url) {
  const response = await fetch(url, { headers: { "user-agent": "GoalMind World Cup Lab/3.0" } });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.text();
}

function playElo(ratings, match, shootoutWinner, phase) {
  const homeRating = ratings.get(match.home_team) ?? 1500;
  const awayRating = ratings.get(match.away_team) ?? 1500;
  const homeAdvantage = match.neutral === "TRUE" ? 0 : 55;
  const expectedHome = 1 / (1 + Math.pow(10, -((homeRating + homeAdvantage) - awayRating) / 400));
  const homeScore = Number(match.home_score);
  const awayScore = Number(match.away_score);
  let actualHome = homeScore > awayScore ? 1 : homeScore < awayScore ? 0 : 0.5;
  if (homeScore === awayScore && shootoutWinner) actualHome = shootoutWinner === match.home_team ? 0.65 : 0.35;
  const baseK = phase === "seed" ? 18 : 30;
  const recency = phase === "seed" ? 1 : 0.82 + dateFraction(match.date) * 0.36;
  const k = baseK * tournamentWeight(match.tournament) * recency * marginMultiplier(Math.abs(homeScore - awayScore));
  const delta = k * (actualHome - expectedHome);
  ratings.set(match.home_team, homeRating + delta);
  ratings.set(match.away_team, awayRating - delta);
}

function resultFor(gf, ga, shootoutResult) {
  if (gf > ga) return "W";
  if (gf < ga) return "L";
  if (shootoutResult === "W") return "PW";
  if (shootoutResult === "L") return "PL";
  return "D";
}

function weightedMetrics(matches, finalRatings) {
  let weightSum = 0;
  let points = 0;
  let goalsFor = 0;
  let goalsAgainst = 0;
  let opponentRating = 0;
  let bigWeight = 0;
  let bigPoints = 0;
  const performance = [];

  for (const match of matches) {
    const timeWeight = Math.exp(-daysAgo(match.date) / 620);
    const weight = timeWeight * tournamentWeight(match.tournament);
    const resultPoints = match.result === "W" ? 1 : match.result === "PW" ? 0.65 : match.result === "D" ? 0.5 : match.result === "PL" ? 0.35 : 0;
    const opponent = finalRatings.get(match.opponentName) ?? 1500;
    weightSum += weight;
    points += resultPoints * weight;
    goalsFor += match.goalsFor * weight;
    goalsAgainst += match.goalsAgainst * weight;
    opponentRating += opponent * weight;
    performance.push(resultPoints);
    if (opponent >= 1600 && tournamentWeight(match.tournament) >= 0.9) {
      bigWeight += weight;
      bigPoints += resultPoints * weight;
    }
  }

  const safeWeight = Math.max(weightSum, 0.01);
  const pointRate = points / safeWeight;
  const gfRate = goalsFor / safeWeight;
  const gaRate = goalsAgainst / safeWeight;
  const opponentAverage = opponentRating / safeWeight;
  const mean = performance.reduce((sum, value) => sum + value, 0) / Math.max(performance.length, 1);
  const deviation = Math.sqrt(performance.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / Math.max(performance.length, 1));
  return {
    form: Math.round(clamp(42 + pointRate * 43 + (opponentAverage - 1500) / 18 + (gfRate - gaRate) * 5, 35, 98)),
    attack: Math.round(clamp(54 + (gfRate - 1.25) * 20 + (opponentAverage - 1500) / 22, 35, 98)),
    defense: Math.round(clamp(72 - (gaRate - 1.0) * 23 + (opponentAverage - 1500) / 24, 35, 98)),
    bigMatch: Math.round(clamp(42 + (bigWeight ? bigPoints / bigWeight : pointRate) * 50 + (opponentAverage - 1500) / 30, 35, 98)),
    consistency: Math.round(clamp(94 - deviation * 62 + Math.min(matches.length, 35) * 0.25, 35, 98)),
    weightedGoalsFor: Number(gfRate.toFixed(2)),
    weightedGoalsAgainst: Number(gaRate.toFixed(2)),
    opponentAverage: Math.round(opponentAverage)
  };
}

async function main() {
  const [resultsText, shootoutsText] = await Promise.all([download(RESULTS_URL), download(SHOOTOUTS_URL)]);
  const allResults = parseCsv(resultsText).filter((match) => {
    return match.date >= SEED_DATE && match.date <= END_DATE
      && Number.isFinite(Number(match.home_score)) && Number.isFinite(Number(match.away_score));
  });
  const shootouts = new Map(parseCsv(shootoutsText).map((row) => [matchKey(row.date, row.home_team, row.away_team), row.winner]));
  const ratings = new Map();

  for (const match of allResults.filter((item) => item.date < START_DATE)) {
    playElo(ratings, match, shootouts.get(matchKey(match.date, match.home_team, match.away_team)), "seed");
  }
  const startRatings = new Map(ratings);
  const periodResults = allResults.filter((item) => item.date >= START_DATE);
  for (const match of periodResults) {
    playElo(ratings, match, shootouts.get(matchKey(match.date, match.home_team, match.away_team)), "period");
  }

  const cache = JSON.parse(fs.readFileSync(path.join(ROOT, "live-cache.json"), "utf8"));
  const idByDatasetName = new Map(Object.entries(datasetNames).map(([abbr, name]) => [name, abbr.toLowerCase()]));
  const teamMeta = new Map(cache.teams.map((team) => [team.abbr, team]));
  const teamMatches = Object.fromEntries(Object.values(datasetNames).map((name) => [name, []]));
  const uniqueMatches = new Set();

  for (const match of periodResults) {
    for (const side of ["home", "away"]) {
      const teamName = match[`${side}_team`];
      if (!teamMatches[teamName]) continue;
      const opponentSide = side === "home" ? "away" : "home";
      const opponentName = match[`${opponentSide}_team`];
      const goalsFor = Number(match[`${side}_score`]);
      const goalsAgainst = Number(match[`${opponentSide}_score`]);
      const shootoutWinner = shootouts.get(matchKey(match.date, match.home_team, match.away_team));
      const shootoutResult = goalsFor === goalsAgainst && shootoutWinner ? (shootoutWinner === teamName ? "W" : "L") : null;
      teamMatches[teamName].push({
        date: match.date,
        opponentId: idByDatasetName.get(opponentName) || null,
        opponentName,
        home: side === "home",
        neutral: match.neutral === "TRUE",
        goalsFor,
        goalsAgainst,
        result: resultFor(goalsFor, goalsAgainst, shootoutResult),
        shootout: shootoutResult,
        tournament: match.tournament,
        city: match.city,
        country: match.country
      });
      uniqueMatches.add(matchKey(match.date, match.home_team, match.away_team));
    }
  }

  const outputTeams = {};
  for (const [abbr, datasetName] of Object.entries(datasetNames)) {
    const id = abbr.toLowerCase();
    const matches = teamMatches[datasetName].sort((a, b) => a.date.localeCompare(b.date));
    const rawStart = startRatings.get(datasetName) ?? 1500;
    const rawCurrent = ratings.get(datasetName) ?? rawStart;
    const metrics = weightedMetrics(matches, ratings);
    const wins = matches.filter((match) => match.result === "W" || match.result === "PW").length;
    const draws = matches.filter((match) => match.result === "D").length;
    const losses = matches.length - wins - draws;
    const goalsFor = matches.reduce((sum, match) => sum + match.goalsFor, 0);
    const goalsAgainst = matches.reduce((sum, match) => sum + match.goalsAgainst, 0);
    const displayOffset = 300;
    const performanceElo = Math.round(rawCurrent + displayOffset);
    const anchorElo = Number(teamMeta.get(abbr)?.elo);
    const validAnchor = Number.isFinite(anchorElo) && anchorElo >= 1400 && anchorElo <= 2300;
    const blendedElo = validAnchor ? Math.round(anchorElo * 0.62 + performanceElo * 0.38) : performanceElo;
    const periodChange = Math.round(rawCurrent - rawStart);
    outputTeams[id] = {
      id, abbr, datasetName,
      name: teamMeta.get(abbr)?.name || datasetName,
      logo: teamMeta.get(abbr)?.logo || "",
      eloStart: blendedElo - periodChange,
      elo: blendedElo,
      performanceElo,
      anchorElo: validAnchor ? anchorElo : null,
      change: periodChange,
      matches: matches.length,
      wins, draws, losses, goalsFor, goalsAgainst,
      cleanSheets: matches.filter((match) => match.goalsAgainst === 0).length,
      winRate: matches.length ? Math.round(wins / matches.length * 100) : 0,
      ...metrics,
      recent: matches.slice(-5).map((match) => match.result),
      matchHistory: matches.slice().reverse()
    };
  }

  const output = {
    generatedAt: new Date().toISOString(),
    periodStart: START_DATE,
    periodEnd: END_DATE,
    source: {
      name: "International football results from 1872",
      url: "https://github.com/martj42/international_results",
      license: "CC0-1.0"
    },
    uniqueMatches: uniqueMatches.size,
    teamMatchEntries: Object.values(outputTeams).reduce((sum, team) => sum + team.matches, 0),
    teams: outputTeams
  };

  fs.writeFileSync(path.join(ROOT, "history-data.json"), JSON.stringify(output, null, 2), "utf8");
  fs.writeFileSync(path.join(ROOT, "history-data.js"), `window.GOALMIND_HISTORY = ${JSON.stringify(output)};\n`, "utf8");
  const ranking = Object.values(outputTeams).sort((a, b) => b.elo - a.elo);
  console.log(JSON.stringify({
    generatedAt: output.generatedAt,
    period: `${START_DATE}..${END_DATE}`,
    uniqueMatches: output.uniqueMatches,
    teamMatchEntries: output.teamMatchEntries,
    teams: Object.keys(outputTeams).length,
    top: ranking.slice(0, 8).map((team) => `${team.name} ${team.elo} (${team.change >= 0 ? "+" : ""}${team.change})`),
    bottom: ranking.slice(-5).map((team) => `${team.name} ${team.elo} (${team.change >= 0 ? "+" : ""}${team.change})`)
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
