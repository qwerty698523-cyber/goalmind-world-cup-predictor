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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function outcome(home, away) {
  return home > away ? "home" : home < away ? "away" : "draw";
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
    predictedDrawRate: Number((rows.filter((row) => row.predictedOutcome === "draw").length / count).toFixed(3)),
    actualDrawRate: Number((rows.filter((row) => row.actualOutcome === "draw").length / count).toFixed(3)),
    scoreMae: Number((absoluteScoreError / count / 2).toFixed(2))
  };
}

function replayModel() {
  const replayTeams = buildReplayTeams();
  const replaySamples = [];
  const replayRows = [];
  const evaluationRecords = [];
  const eloRecords = [];
  const eloPoissonRecords = [];
  const orderedFixtures = clone(live.fixtures || []).sort((a, b) => new Date(a.date) - new Date(b.date));

  for (const fixture of orderedFixtures) {
    if (!fixture.home || !fixture.away) continue;
    const home = replayTeams.get(fixture.home);
    const away = replayTeams.get(fixture.away);
    if (!home || !away) continue;

    const calibration = predictionCalibration(replaySamples);
    const prediction = modelPredictedScore(home, away, fixture.venueMode, fixture, calibration);
    if (!(fixture.completed || fixture.status === "post")) continue;

    const predictedHome = Number(prediction.home || 0);
    const predictedAway = Number(prediction.away || 0);
    const actualHome = Number(fixture.homeScore || 0);
    const actualAway = Number(fixture.awayScore || 0);
    const replayFixture = { ...fixture, modelPrediction: prediction };
    const update = objectiveRatingUpdate(home, away, replayFixture, calibration);
    replayFixture.ratingUpdate = update;
    replayRows.push({
      id: fixture.id,
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
      actualOutcome: outcome(actualHome, actualAway),
      expectedHome: update.expectedHome,
      ratingGap: Math.round(home.elo - away.elo + (fixture.venueMode === "home" ? 65 : 0))
    });
    evaluationRecords.push({
      prediction,
      actual: { home: actualHome, away: actualAway }
    });
    eloRecords.push({
      prediction: eloOutcomeBaselinePrediction(home, away, fixture),
      actual: { home: actualHome, away: actualAway }
    });
    eloPoissonRecords.push({
      prediction: eloPoissonBaselinePrediction(home, away, fixture),
      actual: { home: actualHome, away: actualAway }
    });

    applyRatingUpdate(home, away, fixture, update);
    replaySamples.push(replayFixture);
  }

  const probabilityEvaluation = evaluatePredictionRecords(evaluationRecords);
  return {
    calibration: predictionCalibration(replaySamples),
    probabilityEvaluation,
    baselines: {
      randomOutcome: randomOutcomeBaseline(evaluationRecords),
      elo: evaluatePredictionRecords(eloRecords),
      eloPoisson: evaluatePredictionRecords(eloPoissonRecords),
      fixed10: fixedScoreBaseline(evaluationRecords, 1, 0),
      fixed11: fixedScoreBaseline(evaluationRecords, 1, 1),
      fixed01: fixedScoreBaseline(evaluationRecords, 0, 1)
    },
    all: summarize(replayRows),
    highScoringActual: summarize(replayRows.filter((row) => row.actualTotal >= 4)),
    strongFavorite: summarize(replayRows.filter((row) => Math.abs(row.ratingGap) >= 220)),
    closeMatches: summarize(replayRows.filter((row) => Math.abs(row.ratingGap) < 180))
  };
}

const gateFailures = [];

function assertGate(name, passed, actual, expected) {
  if (!passed) {
    gateFailures.push(`${name} failed: actual ${actual}, expected ${expected}`);
  }
}

function main() {
  const summary = replayModel();
  console.log(JSON.stringify(summary, null, 2));
  assertGate("overall outcome rate", summary.all.outcomeRate >= 0.69, summary.all.outcomeRate, ">= 0.69");
  assertGate("overall exact rate", summary.all.exactRate >= 0.15, summary.all.exactRate, ">= 0.15");
  assertGate("overall score error", summary.all.scoreMae <= 0.88, summary.all.scoreMae, "<= 0.88");
  assertGate("beats Elo+Poisson log loss", summary.probabilityEvaluation.logLoss <= summary.baselines.eloPoisson.logLoss * 0.95, summary.probabilityEvaluation.logLoss, `<= ${Number((summary.baselines.eloPoisson.logLoss * 0.95).toFixed(3))}`);
  assertGate("beats Elo+Poisson brier", summary.probabilityEvaluation.brierScore <= summary.baselines.eloPoisson.brierScore * 0.95, summary.probabilityEvaluation.brierScore, `<= ${Number((summary.baselines.eloPoisson.brierScore * 0.95).toFixed(3))}`);
  assertGate("probability log loss", summary.probabilityEvaluation.logLoss < 1.0, summary.probabilityEvaluation.logLoss, "< 1.0");
  assertGate("probability brier score", summary.probabilityEvaluation.brierScore < 0.58, summary.probabilityEvaluation.brierScore, "< 0.58");
  assertGate("calibration ECE", summary.probabilityEvaluation.ece < 0.04, summary.probabilityEvaluation.ece, "< 0.04");
  assertGate("top-3 score coverage", summary.probabilityEvaluation.top3ScoreCoverage >= 0.3, summary.probabilityEvaluation.top3ScoreCoverage, ">= 0.30");
  assertGate("total goal within one", summary.probabilityEvaluation.totalGoalWithinOneRate >= 0.65, summary.probabilityEvaluation.totalGoalWithinOneRate, ">= 0.65");
  assertGate("high-scoring goal bias", summary.highScoringActual.avgGoalBias <= 2.2, summary.highScoringActual.avgGoalBias, "<= 2.2");
  assertGate("strong-favorite goal bias", summary.strongFavorite.avgGoalBias <= 1.05, summary.strongFavorite.avgGoalBias, "<= 1.05");
  assertGate("close-match outcome rate", summary.closeMatches.outcomeRate >= 0.68, summary.closeMatches.outcomeRate, ">= 0.68");
  if (gateFailures.length) {
    throw new Error(`Model quality gate failed:\n- ${gateFailures.join("\n- ")}`);
  }
}

main();
