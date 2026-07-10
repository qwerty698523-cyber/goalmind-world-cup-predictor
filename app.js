const minimalFallbackTeams = [
  { id: "arg", abbr: "ARG", name: "阿根廷", nameEn: "Argentina", logo: "https://a.espncdn.com/i/teamlogos/countries/500/arg.png", elo: 2115, form: 91, attack: 92, defense: 89, pace: 86, control: 91, trend: 0, record: "-" },
  { id: "esp", abbr: "ESP", name: "西班牙", nameEn: "Spain", logo: "https://a.espncdn.com/i/teamlogos/countries/500/esp.png", elo: 2157, form: 93, attack: 92, defense: 90, pace: 87, control: 94, trend: 0, record: "-" },
  { id: "fra", abbr: "FRA", name: "法国", nameEn: "France", logo: "https://a.espncdn.com/i/teamlogos/countries/500/fra.png", elo: 2048, form: 87, attack: 92, defense: 87, pace: 93, control: 87, trend: 0, record: "-" },
  { id: "bra", abbr: "BRA", name: "巴西", nameEn: "Brazil", logo: "https://a.espncdn.com/i/teamlogos/countries/500/bra.png", elo: 1998, form: 80, attack: 90, defense: 84, pace: 91, control: 89, trend: 0, record: "-" },
  { id: "mex", abbr: "MEX", name: "墨西哥", nameEn: "Mexico", logo: "https://a.espncdn.com/i/teamlogos/countries/500/mex.png", elo: 1785, form: 72, attack: 78, defense: 77, pace: 84, control: 81, trend: 0, record: "-" },
  { id: "rsa", abbr: "RSA", name: "南非", nameEn: "South Africa", logo: "https://a.espncdn.com/i/teamlogos/countries/500/rsa.png", elo: 1628, form: 70, attack: 70, defense: 73, pace: 82, control: 69, trend: 0, record: "-" }
];

const minimalFallbackFixtures = [
  { id: "fallback-1", date: "2026-06-11T19:00:00Z", home: "mex", away: "rsa", homeTeam: { id: "mex", name: "墨西哥", abbr: "MEX", logo: minimalFallbackTeams[4].logo, real: true }, awayTeam: { id: "rsa", name: "南非", abbr: "RSA", logo: minimalFallbackTeams[5].logo, real: true }, homeScore: 0, awayScore: 0, status: "pre", completed: false, statusText: "未开赛", stage: "group", stageName: "小组赛", venue: "Estadio Banorte", city: "Mexico City", venueMode: "home" }
];

const bundledFallback = window.GOALMIND_FALLBACK || { teams: minimalFallbackTeams, fixtures: minimalFallbackFixtures, fetchedAt: null, stale: true };
const historyBundle = window.GOALMIND_HISTORY || { periodStart: "2022-12-19", periodEnd: null, uniqueMatches: 0, teams: {} };
const RATING_MODEL_VERSION = "goalmind-dynamic-power-v4";

function applyHistoricalRatings(sourceTeams) {
  return sourceTeams.map((team) => {
    const model = historyBundle.teams?.[team.id];
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
      historyRecord: `${model.wins}-${model.draws}-${model.losses}`
    };
  }).sort((a, b) => b.elo - a.elo);
}

function bundledTeamsForDisplay(payload = bundledFallback) {
  const sourceTeams = structuredClone(payload.teams || []);
  const hasDynamicModel = payload.modelVersion === RATING_MODEL_VERSION
    && sourceTeams.some((team) => Number.isFinite(team.preTournamentElo) || Number.isFinite(team.lastMatchDelta) || Number(team.matches || 0) > 0);
  return hasDynamicModel
    ? sourceTeams.sort((a, b) => b.elo - a.elo)
    : applyHistoricalRatings(sourceTeams);
}

let teams = bundledTeamsForDisplay(bundledFallback);
let fixtures = structuredClone(bundledFallback.fixtures);
let sourceMeta = { ...bundledFallback, stale: true };
let liveReady = false;
let syncTimer = null;
let currentProfileRequest = 0;
const teamProfileStore = new Map();
const PREDICTION_STORAGE_KEY = "goalmind-prediction-snapshots-v2";
let storedPredictions = loadStoredPredictions();

const state = {
  homeId: "mex", awayId: "rsa", selectedFixtureId: bundledFallback.fixtures.find((item) => item.home === "mex" && item.away === "rsa")?.id || "fallback-1", venue: "home",
  k: 32, homeBonus: 65, formWeight: 0.4, currentFilter: "all"
};

const $ = (id) => document.getElementById(id);
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const teamById = (id) => teams.find((team) => team.id === id);
const pct = (n) => `${Math.round(n * 100)}%`;
const currentFixture = () => fixtures.find((fixture) => fixture.id === state.selectedFixtureId);
const ESPN_LIVE_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260611-20260719&limit=200";
const stageNames = {
  "group-stage": "小组赛", "round-of-32": "32 强赛", "round-of-16": "16 强赛",
  quarterfinals: "1/4 决赛", semifinals: "半决赛", "3rd-place-match": "季军赛", final: "决赛"
};

