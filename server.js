const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { spawn } = require("child_process");
const {
  evaluatePredictionRecords,
  randomOutcomeBaseline,
  fixedScoreBaseline
} = require("./scripts/model-evaluation");
const {
  eloOutcomeBaselinePrediction,
  eloPoissonBaselinePrediction
} = require("./scripts/model-baselines");
const {
  calibrateOutcomeProbabilities
} = require("./scripts/probability-calibration");

const ROOT = __dirname;
const REQUESTED_PORT = Number(process.env.PORT || 3000);
const CACHE_FILE = path.join(ROOT, "live-cache.json");
const HISTORY_FILE = path.join(ROOT, "history-data.json");
const CACHE_TTL = 90 * 1000;
const MATCH_DETAIL_TTL = 5 * 60 * 1000;
const TEAM_PROFILE_TTL = 30 * 60 * 1000;
const WEATHER_TTL = 30 * 60 * 1000;
const AI_ADVICE_TTL = 10 * 60 * 1000;
const ESPN_URL = process.env.ESPN_URL || "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260611-20260719&limit=200";
const ELO_URL = process.env.ELO_URL || "https://www.eloratings.net/World.tsv";
const RATING_MODEL_VERSION = "goalmind-dynamic-power-v3";

const eloCodes = {
  ALG: "DZ", ARG: "AR", AUS: "AU", AUT: "AT", BEL: "BE", BIH: "BA",
  BRA: "BR", CAN: "CA", CPV: "CV", COL: "CO", COD: "CD", CRO: "HR",
  CUW: "CW", CZE: "CZ", ECU: "EC", EGY: "EG", ENG: "EN", FRA: "FR",
  GER: "DE", GHA: "GH", HAI: "HT", IRN: "IR", IRQ: "IQ", CIV: "CI",
  JPN: "JP", JOR: "JO", MEX: "MX", MAR: "MA", NED: "NL", NZL: "NZ",
  NOR: "NO", PAN: "PA", PAR: "PY", POR: "PT", QAT: "QA", KSA: "SA",
  SCO: "SC", SEN: "SN", RSA: "ZA", KOR: "KR", ESP: "ES", SWE: "SE",
  SUI: "CH", TUN: "TN", TUR: "TR", USA: "US", URU: "UY", UZB: "UZ"
};

const chineseNames = {
  ALG: "阿尔及利亚", ARG: "阿根廷", AUS: "澳大利亚", AUT: "奥地利", BEL: "比利时",
  BIH: "波黑", BRA: "巴西", CAN: "加拿大", CPV: "佛得角", COL: "哥伦比亚",
  COD: "民主刚果", CRO: "克罗地亚", CUW: "库拉索", CZE: "捷克", ECU: "厄瓜多尔",
  EGY: "埃及", ENG: "英格兰", FRA: "法国", GER: "德国", GHA: "加纳", HAI: "海地",
  IRN: "伊朗", IRQ: "伊拉克", CIV: "科特迪瓦", JPN: "日本", JOR: "约旦",
  MEX: "墨西哥", MAR: "摩洛哥", NED: "荷兰", NZL: "新西兰", NOR: "挪威",
  PAN: "巴拿马", PAR: "巴拉圭", POR: "葡萄牙", QAT: "卡塔尔", KSA: "沙特阿拉伯",
  SCO: "苏格兰", SEN: "塞内加尔", RSA: "南非", KOR: "韩国", ESP: "西班牙",
  SWE: "瑞典", SUI: "瑞士", TUN: "突尼斯", TUR: "土耳其", USA: "美国",
  URU: "乌拉圭", UZB: "乌兹别克斯坦"
};

const stageNames = {
  "group-stage": "小组赛", "round-of-32": "32 强赛", "round-of-16": "16 强赛",
  quarterfinals: "1/4 决赛", semifinals: "半决赛", "3rd-place-match": "季军赛", final: "决赛"
};

const venueWeatherPoints = {
  "Estadio Banorte": { latitude: 19.43, longitude: -99.13, label: "Mexico City" },
  "Estadio Akron": { latitude: 20.66, longitude: -103.35, label: "Guadalajara" },
  "BMO Field": { latitude: 43.63, longitude: -79.42, label: "Toronto" },
  "SoFi Stadium": { latitude: 33.95, longitude: -118.34, label: "Inglewood" },
  "Levi's Stadium": { latitude: 37.40, longitude: -121.97, label: "Santa Clara" },
  "MetLife Stadium": { latitude: 40.81, longitude: -74.07, label: "East Rutherford" },
  "Gillette Stadium": { latitude: 42.09, longitude: -71.26, label: "Foxborough" },
  "BC Place": { latitude: 49.28, longitude: -123.11, label: "Vancouver" },
  "NRG Stadium": { latitude: 29.68, longitude: -95.41, label: "Houston" },
  "AT&T Stadium": { latitude: 32.75, longitude: -97.09, label: "Arlington" },
  "Lincoln Financial Field": { latitude: 39.90, longitude: -75.17, label: "Philadelphia" },
  "Estadio BBVA": { latitude: 25.67, longitude: -100.24, label: "Guadalupe" },
  "Mercedes-Benz Stadium": { latitude: 33.76, longitude: -84.40, label: "Atlanta" },
  "Lumen Field": { latitude: 47.59, longitude: -122.33, label: "Seattle" },
  "Hard Rock Stadium": { latitude: 25.96, longitude: -80.24, label: "Miami Gardens" },
  "GEHA Field at Arrowhead Stadium": { latitude: 39.05, longitude: -94.48, label: "Kansas City" }
};

let cache = loadCache();
const history = loadHistory();
let refreshPromise = null;
const matchDetailCache = new Map();
const teamProfileCache = new Map();
const weatherCache = new Map();
const availabilityCache = new Map();
const aiAdviceCache = new Map();

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); }
  catch { return null; }
}

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")); }
  catch { return { periodStart: "2022-12-19", periodEnd: null, uniqueMatches: 0, teams: {} }; }
}

function predictionCalibration(sourceFixtures = []) {
  const completed = (sourceFixtures || []).filter((fixture) =>
    (fixture.completed || fixture.status === "post")
    && fixture.home
    && fixture.away
    && Number.isFinite(Number(fixture.homeScore))
    && Number.isFinite(Number(fixture.awayScore))
    && fixture.modelPrediction
  );
  if (!completed.length) {
    return { samples: 0, goalLift: 0.36, modeLift: 0.45, drawAdjustment: 0, drawRisk: 0, sideBias: 0, conservativeIndex: 0.5, outcomeReliability: 0, favoriteRisk: 0, underdogLift: 0.08, lowTotalPressure: 0.12, favoriteSurge: 0.12, drawCaution: 0.08, resistanceDraw: 0.08, highScorePressure: 0.12, source: "default" };
  }

  let actualGoals = 0;
  let predictedGoals = 0;
  let predictedDraws = 0;
  let actualDraws = 0;
  let underPredicted = 0;
  let outcomeHits = 0;
  let strongFavoriteFailures = 0;
  let predictedHomeWins = 0;
  let actualHomeWins = 0;
  let predictedAwayWins = 0;
  let actualAwayWins = 0;
  let strongFavoriteSamples = 0;
  let strongFavoriteGoalBias = 0;
  let strongFavoriteUnder = 0;
  let predictedDrawSamples = 0;
  let predictedDrawHits = 0;
  let predictedDrawGoalBias = 0;
  let favoriteDrawSamples = 0;
  let favoriteDrawPredictions = 0;
  let outcomeHitUnderGoalGap = 0;
  let outcomeHitUnderSamples = 0;
  let highScoreSamples = 0;
  let highScoreUnderSamples = 0;
  completed.forEach((fixture) => {
    const predictedTotal = Number(fixture.modelPrediction.home || 0) + Number(fixture.modelPrediction.away || 0);
    const actualTotal = Number(fixture.homeScore || 0) + Number(fixture.awayScore || 0);
    const predictedOutcome = scoreOutcomeValue(Number(fixture.modelPrediction.home || 0), Number(fixture.modelPrediction.away || 0));
    const actualOutcome = scoreOutcomeValue(Number(fixture.homeScore || 0), Number(fixture.awayScore || 0));
    predictedGoals += predictedTotal;
    actualGoals += actualTotal;
    if (predictedOutcome === actualOutcome) outcomeHits += 1;
    const goalGap = actualTotal - predictedTotal;
    if (predictedOutcome === actualOutcome && predictedOutcome !== "draw" && goalGap > 0) {
      outcomeHitUnderGoalGap += goalGap;
      outcomeHitUnderSamples += 1;
    }
    if (actualTotal >= 4) {
      highScoreSamples += 1;
      if (goalGap > 0) highScoreUnderSamples += 1;
    }
    if (predictedOutcome === "home") predictedHomeWins += 1;
    if (predictedOutcome === "away") predictedAwayWins += 1;
    if (actualOutcome === "home") actualHomeWins += 1;
    if (actualOutcome === "away") actualAwayWins += 1;
    if (Number(fixture.modelPrediction.home) === Number(fixture.modelPrediction.away)) predictedDraws += 1;
    if (Number(fixture.homeScore) === Number(fixture.awayScore)) actualDraws += 1;
    if (predictedTotal < actualTotal) underPredicted += 1;
    if (predictedOutcome === "draw") {
      predictedDrawSamples += 1;
      if (actualOutcome === "draw") predictedDrawHits += 1;
      predictedDrawGoalBias += actualTotal - predictedTotal;
    }
    const expectedHome = Number(fixture.ratingUpdate?.expectedHome);
    if (Number.isFinite(expectedHome)) {
      if (expectedHome >= 0.7 && actualOutcome !== "home") strongFavoriteFailures += 1;
      if (expectedHome <= 0.3 && actualOutcome !== "away") strongFavoriteFailures += 1;
      if (expectedHome >= 0.68 || expectedHome <= 0.32) {
        strongFavoriteSamples += 1;
        strongFavoriteGoalBias += actualTotal - predictedTotal;
        if (predictedTotal < actualTotal) strongFavoriteUnder += 1;
        if (actualOutcome === "draw") favoriteDrawSamples += 1;
        if (predictedOutcome === "draw") favoriteDrawPredictions += 1;
      }
    }
  });

  const samples = completed.length;
  const goalBias = (actualGoals - predictedGoals) / samples;
  const conservativeIndex = clamp(underPredicted / samples, 0, 1);
  const drawGap = (actualDraws - predictedDraws) / samples;
  const sideBias = ((actualHomeWins - predictedHomeWins) - (actualAwayWins - predictedAwayWins)) / samples;
  const favoriteBias = strongFavoriteSamples ? strongFavoriteGoalBias / strongFavoriteSamples : goalBias;
  const favoriteUnderRate = strongFavoriteSamples ? strongFavoriteUnder / strongFavoriteSamples : conservativeIndex;
  const predictedDrawHitRate = predictedDrawSamples ? predictedDrawHits / predictedDrawSamples : 0.5;
  const predictedDrawBias = predictedDrawSamples ? predictedDrawGoalBias / predictedDrawSamples : 0;
  const favoriteDrawGap = strongFavoriteSamples ? (favoriteDrawSamples - favoriteDrawPredictions) / strongFavoriteSamples : 0;
  const outcomeHitUnderBias = outcomeHitUnderSamples ? outcomeHitUnderGoalGap / outcomeHitUnderSamples : Math.max(0, goalBias);
  const highScoreUnderRate = highScoreSamples ? highScoreUnderSamples / highScoreSamples : conservativeIndex;
  return {
    samples,
    avgPredictedGoals: Number((predictedGoals / samples).toFixed(2)),
    avgActualGoals: Number((actualGoals / samples).toFixed(2)),
    goalLift: Number(clamp(goalBias * 0.42 + conservativeIndex * 0.18, 0.18, 1.15).toFixed(2)),
    modeLift: Number(clamp(goalBias * 0.58 + conservativeIndex * 0.2, 0.25, 1.45).toFixed(2)),
    drawAdjustment: Number(clamp(drawGap * 0.35, -0.04, 0.06).toFixed(3)),
    drawRisk: Number(clamp(drawGap, -0.12, 0.18).toFixed(3)),
    sideBias: Number(clamp(sideBias, -0.16, 0.16).toFixed(3)),
    conservativeIndex: Number(conservativeIndex.toFixed(2)),
    outcomeReliability: Number((outcomeHits / samples).toFixed(2)),
    favoriteRisk: Number(clamp(strongFavoriteFailures / samples, 0, 0.32).toFixed(2)),
    underdogLift: Number(clamp((strongFavoriteFailures / samples) * 1.1 + Math.max(0, drawGap) * 0.45, 0, 0.34).toFixed(2)),
    lowTotalPressure: Number(clamp(conservativeIndex * 0.22 + Math.max(0, goalBias - 0.7) * 0.06, 0.08, 0.36).toFixed(2)),
    favoriteSurge: Number(clamp(Math.max(0, favoriteBias) * 0.22 + favoriteUnderRate * 0.18, 0.08, 0.58).toFixed(2)),
    drawCaution: Number(clamp((1 - predictedDrawHitRate) * 0.12 + Math.max(0, predictedDrawBias - 0.5) * 0.04, 0, 0.24).toFixed(2)),
    resistanceDraw: Number(clamp(Math.max(0, drawGap) * 0.38 + Math.max(0, favoriteDrawGap) * 0.55, 0, 0.24).toFixed(2)),
    highScorePressure: Number(clamp(outcomeHitUnderBias * 0.12 + highScoreUnderRate * 0.16 + Math.max(0, goalBias) * 0.08, 0, 0.5).toFixed(2)),
    source: "completed-match-feedback"
  };
}

