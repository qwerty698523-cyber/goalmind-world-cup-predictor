const live = require("../live-cache.json");
const history = require("../history-data.json");
const {
  modelPredictedScore,
  predictionCalibration,
  objectiveRatingUpdate,
  performanceSignal,
  clamp
} = require("../server");
const {
  evaluatePredictionRecords,
  randomOutcomeBaseline,
  fixedScoreBaseline
} = require("./model-evaluation");
const {
  eloOutcomeBaselinePrediction,
  eloPoissonBaselinePrediction
} = require("./model-baselines");

function outcome(home, away) {
  return home > away ? "home" : home < away ? "away" : "draw";
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildReplayTeams() {
  return new Map((live.teams || []).map((team) => {
    const model = history.teams?.[team.id];
    const replayTeam = model
      ? {
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
          lastMatchDelta: 0
        }
      : { ...team, elo: team.preTournamentElo || team.elo, trend: 0, lastMatchDelta: 0 };
    return [team.id, replayTeam];
  }));
}

function summarize(rows) {
  const count = rows.length || 1;
  const exact = rows.filter((row) => row.predicted === row.actual).length;
  const outcomes = rows.filter((row) => row.predictedOutcome === row.actualOutcome).length;
  const predictedGoals = rows.reduce((sum, row) => sum + row.predictedTotal, 0);
  const actualGoals = rows.reduce((sum, row) => sum + row.actualTotal, 0);
  const absoluteScoreError = rows.reduce((sum, row) => sum + Math.abs(row.predictedHome - row.actualHome) + Math.abs(row.predictedAway - row.actualAway), 0);
  return {
    count: rows.length,
    exactRate: Number((exact / count).toFixed(3)),
    outcomeRate: Number((outcomes / count).toFixed(3)),
    avgPredictedGoals: Number((predictedGoals / count).toFixed(2)),
    avgActualGoals: Number((actualGoals / count).toFixed(2)),
    avgGoalBias: Number(((actualGoals - predictedGoals) / count).toFixed(2)),
    underRate: Number((rows.filter((row) => row.predictedTotal < row.actualTotal).length / count).toFixed(3)),
    overRate: Number((rows.filter((row) => row.predictedTotal > row.actualTotal).length / count).toFixed(3)),
    predictedDrawRate: Number((rows.filter((row) => row.predictedOutcome === "draw").length / count).toFixed(3)),
    actualDrawRate: Number((rows.filter((row) => row.actualOutcome === "draw").length / count).toFixed(3)),
    scoreMae: Number((absoluteScoreError / count / 2).toFixed(2))
  };
}

function rowForFixture(fixture, prediction, source) {
  const predictedHome = Number(prediction.home || 0);
  const predictedAway = Number(prediction.away || 0);
  const actualHome = Number(fixture.homeScore || 0);
  const actualAway = Number(fixture.awayScore || 0);
  return {
    id: fixture.id,
    source,
    stage: fixture.stageName,
    home: fixture.home,
    away: fixture.away,
    predicted: `${predictedHome}:${predictedAway}`,
    actual: `${actualHome}:${actualAway}`,
    predictedHome,
    predictedAway,
    actualHome,
    actualAway,
    predictedTotal: predictedHome + predictedAway,
    actualTotal: actualHome + actualAway,
    predictedOutcome: outcome(predictedHome, predictedAway),
    actualOutcome: outcome(actualHome, actualAway)
  };
}

function evaluationRecord(fixture, prediction) {
  return {
    prediction,
    actual: {
      home: Number(fixture.homeScore || 0),
      away: Number(fixture.awayScore || 0)
    }
  };
}

function applyRatingUpdate(home, away, fixture, update) {
  home.elo += update.homeDelta;
  away.elo += update.awayDelta;
  home.trend += update.homeDelta;
  away.trend += update.awayDelta;
  home.lastMatchDelta = update.homeDelta;
  away.lastMatchDelta = update.awayDelta;

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
}

function groupedSummary(rows) {
  return {
    all: summarize(rows),
    groupStage: summarize(rows.filter((row) => row.stage === "小组赛")),
    knockout: summarize(rows.filter((row) => row.stage !== "小组赛")),
    closeMatches: summarize(rows.filter((row) => Math.abs(row.ratingGap || 0) < 180)),
    highScoringActual: summarize(rows.filter((row) => row.actualTotal >= 4)),
    predictedDraws: summarize(rows.filter((row) => row.predictedOutcome === "draw"))
  };
}

function main() {
  const replayTeams = buildReplayTeams();
  const replaySamples = [];
  const replayRows = [];
  const cacheRows = [];
  const replayEvaluationRecords = [];
  const cacheEvaluationRecords = [];
  const eloBaselineRecords = [];
  const eloPoissonBaselineRecords = [];
  const orderedFixtures = clone(live.fixtures || []).sort((a, b) => new Date(a.date) - new Date(b.date));

  for (const fixture of orderedFixtures) {
    if (!fixture.home || !fixture.away) continue;
    const home = replayTeams.get(fixture.home);
    const away = replayTeams.get(fixture.away);
    if (!home || !away) continue;

    const calibration = predictionCalibration(replaySamples);
    const prediction = modelPredictedScore(home, away, fixture.venueMode, fixture, calibration);
    if (!(fixture.completed || fixture.status === "post")) continue;

    const replayFixture = { ...fixture, modelPrediction: prediction };
    const update = objectiveRatingUpdate(home, away, replayFixture, calibration);
    replayFixture.ratingUpdate = update;

    const replayRow = rowForFixture(replayFixture, prediction, "current-model-replay");
    replayRow.ratingGap = Math.round(home.elo - away.elo + (fixture.venueMode === "home" ? 65 : 0));
    replayRows.push(replayRow);
    replayEvaluationRecords.push(evaluationRecord(fixture, prediction));
    eloBaselineRecords.push(evaluationRecord(fixture, eloOutcomeBaselinePrediction(home, away, fixture)));
    eloPoissonBaselineRecords.push(evaluationRecord(fixture, eloPoissonBaselinePrediction(home, away, fixture)));
    if (fixture.modelPrediction) {
      cacheRows.push(rowForFixture(fixture, fixture.modelPrediction, "locked-cache"));
      cacheEvaluationRecords.push(evaluationRecord(fixture, fixture.modelPrediction));
    }

    applyRatingUpdate(home, away, fixture, update);
    replaySamples.push(replayFixture);
  }

  const replaySummary = groupedSummary(replayRows);
  const cacheSummary = groupedSummary(cacheRows);
  const probabilityEvaluation = evaluatePredictionRecords(replayEvaluationRecords);
  const lockedProbabilityEvaluation = evaluatePredictionRecords(cacheEvaluationRecords);
  const futureFixtures = orderedFixtures.filter((fixture) => !(fixture.completed || fixture.status === "post") && fixture.home && fixture.away);
  const finalCalibration = predictionCalibration(replaySamples);
  const futurePreview = futureFixtures.slice(0, 16).map((fixture) => {
    const home = replayTeams.get(fixture.home);
    const away = replayTeams.get(fixture.away);
    const prediction = home && away ? modelPredictedScore(home, away, fixture.venueMode, fixture, finalCalibration) : null;
    return prediction ? {
      id: fixture.id,
      stage: fixture.stageName,
      match: `${fixture.home} vs ${fixture.away}`,
      prediction: `${prediction.home}:${prediction.away}`,
      total: Number(prediction.home) + Number(prediction.away),
      xg: prediction.xg
    } : null;
  }).filter(Boolean);

  console.log(JSON.stringify({
    modelVersion: live.modelVersion,
    replayedCompletedMatches: replayRows.length,
    replayCalibration: finalCalibration,
    replaySummary,
    probabilityEvaluation,
    baselines: {
      randomOutcome: randomOutcomeBaseline(replayEvaluationRecords),
      elo: evaluatePredictionRecords(eloBaselineRecords),
      eloPoisson: evaluatePredictionRecords(eloPoissonBaselineRecords),
      fixedScores: {
        "1:0": fixedScoreBaseline(replayEvaluationRecords, 1, 0),
        "1:1": fixedScoreBaseline(replayEvaluationRecords, 1, 1),
        "0:1": fixedScoreBaseline(replayEvaluationRecords, 0, 1)
      }
    },
    lockedCacheSummary: cacheSummary,
    lockedProbabilityEvaluation,
    deltaVsLockedCache: {
      outcomeRate: Number((replaySummary.all.outcomeRate - cacheSummary.all.outcomeRate).toFixed(3)),
      exactRate: Number((replaySummary.all.exactRate - cacheSummary.all.exactRate).toFixed(3)),
      avgGoalBias: Number((replaySummary.all.avgGoalBias - cacheSummary.all.avgGoalBias).toFixed(2)),
      scoreMae: Number((replaySummary.all.scoreMae - cacheSummary.all.scoreMae).toFixed(2))
    },
    futurePreview
  }, null, 2));
}

main();