function poisson(lambda, goals) {
  let factorial = 1;
  for (let i = 2; i <= goals; i += 1) factorial *= i;
  return Math.exp(-lambda) * Math.pow(lambda, goals) / factorial;
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

function fixtureWeatherImpact(fixture) {
  return fixture?.weather?.impact || { xg: 0, draw: 0, tempo: 0, confidence: 0, notes: ["天气预报临近比赛更新"] };
}

function predictionCalibration(sourceFixtures = fixtures) {
  const completed = (sourceFixtures || []).filter((fixture) => (fixture.completed || fixture.status === "post") && fixture.home && fixture.away && fixture.modelPrediction);
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
    const prediction = fixture.currentModelPrediction || fixture.modelPrediction;
    const predictedTotal = Number(prediction.home || 0) + Number(prediction.away || 0);
    const actualTotal = Number(fixture.homeScore || 0) + Number(fixture.awayScore || 0);
    const predictedOutcome = scoreOutcomeValue(Number(prediction.home || 0), Number(prediction.away || 0));
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
    if (prediction.home === prediction.away) predictedDraws += 1;
    if (fixture.homeScore === fixture.awayScore) actualDraws += 1;
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

function predictionAudit(sourceFixtures = fixtures) {
  const completed = (sourceFixtures || []).filter((fixture) =>
    (fixture.completed || fixture.status === "post")
    && fixture.home
    && fixture.away
    && fixture.modelPrediction
  );
  if (!completed.length) {
    return { samples: 0, exactRate: 0, outcomeRate: 0, avgGoalBias: 0, underRate: 0, scoreMae: 0, recommendation: "等待更多完赛样本后开始审计预测偏差。" };
  }

  let exact = 0;
  let outcomeHits = 0;
  let close = 0;
  let predictedGoals = 0;
  let actualGoals = 0;
  let absoluteGoalError = 0;
  let under = 0;
  let over = 0;
  let predictedDraws = 0;
  let actualDraws = 0;
  let strongFavoriteFailures = 0;

  completed.forEach((fixture) => {
    const prediction = fixture.currentModelPrediction || fixture.modelPrediction;
    const predHome = Number(prediction.home || 0);
    const predAway = Number(prediction.away || 0);
    const actualHome = Number(fixture.homeScore || 0);
    const actualAway = Number(fixture.awayScore || 0);
    const predictedOutcome = scoreOutcomeValue(predHome, predAway);
    const actualOutcome = scoreOutcomeValue(actualHome, actualAway);
    if (predHome === actualHome && predAway === actualAway) exact += 1;
    if (predictedOutcome === actualOutcome) {
      outcomeHits += 1;
      if (predHome !== actualHome || predAway !== actualAway) close += 1;
    }
    predictedGoals += predHome + predAway;
    actualGoals += actualHome + actualAway;
    absoluteGoalError += Math.abs(predHome - actualHome) + Math.abs(predAway - actualAway);
    if (predHome + predAway < actualHome + actualAway) under += 1;
    if (predHome + predAway > actualHome + actualAway) over += 1;
    if (predictedOutcome === "draw") predictedDraws += 1;
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
  const drawGap = actualDraws / samples - predictedDraws / samples;
  const recommendation = avgGoalBias > 0.55 && under / samples > 0.55
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
    underRate: Number((under / samples).toFixed(3)),
    overRate: Number((over / samples).toFixed(3)),
    predictedDrawRate: Number((predictedDraws / samples).toFixed(3)),
    actualDrawRate: Number((actualDraws / samples).toFixed(3)),
    drawGap: Number(drawGap.toFixed(3)),
    scoreMae: Number((absoluteGoalError / samples / 2).toFixed(2)),
    strongFavoriteFailures,
    recommendation
  };
}

function calibratedExpectedGoals(homeXg, awayXg, difference, fixture, calibration = predictionCalibration()) {
  const weather = fixtureWeatherImpact(fixture);
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
  let selected = { home: 0, away: 0, probability: 0, utility: -Infinity };
  const ranked = [];
  for (let homeGoals = 0; homeGoals <= 5; homeGoals += 1) {
    for (let awayGoals = 0; awayGoals <= 5; awayGoals += 1) {
      const probability = matrix[homeGoals]?.[awayGoals] || 0;
      const outcome = scoreOutcomeValue(homeGoals, awayGoals);
      const total = homeGoals + awayGoals;
      const totalFit = Math.exp(-Math.abs(total - targetTotal) * 0.2);
      const xgFit = Math.exp(-(Math.abs(homeGoals - homeXg) + Math.abs(awayGoals - awayXg)) * 0.16);
      const outcomeFit = outcome === dominant
        ? 1.18
        : 0.86;
      const highScoreAggression = outcome !== "draw" ? highScorePressure * (decisiveEdge + goalEnvironment * 0.55) : 0;
      const aggression = 1 + Math.min(total, 6) * (0.035 + (calibration.conservativeIndex || 0) * 0.035 + highScoreAggression * 0.06);
      const belowTarget = Math.max(0, targetTotal - total - 0.75);
      const lowTotalPenalty = 1 - clamp(
        belowTarget * (0.1 + (calibration.lowTotalPressure || 0.12) + highScorePressure * 0.4 + highScoreAggression * 0.08),
        0,
        0.55
      );
      const openDrawPenalty = outcome === "draw" && targetTotal > 2.35
        ? 1 - clamp((targetTotal - 2.35) * (0.08 + (calibration.drawCaution || 0)), 0, 0.34)
        : 1;
      const utility = Math.pow(probability, 0.72) * totalFit * xgFit * outcomeFit * aggression * lowTotalPenalty * openDrawPenalty;
      ranked.push({ home: homeGoals, away: awayGoals, probability, utility });
      if (utility > selected.utility) selected = { home: homeGoals, away: awayGoals, probability, utility };
    }
  }
  ranked.sort((a, b) => b.utility - a.utility || b.probability - a.probability);
  return { ...(ranked[0] || selected), candidates: ranked.slice(0, 6) };
}

function roundProbability(value) {
  return Number(Number(value || 0).toFixed(4));
}

function normalizeOutcomeProbabilities(input = {}) {
  const raw = {
    homeWin: Number(input.homeWin ?? input.home ?? 0),
    draw: Number(input.draw ?? 0),
    awayWin: Number(input.awayWin ?? input.away ?? 0)
  };
  let total = raw.homeWin + raw.draw + raw.awayWin;
  if (!Number.isFinite(total) || total <= 0) {
    return { homeWin: 1 / 3, draw: 1 / 3, awayWin: 1 / 3 };
  }
  return {
    homeWin: raw.homeWin / total,
    draw: raw.draw / total,
    awayWin: raw.awayWin / total
  };
}

function calibrateConfidenceShape(probabilities = {}, calibration = {}, context = {}) {
  let { homeWin, draw, awayWin } = normalizeOutcomeProbabilities(probabilities);
  const samples = Number(calibration.samples || 0);
  if (samples < 10) return { homeWin, draw, awayWin };
  if (context.protectDrawCorrection) return { homeWin, draw, awayWin };
  const strongest = Math.max(homeWin, draw, awayWin);
  const exponent = strongest >= 0.7
    ? 0.75
    : strongest < 0.42
      ? 1.2
      : 1.5;
  return normalizeOutcomeProbabilities({
    homeWin: Math.pow(homeWin, exponent),
    draw: Math.pow(draw, exponent),
    awayWin: Math.pow(awayWin, exponent)
  });
}

function calibrateOutcomeProbabilities(probabilities = {}, context = {}) {
  let { homeWin, draw, awayWin } = normalizeOutcomeProbabilities(probabilities);
  const calibration = context.calibration || {};
  const samples = Number(calibration.samples || 0);
  const sampleWeight = clamp((samples - 4) / 50, 0, 0.35);
  const ratingDifference = Math.abs(Number(context.ratingDifference || 0));
  const closeMatchWeight = Math.exp(-ratingDifference / 260);
  const xg = context.xg || context.expectedGoals || {};
  const xgHome = Number(xg.home ?? context.homeXg);
  const xgAway = Number(xg.away ?? context.awayXg);
  const hasXg = Number.isFinite(xgHome) && Number.isFinite(xgAway);
  const xgDiff = hasXg ? Math.abs(xgHome - xgAway) : Infinity;
  const xgTotal = hasXg ? xgHome + xgAway : Infinity;
  const drawSignal = clamp(
    Number(calibration.drawRisk || 0) * 0.18 + Number(calibration.resistanceDraw || 0) * 0.12,
    -0.08,
    0.35
  );
  const targetDraw = clamp(0.18 + closeMatchWeight * 0.04 + drawSignal, 0.16, 0.38);
  const drawLiftWeight = sampleWeight * clamp(closeMatchWeight + 0.25, 0, 1);
  let protectDrawCorrection = false;
  if (draw < targetDraw && drawLiftWeight > 0) {
    const lift = (targetDraw - draw) * drawLiftWeight;
    const nonDraw = homeWin + awayWin || 1;
    homeWin -= lift * (homeWin / nonDraw);
    awayWin -= lift * (awayWin / nonDraw);
    draw += lift;
    protectDrawCorrection = ratingDifference <= 90 && drawSignal > 0.03 && lift >= 0.015;
  }
  const topNonDraw = Math.max(homeWin, awayWin);
  const drawGap = topNonDraw - draw;
  const nearEvenGame = samples >= 10
    && draw >= 0.28
    && drawGap > 0
    && drawGap <= 0.07
    && xgDiff <= 0.45
    && xgTotal <= 3.05;
  if (nearEvenGame) {
    const promotion = Math.min(drawGap + 0.006, 0.08);
    if (homeWin >= awayWin) homeWin = Math.max(0.01, homeWin - promotion);
    else awayWin = Math.max(0.01, awayWin - promotion);
    draw += promotion;
    protectDrawCorrection = true;
  }
  return calibrateConfidenceShape({ homeWin, draw, awayWin }, calibration, { protectDrawCorrection });
}

function scoreKey(homeGoals, awayGoals) {
  return `${homeGoals}:${awayGoals}`;
}

function normalizedScoreDistribution(matrix) {
  const cells = [];
  let total = 0;
  for (let homeGoals = 0; homeGoals <= 5; homeGoals += 1) {
    for (let awayGoals = 0; awayGoals <= 5; awayGoals += 1) {
      const probability = Number(matrix?.[homeGoals]?.[awayGoals] || 0);
      cells.push({ home: homeGoals, away: awayGoals, probability });
      total += probability;
    }
  }
  if (!Number.isFinite(total) || total <= 0) return cells.map((cell) => ({ ...cell, probability: 0 }));
  return cells.map((cell) => ({ ...cell, probability: roundProbability(cell.probability / total) }));
}

function scoreCandidatesFromMatrix(matrix, best, limit = 5) {
  const probabilityByScore = new Map(normalizedScoreDistribution(matrix).map((item) => [scoreKey(item.home, item.away), item.probability]));
  const candidates = best?.candidates?.length ? best.candidates : [best].filter(Boolean);
  return candidates.slice(0, limit).map((candidate) => ({
    home: candidate.home,
    away: candidate.away,
    probability: roundProbability(probabilityByScore.get(scoreKey(candidate.home, candidate.away)) ?? candidate.probability ?? 0)
  }));
}

function totalGoalsFromMatrix(matrix, homeXg, awayXg) {
  const distribution = normalizedScoreDistribution(matrix);
  let over25 = 0;
  let under25 = 0;
  let bothTeamsScore = 0;
  const byTotal = {};
  for (const item of distribution) {
    const total = item.home + item.away;
    if (total >= 3) over25 += item.probability;
    else under25 += item.probability;
    if (item.home > 0 && item.away > 0) bothTeamsScore += item.probability;
    byTotal[total] = roundProbability((byTotal[total] || 0) + item.probability);
  }
  return {
    expected: Number((Number(homeXg || 0) + Number(awayXg || 0)).toFixed(2)),
    over25: roundProbability(over25),
    under25: roundProbability(under25),
    bothTeamsScore: roundProbability(bothTeamsScore),
    byTotal
  };
}

function isKnockoutFixture(fixture) {
  const stage = `${fixture?.stage || ""} ${fixture?.stageName || ""}`;
  return /knockout|round|quarter|semi|final|32|16|1\/4|淘汰|决赛|半决赛|强/i.test(stage);
}

function knockoutAdvanceProbabilities(probabilities, difference, fixture) {
  if (!isKnockoutFixture(fixture)) return null;
  const homeWin = Number(probabilities.homeWin || 0);
  const draw = Number(probabilities.draw || 0);
  const awayWin = Number(probabilities.awayWin || 0);
  const total = homeWin + draw + awayWin || 1;
  const homeShare = clamp(0.5 + Number(difference || 0) / 1800, 0.32, 0.68);
  const extraTimeResolve = clamp(0.52 - Math.abs(Number(difference || 0)) / 2600, 0.36, 0.58);
  const penaltyShare = 1 - extraTimeResolve;
  const homeAfterDraw = extraTimeResolve * homeShare + penaltyShare * clamp(0.5 + Number(difference || 0) / 3000, 0.42, 0.58);
  const awayAfterDraw = 1 - homeAfterDraw;
  const normalizedHome = homeWin / total;
  const normalizedDraw = draw / total;
  const normalizedAway = awayWin / total;
  return {
    homeAdvance: roundProbability(normalizedHome + normalizedDraw * homeAfterDraw),
    awayAdvance: roundProbability(normalizedAway + normalizedDraw * awayAfterDraw),
    regularTimeDraw: roundProbability(normalizedDraw),
    extraTimeResolution: roundProbability(normalizedDraw * extraTimeResolve),
    penaltyShootout: roundProbability(normalizedDraw * penaltyShare),
    note: "淘汰赛先展示90分钟胜平负概率；若90分钟平局，会进入加时赛，仍平则通过点球大战决定晋级。"
  };
}

function predict(home, away, venue = state.venue, fixture = null) {
  const venueBonus = venue === "home" ? state.homeBonus : 0;
  const homeAvailability = teamAvailabilityAdjustment(home);
  const awayAvailability = teamAvailabilityAdjustment(away);
  const weather = fixtureWeatherImpact(fixture);
  const calibration = predictionCalibration();
  const formHome = (home.form - 75) * state.formWeight;
  const formAway = (away.form - 75) * state.formWeight;
  const effectiveHome = home.elo - homeAvailability.ratingPenalty + venueBonus + formHome;
  const effectiveAway = away.elo - awayAvailability.ratingPenalty + formAway;
  const difference = effectiveHome - effectiveAway;
  const eloHomeExpected = 1 / (1 + Math.pow(10, -difference / 400));
  const eloDraw = clamp(0.26 - Math.abs(difference) / 1800 + weather.draw + calibration.drawAdjustment, 0.14, 0.38);
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

  for (let h = 0; h <= 5; h += 1) {
    matrix[h] = [];
    for (let a = 0; a <= 5; a += 1) {
      const probability = poisson(homeXg, h) * poisson(awayXg, a);
      matrix[h][a] = probability;
      if (h > a) poissonHome += probability;
      else if (h === a) poissonDraw += probability;
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
  const scoreCandidates = scoreCandidatesFromMatrix(matrix, best, 5);
  const totalGoals = totalGoalsFromMatrix(matrix, homeXg, awayXg);
  const probabilitySnapshot = {
    homeWin: roundProbability(probabilities.homeWin),
    draw: roundProbability(probabilities.draw),
    awayWin: roundProbability(probabilities.awayWin)
  };
  return {
    ...probabilities,
    homeXg, awayXg, matrix, best,
    probabilities: probabilitySnapshot,
    firstScore: scoreCandidates[0] || { home: best.home, away: best.away, probability: roundProbability(best.probability || 0) },
    scoreCandidates,
    xg: { home: Number(homeXg.toFixed(2)), away: Number(awayXg.toFixed(2)) },
    totalGoals,
    bothTeamsScore: totalGoals.bothTeamsScore,
    advance: knockoutAdvanceProbabilities(probabilitySnapshot, difference, fixture),
    calibration: { ...calibration, totalLift: adjustedGoals.totalLift }
  };
}

function matchRatingK(fixture) {
  const name = fixture?.stageName || "";
  if (/决赛|final/i.test(name)) return 44;
  if (/半决赛|semifinal/i.test(name)) return 40;
  if (/1\/4|16|32|knockout|强/i.test(name)) return 38;
  return 34;
}

function expectedScore(home, away, venueMode = "neutral", fixture = null) {
  const homeAdvantage = venueMode === "home" ? 55 : 0;
  const homeAvailability = teamAvailabilityAdjustment(home);
  const awayAvailability = teamAvailabilityAdjustment(away);
  return 1 / (1 + Math.pow(10, -(((home.elo - homeAvailability.ratingPenalty) + homeAdvantage) - (away.elo - awayAvailability.ratingPenalty)) / 400));
}

function expectedGoals(home, away, venueMode = "neutral", fixture = null) {
  const homeAdvantage = venueMode === "home" ? 55 : 0;
  const homeAvailability = teamAvailabilityAdjustment(home);
  const awayAvailability = teamAvailabilityAdjustment(away);
  const weather = fixtureWeatherImpact(fixture);
  const difference = (home.elo - homeAvailability.ratingPenalty) + homeAdvantage - (away.elo - awayAvailability.ratingPenalty);
  const baseHome = clamp(1.25 + (home.attack - homeAvailability.attackPenalty - (away.defense - awayAvailability.defensePenalty)) / 44 + difference / 700 + (venueMode === "home" ? 0.12 : 0) + weather.xg, 0.25, 3.6);
  const baseAway = clamp(1.10 + (away.attack - awayAvailability.attackPenalty - (home.defense - homeAvailability.defensePenalty)) / 44 - difference / 760 + weather.xg, 0.25, 3.6);
  return calibratedExpectedGoals(baseHome, baseAway, difference, fixture, predictionCalibration());
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

function objectiveRatingUpdate(home, away, fixture) {
  const expectedHome = expectedScore(home, away, fixture.venueMode, fixture);
  const expectedAway = 1 - expectedHome;
  const actualHome = fixture.homeScore > fixture.awayScore ? 1 : fixture.homeScore < fixture.awayScore ? 0 : 0.5;
  const actualAway = 1 - actualHome;
  const goals = expectedGoals(home, away, fixture.venueMode, fixture);
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

function loadStoredPredictions() {
  try { return JSON.parse(localStorage.getItem(PREDICTION_STORAGE_KEY) || "{}"); }
  catch { return {}; }
}

function ensureFixturePredictions() {
  let changed = false;
  for (const fixture of fixtures) {
    if (!fixture.home || !fixture.away) continue;
    const stored = storedPredictions[fixture.id];
    if (!fixture.modelPrediction && stored?.homeTeam === fixture.home && stored?.awayTeam === fixture.away) {
      fixture.modelPrediction = { home: stored.home, away: stored.away, createdAt: stored.createdAt };
    }
    if (!fixture.modelPrediction) {
      const home = teamById(fixture.home);
      const away = teamById(fixture.away);
      if (!home || !away) continue;
      const best = predict(home, away, fixture.venueMode, fixture).best;
      fixture.modelPrediction = { home: best.home, away: best.away, createdAt: new Date().toISOString() };
    }
    const next = { homeTeam: fixture.home, awayTeam: fixture.away, ...fixture.modelPrediction };
    if (JSON.stringify(storedPredictions[fixture.id]) !== JSON.stringify(next)) {
      storedPredictions[fixture.id] = next;
      changed = true;
    }
  }
  if (changed) {
    try { localStorage.setItem(PREDICTION_STORAGE_KEY, JSON.stringify(storedPredictions)); }
    catch { /* Storage can be unavailable in privacy mode. */ }
  }
}

function scoreOutcome(homeScore, awayScore) {
  if (homeScore === awayScore) return "draw";
  return homeScore > awayScore ? "home" : "away";
}

function assessPrediction(fixture) {
  if (fixture.status !== "post" || !fixture.modelPrediction) return null;
  const prediction = fixture.modelPrediction;
  const actualOutcome = fixture.winnerSide || scoreOutcome(fixture.homeScore, fixture.awayScore);
  const predictedOutcome = scoreOutcome(prediction.home, prediction.away);
  const exact = prediction.home === fixture.homeScore && prediction.away === fixture.awayScore;
  if (exact && actualOutcome === predictedOutcome) return { className: "prediction-correct", label: "预测正确", prediction };
  if (actualOutcome === predictedOutcome) return { className: "prediction-close", label: "赛果正确，比分有偏差", prediction };
  return { className: "prediction-wrong", label: "预测错误", prediction };
}

function predictedScoreText(fixture) {
  return fixture.modelPrediction ? `预测 ${fixture.modelPrediction.home} : ${fixture.modelPrediction.away}` : "";
}

function teamMark(team, small = false) {
  if (!team) return `<span class="abbr-mark${small ? " small" : ""}">TBD</span>`;
  if (team.logo) return `<img class="team-logo${small ? " small" : ""}" src="${team.logo}" alt="${team.name}">`;
  return `<span class="abbr-mark${small ? " small" : ""}">${team.abbr || "TBD"}</span>`;
}

function setTeamMark(element, team) {
  element.innerHTML = teamMark(team);
}

function formatDate(value, includeYear = false) {
  const options = { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false };
  if (includeYear) options.year = "numeric";
  return new Intl.DateTimeFormat("zh-CN", options).format(new Date(value)).replaceAll("/", "-");
}

function formatSyncTime(value) {
  if (!value) return "--:--";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value));
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
    .replace(/Third Place Group/i, "小组第三名");
}

function transformEspnEvents(events) {
  const baseByAbbr = new Map(bundledFallback.teams.map((team) => [team.abbr, team]));
  const toTeam = (competitor) => {
    const source = competitor?.team || {};
    const base = baseByAbbr.get(source.abbreviation);
    const real = Boolean(base && source.logo && /^[A-Z]{3}$/.test(source.abbreviation));
    return {
      id: real ? base.id : null,
      abbr: source.abbreviation || "TBD",
      name: real ? base.name : translatePlaceholder(source.displayName),
      nameEn: source.displayName || "TBD",
      logo: source.logo || "",
      score: Number(competitor?.score || 0),
      winner: Boolean(competitor?.winner),
      real
    };
  };

  return events.map((event) => {
    const competition = event.competitions?.[0] || {};
    const competitors = competition.competitors || [];
    const homeTeam = toTeam(competitors.find((item) => item.homeAway === "home"));
    const awayTeam = toTeam(competitors.find((item) => item.homeAway === "away"));
    const status = event.status?.type?.state || "pre";
    const stageSlug = event.season?.slug || "group-stage";
    return {
      id: event.id, date: event.date, home: homeTeam.id, away: awayTeam.id, homeTeam, awayTeam,
      homeScore: homeTeam.score, awayScore: awayTeam.score, status,
      winnerSide: homeTeam.winner ? "home" : awayTeam.winner ? "away" : null,
      completed: Boolean(event.status?.type?.completed),
      statusText: status === "in" ? (event.status?.type?.shortDetail || "进行中") : status === "post" ? "已结束" : "未开赛",
      clock: event.status?.displayClock || "", stage: stageSlug === "group-stage" ? "group" : "knockout",
      stageName: stageNames[stageSlug] || stageSlug, venue: competition.venue?.fullName || "场地待定",
      city: competition.venue?.address?.city || "",
      venueMode: ["MEX", "USA", "CAN"].includes(homeTeam.abbr) ? "home" : "neutral"
    };
  }).sort((a, b) => new Date(a.date) - new Date(b.date));
}

function recalculateTeamMetrics(baseTeams, liveFixtures) {
  const updated = structuredClone(baseTeams);
  const byId = new Map(updated.map((team) => [team.id, team]));
  const stats = new Map(updated.map((team) => [team.id, { matches: 0, points: 0, gf: 0, ga: 0, results: [] }]));
  const completedFixtures = liveFixtures
    .filter((item) => item.completed && item.home && item.away)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  for (const fixture of completedFixtures) {
    const home = stats.get(fixture.home);
    const away = stats.get(fixture.away);
    const homeTeam = byId.get(fixture.home);
    const awayTeam = byId.get(fixture.away);
    if (!home || !away || !homeTeam || !awayTeam) continue;

    const update = objectiveRatingUpdate(homeTeam, awayTeam, fixture);
    homeTeam.elo += update.homeDelta; awayTeam.elo += update.awayDelta;
    homeTeam.trend += update.homeDelta; awayTeam.trend += update.awayDelta;
    homeTeam.lastMatchDelta = update.homeDelta;
    awayTeam.lastMatchDelta = update.awayDelta;
    fixture.ratingUpdate = update;
    homeTeam.form = Math.round(clamp(homeTeam.form * 0.82 + performanceSignal(update.actualHome, update.expectedHome) * 0.18, 35, 98));
    awayTeam.form = Math.round(clamp(awayTeam.form * 0.82 + performanceSignal(update.actualAway, update.expectedAway) * 0.18, 35, 98));

    const actual = update.actualHome;
    const homeAttackSignal = clamp(52 + fixture.homeScore * 14 + (awayTeam.defense - 70) * 0.25, 42, 98);
    const awayAttackSignal = clamp(52 + fixture.awayScore * 14 + (homeTeam.defense - 70) * 0.25, 42, 98);
    const homeDefenseSignal = clamp(94 - fixture.awayScore * 15 + (awayTeam.attack - 70) * 0.2, 42, 98);
    const awayDefenseSignal = clamp(94 - fixture.homeScore * 15 + (homeTeam.attack - 70) * 0.2, 42, 98);
    homeTeam.attack = Math.round(homeTeam.attack * 0.88 + homeAttackSignal * 0.12);
    awayTeam.attack = Math.round(awayTeam.attack * 0.88 + awayAttackSignal * 0.12);
    homeTeam.defense = Math.round(homeTeam.defense * 0.88 + homeDefenseSignal * 0.12);
    awayTeam.defense = Math.round(awayTeam.defense * 0.88 + awayDefenseSignal * 0.12);
    homeTeam.pace = homeTeam.bigMatch = Math.round(clamp((homeTeam.bigMatch ?? homeTeam.pace) * 0.9 + actual * 100 * 0.1, 40, 98));
    awayTeam.pace = awayTeam.bigMatch = Math.round(clamp((awayTeam.bigMatch ?? awayTeam.pace) * 0.9 + update.actualAway * 100 * 0.1, 40, 98));

    home.matches += 1; away.matches += 1;
    home.gf += fixture.homeScore; home.ga += fixture.awayScore;
    away.gf += fixture.awayScore; away.ga += fixture.homeScore;
    if (fixture.homeScore > fixture.awayScore) { home.points += 3; home.results.push("W"); away.results.push("L"); }
    else if (fixture.homeScore < fixture.awayScore) { away.points += 3; away.results.push("W"); home.results.push("L"); }
    else { home.points += 1; away.points += 1; home.results.push("D"); away.results.push("D"); }
  }

  return updated.map((team) => {
    const record = stats.get(team.id);
    if (!record?.matches) return { ...team, matches: 0, record: "-" };
    return {
      ...team,
      matches: record.matches,
      record: record.results.slice(-5).join("") || "-"
    };
  }).sort((a, b) => b.elo - a.elo);
}

async function fetchLivePayload(force) {
  if (location.protocol !== "file:") {
    try {
      const response = await fetch(`/api/world-cup${force ? "?force=1" : ""}`, { cache: "no-store" });
      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data.teams) && data.teams.length && Array.isArray(data.fixtures)) return data;
      }
    } catch {}
  }

  const response = await fetch(ESPN_LIVE_URL, { cache: "no-store" });
  if (!response.ok) throw new Error(`公开赛事接口返回 ${response.status}`);
  const raw = await response.json();
  const liveFixtures = transformEspnEvents(raw.events || []);
  if (liveFixtures.length < 100) throw new Error("赛事接口返回数据不完整");
  return {
    fetchedAt: new Date().toISOString(), stale: false,
    teams: recalculateTeamMetrics(applyHistoricalRatings(bundledFallback.teams), liveFixtures), fixtures: liveFixtures,
    modelVersion: RATING_MODEL_VERSION,
    source: { matches: "ESPN FIFA World Cup", ratings: "GoalMind dynamic power rating v4" }
  };
}

function populateSelects() {
  const sorted = [...teams].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  const options = sorted.map((team) => `<option value="${team.id}">${team.name} · ${team.elo}</option>`).join("");
  $("homeTeam").innerHTML = options;
  $("awayTeam").innerHTML = options;
  if (teamById(state.homeId)) $("homeTeam").value = state.homeId;
  if (teamById(state.awayId)) $("awayTeam").value = state.awayId;
}

function setOptionalText(id, value) {
  const node = $(id);
  if (node) node.textContent = value;
}

function displayPercent(value) {
  return `${Math.round(Number(value || 0) * 100)}%`;
}

function predictionProbabilities(snapshot, result) {
  const source = snapshot?.probabilities || snapshot || result?.probabilities || result || {};
  return {
    homeWin: Number(source.homeWin ?? source.home ?? result?.homeWin ?? 0),
    draw: Number(source.draw ?? result?.draw ?? 0),
    awayWin: Number(source.awayWin ?? source.away ?? result?.awayWin ?? 0)
  };
}

function predictionXg(snapshot, result) {
  return {
    home: Number(snapshot?.xg?.home ?? result?.xg?.home ?? result?.homeXg ?? 0),
    away: Number(snapshot?.xg?.away ?? result?.xg?.away ?? result?.awayXg ?? 0)
  };
}

function isLegacyPredictionSnapshot(snapshot) {
  return Boolean(snapshot && Number.isFinite(Number(snapshot.home)) && Number.isFinite(Number(snapshot.away))
    && !snapshot.probabilities && !snapshot.scoreCandidates && !snapshot.xg);
}

function predictionScoreCandidates(snapshot, result) {
  if (Array.isArray(snapshot?.scoreCandidates) && snapshot.scoreCandidates.length) return snapshot.scoreCandidates;
  if (isLegacyPredictionSnapshot(snapshot)) return [{ home: Number(snapshot.home), away: Number(snapshot.away) }];
  if (Array.isArray(result?.scoreCandidates) && result.scoreCandidates.length) return result.scoreCandidates;
  return scoreCandidatesFromMatrix(result?.matrix, result?.best, 5);
}

function predictionTotalGoals(snapshot, result, xg) {
  if (snapshot?.totalGoals) return snapshot.totalGoals;
  if (result?.totalGoals) return result.totalGoals;
  return totalGoalsFromMatrix(result?.matrix, xg.home, xg.away);
}

function candidateLabel(candidate) {
  if (!candidate) return "--";
  const probability = Number.isFinite(Number(candidate.probability)) ? ` · ${displayPercent(candidate.probability)}` : "";
  return `${candidate.home} : ${candidate.away}${probability}`;
}

function renderPredictionDetails(snapshot, result, home, away, fixture) {
  const probabilities = predictionProbabilities(snapshot, result);
  const xg = predictionXg(snapshot, result);
  const candidates = predictionScoreCandidates(snapshot, result);
  const topThree = candidates.slice(0, 3);
  const totalGoals = predictionTotalGoals(snapshot, result, xg);
  const advance = snapshot?.advance || result?.advance || knockoutAdvanceProbabilities(probabilities, (home?.elo || 0) - (away?.elo || 0), fixture);
  const createdAt = snapshot?.createdAt || sourceMeta.fetchedAt;
  const version = snapshot?.modelVersion || sourceMeta.modelVersion || RATING_MODEL_VERSION;
  const legacySnapshot = isLegacyPredictionSnapshot(snapshot);

  setOptionalText("scoreCandidateLead", candidateLabel(topThree[0]));
  setOptionalText("scoreCandidateList", legacySnapshot
    ? "早期锁定快照仅保存第一预测比分；不会用赛后数据补写当时的概率或候选比分。"
    : topThree.length > 1
    ? topThree.map(candidateLabel).join(" / ")
    : "模型会在有完整矩阵后展示前三候选比分");
  setOptionalText("goalModelLead", `xG ${xg.home.toFixed(2)} : ${xg.away.toFixed(2)}`);
  setOptionalText("goalModelDetail", legacySnapshot
    ? `早期快照未记录 xG；当前显示为本版本复盘参考：总进球 ${Number(totalGoals.expected || (xg.home + xg.away)).toFixed(2)}，大于2.5球 ${displayPercent(totalGoals.over25)}。`
    : `预期总进球 ${Number(totalGoals.expected || (xg.home + xg.away)).toFixed(2)}；大于2.5球 ${displayPercent(totalGoals.over25)}；双方进球 ${displayPercent(totalGoals.bothTeamsScore ?? totalGoals.btts)}。`);
  setOptionalText("predictionVersion", version);
  setOptionalText("predictionMeta", legacySnapshot
    ? `早期赛前快照；生成 ${createdAt ? formatSyncTime(createdAt) : "--:--"}；只保留锁定比分，概率与 xG 为当前复盘参考。`
    : `${snapshot?.regularTimeOnly ? "90分钟常规时间" : "常规时间预测"}；生成 ${createdAt ? formatSyncTime(createdAt) : "--:--"}；开赛前锁定，赛后只评价。`);

  const advanceCard = $("knockoutAdvanceCard");
  if (!advanceCard) return;
  advanceCard.hidden = !advance;
  if (advance) {
    const homeAdvance = advance.homeAdvance ?? advance.home;
    const awayAdvance = advance.awayAdvance ?? advance.away;
    setOptionalText("advanceLead", `${home.name} ${displayPercent(homeAdvance)} / ${away.name} ${displayPercent(awayAdvance)}`);
    setOptionalText("advanceDetail", `90分钟平局 ${displayPercent(advance.regularTimeDraw)}；进入加时并解决 ${displayPercent(advance.extraTimeResolution)}；进入点球大战 ${displayPercent(advance.penaltyShootout)}。若常规时间打平，晋级不再按胜平负结算，而按加时/点球路径估计。`);
  }
}

function renderPrediction() {
  const home = teamById(state.homeId);
  const away = teamById(state.awayId);
  if (!home || !away) return;
  const fixture = currentFixture();
  const matchingFixture = fixture && fixture.home === home.id && fixture.away === away.id ? fixture : null;
  const result = predict(home, away, matchingFixture?.venueMode || state.venue, matchingFixture || fixture);
  const showActual = matchingFixture && ["in", "post"].includes(matchingFixture.status);
  const displayPrediction = matchingFixture?.modelPrediction || result.best;
  const displayProbabilities = predictionProbabilities(displayPrediction, result);
  const displayXg = predictionXg(displayPrediction, result);
  const assessment = matchingFixture ? assessPrediction(matchingFixture) : null;

  setTeamMark($("homeFlag"), home);
  setTeamMark($("awayFlag"), away);
  $("homeRating").textContent = home.elo;
  $("awayRating").textContent = away.elo;
  $("homeTrend").textContent = `${home.trend >= 0 ? "+" : ""}${home.trend}`;
  $("awayTrend").textContent = `${away.trend >= 0 ? "+" : ""}${away.trend}`;
  $("homeTrend").className = home.trend >= 0 ? "trend-positive" : "trend-negative";
  $("awayTrend").className = away.trend >= 0 ? "trend-positive" : "trend-negative";
  $("homeScore").textContent = showActual ? matchingFixture.homeScore : displayPrediction.home;
  $("awayScore").textContent = showActual ? matchingFixture.awayScore : displayPrediction.away;
  $("scoreCaption").textContent = showActual ? (matchingFixture.status === "in" ? `实时比分 · ${matchingFixture.clock || "进行中"}` : `最终比分 · ${assessment?.label || "等待评估"}`) : "最可能比分";
  $("scorePrediction").hidden = matchingFixture?.status !== "post";
  $("scorePrediction").textContent = matchingFixture?.status === "post" ? predictedScoreText(matchingFixture) : "";
  $("predictionCard").classList.remove("prediction-correct", "prediction-close", "prediction-wrong");
  if (assessment) $("predictionCard").classList.add(assessment.className);
  $("homeWin").textContent = pct(displayProbabilities.homeWin);
  $("draw").textContent = pct(displayProbabilities.draw);
  $("awayWin").textContent = pct(displayProbabilities.awayWin);
  $("homeWinBar").style.width = pct(displayProbabilities.homeWin);
  $("drawBar").style.width = pct(displayProbabilities.draw);
  $("awayWinBar").style.width = pct(displayProbabilities.awayWin);

  const badge = $("matchStatusBadge");
  badge.className = `match-status-badge ${fixture?.status || "prediction"}`;
  badge.textContent = fixture ? (fixture.status === "in" ? "直播" : fixture.status === "post" ? "完赛" : "未开赛") : "自选预测";
  $("matchMeta").textContent = fixture && fixture.home === home.id && fixture.away === away.id
    ? `${fixture.stageName} · ${formatDate(fixture.date)} · ${fixture.venue}`
    : `${state.venue === "home" ? `${home.name}主场` : "中立场"} · 90 分钟`;

  ["factorHomeName", "xgHomeName"].forEach((id) => $(id).textContent = home.name);
  ["factorAwayName", "xgAwayName"].forEach((id) => $(id).textContent = away.name);
  $("homeXg").textContent = displayXg.home.toFixed(2);
  $("awayXg").textContent = displayXg.away.toFixed(2);
  renderFactors(home, away);
  renderMatrix(result.matrix, result.best);
  renderPredictionDetails(displayPrediction, result, home, away, matchingFixture || fixture);
  renderContextVariables(matchingFixture, home, away);
  renderMatchIntelligence(matchingFixture, home, away, result);
}

function renderFactors(home, away) {
  const factors = [
    ["综合实力", clamp((home.elo - 1400) / 8, 0, 100), clamp((away.elo - 1400) / 8, 0, 100)],
    ["近期状态", home.form, away.form], ["进攻威胁", home.attack, away.attack],
    ["防守稳定", home.defense, away.defense], ["大赛表现", home.bigMatch ?? home.pace, away.bigMatch ?? away.pace], ["结果稳定性", home.consistency ?? home.control, away.consistency ?? away.control]
  ];
  $("factorRows").innerHTML = factors.map(([label, h, a]) => `
    <div class="factor-row">
      <div class="metric"><b>${Math.round(h)}</b><span class="metric-bar"><i style="width:${h}%"></i></span></div>
      <span class="metric-label">${label}</span>
      <div class="metric reverse"><b>${Math.round(a)}</b><span class="metric-bar"><i style="width:${a}%"></i></span></div>
    </div>`).join("");
}

function renderMatrix(matrix, best) {
  let html = `<span class="matrix-cell axis">球</span>${[0,1,2,3,4,5].map((n) => `<span class="matrix-cell axis">客${n}</span>`).join("")}`;
  for (let h = 0; h <= 5; h += 1) {
    html += `<span class="matrix-cell axis">主${h}</span>`;
    for (let a = 0; a <= 5; a += 1) {
      const value = matrix[h][a];
      const alpha = clamp(value * 5, 0.025, 0.45);
      html += `<span class="matrix-cell ${best.home === h && best.away === a ? "hot" : ""}" style="background:rgba(89,226,179,${alpha})">${(value * 100).toFixed(1)}</span>`;
    }
  }
  $("scoreMatrix").innerHTML = html;
}

function availabilityImpactText(availability = {}) {
  const parts = [];
  if (availability.ratingPenalty) parts.push(`战力修正 -${availability.ratingPenalty}`);
  if (availability.attackPenalty) parts.push(`进攻 -${availability.attackPenalty}`);
  if (availability.defensePenalty) parts.push(`防守 -${availability.defensePenalty}`);
  if (availability.controlPenalty) parts.push(`控球 -${availability.controlPenalty}`);
  const playerText = availability.players?.length
    ? `重点关注：${availability.players.map((player) => `${player.name}${player.status ? `(${player.status})` : ""}`).join("、")}`
    : "";
  return [parts.join("，") || "当前不额外修正模型", playerText].filter(Boolean).join("；");
}

function renderContextVariables(fixture, home, away) {
  const weather = fixture?.weather;
  const calibration = fixture?.modelPrediction?.calibration || fixture?.predictionCalibration || sourceMeta.predictionCalibration || predictionCalibration();
  const calibrationLabel = calibration?.samples ? `${calibration.samples} 场复盘校准` : "等待复盘样本";
  $("contextSource").textContent = fixture ? `随赛程同步 · ${calibrationLabel}` : `自选对阵 · ${calibrationLabel}`;
  $("weatherSummary").textContent = weather?.summary || "天气预报待同步";
  $("weatherImpact").textContent = weather?.impact?.notes?.join("；") || "确定赛程后会按球场天气修正比赛节奏、射门质量和平局概率。";

  const homeAvailability = home.availability || { summary: "暂无官方伤病名单", players: [] };
  const awayAvailability = away.availability || { summary: "暂无官方伤病名单", players: [] };
  $("homeAvailabilityName").textContent = `${home.name}人员`;
  $("awayAvailabilityName").textContent = `${away.name}人员`;
  $("homeAvailabilitySummary").textContent = homeAvailability.summary || "暂无官方伤病名单";
  $("awayAvailabilitySummary").textContent = awayAvailability.summary || "暂无官方伤病名单";
  $("homeAvailabilityImpact").textContent = availabilityImpactText(homeAvailability);
  $("awayAvailabilityImpact").textContent = availabilityImpactText(awayAvailability);
}

function fixtureResult(fixture) {
  if (["in", "post"].includes(fixture.status)) return `${fixture.homeScore} : ${fixture.awayScore}`;
  if (fixture.modelPrediction) return `${fixture.modelPrediction.home} : ${fixture.modelPrediction.away}`;
  const home = teamById(fixture.home);
  const away = teamById(fixture.away);
  if (!home || !away) return "待定";
  const result = predict(home, away, fixture.venueMode, fixture);
  return `${result.best.home} : ${result.best.away}`;
}

function renderRankings() {
  const sorted = [...teams].sort((a, b) => b.elo - a.elo);
  $("rankingTable").innerHTML = sorted.map((team, index) => `<tr>
    <td>${index + 1}</td><td><button class="table-team team-link" data-team-profile="${team.id}">${teamMark(team, true)}${team.name}</button></td><td>${team.elo}</td>
    <td>${team.form}${team.record !== "-" ? ` · ${team.record}` : ""}</td><td>${team.attack}</td><td>${team.defense}</td>
    <td class="${team.trend >= 0 ? "trend-positive" : "trend-negative"}">${team.trend >= 0 ? "+" : ""}${team.trend}</td>
    <td><button data-pick-team="${team.id}">发起预测</button></td>
  </tr>`).join("");
  document.querySelectorAll("[data-pick-team]").forEach((button) => button.addEventListener("click", () => {
    const opponent = sorted.find((team) => team.id !== button.dataset.pickTeam)?.id;
    loadMatch(button.dataset.pickTeam, opponent, "neutral");
  }));
  bindProfileLinks();
}

function renderMatches(filter = state.currentFilter) {
  state.currentFilter = filter;
  const visible = filter === "all" ? fixtures : fixtures.filter((fixture) => fixture.stage === filter);
  $("matchList").innerHTML = visible.map((fixture) => {
    const home = fixture.home ? teamById(fixture.home) : null;
    const away = fixture.away ? teamById(fixture.away) : null;
    const canPredict = Boolean(home && away);
    const score = fixtureResult(fixture);
    const assessment = assessPrediction(fixture);
    let detail = "双方待定";
    if (canPredict && fixture.status === "pre") {
      const result = predict(home, away, fixture.venueMode, fixture);
      detail = `${pct(result.homeWin)} / ${pct(result.draw)} / ${pct(result.awayWin)}`;
    } else if (fixture.status === "in") detail = fixture.clock || "进行中";
    else if (fixture.status === "post") detail = assessment?.label || "最终比分";
    return `<article class="match-row ${fixture.status} ${assessment?.className || ""}">
      <time>${formatDate(fixture.date)}</time>
      <div class="match-team">${teamMark(home || fixture.homeTeam, true)}${home ? `<button class="team-link" data-team-profile="${home.id}">${home.name}</button>` : `<b>${fixture.homeTeam.name}</b>`}</div>
      <div class="match-prediction"><span class="final-score-row"><b>${score}</b>${fixture.status === "post" ? `<small class="predicted-score">${predictedScoreText(fixture)}</small>` : ""}</span><small class="prediction-verdict">${detail}</small></div>
      <div class="match-team away-team">${away ? `<button class="team-link" data-team-profile="${away.id}">${away.name}</button>` : `<b>${fixture.awayTeam.name}</b>`}${teamMark(away || fixture.awayTeam, true)}</div>
      <div class="stage"><span class="fixture-state ${fixture.status}">${fixture.status === "in" ? "直播" : fixture.status === "post" ? "完赛" : fixture.stageName}</span>${canPredict ? ` · <button data-fixture-id="${fixture.id}">预测详情</button>` : ""}</div>
    </article>`;
  }).join("");
  document.querySelectorAll("#matchList [data-fixture-id]").forEach((button) => button.addEventListener("click", () => loadFixture(button.dataset.fixtureId)));
  bindProfileLinks();
}

function profileResultLabel(match) {
  if (match.result === "W") return "胜";
  if (match.result === "L") return "负";
  if (match.result === "PW") return "点胜";
  if (match.result === "PL") return "点负";
  return "平";
}

function profileResultClass(match) {
  if (match.result === "W" || match.result === "PW") return "win";
  if (match.result === "L" || match.result === "PL") return "loss";
  return "draw";
}

function teamWorldCupFixtures(teamId) {
  return fixtures.filter((fixture) => fixture.home === teamId || fixture.away === teamId);
}

function escapeProfileHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]);
}