function predictionAudit(sourceFixtures = []) {
  const completed = (sourceFixtures || []).filter((fixture) =>
    (fixture.completed || fixture.status === "post")
    && fixture.home
    && fixture.away
    && Number.isFinite(Number(fixture.homeScore))
    && Number.isFinite(Number(fixture.awayScore))
    && fixture.modelPrediction
  );
  if (!completed.length) {
    return {
      samples: 0,
      exactRate: 0,
      outcomeRate: 0,
      avgGoalBias: 0,
      underRate: 0,
      scoreMae: 0,
      recommendation: "等待更多完赛样本后开始审计预测偏差。"
    };
  }

  let exact = 0;
  let outcomeHits = 0;
  let close = 0;
  let predictedGoals = 0;
  let actualGoals = 0;
  let absoluteGoalError = 0;
  let under = 0;
  let over = 0;
  let predictedHomeWins = 0;
  let actualHomeWins = 0;
  let predictedAwayWins = 0;
  let actualAwayWins = 0;
  let predictedDraws = 0;
  let actualDraws = 0;
  let strongFavoriteFailures = 0;

  completed.forEach((fixture) => {
    const predHome = Number(fixture.modelPrediction.home || 0);
    const predAway = Number(fixture.modelPrediction.away || 0);
    const actualHome = Number(fixture.homeScore || 0);
    const actualAway = Number(fixture.awayScore || 0);
    const predictedTotal = predHome + predAway;
    const actualTotal = actualHome + actualAway;
    const predictedOutcome = scoreOutcomeValue(predHome, predAway);
    const actualOutcome = scoreOutcomeValue(actualHome, actualAway);

    if (predHome === actualHome && predAway === actualAway) exact += 1;
    if (predictedOutcome === actualOutcome) {
      outcomeHits += 1;
      if (predHome !== actualHome || predAway !== actualAway) close += 1;
    }
    predictedGoals += predictedTotal;
    actualGoals += actualTotal;
    absoluteGoalError += Math.abs(predHome - actualHome) + Math.abs(predAway - actualAway);
    if (predictedTotal < actualTotal) under += 1;
    if (predictedTotal > actualTotal) over += 1;
    if (predictedOutcome === "home") predictedHomeWins += 1;
    if (predictedOutcome === "away") predictedAwayWins += 1;
    if (predictedOutcome === "draw") predictedDraws += 1;
    if (actualOutcome === "home") actualHomeWins += 1;
    if (actualOutcome === "away") actualAwayWins += 1;
    if (actualOutcome === "draw") actualDraws += 1;

    const expectedHome = Number(fixture.ratingUpdate?.expectedHome);
    if (Number.isFinite(expectedHome)) {
      if (expectedHome >= 0.7 && actualOutcome !== "home") strongFavoriteFailures += 1;
      if (expectedHome <= 0.3 && actualOutcome !== "away") strongFavoriteFailures += 1;
    }
  });

  const samples = completed.length;
  const avgPredictedGoals = predictedGoals / samples;
  const avgActualGoals = actualGoals / samples;
  const avgGoalBias = avgActualGoals - avgPredictedGoals;
  const underRate = under / samples;
  const drawGap = actualDraws / samples - predictedDraws / samples;
  const sideBias = (actualHomeWins / samples - predictedHomeWins / samples) - (actualAwayWins / samples - predictedAwayWins / samples);
  const recommendation = avgGoalBias > 0.55 && underRate > 0.55
    ? "模型仍有低估总进球倾向，后续预测继续上调 xG 与比分选择阈值。"
    : drawGap > 0.08
      ? "真实平局率高于预测，后续应提高接近实力比赛的平局权重。"
      : strongFavoriteFailures / samples > 0.18
        ? "强弱差场次的冷门风险偏低，后续应降低强队大胜默认权重。"
        : "当前偏差处于可接受区间，继续随完赛样本滚动校准。";

  return {
    samples,
    exactRate: Number((exact / samples).toFixed(3)),
    outcomeRate: Number((outcomeHits / samples).toFixed(3)),
    closeRate: Number((close / samples).toFixed(3)),
    wrongRate: Number(((samples - outcomeHits) / samples).toFixed(3)),
    avgPredictedGoals: Number(avgPredictedGoals.toFixed(2)),
    avgActualGoals: Number(avgActualGoals.toFixed(2)),
    avgGoalBias: Number(avgGoalBias.toFixed(2)),
    underRate: Number(underRate.toFixed(3)),
    overRate: Number((over / samples).toFixed(3)),
    predictedDrawRate: Number((predictedDraws / samples).toFixed(3)),
    actualDrawRate: Number((actualDraws / samples).toFixed(3)),
    drawGap: Number(drawGap.toFixed(3)),
    predictedHomeWinRate: Number((predictedHomeWins / samples).toFixed(3)),
    actualHomeWinRate: Number((actualHomeWins / samples).toFixed(3)),
    predictedAwayWinRate: Number((predictedAwayWins / samples).toFixed(3)),
    actualAwayWinRate: Number((actualAwayWins / samples).toFixed(3)),
    sideBias: Number(sideBias.toFixed(3)),
    scoreMae: Number((absoluteGoalError / samples / 2).toFixed(2)),
    strongFavoriteFailures,
    recommendation
  };
}

function currentModelFixtureView(sourceFixtures = []) {
  return (sourceFixtures || []).map((fixture) => (
    fixture?.currentModelPrediction
      ? { ...fixture, modelPrediction: fixture.currentModelPrediction }
      : fixture
  ));
}

function predictionEvaluationRecord(fixture, prediction = fixture?.modelPrediction) {
  if (!fixture || !prediction) return null;
  if (!(fixture.completed || fixture.status === "post")) return null;
  if (!Number.isFinite(Number(fixture.homeScore)) || !Number.isFinite(Number(fixture.awayScore))) return null;
  return {
    prediction,
    actual: {
      home: Number(fixture.homeScore),
      away: Number(fixture.awayScore)
    }
  };
}

function buildProbabilityEvaluation(sourceFixtures = [], sourceTeams = []) {
  const byId = new Map((sourceTeams || []).map((team) => [team.id, team]));
  const records = [];
  const eloRecords = [];
  const eloPoissonRecords = [];
  for (const fixture of sourceFixtures || []) {
    const record = predictionEvaluationRecord(fixture);
    if (!record) continue;
    records.push(record);
    const home = byId.get(fixture.home);
    const away = byId.get(fixture.away);
    if (!home || !away) continue;
    eloRecords.push(predictionEvaluationRecord(fixture, eloOutcomeBaselinePrediction(home, away, fixture)));
    eloPoissonRecords.push(predictionEvaluationRecord(fixture, eloPoissonBaselinePrediction(home, away, fixture)));
  }
  return {
    model: evaluatePredictionRecords(records),
    baselines: {
      randomOutcome: randomOutcomeBaseline(records),
      elo: evaluatePredictionRecords(eloRecords),
      eloPoisson: evaluatePredictionRecords(eloPoissonRecords),
      fixedScores: {
        "1:0": fixedScoreBaseline(records, 1, 0),
        "1:1": fixedScoreBaseline(records, 1, 1),
        "0:1": fixedScoreBaseline(records, 0, 1)
      }
    }
  };
}

function calibratedExpectedGoals(homeXg, awayXg, difference, fixture = {}, calibration = predictionCalibration()) {
  const weather = fixture.weather?.impact || { tempo: 0 };
  const volatility = clamp(Math.abs(difference) / 900, 0, 0.42);
  const tempoLift = clamp((weather.tempo || 0) / 100, -0.08, 0.08);
  const favoriteSurge = Math.abs(difference) > 220
    ? clamp((calibration.favoriteSurge || 0) * ((Math.abs(difference) - 190) / 520), 0, 0.42)
    : 0;
  const totalLift = clamp((calibration.goalLift || 0) + volatility * 0.22 + tempoLift + favoriteSurge, 0, 1.72);
  const favoriteShare = clamp(0.52 + Math.abs(difference) / 1800, 0.52, 0.68);
  let homeShare = difference >= 0 ? favoriteShare : 1 - favoriteShare;
  const underdogLift = clamp(calibration.underdogLift || 0, 0, 0.34);
  if (underdogLift && Math.abs(difference) > 170) {
    const correction = clamp(underdogLift * ((Math.abs(difference) - 150) / 650), 0, 0.16);
    homeShare += difference >= 0 ? -correction : correction;
    homeShare = clamp(homeShare, 0.38, 0.62);
  }
  return {
    home: clamp(homeXg + totalLift * homeShare, 0.25, 4.4),
    away: clamp(awayXg + totalLift * (1 - homeShare), 0.25, 4.1),
    totalLift: Number(totalLift.toFixed(2))
  };
}

function scoreOutcomeValue(homeGoals, awayGoals) {
  return homeGoals > awayGoals ? "home" : homeGoals < awayGoals ? "away" : "draw";
}

function roundedProbability(value) {
  return Number(clamp(Number(value || 0), 0, 1).toFixed(4));
}

function normalizedScoreDistribution(matrix, covered) {
  const total = covered > 0 ? covered : matrix.flat().reduce((sum, value) => sum + Number(value || 0), 0);
  const rows = [];
  for (let homeGoals = 0; homeGoals <= 5; homeGoals += 1) {
    for (let awayGoals = 0; awayGoals <= 5; awayGoals += 1) {
      const probability = total ? (matrix[homeGoals]?.[awayGoals] || 0) / total : 0;
      rows.push({ home: homeGoals, away: awayGoals, probability: roundedProbability(probability) });
    }
  }
  return rows.sort((a, b) => b.probability - a.probability);
}

function scoreKey(homeGoals, awayGoals) {
  return `${homeGoals}:${awayGoals}`;
}

function scoreProbabilityMap(distribution) {
  return new Map(distribution.map((item) => [scoreKey(item.home, item.away), item.probability]));
}

function totalGoalProbabilities(distribution, homeXg, awayXg) {
  const totals = {};
  let over25 = 0;
  let bothTeamsScore = 0;
  distribution.forEach((item) => {
    const total = item.home + item.away;
    totals[total] = (totals[total] || 0) + item.probability;
    if (total >= 3) over25 += item.probability;
    if (item.home > 0 && item.away > 0) bothTeamsScore += item.probability;
  });
  return {
    expected: Number((homeXg + awayXg).toFixed(2)),
    over25: roundedProbability(over25),
    under25: roundedProbability(1 - over25),
    bothTeamsScore: roundedProbability(bothTeamsScore),
    byTotal: Object.fromEntries(Object.entries(totals).map(([total, probability]) => [total, roundedProbability(probability)]))
  };
}

function isKnockoutFixture(fixture = {}) {
  const stage = `${fixture.stage || ""} ${fixture.stageName || ""}`;
  return /knockout|32|16|1\/4|quarter|semi|final|寮|决|決|半|淘汰/i.test(stage) && !/group|小组/i.test(stage);
}

function knockoutAdvanceProbabilities(probabilities, difference, fixture = {}) {
  if (!isKnockoutFixture(fixture)) return null;
  const homeWin = probabilities.homeWin;
  const awayWin = probabilities.awayWin;
  const draw = probabilities.draw;
  const nonDrawTotal = homeWin + awayWin || 1;
  const strengthShare = clamp(homeWin / nonDrawTotal, 0.18, 0.82);
  const penaltyHomeShare = clamp(0.5 + difference / 2400, 0.42, 0.58);
  const extraResolutionShare = 0.42;
  const penaltyShare = 1 - extraResolutionShare;
  const homeAfterDraw = strengthShare * extraResolutionShare + penaltyHomeShare * penaltyShare;
  const homeAdvance = homeWin + draw * homeAfterDraw;
  const awayAdvance = awayWin + draw * (1 - homeAfterDraw);
  const total = homeAdvance + awayAdvance || 1;
  const normalizedHomeAdvance = roundedProbability(homeAdvance / total);
  const normalizedAwayAdvance = roundedProbability(awayAdvance / total);
  return {
    applies: true,
    regularTimeDraw: roundedProbability(draw),
    extraTimeResolution: roundedProbability(draw * extraResolutionShare),
    penaltyShootout: roundedProbability(draw * penaltyShare),
    home: normalizedHomeAdvance,
    away: normalizedAwayAdvance,
    homeAdvance: normalizedHomeAdvance,
    awayAdvance: normalizedAwayAdvance,
    note: "Knockout prediction separates 90-minute result from final advancement; a 90-minute draw is resolved through extra time or penalties."
  };
}

function selectCalibratedScore(matrix, homeXg, awayXg, probabilities, calibration = predictionCalibration()) {
  const dominant = probabilities.homeWin >= probabilities.awayWin && probabilities.homeWin >= probabilities.draw
    ? "home"
    : probabilities.awayWin >= probabilities.draw ? "away" : "draw";
  const highScorePressure = clamp(calibration.highScorePressure || 0, 0, 0.5);
  const strongestWin = Math.max(probabilities.homeWin, probabilities.awayWin);
  const decisiveEdge = dominant === "draw" ? 0 : clamp((strongestWin - probabilities.draw - 0.18) / 0.42, 0, 1);
  const goalEnvironment = dominant === "draw" ? 0 : clamp((homeXg + awayXg - 2.1) / 1.4, 0, 1);
  const highScoreLift = highScorePressure * clamp(0.35 + decisiveEdge * 0.95 + goalEnvironment * 0.4, 0, 1.45);
  const targetTotal = clamp(homeXg + awayXg + (calibration.modeLift || 0) + highScoreLift, 1.2, 6.8);
  const ranked = [];
  for (let homeGoals = 0; homeGoals <= 5; homeGoals += 1) {
    for (let awayGoals = 0; awayGoals <= 5; awayGoals += 1) {
      const probability = matrix[homeGoals]?.[awayGoals] || 0;
      const outcome = scoreOutcomeValue(homeGoals, awayGoals);
      const total = homeGoals + awayGoals;
      const totalFit = Math.exp(-Math.abs(total - targetTotal) * 0.23);
      const xgFit = Math.exp(-(Math.abs(homeGoals - homeXg) + Math.abs(awayGoals - awayXg)) * 0.16);
      const outcomeFit = outcome === dominant
        ? 1.18
        : 0.86;
      const highScoreAggression = outcome !== "draw" ? highScorePressure * (decisiveEdge + goalEnvironment * 0.55) : 0;
      const aggression = 1 + Math.min(total, 6) * (0.035 + (calibration.conservativeIndex || 0) * 0.035 + highScoreAggression * 0.06);
      const belowTarget = Math.max(0, targetTotal - total - 0.85);
      const lowTotalPenalty = 1 - clamp(belowTarget * (0.08 + (calibration.lowTotalPressure || 0.12) * 0.75), 0, 0.42);
      const openDrawPenalty = outcome === "draw" && targetTotal > 2.35
        ? 1 - clamp((targetTotal - 2.35) * (0.08 + (calibration.drawCaution || 0)), 0, 0.34)
        : 1;
      const utility = Math.pow(probability, 0.72) * totalFit * xgFit * outcomeFit * aggression * lowTotalPenalty * openDrawPenalty;
      ranked.push({ home: homeGoals, away: awayGoals, probability, utility });
    }
  }
  ranked.sort((a, b) => b.utility - a.utility);
  return { ...ranked[0], candidates: ranked.slice(0, 6) };
}

function applyHistoricalModel(teams, fixtures) {
  const modeled = teams.map((team) => {
    const model = history.teams?.[team.id];
    if (!model) return team;
    return {
      ...team,
      elo: model.elo,
      preTournamentElo: model.elo,
      historyChange: model.change,
      trend: 0,
      form: model.form,
      attack: model.attack,
      defense: model.defense,
      pace: model.bigMatch,
      control: model.consistency,
      bigMatch: model.bigMatch,
      consistency: model.consistency,
      historyMatches: model.matches,
      historyRecord: `${model.wins}-${model.draws}-${model.losses}`,
      modelSource: "GoalMind 2022-2026"
    };
  });

  const byId = new Map(modeled.map((team) => [team.id, team]));
  const previousPredictions = new Map((cache?.fixtures || [])
    .filter((fixture) => fixture.modelPrediction)
    .map((fixture) => [fixture.id, fixture]));
  const orderedFixtures = [...fixtures].sort((a, b) => new Date(a.date) - new Date(b.date));
  const completedSamples = [];
  for (const fixture of orderedFixtures) {
    const home = byId.get(fixture.home);
    const away = byId.get(fixture.away);
    if (!home || !away) continue;
    const previous = previousPredictions.get(fixture.id);
    const calibration = predictionCalibration(completedSamples);
    const freshPrediction = modelPredictedScore(home, away, fixture.venueMode, fixture, calibration);
    const lockedSnapshot = fixture.completed
      && previous?.home === fixture.home
      && previous?.away === fixture.away
      && previous.modelPrediction;
    fixture.predictionCalibration = calibration;
    fixture.currentModelPrediction = freshPrediction;
    fixture.modelPrediction = lockedSnapshot
      ? previous.modelPrediction
      : freshPrediction;
    fixture.preMatchAnalysis = fixture.completed && previous?.home === fixture.home && previous?.away === fixture.away && previous.preMatchAnalysis
      ? previous.preMatchAnalysis
      : buildPreMatchAnalysis(home, away, fixture);
    if (!fixture.completed) continue;
    const update = objectiveRatingUpdate(home, away, fixture, calibration);
    home.elo += update.homeDelta; away.elo += update.awayDelta;
    home.trend += update.homeDelta; away.trend += update.awayDelta;
    home.lastMatchDelta = update.homeDelta;
    away.lastMatchDelta = update.awayDelta;
    fixture.ratingUpdate = update;
    home.form = Math.round(clamp(home.form * 0.82 + performanceSignal(update.actualHome, update.expectedHome) * 0.18, 35, 98));
    away.form = Math.round(clamp(away.form * 0.82 + performanceSignal(update.actualAway, update.expectedAway) * 0.18, 35, 98));
    const actual = update.actualHome;
    const homeAttackSignal = clamp(52 + fixture.homeScore * 14 + (away.defense - 70) * 0.25, 42, 98);
    const awayAttackSignal = clamp(52 + fixture.awayScore * 14 + (home.defense - 70) * 0.25, 42, 98);
    const homeDefenseSignal = clamp(94 - fixture.awayScore * 15 + (away.attack - 70) * 0.2, 42, 98);
    const awayDefenseSignal = clamp(94 - fixture.homeScore * 15 + (home.attack - 70) * 0.2, 42, 98);
    home.attack = Math.round(home.attack * 0.88 + homeAttackSignal * 0.12);
    away.attack = Math.round(away.attack * 0.88 + awayAttackSignal * 0.12);
    home.defense = Math.round(home.defense * 0.88 + homeDefenseSignal * 0.12);
    away.defense = Math.round(away.defense * 0.88 + awayDefenseSignal * 0.12);
    home.pace = home.bigMatch = Math.round(clamp(home.bigMatch * 0.9 + actual * 100 * 0.1, 40, 98));
    away.pace = away.bigMatch = Math.round(clamp(away.bigMatch * 0.9 + (1 - actual) * 100 * 0.1, 40, 98));
    completedSamples.push({ ...fixture, modelPrediction: freshPrediction, ratingUpdate: update });
  }
  return modeled.sort((a, b) => b.elo - a.elo);
}