function profilePositionLabel(position) {
  return ({ G: "门将", GK: "门将", D: "后卫", DF: "后卫", M: "中场", MF: "中场", F: "前锋", FW: "前锋" })[position] || position || "球员";
}

function profileFormation(team) {
  if (team.control >= 86 && team.attack >= 82) return "4-3-3";
  if (team.pace >= 86 && team.control < 80) return "3-4-2-1";
  if (team.defense >= 84 && team.attack < 76) return "5-4-1";
  if (team.defense >= 80 || team.control >= 78) return "4-2-3-1";
  return "4-4-2";
}

function projectProfileLineup(squad, formation) {
  if (!squad?.length) return [];
  const digits = formation.split("-").map(Number).filter(Number.isFinite);
  const defenderCount = digits[0] || 4;
  const forwardCount = digits.at(-1) || 1;
  const midfieldCount = Math.max(1, 10 - defenderCount - forwardCount);
  const groups = {
    goalkeepers: squad.filter((player) => ["G", "GK"].includes(player.position)),
    defenders: squad.filter((player) => ["D", "DF"].includes(player.position)),
    midfielders: squad.filter((player) => ["M", "MF"].includes(player.position)),
    forwards: squad.filter((player) => ["F", "FW"].includes(player.position))
  };
  const selected = [groups.goalkeepers[0], ...groups.defenders.slice(0, defenderCount), ...groups.midfielders.slice(0, midfieldCount), ...groups.forwards.slice(0, forwardCount)].filter(Boolean);
  for (const player of squad) {
    if (selected.length >= 11) break;
    if (!selected.some((item) => item.id === player.id)) selected.push(player);
  }
  return selected.slice(0, 11);
}

function profilePlayersHtml(players, emptyText = "等待官方发布") {
  if (!players?.length) return `<p class="empty-state">${emptyText}</p>`;
  return players.map((player) => `<div class="profile-player ${player.unavailable ? "unavailable" : ""}">
    <span>${escapeProfileHtml(player.jersey || "--")}</span>
    <b title="${escapeProfileHtml(player.name)}">${escapeProfileHtml(player.shortName || player.name)}</b>
    <small>${escapeProfileHtml(profilePositionLabel(player.position))}${player.age ? ` · ${player.age} 岁` : ""}${player.unavailable ? ` · ${escapeProfileHtml(player.statusLabel || "不可用")}` : ""}</small>
  </div>`).join("");
}

function profileAnalysisHtml(items) {
  return items.map((item) => `<article><span>${escapeProfileHtml(item.title)}</span><p>${escapeProfileHtml(item.text)}</p></article>`).join("");
}

function latestProfileFixture(teamId, worldCup) {
  const live = worldCup.find((fixture) => fixture.status === "in");
  if (live) return live;
  const completed = worldCup.filter((fixture) => fixture.status === "post").sort((a, b) => new Date(b.date) - new Date(a.date))[0];
  if (completed) return completed;
  return worldCup.filter((fixture) => fixture.status === "pre" && new Date(fixture.date).getTime() - Date.now() < 6 * 60 * 60 * 1000).sort((a, b) => new Date(a.date) - new Date(b.date))[0] || null;
}