function normalizeCachedPayload(payload, errorMessage = "") {
  const fixtures = Array.isArray(payload?.fixtures) ? structuredClone(payload.fixtures) : [];
  const sourceTeams = Array.isArray(payload?.teams) ? structuredClone(payload.teams) : [];
  const hasDynamicCache = payload?.modelVersion === RATING_MODEL_VERSION
    && sourceTeams.some((team) => Number.isFinite(team.preTournamentElo) || Number.isFinite(team.lastMatchDelta) || Number(team.matches || 0) > 0);
  if (hasDynamicCache) {
    const byId = new Map(sourceTeams.map((team) => [team.id, team]));
    const currentFixtures = currentModelFixtureView(fixtures);
    const calibration = predictionCalibration(currentFixtures);
    const audit = predictionAudit(currentFixtures);
    const lockedAudit = predictionAudit(fixtures);
    const probabilityEvaluation = buildProbabilityEvaluation(currentFixtures, sourceTeams);
    const lockedProbabilityEvaluation = buildProbabilityEvaluation(fixtures, sourceTeams);
    for (const fixture of fixtures) {
      if (!fixture?.home || !fixture?.away) continue;
      const home = byId.get(fixture.home);
      const away = byId.get(fixture.away);
      if (!home || !away) continue;
      const lockedSnapshot = fixture.completed || fixture.status === "post";
      fixture.predictionCalibration = calibration;
      fixture.currentModelPrediction ||= fixture.modelPrediction;
      if (!lockedSnapshot || !fixture.modelPrediction) {
        fixture.modelPrediction = modelPredictedScore(home, away, fixture.venueMode, fixture, calibration);
        fixture.currentModelPrediction = fixture.modelPrediction;
      }
      fixture.preMatchAnalysis ||= buildPreMatchAnalysis(home, away, fixture);
    }
    return {
      ...payload,
      stale: true,
      error: errorMessage || payload?.error,
      teams: sourceTeams.sort((a, b) => b.elo - a.elo),
      fixtures,
      predictionCalibration: calibration,
      predictionAudit: audit,
      lockedPredictionAudit: lockedAudit,
      probabilityEvaluation: probabilityEvaluation.model,
      predictionBaselines: probabilityEvaluation.baselines,
      lockedProbabilityEvaluation: lockedProbabilityEvaluation.model,
      modelVersion: RATING_MODEL_VERSION,
      source: { ...(payload?.source || {}), ratings: "GoalMind dynamic power rating v3" }
    };
  }
  const modeledTeams = applyHistoricalModel(sourceTeams, fixtures);
  const currentFixtures = currentModelFixtureView(fixtures);
  const calibration = predictionCalibration(currentFixtures);
  const audit = predictionAudit(currentFixtures);
  const lockedAudit = predictionAudit(fixtures);
  const probabilityEvaluation = buildProbabilityEvaluation(currentFixtures, modeledTeams);
  const lockedProbabilityEvaluation = buildProbabilityEvaluation(fixtures, modeledTeams);
  return {
    ...payload,
    stale: true,
    error: errorMessage || payload?.error,
    teams: modeledTeams,
    fixtures,
    predictionCalibration: calibration,
    predictionAudit: audit,
    lockedPredictionAudit: lockedAudit,
    probabilityEvaluation: probabilityEvaluation.model,
    predictionBaselines: probabilityEvaluation.baselines,
    lockedProbabilityEvaluation: lockedProbabilityEvaluation.model,
    modelVersion: RATING_MODEL_VERSION,
    source: { ...(payload?.source || {}), ratings: "GoalMind dynamic power rating v3" }
  };
}

function weatherPointForFixture(fixture) {
  return venueWeatherPoints[fixture.venue] || null;
}

function weatherCodeLabel(code) {
  if (code === 0) return "晴";
  if ([1, 2].includes(code)) return "少云";
  if (code === 3) return "多云";
  if ([45, 48].includes(code)) return "雾";
  if (code >= 51 && code <= 67) return "降雨";
  if (code >= 71 && code <= 77) return "降雪";
  if (code >= 80 && code <= 82) return "阵雨";
  if (code >= 95) return "雷暴";
  return "天气待判定";
}

function weatherImpact(weather) {
  if (!weather?.available) return { xg: 0, draw: 0, tempo: 0, confidence: 0, notes: ["天气预报临近比赛更新"] };
  let xg = 0;
  let draw = 0;
  let tempo = 0;
  let confidence = 0;
  const notes = [];

  if (weather.temperature >= 30) {
    xg -= 0.06; draw += 0.01; tempo -= 6; confidence -= 2;
    notes.push("高温会降低冲刺和高位压迫持续性");
  } else if (weather.temperature <= 5) {
    xg -= 0.04; draw += 0.006; tempo -= 3;
    notes.push("低温可能降低脚下处理稳定性");
  }
  if (weather.windSpeed >= 28) {
    xg -= 0.08; draw += 0.015; tempo -= 4; confidence -= 2;
    notes.push("大风会影响长传、传中和定位球落点");
  }
  if (weather.precipitationProbability >= 55 || /雨|雪|雷暴/.test(weather.label)) {
    xg -= 0.08; draw += 0.02; tempo -= 5; confidence -= 3;
    notes.push("降水会增加控球失误并降低射门质量");
  }
  if (weather.humidity >= 78 && weather.temperature >= 26) {
    xg -= 0.04; draw += 0.006; tempo -= 4;
    notes.push("闷热湿度会放大体能衰减");
  }
  if (!notes.length) notes.push("天气条件对比赛影响较小");

  return {
    xg: Number(xg.toFixed(2)),
    draw: Number(draw.toFixed(3)),
    tempo,
    confidence,
    notes
  };
}