async function getTeamProfileData(teamId) {
  const cached = teamProfileStore.get(teamId);
  if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < 30 * 60 * 1000) return cached;
  if (location.protocol === "file:") throw new Error("请通过网站服务打开以载入球队名单");
  const response = await fetch(`/api/team-profile?id=${encodeURIComponent(teamId)}`, { cache: "no-store" });
  if (!response.ok) throw new Error("球队名单接口暂不可用");
  const data = await response.json();
  teamProfileStore.set(teamId, data);
  return data;
}

function buildProfileTactics(team, history, formation, stats = {}, hasOfficialLineup = false) {
  const possession = Number(stats.possessionPct);
  const passes = Number(stats.totalPasses);
  const passPct = Number(stats.passPct);
  const shots = Number(stats.totalShots);
  const crosses = Number(stats.totalCrosses);
  const longBalls = Number(stats.totalLongBalls);
  const tackles = Number(stats.totalTackles);
  const interceptions = Number(stats.interceptions);
  const tempo = team.pace >= 86 ? "快节奏" : team.pace >= 74 ? "中快节奏" : "中节奏";
  const pressing = team.form >= 84 ? "积极压迫" : team.defense >= 82 ? "中位压迫" : "阵地防守";
  const lineHeight = team.defense >= 86 && team.pace >= 80 ? "中高位" : team.defense >= 75 ? "中位" : "中低位";
  const buildUp = team.control >= 86 ? "后场短传组织" : team.pace >= team.control + 6 ? "快速纵向推进" : "短传与直接推进结合";
  const route = team.pace >= team.control ? "边路与身后空间" : "中路与肋部连接";
  const recentStats = Number.isFinite(possession)
    ? `最近一场官方统计为控球 ${possession.toFixed(1)}%、${Number.isFinite(passes) ? `${passes} 次传球` : "传球数据待补充"}${Number.isFinite(shots) ? `、${shots} 次射门` : ""}。`
    : "尚无本届世界杯完整技术统计，以下以近四年结果和能力模型评估。";
  const strengths = [
    team.control >= 82 ? "中场控制与连续组织" : "纵向推进和转换速度",
    team.defense >= 82 ? "防线稳定与禁区保护" : "快速回收与局部围抢",
    team.attack >= 82 ? "前场机会创造能力" : "定位球与第二落点"
  ];
  const risks = [
    team.control < 76 ? "持续控球时的出球稳定性" : "控球占优时身后空间保护",
    team.defense < 76 ? "禁区前沿与高球防守" : "高位防线被快速反击",
    history.consistency < 76 ? "比赛状态波动较大" : "领先后节奏可能趋于保守"
  ];
  return {
    tags: [tempo, formation, pressing, `${lineHeight}防线`, buildUp],
    strengths,
    risks,
    inPossession: [
      { title: "控球与推进方式", text: `${buildUp}为主要框架，预计优先通过${route}向前输送。${recentStats}` },
      { title: "边路 / 中路倾向", text: team.pace >= team.control ? `速度指标 ${team.pace}，更适合利用边路一对一、套边和纵深跑动。` : `控制指标 ${team.control}，更倾向中场形成接应三角并从肋部进入禁区。` },
      { title: "射门质量与机会转化", text: `进攻能力 ${team.attack}/100，预计以${team.attack >= 84 ? "禁区内配合与高质量终结" : "转换、二点球和定位球"}作为主要得分路径${Number.isFinite(crosses) || Number.isFinite(longBalls) ? `；最近一场传中 ${crosses || 0} 次、长传 ${longBalls || 0} 次` : ""}。` }
    ],
    outPossession: [
      { title: "防守纪律", text: `防守能力 ${team.defense}/100，主要采用${lineHeight}防线，优先保持中路紧凑并限制禁区前沿的直接配合。` },
      { title: "压迫强度", text: `${pressing}。${team.form >= 84 ? "丢球后的前几秒会尝试就地反抢，前场压迫持续性较强。" : "更重视阵型回收，避免中后场被连续拉开。"}` },
      { title: "夺回球权方式", text: Number.isFinite(tackles) || Number.isFinite(interceptions) ? `最近一场完成 ${tackles || 0} 次抢断尝试和 ${interceptions || 0} 次拦截，反映其主要夺回球权区域。` : "预计依靠中场协防、边路夹击和禁区前的第二落点争夺重新获得球权。" }
    ],
    structure: [
      { title: "常用 / 最近阵型", text: `${formation}${hasOfficialLineup ? "，来自最近一场官方首发" : "，为当前能力结构下的模型建议阵型"}。` },
      { title: "人员结构", text: `${formation.startsWith("3") || formation.startsWith("5") ? "三中卫体系需要翼卫提供纵深，中场负责保护边路身后。" : "四后卫保持基础宽度，中场承担出球、保护和前插的分层任务。"}` },
      { title: "阵容深度与轮换", text: `近四年累计 ${history.matches} 场国家队比赛，当前名单会按门将、后卫、中场、前锋分组展示；正式首发发布后自动替换模型参考阵容。` }
    ],
    transitions: [
      { title: "由守转攻", text: team.pace >= 82 ? "夺回球权后优先寻找向前第一传，并利用边锋或前锋的纵深跑动快速推进。" : "更可能先通过中场短传稳定球权，再寻找边路推进或肋部接应。" },
      { title: "由攻转守", text: team.defense >= 82 ? "丢球后由中场立即延缓对手推进，后卫线保持距离并保护中路。" : "需要优先回收边后卫身后空间，避免被对手用一脚直传穿过第一道压力。" },
      { title: "领先 / 落后策略", text: `领先时倾向${team.consistency >= 80 ? "降低比赛速度并控制球权" : "收紧阵型、强化禁区保护"}；落后时预计增加前场人数和传中频率，最后阶段需防范反击风险。` },
      { title: "比赛末段风险", text: `${history.cleanSheets} 场零封、近四年稳定性 ${history.consistency}/100。${history.consistency >= 80 ? "末段结构通常较稳定，但仍需控制无谓犯规。" : "比赛后段注意力和阵型间距是主要风险点。"}` }
    ]
  };
}

function renderProfileTactics(team, history, roster, stats) {
  const formation = roster?.formation || profileFormation(team);
  const tactics = buildProfileTactics(team, history, formation, stats, Boolean(roster?.lineupOfficial));
  $("profileStyleTags").innerHTML = tactics.tags.map((tag) => `<span>${escapeProfileHtml(tag)}</span>`).join("");
  $("profileStrengths").innerHTML = tactics.strengths.map((item) => `<p>${escapeProfileHtml(item)}</p>`).join("");
  $("profileRisks").innerHTML = tactics.risks.map((item) => `<p>${escapeProfileHtml(item)}</p>`).join("");
  $("profileInPossession").innerHTML = profileAnalysisHtml(tactics.inPossession);
  $("profileOutPossession").innerHTML = profileAnalysisHtml(tactics.outPossession);
  $("profileStructure").innerHTML = profileAnalysisHtml(tactics.structure);
  $("profileTransitions").innerHTML = profileAnalysisHtml(tactics.transitions);
}

function renderProfileSquad(team, squadData, roster, fixture) {
  const squad = squadData?.squad || [];
  const availableSquad = squad.filter((player) => !player.unavailable);
  const formation = roster?.formation || profileFormation(team);
  const projected = roster?.starters?.length ? roster.starters : projectProfileLineup(availableSquad, formation);
  const starterIds = new Set(projected.map((player) => String(player.id)));
  const substitutes = roster?.substitutes?.length ? roster.substitutes : availableSquad.filter((player) => !starterIds.has(String(player.id)));
  const sourceLabel = roster?.lineupOfficial
    ? `官方首发 · ${fixture ? formatDate(fixture.date) : "最近比赛"} · ${formation}`
    : `结构化预计首发 · ${formation}`;
  $("profileLineupSource").textContent = sourceLabel;
  $("profileStartingLineup").innerHTML = profilePlayersHtml(projected, "首发名单尚未发布");
  $("profileSubstitutes").innerHTML = profilePlayersHtml(substitutes, "替补名单尚未发布");
  $("profileStaff").innerHTML = squadData?.staff?.length
    ? squadData.staff.map((member) => `<div><b>${escapeProfileHtml(member.name)}</b><small>${escapeProfileHtml(member.role)}</small></div>`).join("")
    : `<p class="empty-state">教练组数据暂未发布</p>`;
  const groups = [["G", "门将"], ["D", "后卫"], ["M", "中场"], ["F", "前锋"]];
  $("profileFullSquad").innerHTML = squad.length ? `<header><b>完整参赛名单</b><small>ESPN 2026 世界杯球队名单 · ${squad.length} 人</small></header><div>${groups.map(([position, label]) => {
    const players = squad.filter((player) => player.position === position || player.position === `${position}${position === "G" ? "K" : position === "D" ? "F" : position === "M" ? "F" : "W"}`);
    return `<section><span>${label} · ${players.length}</span>${players.map((player) => `<em class="${player.unavailable ? "unavailable" : ""}" title="${escapeProfileHtml(player.statusLabel || player.name)}">${escapeProfileHtml(player.jersey || "--")} ${escapeProfileHtml(player.shortName || player.name)}${player.unavailable ? " · 不可用" : ""}</em>`).join("") || `<small>待补充</small>`}</section>`;
  }).join("")}</div>` : `<p class="empty-state">完整参赛名单暂时不可用</p>`;
  $("profileSquadMeta").textContent = squad.length ? `${squad.length} 人 · ${roster?.lineupOfficial ? "正式首发已同步" : "首发待官方发布"}` : "名单数据待恢复";
}

async function hydrateTeamProfile(team, history, worldCup, requestId) {
  const fixture = latestProfileFixture(team.id, worldCup);
  const squadPromise = getTeamProfileData(team.id);
  const detailPromise = fixture ? getMatchDetailData(fixture) : Promise.reject(new Error("暂无比赛详情"));
  const [squadResult, detailResult] = await Promise.allSettled([squadPromise, detailPromise]);
  if (requestId !== currentProfileRequest) return;
  const squadData = squadResult.status === "fulfilled" ? squadResult.value : null;
  const detail = detailResult.status === "fulfilled" ? detailResult.value : null;
  const roster = detail?.rosters?.find((item) => item.abbr === team.abbr && item.starters?.length) || null;
  const stats = detail?.statistics?.find((item) => item.abbr === team.abbr)?.values || {};
  renderProfileSquad(team, squadData, roster, fixture);
  renderProfileTactics(team, history, roster, stats);
  const synced = Boolean(squadData || detail);
  $("profileDataState").textContent = synced
    ? roster?.lineupOfficial ? "完整名单、教练组与最近一场正式阵容已同步" : "完整名单已同步，正式首发发布后会自动替换"
    : "实时名单暂时不可用，当前显示模型结构分析";
  $("profileDataUpdated").textContent = squadData?.fetchedAt ? `名单更新 ${formatSyncTime(squadData.fetchedAt)}` : "";
}