function nearestHourlyWeather(hourly, fixtureDate) {
  if (!Array.isArray(hourly?.time) || !hourly.time.length) return null;
  const target = new Date(fixtureDate).getTime();
  let bestIndex = -1;
  let bestDistance = Infinity;
  hourly.time.forEach((time, index) => {
    const current = new Date(`${time}Z`).getTime();
    const distance = Math.abs(current - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  if (bestIndex < 0 || bestDistance > 3 * 60 * 60 * 1000) return null;
  return {
    time: hourly.time[bestIndex],
    temperature: Number(hourly.temperature_2m?.[bestIndex]),
    humidity: Number(hourly.relative_humidity_2m?.[bestIndex]),
    precipitationProbability: Number(hourly.precipitation_probability?.[bestIndex]),
    windSpeed: Number(hourly.wind_speed_10m?.[bestIndex]),
    code: Number(hourly.weather_code?.[bestIndex])
  };
}

async function getFixtureWeather(fixture) {
  const point = weatherPointForFixture(fixture);
  if (!point || !fixture?.date) return { available: false, summary: "球场天气待同步", source: "Open-Meteo", impact: weatherImpact(null) };
  const hourKey = new Date(fixture.date).toISOString().slice(0, 13);
  const cacheKey = `${fixture.venue}:${hourKey}`;
  const cached = weatherCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < WEATHER_TTL) return cached.data;

  try {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", point.latitude);
    url.searchParams.set("longitude", point.longitude);
    url.searchParams.set("hourly", "temperature_2m,relative_humidity_2m,precipitation_probability,wind_speed_10m,weather_code");
    url.searchParams.set("timezone", "UTC");
    url.searchParams.set("forecast_days", "16");
    const raw = JSON.parse(await fetchText(url.toString()));
    const hour = nearestHourlyWeather(raw.hourly, fixture.date);
    if (!hour) {
      const pending = {
        available: false,
        venue: fixture.venue,
        city: point.label,
        summary: "天气预报临近比赛更新",
        source: "Open-Meteo forecast",
        impact: weatherImpact(null)
      };
      weatherCache.set(cacheKey, { cachedAt: Date.now(), data: pending });
      return pending;
    }
    const label = weatherCodeLabel(hour.code);
    const data = {
      available: true,
      venue: fixture.venue,
      city: point.label,
      time: hour.time,
      temperature: hour.temperature,
      humidity: hour.humidity,
      precipitationProbability: hour.precipitationProbability,
      windSpeed: hour.windSpeed,
      code: hour.code,
      label,
      summary: `${label} · ${Math.round(hour.temperature)}°C · 风速 ${Math.round(hour.windSpeed)} km/h · 降水 ${Math.round(hour.precipitationProbability)}%`,
      source: "Open-Meteo forecast"
    };
    data.impact = weatherImpact(data);
    weatherCache.set(cacheKey, { cachedAt: Date.now(), data });
    return data;
  } catch {
    return { available: false, venue: fixture.venue, city: point.label, summary: "天气源暂不可用", source: "Open-Meteo forecast", impact: weatherImpact(null) };
  }
}

async function attachWeatherToFixtures(fixtures) {
  await Promise.all(fixtures.map(async (fixture) => {
    fixture.weather = await getFixtureWeather(fixture);
  }));
  return fixtures;
}

function normalizePlayerStatus(athlete = {}) {
  const label = [athlete.status?.displayName, athlete.status?.name, athlete.status?.type, athlete.status?.description].filter(Boolean).join(" ");
  const unavailable = /inactive|injur|out|doubt|question|suspend|伤|缺阵|停赛|存疑/i.test(label);
  return {
    type: athlete.status?.type || (unavailable ? "unavailable" : "active"),
    label: label || "可出场",
    unavailable,
    injuryLike: /injur|伤|out|doubt|question|缺阵|存疑/i.test(label)
  };
}

function availabilityFromSquad(teamId, squad = []) {
  const unavailable = squad.filter((player) => player.unavailable || player.active === false);
  const byPosition = unavailable.reduce((acc, player) => {
    const key = player.position || "UNK";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const attackPenalty = unavailable.reduce((sum, player) => sum + (["F", "FW"].includes(player.position) ? 5 : ["M", "MF"].includes(player.position) ? 2 : 0), 0);
  const defensePenalty = unavailable.reduce((sum, player) => sum + (["G", "GK"].includes(player.position) ? 7 : ["D", "DF"].includes(player.position) ? 4 : ["M", "MF"].includes(player.position) ? 1 : 0), 0);
  const controlPenalty = unavailable.reduce((sum, player) => sum + (["M", "MF"].includes(player.position) ? 4 : ["D", "DF"].includes(player.position) ? 1 : 0), 0);
  const impact = clamp(attackPenalty + defensePenalty + controlPenalty * 0.6, 0, 22);
  return {
    teamId,
    available: true,
    unavailableCount: unavailable.length,
    byPosition,
    attackPenalty: Math.round(clamp(attackPenalty, 0, 14)),
    defensePenalty: Math.round(clamp(defensePenalty, 0, 14)),
    controlPenalty: Math.round(clamp(controlPenalty, 0, 12)),
    ratingPenalty: Math.round(impact),
    summary: unavailable.length ? `${unavailable.length} 名球员不可用/存疑` : "暂无官方伤病名单",
    players: unavailable.slice(0, 6).map((player) => ({
      id: player.id,
      name: player.shortName || player.name,
      position: player.position,
      status: player.statusLabel || "不可用"
    }))
  };
}

async function mapLimit(items, limit, task) {
  const results = [];
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      results[current] = await task(items[current]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function getTeamAvailability(team) {
  if (!team?.providerId) return { teamId: team?.id, available: false, summary: "暂无官方伤病名单", unavailableCount: 0, ratingPenalty: 0, attackPenalty: 0, defensePenalty: 0, controlPenalty: 0, players: [] };
  const cached = availabilityCache.get(team.id);
  if (cached && Date.now() - cached.cachedAt < TEAM_PROFILE_TTL) return cached.data;
  try {
    const profile = await fetchTeamProfileForTeam(team, team.id);
    teamProfileCache.set(team.id, { cachedAt: Date.now(), data: profile });
    const data = availabilityFromSquad(team.id, profile.squad || []);
    availabilityCache.set(team.id, { cachedAt: Date.now(), data });
    return data;
  } catch {
    return { teamId: team.id, available: false, summary: "官方伤病源暂不可用", unavailableCount: 0, ratingPenalty: 0, attackPenalty: 0, defensePenalty: 0, controlPenalty: 0, players: [] };
  }
}

async function attachAvailabilityToTeams(teams) {
  await mapLimit(teams, 6, async (team) => {
    team.availability = await getTeamAvailability(team);
  });
  return teams;
}

function buildPreMatchAnalysis(home, away, fixture) {
  const difference = contextualRatingDifference(home, away, fixture);
  const homePossession = Math.round(clamp(50 + difference / 32 + ((home.control || 70) - (away.control || 70)) * 0.18, 31, 69));
  const homeShots = Math.round(clamp(10 + (home.attack - away.defense) / 7 + difference / 85, 5, 22));
  const awayShots = Math.round(clamp(10 + (away.attack - home.defense) / 7 - difference / 95, 4, 20));
  return {
    createdAt: new Date().toISOString(),
    modelVersion: "goalmind-match-intelligence-v1",
    home: buildTeamPlan(home, away, true),
    away: buildTeamPlan(away, home, false),
    expected: {
      possessionHome: homePossession,
      possessionAway: 100 - homePossession,
      shotsHome: homeShots,
      shotsAway: awayShots,
      cornersHome: Math.round(clamp(4 + (home.attack - away.defense) / 15 + difference / 180, 2, 9)),
      cornersAway: Math.round(clamp(4 + (away.attack - home.defense) / 15 - difference / 200, 1, 9))
    },
    context: buildMatchContext(home, away, fixture),
    matchScript: difference > 120
      ? `${home.name}预计掌握更多球权并持续压迫，${away.name}更可能收紧中路、依靠转换寻找机会。`
      : difference < -120
        ? `${away.name}预计控制比赛节奏，${home.name}需要降低推进风险并提高反击效率。`
        : "双方实力接近，中场争夺、二点球和定位球处理可能决定比赛走势。",
    scoringWindow: Math.abs(difference) > 150 ? "强势方在开场 25 分钟及下半场体能下降阶段更具进球机会" : "比赛可能在中场僵持后，于 55—75 分钟出现决定性空间",
    confidence: Math.round(clamp(58 + Math.abs(difference) / 9 + ((home.consistency || 70) + (away.consistency || 70) - 140) * 0.15 + (fixture.weather?.impact?.confidence || 0), 55, 88))
  };
}

function buildTeamPlan(team, opponent, isHome) {
  const formation = suggestedFormation(team, opponent);
  const stronger = team.elo >= opponent.elo;
  const approach = stronger
    ? (team.control >= team.pace ? "主动控球，利用中场人数形成持续压迫" : "提高推进速度，以纵向冲击和前场反抢制造机会")
    : (team.defense >= team.attack ? "保持紧凑防线，压缩禁区前沿并等待反击" : "避免低位久守，以快速转换主动攻击对手身后");
  const goalRoutes = [];
  if (team.attack >= 80) goalRoutes.push("禁区前沿的连续配合与二次进攻");
  if ((team.pace || 70) >= 78) goalRoutes.push("边路速度和反击中的纵深跑动");
  if (team.control >= 78) goalRoutes.push("中场控球后向肋部输送最后一传");
  if (team.attack < 75 || goalRoutes.length < 2) goalRoutes.push("定位球、后点包抄和第二落点");
  return {
    teamId: team.id,
    formation,
    approach,
    lineupFramework: formationFramework(formation),
    goalRoutes: goalRoutes.slice(0, 3),
    defensiveFocus: opponent.pace >= opponent.control ? "限制对手身后冲刺，边后卫前压时保留保护人数" : "封锁中路传球线路，迫使对手转向低效率边路传中",
    pressing: team.form >= 82 ? "前 20 分钟可采用较积极的前场压迫" : "更适合中位防守，避免阵型被连续拉开",
    venueNote: isHome && team.abbr && ["MEX", "USA", "CAN"].includes(team.abbr) ? "具备东道主环境与场地适应优势" : "按中立场条件评估"
  };
}

function suggestedFormation(team, opponent) {
  if (team.defense >= 82 && team.attack < opponent.attack - 8) return "5-4-1";
  if (team.pace >= 84 && team.control < 78) return "3-4-2-1";
  if (team.control >= 84 && team.attack >= 80) return "4-3-3";
  if (team.defense >= 80 && team.control >= 76) return "4-2-3-1";
  return team.attack >= 76 ? "4-2-3-1" : "4-4-2";
}

function formationFramework(formation) {
  return ({
    "4-3-3": ["门将", "四后卫", "单后腰与双中前卫", "两名边锋", "中锋"],
    "4-2-3-1": ["门将", "四后卫", "双后腰", "前腰与双边锋", "单中锋"],
    "3-4-2-1": ["门将", "三中卫", "双翼卫与双中场", "双前腰", "单中锋"],
    "5-4-1": ["门将", "三中卫与双翼卫", "四人中场", "单前锋"],
    "4-4-2": ["门将", "四后卫", "平行四中场", "双前锋"]
  })[formation] || ["门将", "后卫线", "中场线", "锋线"];
}

function teamAvailabilityAdjustment(team) {
  const availability = team?.availability || {};
  return {
    ratingPenalty: Number(availability.ratingPenalty || 0),
    attackPenalty: Number(availability.attackPenalty || 0),
    defensePenalty: Number(availability.defensePenalty || 0),
    controlPenalty: Number(availability.controlPenalty || 0)
  };
}

function contextualRatingDifference(home, away, fixture = {}) {
  const venueBonus = fixture.venueMode === "home" ? 65 : 0;
  const homeAvailability = teamAvailabilityAdjustment(home);
  const awayAvailability = teamAvailabilityAdjustment(away);
  return (home.elo - homeAvailability.ratingPenalty) + venueBonus - (away.elo - awayAvailability.ratingPenalty);
}

function buildMatchContext(home, away, fixture = {}) {
  const weather = fixture.weather || { available: false, summary: "天气预报临近比赛更新", impact: weatherImpact(null) };
  return {
    weather,
    availability: {
      home: home.availability || { summary: "暂无官方伤病名单", unavailableCount: 0, ratingPenalty: 0, players: [] },
      away: away.availability || { summary: "暂无官方伤病名单", unavailableCount: 0, ratingPenalty: 0, players: [] }
    }
  };
}

function modelPredictedScore(home, away, venue, fixture = {}, calibration = predictionCalibration()) {
  const venueBonus = venue === "home" ? 65 : 0;
  const homeAvailability = teamAvailabilityAdjustment(home);
  const awayAvailability = teamAvailabilityAdjustment(away);
  const weather = fixture.weather?.impact || { xg: 0, draw: 0 };
  const effectiveHome = home.elo - homeAvailability.ratingPenalty + venueBonus + (home.form - 75) * 0.4;
  const effectiveAway = away.elo - awayAvailability.ratingPenalty + (away.form - 75) * 0.4;
  const difference = effectiveHome - effectiveAway;
  const eloHomeExpected = 1 / (1 + Math.pow(10, -difference / 400));
  const eloDraw = clamp(0.26 - Math.abs(difference) / 1800 + (weather.draw || 0) + (calibration.drawAdjustment || 0), 0.14, 0.38);
  const eloHomeWin = eloHomeExpected * (1 - eloDraw);
  const eloAwayWin = (1 - eloHomeExpected) * (1 - eloDraw);
  const baseHomeXg = clamp(1.28 + (home.attack - homeAvailability.attackPenalty - (away.defense - awayAvailability.defensePenalty)) / 38 + difference / 650 + (venue === "home" ? 0.12 : 0) + weather.xg, 0.3, 3.6);
  const baseAwayXg = clamp(1.12 + (away.attack - awayAvailability.attackPenalty - (home.defense - homeAvailability.defensePenalty)) / 38 - difference / 720 + weather.xg, 0.3, 3.6);
  const adjustedGoals = calibratedExpectedGoals(baseHomeXg, baseAwayXg, difference, fixture, calibration);
  const homeXg = adjustedGoals.home;
  const awayXg = adjustedGoals.away;
  const matrix = [];
  let poissonHome = 0;
  let poissonDraw = 0;
  let poissonAway = 0;
  for (let homeGoals = 0; homeGoals <= 5; homeGoals += 1) {
    matrix[homeGoals] = [];
    for (let awayGoals = 0; awayGoals <= 5; awayGoals += 1) {
      const probability = poisson(homeXg, homeGoals) * poisson(awayXg, awayGoals);
      matrix[homeGoals][awayGoals] = probability;
      if (homeGoals > awayGoals) poissonHome += probability;
      else if (homeGoals === awayGoals) poissonDraw += probability;
      else poissonAway += probability;
    }
  }
  const covered = poissonHome + poissonDraw + poissonAway;
  poissonHome /= covered;
  poissonDraw /= covered;
  poissonAway /= covered;
  const probabilities = {
    homeWin: eloHomeWin * 0.58 + poissonHome * 0.42,
    draw: eloDraw * 0.58 + poissonDraw * 0.42,
    awayWin: eloAwayWin * 0.58 + poissonAway * 0.42
  };
  const favoriteRisk = clamp(calibration.favoriteRisk || 0, 0, 0.32);
  if (favoriteRisk && Math.abs(difference) > 220) {
    const riskShare = clamp(favoriteRisk * 0.16, 0, 0.055);
    if (difference > 0) {
      probabilities.homeWin = clamp(probabilities.homeWin - riskShare, 0.02, 0.94);
      probabilities.draw += riskShare * 0.58;
      probabilities.awayWin += riskShare * 0.42;
    } else {
      probabilities.awayWin = clamp(probabilities.awayWin - riskShare, 0.02, 0.94);
      probabilities.draw += riskShare * 0.58;
      probabilities.homeWin += riskShare * 0.42;
    }
    const total = probabilities.homeWin + probabilities.draw + probabilities.awayWin;
    probabilities.homeWin /= total;
    probabilities.draw /= total;
    probabilities.awayWin /= total;
  }
  const drawRisk = clamp(calibration.drawRisk || 0, -0.12, 0.18);
  if (drawRisk && Math.abs(difference) < 260) {
    const drawShare = clamp(drawRisk * 0.22, -0.025, 0.055);
    probabilities.draw = clamp(probabilities.draw + drawShare, 0.08, 0.46);
    const nonDraw = probabilities.homeWin + probabilities.awayWin;
    const remaining = 1 - probabilities.draw;
    probabilities.homeWin = remaining * (probabilities.homeWin / nonDraw);
    probabilities.awayWin = remaining * (probabilities.awayWin / nonDraw);
  }
  const resistanceDraw = clamp(calibration.resistanceDraw || 0, 0, 0.24);
  if (resistanceDraw && Math.abs(difference) >= 160) {
    const drawShare = clamp(resistanceDraw * (Math.abs(difference) >= 260 ? 0.16 : 0.23), 0, 0.045);
    probabilities.draw = clamp(probabilities.draw + drawShare, 0.08, 0.44);
    if (difference >= 0) probabilities.homeWin = clamp(probabilities.homeWin - drawShare, 0.02, 0.94);
    else probabilities.awayWin = clamp(probabilities.awayWin - drawShare, 0.02, 0.94);
    const total = probabilities.homeWin + probabilities.draw + probabilities.awayWin;
    probabilities.homeWin /= total;
    probabilities.draw /= total;
    probabilities.awayWin /= total;
  }
  const sideBias = clamp(calibration.sideBias || 0, -0.16, 0.16);
  if (sideBias) {
    const sideShift = clamp(sideBias * 0.09, -0.018, 0.018);
    probabilities.homeWin = clamp(probabilities.homeWin + sideShift, 0.02, 0.94);
    probabilities.awayWin = clamp(probabilities.awayWin - sideShift, 0.02, 0.94);
    const total = probabilities.homeWin + probabilities.draw + probabilities.awayWin;
    probabilities.homeWin /= total;
    probabilities.draw /= total;
    probabilities.awayWin /= total;
  }
  const calibratedProbabilities = calibrateOutcomeProbabilities(probabilities, {
    ratingDifference: difference,
    xg: { home: homeXg, away: awayXg },
    calibration
  });
  probabilities.homeWin = calibratedProbabilities.homeWin;
  probabilities.draw = calibratedProbabilities.draw;
  probabilities.awayWin = calibratedProbabilities.awayWin;
  const best = selectCalibratedScore(matrix, homeXg, awayXg, probabilities, calibration);
  const distribution = normalizedScoreDistribution(matrix, covered);
  const probabilityByScore = scoreProbabilityMap(distribution);
  const scoreCandidates = (best.candidates || [best]).slice(0, 5).map((candidate) => ({
    home: candidate.home,
    away: candidate.away,
    probability: roundedProbability(probabilityByScore.get(scoreKey(candidate.home, candidate.away)) ?? 0),
    utility: Number(Number(candidate.utility || 0).toFixed(6))
  }));
  const totalGoals = totalGoalProbabilities(distribution, homeXg, awayXg);
  const probabilitySnapshot = {
    homeWin: roundedProbability(probabilities.homeWin),
    draw: roundedProbability(probabilities.draw),
    awayWin: roundedProbability(probabilities.awayWin)
  };
  return {
    modelVersion: RATING_MODEL_VERSION,
    home: best.home,
    away: best.away,
    createdAt: new Date().toISOString(),
    regularTimeOnly: true,
    homeWin: probabilitySnapshot.homeWin,
    draw: probabilitySnapshot.draw,
    awayWin: probabilitySnapshot.awayWin,
    probabilities: probabilitySnapshot,
    firstScore: { home: best.home, away: best.away, probability: roundedProbability(probabilityByScore.get(scoreKey(best.home, best.away)) ?? 0) },
    scoreCandidates,
    scoreDistribution: distribution,
    xg: { home: Number(homeXg.toFixed(2)), away: Number(awayXg.toFixed(2)) },
    totalGoals,
    bothTeamsScore: totalGoals.bothTeamsScore,
    advance: knockoutAdvanceProbabilities(probabilitySnapshot, difference, fixture),
    calibration: { ...calibration, totalLift: adjustedGoals.totalLift }
  };
}

function poisson(lambda, goals) {
  let factorial = 1;
  for (let value = 2; value <= goals; value += 1) factorial *= value;
  return Math.exp(-lambda) * Math.pow(lambda, goals) / factorial;
}

function marginMultiplier(diff) {
  if (diff <= 1) return 1;
  return Math.min(2.5, Math.log(diff + 1) * 1.3);
}

function matchRatingK(fixture) {
  const name = fixture?.stageName || "";
  if (/决赛|final/i.test(name)) return 44;
  if (/半决赛|semifinal/i.test(name)) return 40;
  if (/1\/4|16|32|knockout|强/i.test(name)) return 38;
  return 34;
}

function expectedScore(home, away, venueMode = "neutral", fixture = {}) {
  const homeAdvantage = venueMode === "home" ? 55 : 0;
  const homeAvailability = teamAvailabilityAdjustment(home);
  const awayAvailability = teamAvailabilityAdjustment(away);
  return 1 / (1 + Math.pow(10, -(((home.elo - homeAvailability.ratingPenalty) + homeAdvantage) - (away.elo - awayAvailability.ratingPenalty)) / 400));
}

function expectedGoals(home, away, venueMode = "neutral", fixture = {}, calibration = predictionCalibration()) {
  const homeAdvantage = venueMode === "home" ? 55 : 0;
  const homeAvailability = teamAvailabilityAdjustment(home);
  const awayAvailability = teamAvailabilityAdjustment(away);
  const weather = fixture.weather?.impact || { xg: 0 };
  const difference = (home.elo - homeAvailability.ratingPenalty) + homeAdvantage - (away.elo - awayAvailability.ratingPenalty);
  const baseHome = clamp(1.25 + (home.attack - homeAvailability.attackPenalty - (away.defense - awayAvailability.defensePenalty)) / 44 + difference / 700 + (venueMode === "home" ? 0.12 : 0) + weather.xg, 0.25, 3.6);
  const baseAway = clamp(1.10 + (away.attack - awayAvailability.attackPenalty - (home.defense - homeAvailability.defensePenalty)) / 44 - difference / 760 + weather.xg, 0.25, 3.6);
  return calibratedExpectedGoals(baseHome, baseAway, difference, fixture, calibration);
}

function teamRatingDelta({ actual, expected, goalsFor, goalsAgainst, expectedFor, expectedAgainst, k }) {
  const resultDelta = k * 0.82 * (actual - expected);
  const scoringDelta = clamp((goalsFor - expectedFor) * 2.8, -7, 8);
  const defenseDelta = clamp((expectedAgainst - goalsAgainst) * 2.2, -7, 7);
  const marginDelta = clamp(((goalsFor - goalsAgainst) - (expectedFor - expectedAgainst)) * 1.9, -8, 8);
  let total = Math.round(resultDelta + scoringDelta + defenseDelta + marginDelta);

  if (actual === 1 && actual > expected && total < 1) total = 1;
  if (actual === 0 && actual < expected && total > -1) total = -1;
  if (actual === 0.5 && expected >= 0.58 && total > -1) total = -1;
  if (actual === 0.5 && expected <= 0.42 && total < 1) total = 1;

  return {
    delta: total,
    components: {
      result: Number(resultDelta.toFixed(1)),
      scoring: Number(scoringDelta.toFixed(1)),
      defense: Number(defenseDelta.toFixed(1)),
      margin: Number(marginDelta.toFixed(1))
    }
  };
}

function objectiveRatingUpdate(home, away, fixture, calibration = predictionCalibration()) {
  const expectedHome = expectedScore(home, away, fixture.venueMode, fixture);
  const expectedAway = 1 - expectedHome;
  const actualHome = fixture.homeScore > fixture.awayScore ? 1 : fixture.homeScore < fixture.awayScore ? 0 : 0.5;
  const actualAway = 1 - actualHome;
  const goals = expectedGoals(home, away, fixture.venueMode, fixture, calibration);
  const k = matchRatingK(fixture);
  const homeUpdate = teamRatingDelta({
    actual: actualHome,
    expected: expectedHome,
    goalsFor: fixture.homeScore,
    goalsAgainst: fixture.awayScore,
    expectedFor: goals.home,
    expectedAgainst: goals.away,
    k
  });
  const awayUpdate = teamRatingDelta({
    actual: actualAway,
    expected: expectedAway,
    goalsFor: fixture.awayScore,
    goalsAgainst: fixture.homeScore,
    expectedFor: goals.away,
    expectedAgainst: goals.home,
    k
  });
  return {
    model: RATING_MODEL_VERSION,
    expectedHome: Number(expectedHome.toFixed(3)),
    expectedAway: Number(expectedAway.toFixed(3)),
    expectedGoalsHome: Number(goals.home.toFixed(2)),
    expectedGoalsAway: Number(goals.away.toFixed(2)),
    actualHome,
    actualAway,
    k,
    homeDelta: homeUpdate.delta,
    awayDelta: awayUpdate.delta,
    homeComponents: homeUpdate.components,
    awayComponents: awayUpdate.components
  };
}

function performanceSignal(actual, expected) {
  return clamp(50 + (actual - expected) * 90 + (actual - 0.5) * 20, 0, 100);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isRealTeam(team) {
  return Boolean(team && team.isActive && team.logo && /^[A-Z]{3}$/.test(team.abbreviation));
}

function parseRatings(tsv) {
  const ratings = new Map();
  for (const line of tsv.trim().split(/\r?\n/)) {
    const cells = line.split("\t");
    if (cells.length < 4) continue;
    const rating = Number(cells[3]);
    const trend = Number(String(cells[11] || "0").replace("−", "-"));
    if (cells[2] && Number.isFinite(rating)) ratings.set(cells[2], { rating, trend: Number.isFinite(trend) ? trend : 0 });
  }
  return ratings;
}

function fixtureTeam(competitor) {
  const team = competitor?.team || {};
  const real = isRealTeam(team);
  return {
    id: real ? team.abbreviation.toLowerCase() : null,
    abbr: team.abbreviation || "TBD",
    name: real ? (chineseNames[team.abbreviation] || team.displayName) : translatePlaceholder(team.displayName),
    nameEn: team.displayName || "TBD",
    logo: team.logo || "",
    score: Number(competitor?.score || 0),
    winner: Boolean(competitor?.winner),
    real
  };
}

function translatePlaceholder(name = "待定") {
  return name
    .replace(/Group ([A-L]) Winner/i, "$1 组第 1 名")
    .replace(/Group ([A-L]) 2nd Place/i, "$1 组第 2 名")
    .replace(/Round of 32 (\d+) Winner/i, "32 强赛第 $1 场胜者")
    .replace(/Round of 16 (\d+) Winner/i, "16 强赛第 $1 场胜者")
    .replace(/Quarterfinal (\d+) Winner/i, "1/4 决赛第 $1 场胜者")
    .replace(/Semifinal (\d+) Winner/i, "半决赛第 $1 场胜者")
    .replace(/Semifinal (\d+) Loser/i, "半决赛第 $1 场负者")
    .replace(/Third Place Group/i, "小组第三名")
    .replace("at", "对阵");
}

function transformFixtures(events) {
  return events.map((event) => {
    const competition = event.competitions?.[0] || {};
    const competitors = competition.competitors || [];
    const home = fixtureTeam(competitors.find((item) => item.homeAway === "home"));
    const away = fixtureTeam(competitors.find((item) => item.homeAway === "away"));
    const state = event.status?.type?.state || "pre";
    const stageSlug = event.season?.slug || "group-stage";
    return {
      id: event.id,
      date: event.date,
      home: home.id,
      away: away.id,
      homeTeam: home,
      awayTeam: away,
      homeScore: home.score,
      awayScore: away.score,
      winnerSide: home.winner ? "home" : away.winner ? "away" : null,
      status: state,
      completed: Boolean(event.status?.type?.completed),
      statusText: state === "in" ? (event.status?.type?.shortDetail || "进行中") : state === "post" ? "已结束" : "未开赛",
      clock: event.status?.displayClock || "",
      stage: stageSlug === "group-stage" ? "group" : "knockout",
      stageName: stageNames[stageSlug] || stageSlug,
      venue: competition.venue?.fullName || "场地待定",
      city: competition.venue?.address?.city || "",
      venueMode: ["MEX", "USA", "CAN"].includes(home.abbr) ? "home" : "neutral"
    };
  }).sort((a, b) => new Date(a.date) - new Date(b.date));
}

function buildTeams(events, fixtures, ratings) {
  const sourceTeams = new Map();
  for (const event of events) {
    for (const competitor of event.competitions?.[0]?.competitors || []) {
      const team = competitor.team;
      if (isRealTeam(team)) sourceTeams.set(team.abbreviation, team);
    }
  }

  const stats = new Map();
  for (const abbr of sourceTeams.keys()) stats.set(abbr.toLowerCase(), { matches: 0, points: 0, gf: 0, ga: 0, results: [] });
  for (const fixture of fixtures.filter((item) => item.completed && item.home && item.away)) {
    const home = stats.get(fixture.home);
    const away = stats.get(fixture.away);
    if (!home || !away) continue;
    home.matches += 1; away.matches += 1;
    home.gf += fixture.homeScore; home.ga += fixture.awayScore;
    away.gf += fixture.awayScore; away.ga += fixture.homeScore;
    if (fixture.homeScore > fixture.awayScore) { home.points += 3; home.results.push("W"); away.results.push("L"); }
    else if (fixture.homeScore < fixture.awayScore) { away.points += 3; away.results.push("W"); home.results.push("L"); }
    else { home.points += 1; away.points += 1; home.results.push("D"); away.results.push("D"); }
  }

  return [...sourceTeams.entries()].map(([abbr, team]) => {
    const ratingInfo = ratings.get(eloCodes[abbr]) || { rating: 1500, trend: 0 };
    const record = stats.get(abbr.toLowerCase());
    const base = clamp(55 + (ratingInfo.rating - 1500) / 12, 48, 96);
    const form = record.matches
      ? clamp(54 + (record.points / (record.matches * 3)) * 38 + ((record.gf - record.ga) / record.matches) * 3, 45, 98)
      : clamp(70 + (ratingInfo.rating - 1700) / 18, 58, 91);
    const attack = record.matches ? clamp(base * 0.72 + (record.gf / record.matches) * 13, 45, 98) : base;
    const defense = record.matches ? clamp(base * 0.82 + (2 - record.ga / record.matches) * 8, 45, 98) : clamp(base - 1, 45, 96);
    const seed = abbr.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0);
    return {
      id: abbr.toLowerCase(), abbr, name: chineseNames[abbr] || team.displayName, nameEn: team.displayName,
      providerId: team.id, logo: team.logo, elo: ratingInfo.rating, externalTrend: ratingInfo.trend, trend: 0, form: Math.round(form),
      attack: Math.round(attack), defense: Math.round(defense), pace: Math.round(clamp(base + (seed % 9) - 4, 48, 96)),
      control: Math.round(clamp(base + (seed % 7) - 3, 48, 96)), matches: record.matches,
      record: record.results.slice(-5).join("") || "-"
    };
  }).sort((a, b) => b.elo - a.elo);
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { "user-agent": "GoalMind World Cup Lab/2.0", accept: "application/json,text/plain,*/*" } });
  if (!response.ok) throw new Error(`${url} 返回 ${response.status}`);
  return response.text();
}

async function getMatchDetail(eventId) {
  if (!/^\d+$/.test(String(eventId || ""))) throw new Error("无效的比赛编号");
  const existing = matchDetailCache.get(String(eventId));
  if (existing && Date.now() - existing.cachedAt < MATCH_DETAIL_TTL) return existing.data;
  const text = await fetchText(`https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary?event=${eventId}`);
  const raw = JSON.parse(text);
  const data = transformMatchDetail(raw, String(eventId));
  matchDetailCache.set(String(eventId), { cachedAt: Date.now(), data });
  return data;
}

async function fetchTeamProfileForTeam(team, normalizedId = team?.id) {
  const text = await fetchText(`https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/teams/${team.providerId}/roster?season=2026`);
  const raw = JSON.parse(text);
  const positionOrder = { G: 0, GK: 0, D: 1, DF: 1, M: 2, MF: 2, F: 3, FW: 3 };
  const squad = (raw.athletes || []).map((athlete) => {
    const status = normalizePlayerStatus(athlete);
    return {
      id: athlete.id || "",
      name: athlete.displayName || athlete.fullName || athlete.shortName || "",
      shortName: athlete.shortName || athlete.displayName || "",
      jersey: athlete.jersey || "",
      position: athlete.position?.abbreviation || "",
      positionName: athlete.position?.displayName || athlete.position?.name || "",
      age: Number(athlete.age || 0),
      active: !status.unavailable,
      unavailable: status.unavailable,
      injuryLike: status.injuryLike,
      statusType: status.type,
      statusLabel: status.label
    };
  }).filter((athlete) => athlete.name).sort((a, b) => {
    const positionDifference = (positionOrder[a.position] ?? 9) - (positionOrder[b.position] ?? 9);
    if (positionDifference) return positionDifference;
    return Number(a.jersey || 99) - Number(b.jersey || 99);
  });
  const staff = (raw.coach || []).map((coach) => ({
    id: coach.id || "",
    name: [coach.firstName, coach.lastName].filter(Boolean).join(" "),
    role: "教练组登记"
  })).filter((member) => member.name);
  const profile = {
    teamId: normalizedId,
    providerId: String(team.providerId),
    fetchedAt: raw.timestamp || new Date().toISOString(),
    season: raw.season?.displayName || "2026 FIFA World Cup",
    source: "ESPN FIFA World Cup squad",
    squad,
    staff
  };
  return profile;
}

async function getTeamProfile(teamId) {
  const normalizedId = String(teamId || "").trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(normalizedId)) throw new Error("无效的球队编号");
  const existing = teamProfileCache.get(normalizedId);
  if (existing && Date.now() - existing.cachedAt < TEAM_PROFILE_TTL) return existing.data;

  let data = await getData(false);
  let team = data.teams?.find((item) => item.id === normalizedId);
  if (!team?.providerId) {
    data = await refreshData();
    team = data.teams?.find((item) => item.id === normalizedId);
  }
  if (!team?.providerId) throw new Error("未找到球队数据源编号");

  const profile = await fetchTeamProfileForTeam(team, normalizedId);
  teamProfileCache.set(normalizedId, { cachedAt: Date.now(), data: profile });
  return profile;
}

function transformMatchDetail(raw, eventId) {
  const competition = raw.header?.competitions?.[0] || {};
  const rosters = (raw.rosters || []).map((roster) => ({
    side: roster.homeAway,
    abbr: roster.team?.abbreviation || "",
    name: roster.team?.displayName || "",
    formation: roster.formation || "",
    lineupOfficial: Array.isArray(roster.roster) && roster.roster.some((entry) => entry.starter),
    starters: (roster.roster || []).filter((entry) => entry.starter).map(transformAthlete),
    substitutes: (roster.roster || []).filter((entry) => !entry.starter && entry.active).map(transformAthlete)
  }));
  const statistics = (raw.boxscore?.teams || []).map((entry) => ({
    side: entry.homeAway,
    abbr: entry.team?.abbreviation || "",
    values: Object.fromEntries((entry.statistics || []).map((stat) => [stat.name, numberValue(stat)]))
  }));
  const events = (competition.details || []).map((event) => ({
    minute: event.clock?.displayValue || "",
    teamAbbr: event.team?.abbreviation || "",
    type: event.scoringPlay ? "goal" : event.redCard ? "red-card" : "event",
    scorer: event.participants?.[0]?.athlete?.displayName || "",
    assist: event.scoringPlay ? event.participants?.[1]?.athlete?.displayName || "" : "",
    penalty: Boolean(event.penaltyKick),
    ownGoal: Boolean(event.ownGoal)
  }));
  return {
    eventId,
    fetchedAt: new Date().toISOString(),
    status: competition.status?.type?.state || raw.header?.competitions?.[0]?.status?.type?.state || "pre",
    venue: raw.gameInfo?.venue?.fullName || competition.venue?.fullName || "",
    attendance: Number(raw.gameInfo?.attendance || 0),
    rosters,
    statistics,
    events
  };
}

function transformAthlete(entry) {
  const status = normalizePlayerStatus({ ...(entry.athlete || {}), status: entry.athlete?.status || entry.status });
  return {
    id: entry.athlete?.id || "",
    name: entry.athlete?.displayName || entry.athlete?.shortName || "",
    shortName: entry.athlete?.shortName || entry.athlete?.displayName || "",
    jersey: entry.jersey || "",
    position: entry.position?.abbreviation || entry.position?.displayName || "",
    active: !status.unavailable,
    unavailable: status.unavailable,
    statusLabel: status.label,
    injuryLike: status.injuryLike,
    formationPlace: entry.formationPlace || "",
    subbedIn: Boolean(entry.subbedIn),
    subbedOut: Boolean(entry.subbedOut),
    stats: Object.fromEntries((entry.stats || []).map((stat) => [stat.name, numberValue(stat)]))
  };
}

function numberValue(stat) {
  const value = Number(stat.value ?? stat.displayValue);
  return Number.isFinite(value) ? value : stat.displayValue || "";
}

function buildAdviceSnapshot(data, fixture, home, away) {
  return {
    fixture: {
      id: fixture.id,
      date: fixture.date,
      stageName: fixture.stageName,
      venue: fixture.venue,
      venueMode: fixture.venueMode,
      status: fixture.status,
      score: fixture.completed ? `${fixture.homeScore}:${fixture.awayScore}` : null
    },
    teams: {
      home: {
        id: home.id,
        name: home.name,
        elo: home.elo,
        form: home.form,
        attack: home.attack,
        defense: home.defense,
        trend: home.trend,
        availability: home.availability?.summary || "暂无官方伤病名单"
      },
      away: {
        id: away.id,
        name: away.name,
        elo: away.elo,
        form: away.form,
        attack: away.attack,
        defense: away.defense,
        trend: away.trend,
        availability: away.availability?.summary || "暂无官方伤病名单"
      }
    },
    prediction: fixture.modelPrediction || null,
    calibration: fixture.predictionCalibration || fixture.modelPrediction?.calibration || data.predictionCalibration || predictionCalibration(data.fixtures),
    audit: data.predictionAudit || predictionAudit(data.fixtures),
    weather: fixture.weather || null,
    preMatchAnalysis: fixture.preMatchAnalysis || null
  };
}

function deterministicAiAdvice(snapshot) {
  const home = snapshot.teams.home;
  const away = snapshot.teams.away;
  const prediction = snapshot.prediction || { home: 0, away: 0 };
  const calibration = snapshot.calibration || {};
  const audit = snapshot.audit || {};
  const pre = snapshot.preMatchAnalysis || {};
  const weatherNotes = snapshot.weather?.impact?.notes?.join("；") || "天气暂无强修正";
  const injuryText = `${home.name}: ${home.availability}；${away.name}: ${away.availability}`;
  const edge = home.elo - away.elo + (snapshot.fixture.venueMode === "home" ? 55 : 0);
  const edgeText = edge > 120 ? `${home.name}纸面优势更明显` : edge < -120 ? `${away.name}纸面优势更明显` : "两队赛前战力接近";
  const expected = pre.expected || {};
  const expectedStats = Number.isFinite(expected.possessionHome)
    ? `预估控球 ${expected.possessionHome}%:${expected.possessionAway}%，射门 ${expected.shotsHome}:${expected.shotsAway}，角球 ${expected.cornersHome}:${expected.cornersAway}`
    : "预估技术统计尚未完整生成";
  const homePlan = pre.home || {};
  const awayPlan = pre.away || {};
  const routeText = `${home.name}预计 ${homePlan.formation || "待定阵型"}，重点路径为 ${(homePlan.goalRoutes || []).slice(0, 2).join("、") || "中路推进与定位球"}；${away.name}预计 ${awayPlan.formation || "待定阵型"}，重点路径为 ${(awayPlan.goalRoutes || []).slice(0, 2).join("、") || "转换进攻与第二落点"}。`;
  const tacticalLine = edge > 180
    ? `${home.name}需要把实力优势转化为禁区内机会，避免只形成外围控球。`
    : edge < -180
      ? `${away.name}纸面优势更明显，${home.name}的关键是压缩中路并提高反击第一脚质量。`
      : "双方差距不大，比赛更可能由转换质量、定位球和首个进球后的节奏选择决定。";
  return {
    available: false,
    provider: "goalmind-local-review",
    reason: "未配置 OPENAI_API_KEY，已使用本地模型复核。",
    generatedAt: new Date().toISOString(),
    summary: `${home.name} vs ${away.name} 当前预测 ${prediction.home}:${prediction.away}。${tacticalLine}`,
    checks: [
      `数据基准：${edgeText}，但当前模型会同时查看攻防分项、近期状态、主客/中立场和赛后校准，不会只按世界排名或 Elo 排名下结论。${expectedStats}。`,
      `战术对位：${routeText}复核重点是控球能否进入禁区前沿，而不是控球率本身；若优势方只在外围传导，实际威胁会低于比分模型。`,
      `节奏窗口：${pre.scoringWindow || "首个进球和上下半场前 15 分钟会显著改变比赛结构"}。如果弱势方能在前段守住中路并减少定位球犯规，平局和小比分权重需要上调。`,
      `天气变量：${weatherNotes}。天气只作为修正项，主要影响传中质量、长传落点、冲刺频率和体能下滑速度。`,
      `人员变量：${injuryText}。首发公布后要优先复查中场人数、边路速度、替补席进攻深度和关键后卫缺席对防线高度的影响。`,
      `模型风险：校准样本 ${calibration.samples || 0} 场，赛果命中 ${Math.round(Number(audit.outcomeRate || 0) * 100)}%，总进球低估率 ${Math.round(Number(audit.underRate || 0) * 100)}%，高比分压力 ${Math.round(Number(calibration.highScorePressure || 0) * 100)}%，平局风险 ${Math.round(Number(calibration.drawRisk || 0) * 100)}%，强弱差守成平局 ${Math.round(Number(calibration.resistanceDraw || 0) * 100)}%，强弱差冷门风险 ${Math.round(Number(calibration.favoriteRisk || 0) * 100)}%。当前已启用弱势方进球回拨 ${calibration.underdogLift ?? "--"}、强队大胜释放 ${calibration.favoriteSurge ?? "--"}、高比分压力 ${calibration.highScorePressure ?? "--"}、低比分惩罚 ${calibration.lowTotalPressure ?? "--"}、开放平局谨慎 ${calibration.drawCaution ?? "--"} 与守成平局修正 ${calibration.resistanceDraw ?? "--"}，避免过早给出大热门碾压、虚假平局或低比分保守结论。`
    ],
    source: "GoalMind deterministic advisor"
  };
}

function extractOpenAiText(payload) {
  if (payload?.output_text) return payload.output_text;
  const chunks = [];
  for (const item of payload?.output || []) {
    for (const content of item.content || []) {
      if (content.text) chunks.push(content.text);
      else if (content.type === "output_text" && content.value) chunks.push(content.value);
    }
  }
  return chunks.join("\n").trim();
}

async function callOpenAiAdvice(snapshot) {
  const apiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY;
  if (!apiKey) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        input: [
          {
            role: "system",
            content: "你是客观的足球赛前情报复核助手。只基于用户给出的结构化数据做判断，不编造首发、伤病或实时新闻。输出中文。请从数据基准、战术对位、节奏窗口、天气、人员、模型风险六个角度给出可执行判断，避免情绪化措辞。"
          },
          {
            role: "user",
            content: `请深度复核这场世界杯比赛预测，输出 1 段总判断和 4-6 条高价值修正意见；每条都必须说明“为什么这会影响预测”：\n${JSON.stringify(snapshot)}`
          }
        ]
      })
    });
    if (!response.ok) throw new Error(`OpenAI ${response.status}`);
    const payload = await response.json();
    const text = extractOpenAiText(payload);
    return {
      available: true,
      provider: "openai",
      generatedAt: new Date().toISOString(),
      summary: text || "AI 复核暂未返回有效文本。",
      checks: [],
      source: "OpenAI Responses API"
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function getAiMatchAdvice(eventId) {
  const id = String(eventId || "");
  if (!id) throw new Error("无效的比赛编号");
  const cached = aiAdviceCache.get(id);
  if (cached && Date.now() - cached.cachedAt < AI_ADVICE_TTL) return cached.data;

  const data = await getData(false);
  const fixture = data.fixtures.find((item) => String(item.id) === id);
  if (!fixture?.home || !fixture?.away) throw new Error("该场比赛双方尚未确定");
  const home = data.teams.find((team) => team.id === fixture.home);
  const away = data.teams.find((team) => team.id === fixture.away);
  if (!home || !away) throw new Error("未找到球队数据");

  const snapshot = buildAdviceSnapshot(data, fixture, home, away);
  const fallback = deterministicAiAdvice(snapshot);
  let advice = fallback;
  try {
    advice = await callOpenAiAdvice(snapshot) || fallback;
  } catch (error) {
    advice = { ...fallback, aiError: error.message, reason: `OpenAI 复核不可用，已回退本地模型：${error.message}` };
  }
  aiAdviceCache.set(id, { cachedAt: Date.now(), data: advice });
  return advice;
}

async function refreshData() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const [espnText, ratingsText] = await Promise.all([fetchText(ESPN_URL), fetchText(ELO_URL)]);
      const espn = JSON.parse(espnText);
      const fixtures = transformFixtures(espn.events || []);
      const baseTeams = buildTeams(espn.events || [], fixtures, parseRatings(ratingsText));
      await Promise.all([attachWeatherToFixtures(fixtures), attachAvailabilityToTeams(baseTeams)]);
      const teams = applyHistoricalModel(baseTeams, fixtures);
      const currentFixtures = currentModelFixtureView(fixtures);
      const calibration = predictionCalibration(currentFixtures);
      const audit = predictionAudit(currentFixtures);
      const lockedAudit = predictionAudit(fixtures);
      const probabilityEvaluation = buildProbabilityEvaluation(currentFixtures, teams);
      const lockedProbabilityEvaluation = buildProbabilityEvaluation(fixtures, teams);
      cache = {
        fetchedAt: new Date().toISOString(), stale: false, teams, fixtures,
        predictionCalibration: calibration,
        predictionAudit: audit,
        lockedPredictionAudit: lockedAudit,
        probabilityEvaluation: probabilityEvaluation.model,
        predictionBaselines: probabilityEvaluation.baselines,
        lockedProbabilityEvaluation: lockedProbabilityEvaluation.model,
        modelVersion: RATING_MODEL_VERSION,
        historySummary: { periodStart: history.periodStart, periodEnd: history.periodEnd, uniqueMatches: history.uniqueMatches },
        source: { matches: "ESPN FIFA World Cup", ratings: "GoalMind dynamic power rating v3" }
      };
      await fs.promises.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8").catch(() => {});
      return cache;
    } catch (error) {
      if (cache) return normalizeCachedPayload(cache, error.message);
      throw error;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

async function getData(force) {
  const age = cache ? Date.now() - new Date(cache.fetchedAt).getTime() : Infinity;
  if (!force && cache && cache.modelVersion === RATING_MODEL_VERSION && age < CACHE_TTL) return cache;
  return refreshData();
}

function contentType(filePath) {
  return ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".md": "text/markdown; charset=utf-8" })[path.extname(filePath)] || "application/octet-stream";
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (requestUrl.pathname === "/api/world-cup") {
    try {
      const data = await getData(requestUrl.searchParams.get("force") === "1");
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(data));
    } catch (error) {
      res.writeHead(503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "赛事数据暂时不可用", detail: error.message }));
    }
    return;
  }

  if (requestUrl.pathname === "/api/match-detail") {
    try {
      const data = await getMatchDetail(requestUrl.searchParams.get("id"));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(data));
    } catch (error) {
      res.writeHead(503, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "比赛详情暂时不可用", detail: error.message }));
    }
    return;
  }

  if (requestUrl.pathname === "/api/team-profile") {
    try {
      const data = await getTeamProfile(requestUrl.searchParams.get("id"));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(data));
    } catch (error) {
      res.writeHead(503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "球队名单暂时不可用", detail: error.message }));
    }
    return;
  }

  if (requestUrl.pathname === "/api/ai-match-advice") {
    try {
      const data = await getAiMatchAdvice(requestUrl.searchParams.get("id"));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(data));
    } catch (error) {
      res.writeHead(503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ error: "AI 复核暂时不可用", detail: error.message }));
    }
    return;
  }

  const relative = requestUrl.pathname === "/" ? "index.html" : decodeURIComponent(requestUrl.pathname.slice(1));
  const filePath = path.resolve(ROOT, relative);
  const relation = path.relative(ROOT, filePath);
  if (relation.startsWith("..") || path.isAbsolute(relation) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "content-type": contentType(filePath), "cache-control": "no-cache" });
  fs.createReadStream(filePath).pipe(res);
});