function resetProfileAccordions() {
  document.querySelectorAll("#teamModal [data-profile-accordion]").forEach((trigger) => {
    const expanded = ["profileSquadPanel", "profileWorldCupPanel"].includes(trigger.getAttribute("aria-controls"));
    trigger.setAttribute("aria-expanded", String(expanded));
    trigger.closest(".profile-accordion")?.classList.toggle("is-open", expanded);
    const panel = $(trigger.getAttribute("aria-controls"));
    if (panel) panel.hidden = !expanded;
  });
}

function renderTeamProfile(teamId) {
  const team = teamById(teamId);
  const history = historyBundle.teams?.[teamId];
  if (!team || !history) return;
  $("profileTeamLogo").innerHTML = teamMark(team);
  $("profileTeamName").textContent = team.name;
  $("profileTeamMeta").textContent = `${history.matches} 场 · ${history.wins} 胜 ${history.draws} 平 ${history.losses} 负 · 进 ${history.goalsFor} / 失 ${history.goalsAgainst}`;
  $("profileRatingRow").innerHTML = `
    <div><span>GoalMind 战力</span><b>${team.elo}</b><em class="${team.trend >= 0 ? "trend-positive" : "trend-negative"}">${team.trend >= 0 ? "+" : ""}${team.trend}</em></div>
    <div><span>近期状态</span><b>${history.form}</b><small>/ 100</small></div>
    <div><span>进攻</span><b>${history.attack}</b><small>/ 100</small></div>
    <div><span>防守</span><b>${history.defense}</b><small>/ 100</small></div>
    <div><span>胜率</span><b>${history.winRate}%</b><small>${history.cleanSheets} 场零封</small></div>`;

  const requestId = ++currentProfileRequest;
  resetProfileAccordions();
  $("profileDataState").textContent = "正在载入球队名单、教练组与最近比赛数据";
  $("profileDataUpdated").textContent = "";
  $("profileSquadMeta").textContent = "等待官方名单";
  $("profileLineupSource").textContent = "";
  $("profileStartingLineup").innerHTML = `<p class="empty-state">正在载入</p>`;
  $("profileSubstitutes").innerHTML = `<p class="empty-state">正在载入</p>`;
  $("profileStaff").innerHTML = `<p class="empty-state">正在载入</p>`;
  $("profileFullSquad").innerHTML = "";
  renderProfileTactics(team, history, null, {});

  const worldCup = teamWorldCupFixtures(teamId);
  $("profileWorldCupCount").textContent = `${worldCup.length} 场`;
  $("profileWorldCup").innerHTML = worldCup.map((fixture) => {
    const isHome = fixture.home === teamId;
    const opponentId = isHome ? fixture.away : fixture.home;
    const opponent = opponentId ? teamById(opponentId) : null;
    const fallbackOpponent = isHome ? fixture.awayTeam : fixture.homeTeam;
    const score = fixture.status === "pre" ? formatDate(fixture.date) : `${isHome ? fixture.homeScore : fixture.awayScore} : ${isHome ? fixture.awayScore : fixture.homeScore}`;
    const assessment = assessPrediction(fixture);
    const profilePrediction = fixture.modelPrediction ? `预测 ${isHome ? fixture.modelPrediction.home : fixture.modelPrediction.away} : ${isHome ? fixture.modelPrediction.away : fixture.modelPrediction.home}` : "";
    return `<article class="${assessment?.className || ""}">
      <span class="fixture-state ${fixture.status}">${fixture.status === "in" ? "直播" : fixture.status === "post" ? assessment?.label || "完赛" : fixture.stageName}</span>
      <div>${opponent ? teamMark(opponent, true) : teamMark(fallbackOpponent, true)}<b>${opponent?.name || fallbackOpponent.name}</b></div>
      <strong>${score}</strong>${fixture.status === "post" ? `<small class="profile-prediction">${profilePrediction}</small>` : ""}<small>${fixture.venue}</small>
    </article>`;
  }).join("") || `<p class="empty-state">暂无本届世界杯赛程</p>`;

  const opponentIds = [...new Set(worldCup.map((fixture) => fixture.home === teamId ? fixture.away : fixture.home).filter(Boolean))];
  $("profileH2h").innerHTML = opponentIds.map((opponentId) => {
    const opponent = teamById(opponentId);
    const meetings = history.matchHistory.filter((match) => match.opponentId === opponentId);
    const wins = meetings.filter((match) => ["W", "PW"].includes(match.result)).length;
    const draws = meetings.filter((match) => match.result === "D").length;
    const losses = meetings.length - wins - draws;
    return `<article>
      <button class="team-link" data-team-profile="${opponentId}">${teamMark(opponent, true)}<b>${opponent.name}</b></button>
      <strong>${meetings.length ? `${wins}胜 ${draws}平 ${losses}负` : "近四年未交手"}</strong>
      <small>${meetings[0] ? `最近：${meetings[0].date}　${meetings[0].goalsFor}:${meetings[0].goalsAgainst}` : "等待世界杯相遇"}</small>
    </article>`;
  }).join("") || `<p class="empty-state">淘汰赛对手尚未确定</p>`;

  $("profileHistoryCount").textContent = `${history.matches} 场 · 数据截至 ${historyBundle.periodEnd}`;
  $("profileHistory").innerHTML = history.matchHistory.map((match) => {
    const opponent = match.opponentId ? teamById(match.opponentId) : null;
    return `<article>
      <time>${match.date}</time><span class="result-chip ${profileResultClass(match)}">${profileResultLabel(match)}</span>
      <div>${opponent ? teamMark(opponent, true) : ""}<b>${opponent?.name || match.opponentName}</b><small>${match.home ? "主场" : match.neutral ? "中立场" : "客场"}</small></div>
      <strong>${match.goalsFor} : ${match.goalsAgainst}</strong><span>${match.tournament}</span>
    </article>`;
  }).join("");

  $("teamModal").hidden = false;
  document.body.classList.add("modal-open");
  bindProfileLinks();
  hydrateTeamProfile(team, history, worldCup, requestId);
}

function closeTeamProfile() {
  currentProfileRequest += 1;
  $("teamModal").hidden = true;
  document.body.classList.remove("modal-open");
}

function bindProfileLinks() {
  document.querySelectorAll("[data-team-profile]").forEach((button) => {
    if (button.dataset.profileBound) return;
    button.dataset.profileBound = "1";
    button.addEventListener("click", (event) => { event.stopPropagation(); renderTeamProfile(button.dataset.teamProfile); });
  });
}

function selectDefaultFixture() {
  const now = Date.now();
  return fixtures.find((fixture) => fixture.status === "in" && fixture.home && fixture.away)
    || fixtures.find((fixture) => fixture.status === "pre" && fixture.home && fixture.away && new Date(fixture.date).getTime() >= now - 6 * 60 * 60 * 1000)
    || [...fixtures].reverse().find((fixture) => fixture.status === "post" && fixture.home && fixture.away)
    || fixtures.find((fixture) => fixture.home && fixture.away);
}

function loadFixture(fixtureId, switchPage = true) {
  const fixture = fixtures.find((item) => item.id === fixtureId);
  if (!fixture?.home || !fixture?.away) return;
  state.selectedFixtureId = fixture.id;
  state.homeId = fixture.home;
  state.awayId = fixture.away;
  state.venue = fixture.venueMode || "neutral";
  $("homeTeam").value = state.homeId;
  $("awayTeam").value = state.awayId;
  document.querySelectorAll("[data-venue]").forEach((button) => button.classList.toggle("active", button.dataset.venue === state.venue));
  if (switchPage) switchView("dashboard");
  renderPrediction();
  if (switchPage) window.scrollTo({ top: 0, behavior: "smooth" });
}