function openBrowser(url) {
  if (process.env.GOALMIND_OPEN_BROWSER !== "1") return;
  const child = spawn("cmd.exe", ["/c", "start", "", url], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

function listen(port, remainingAttempts = 10) {
  const handleError = (error) => {
    if (error.code === "EADDRINUSE" && remainingAttempts > 0) {
      console.log(`端口 ${port} 已被占用，正在尝试 ${port + 1}...`);
      listen(port + 1, remainingAttempts - 1);
      return;
    }
    console.error("网站启动失败：", error.message);
    process.exitCode = 1;
  };

  server.once("error", handleError);
  server.listen(port, "127.0.0.1", () => {
    server.removeListener("error", handleError);
    const url = `http://127.0.0.1:${port}`;
    console.log("");
    console.log(`GoalMind 已启动：${url}`);
    console.log("请保持此窗口开启；关闭窗口后网站将停止。");
    console.log("");
    openBrowser(url);
    refreshData().catch((error) => console.error("首次同步失败：", error.message));
  });
}

if (require.main === module) listen(REQUESTED_PORT);

module.exports = {
  getData,
  getMatchDetail,
  getTeamProfile,
  getAiMatchAdvice,
  modelPredictedScore,
  predictionCalibration,
  objectiveRatingUpdate,
  performanceSignal,
  clamp
};