function loadMatch(homeId, awayId, venue = "neutral") {
  if (!teamById(homeId) || !teamById(awayId)) return;
  state.homeId = homeId;
  state.awayId = awayId;
  state.selectedFixtureId = null;
  state.venue = venue;
  $("homeTeam").value = homeId;
  $("awayTeam").value = awayId;
  document.querySelectorAll("[data-venue]").forEach((button) => button.classList.toggle("active", button.dataset.venue === venue));
  switchView("dashboard");
  renderPrediction();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function switchView(view) {
  const titles = { dashboard: "比赛预测中心", matches: "比赛日程", simulation: "世界杯全程模拟", rankings: "动态战力排名", method: "模型与参数" };
  document.querySelectorAll(".view").forEach((section) => section.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  $(`${view}View`).classList.add("active");
  $("pageTitle").textContent = titles[view];
  if (view === "rankings") renderRankings();
  if (view === "matches") renderMatches();
  if (view === "simulation") renderSimulation();
  if (view === "method") renderModelAudit();
}

function auditPercent(value) {
  return `${Math.round(Number(value || 0) * 100)}%`;
}

function auditNumber(value, digits = 3) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "--";
}

function renderModelAudit() {
  const grid = $("modelAuditGrid");
  if (!grid) return;
  const audit = sourceMeta.predictionAudit || predictionAudit();
  const lockedAudit = sourceMeta.lockedPredictionAudit;
  const probabilityAudit = sourceMeta.probabilityEvaluation || {};
  const baselines = sourceMeta.predictionBaselines || {};
  const eloPoisson = baselines.eloPoisson || {};
  const calibration = sourceMeta.predictionCalibration || predictionCalibration();
  const conservative = Number(audit.avgGoalBias || 0) > 0.55 && Number(audit.underRate || 0) > 0.55;
  const cards = [
    `<article class="${audit.outcomeRate >= 0.55 ? "good" : "warning"}"><span>赛果命中</span><b>${auditPercent(audit.outcomeRate)}</b><small>${audit.samples || 0} 场完赛样本；完全比分 ${auditPercent(audit.exactRate)}</small></article>`,
    `<article class="${conservative ? "warning" : "good"}"><span>总进球偏差</span><b>${Number(audit.avgGoalBias || 0) >= 0 ? "+" : ""}${audit.avgGoalBias || 0}</b><small>预测 ${audit.avgPredictedGoals ?? "--"} / 真实 ${audit.avgActualGoals ?? "--"}；低估率 ${auditPercent(audit.underRate)}</small></article>`,
    `<article><span>平局偏差</span><b>${Number(audit.drawGap || 0) >= 0 ? "+" : ""}${auditPercent(audit.drawGap)}</b><small>预测平局 ${auditPercent(audit.predictedDrawRate)} / 真实平局 ${auditPercent(audit.actualDrawRate)}</small></article>`,
    `<article><span>比分平均误差</span><b>${audit.scoreMae ?? "--"}</b><small>按两队进球绝对误差均值计算</small></article>`,
    `<article class="wide"><span>当前校准动作</span><b>${calibration.samples || 0} 场反馈</b><small>xG 抬升 ${calibration.goalLift ?? 0}，比分阈值 ${calibration.modeLift ?? 0}，高比分压力 ${auditPercent(calibration.highScorePressure)}，低比分惩罚 ${calibration.lowTotalPressure ?? "--"}，开放平局谨慎 ${calibration.drawCaution ?? "--"}，平局风险 ${auditPercent(calibration.drawRisk)}，守成平局 ${auditPercent(calibration.resistanceDraw)}，赛果可靠度 ${auditPercent(calibration.outcomeReliability)}。${audit.recommendation || "继续滚动校准。"}</small></article>`,
    `<article class="wide"><span>强弱与方向风险</span><b>${audit.strongFavoriteFailures || 0} 场</b><small>冷门风险反馈 ${auditPercent(calibration.favoriteRisk)}；弱势方进球回拨 ${calibration.underdogLift ?? "--"}；强队大胜释放 ${calibration.favoriteSurge ?? "--"}；主客方向修正 ${Number(calibration.sideBias || 0) >= 0 ? "+" : ""}${auditPercent(calibration.sideBias)}。</small></article>`
  ];
  if (lockedAudit) {
    const biasDelta = Number(lockedAudit.avgGoalBias || 0) - Number(audit.avgGoalBias || 0);
    const maeDelta = Number(lockedAudit.scoreMae || 0) - Number(audit.scoreMae || 0);
    cards.push(`<article class="wide good"><span>当前模型 vs 原赛前快照</span><b>${biasDelta >= 0 ? "-" : "+"}${Math.abs(biasDelta).toFixed(2)} 总进球偏差</b><small>原快照赛果命中 ${auditPercent(lockedAudit.outcomeRate)} / 当前回放 ${auditPercent(audit.outcomeRate)}；比分误差改善 ${maeDelta >= 0 ? "-" : "+"}${Math.abs(maeDelta).toFixed(2)}。页面历史比分仍保留赛前锁定值，模型校准使用当前回放值。</small></article>`);
  }
  if (probabilityAudit.count) {
    const logLossOk = Number(probabilityAudit.logLoss) < 1;
    const brierOk = Number(probabilityAudit.brierScore) < 0.58;
    const eceOk = Number(probabilityAudit.ece) < 0.04;
    const top3Ok = Number(probabilityAudit.top3ScoreCoverage) >= 0.3;
    cards.push(
      `<article class="${probabilityAudit.count >= 500 ? "good" : "warning"}"><span>已回看比赛</span><b>${probabilityAudit.count}</b><small>系统会用已完赛场次持续回看预测表现；样本越多，概率参考会越稳定。当前结果适合观察趋势，不代表确定结论。</small></article>`,
      `<article class="${logLossOk ? "good" : "warning"}"><span>Log Loss</span><b>${auditNumber(probabilityAudit.logLoss)}</b><small>目标低于 1.00；Elo+Poisson 基准 ${auditNumber(eloPoisson.logLoss)}，越低越好。</small></article>`,
      `<article class="${brierOk ? "good" : "warning"}"><span>Brier Score</span><b>${auditNumber(probabilityAudit.brierScore)}</b><small>目标低于 0.58；随机三分类约 0.667，Elo+Poisson ${auditNumber(eloPoisson.brierScore)}。</small></article>`,
      `<article class="${eceOk ? "good" : "warning"}"><span>概率校准 ECE</span><b>${auditPercent(probabilityAudit.ece)}</b><small>目标低于 4%；这个指标衡量“60% 胜率是否真的接近赢 60%”。</small></article>`,
      `<article class="${top3Ok ? "good" : "warning"}"><span>前三比分覆盖</span><b>${auditPercent(probabilityAudit.top3ScoreCoverage)}</b><small>第一比分 ${auditPercent(probabilityAudit.firstScoreAccuracy)}；总进球误差≤1球 ${auditPercent(probabilityAudit.totalGoalWithinOneRate)}；综合 MAE ${auditNumber(probabilityAudit.combinedGoalMae, 2)}。</small></article>`,
      `<article class="wide ${Number(probabilityAudit.drawRecall) >= 0.25 ? "good" : "warning"}"><span>平局与类别表现</span><b>平局召回 ${auditPercent(probabilityAudit.drawRecall)}</b><small>宏平均 F1 ${auditNumber(probabilityAudit.macroF1)}；不能只追求总体命中率，平局和冷门识别不足会导致概率过度自信。</small></article>`,
      `<article class="wide"><span>基准模型比较</span><b>Elo+Poisson ${auditPercent(eloPoisson.outcomeAccuracy)}</b><small>当前模型胜平负命中 ${auditPercent(probabilityAudit.outcomeAccuracy)}；必须长期稳定优于随机、固定比分、Elo 和 Elo+Poisson，才算真正有模型价值。</small></article>`
    );
  }
  grid.innerHTML = cards.join("");
}

function updateSyncStatus(mode, message) {
  const stateNode = $("syncState");
  stateNode.className = mode;
  stateNode.innerHTML = `<i class="live-dot"></i>${message}`;
  $("syncButton").disabled = mode === "syncing";
}

async function syncLiveData(force = false) {
  updateSyncStatus("syncing", "正在同步赛事");
  try {
    const data = await fetchLivePayload(force);
    if (!Array.isArray(data.teams) || !data.teams.length || !Array.isArray(data.fixtures)) throw new Error("数据格式不完整");
    teams = data.modelVersion === RATING_MODEL_VERSION || data.modelVersion === "goalmind-history-v1" ? data.teams : applyHistoricalRatings(data.teams);
    fixtures = data.fixtures;
    sourceMeta = data;
    populateSelects();

    const selected = currentFixture();
    if (!selected || !selected.home || !selected.away || !teamById(selected.home) || !teamById(selected.away)) {
      const defaultFixture = selectDefaultFixture();
      if (defaultFixture) {
        state.selectedFixtureId = defaultFixture.id;
        state.homeId = defaultFixture.home;
        state.awayId = defaultFixture.away;
        state.venue = defaultFixture.venueMode;
      }
    }
    liveReady = true;
    renderAll();
    updateSyncStatus(data.stale ? "stale" : "ready", data.stale ? "缓存数据 · 等待网络" : "实时数据已连接");
    $("sidebarSyncText").textContent = data.stale ? "最近缓存" : `最近同步 ${formatSyncTime(data.fetchedAt)}`;
    refreshCompletedMatchLearning().then(() => {
      if (currentFixture()?.status === "pre") renderPrediction();
    });
    if (force) showToast(data.stale ? "网络暂不可用，已保留最近数据" : "赛事与动态战力已更新");
  } catch (error) {
    teams = bundledTeamsForDisplay(bundledFallback);
    fixtures = structuredClone(bundledFallback.fixtures);
    sourceMeta = { ...bundledFallback, stale: true };
    populateSelects();
    updateSyncStatus("stale", "实时源暂不可用 · 使用完整缓存");
    $("sidebarSyncText").textContent = "完整赛事缓存";
    if (force) showToast(`${error.message}，已显示完整缓存`);
    renderAll();
  }
}

function showToast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => $("toast").classList.remove("show"), 2200);
}

function renderAll() {
  ensureFixturePredictions();
  $("matchCount").textContent = `${fixtures.length} 场`;
  $("teamCount").textContent = `${teams.length} 支`;
  $("syncTime").textContent = formatSyncTime(sourceMeta.fetchedAt);
  $("scheduleDataBadge").textContent = sourceMeta.stale ? "缓存赛程" : `${fixtures.length} 场实时赛程`;
  if ($("homeTeam").options.length !== teams.length) populateSelects();
  $("homeTeam").value = state.homeId;
  $("awayTeam").value = state.awayId;
  renderPrediction();
  if ($("rankingsView").classList.contains("active")) renderRankings();
  if ($("matchesView").classList.contains("active")) renderMatches();
  if ($("simulationView").classList.contains("active")) renderSimulation();
  if ($("methodView").classList.contains("active")) renderModelAudit();
  bindProfileLinks();
}

function bindEvents() {
  $("homeTeam").addEventListener("change", (event) => {
    if (event.target.value === state.awayId) { event.target.value = state.homeId; showToast("请选择不同的球队"); return; }
    state.homeId = event.target.value; state.selectedFixtureId = null; renderPrediction();
  });
  $("awayTeam").addEventListener("change", (event) => {
    if (event.target.value === state.homeId) { event.target.value = state.awayId; showToast("请选择不同的球队"); return; }
    state.awayId = event.target.value; state.selectedFixtureId = null; renderPrediction();
  });
  $("swapTeams").addEventListener("click", () => {
    [state.homeId, state.awayId] = [state.awayId, state.homeId];
    state.selectedFixtureId = null;
    $("homeTeam").value = state.homeId; $("awayTeam").value = state.awayId; renderPrediction();
  });
  document.querySelectorAll("[data-venue]").forEach((button) => button.addEventListener("click", () => {
    state.venue = button.dataset.venue;
    state.selectedFixtureId = null;
    document.querySelectorAll("[data-venue]").forEach((item) => item.classList.toggle("active", item === button));
    renderPrediction();
  }));
  document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
  document.querySelectorAll("[data-go-view]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.goView)));
  document.querySelectorAll(".filter-button").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll(".filter-button").forEach((item) => item.classList.toggle("active", item === button));
    renderMatches(button.dataset.filter);
  }));
  ["syncButton", "syncRatingsTop"].forEach((id) => $(id).addEventListener("click", () => syncLiveData(true)));
  $("rerunSimulation").addEventListener("click", () => { renderSimulation(); showToast("已按最新真实赛果重新推演"); });
  $("themeButton").addEventListener("click", () => document.body.classList.toggle("soft-light"));
  document.querySelectorAll("[data-profile-side]").forEach((button) => button.addEventListener("click", () => renderTeamProfile(state[`${button.dataset.profileSide}Id`])));
  document.querySelectorAll("[data-close-profile]").forEach((button) => button.addEventListener("click", closeTeamProfile));
  $("teamModal").addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-profile-accordion]");
    if (!trigger) return;
    const expanded = trigger.getAttribute("aria-expanded") !== "true";
    trigger.setAttribute("aria-expanded", String(expanded));
    trigger.closest(".profile-accordion")?.classList.toggle("is-open", expanded);
    const panel = $(trigger.getAttribute("aria-controls"));
    if (panel) panel.hidden = !expanded;
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !$("teamModal").hidden) closeTeamProfile(); });
  [["kFactor", "kFactorOutput", "k"], ["homeBonus", "homeBonusOutput", "homeBonus"], ["formWeight", "formWeightOutput", "formWeight"]].forEach(([inputId, outputId, key]) => {
    $(inputId).addEventListener("input", (event) => {
      state[key] = Number(event.target.value);
      $(outputId).textContent = event.target.value;
      renderAll();
    });
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && liveReady) syncLiveData(false); });
}

populateSelects();
bindEvents();
renderAll();
syncLiveData(false);
syncTimer = setInterval(() => syncLiveData(false), 60 * 1000);
