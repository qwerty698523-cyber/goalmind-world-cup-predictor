const data = require("../live-cache.json");

function outcome(home, away) {
  return home > away ? "home" : home < away ? "away" : "draw";
}

function summarize(rows) {
  const count = rows.length || 1;
  const predictedGoals = rows.reduce((sum, row) => sum + row.predictedTotal, 0);
  const actualGoals = rows.reduce((sum, row) => sum + row.actualTotal, 0);
  return {
    count: rows.length,
    outcomeRate: Number((rows.filter((row) => row.predictedOutcome === row.actualOutcome).length / count).toFixed(3)),
    exactRate: Number((rows.filter((row) => row.predicted === row.actual).length / count).toFixed(3)),
    avgPredictedGoals: Number((predictedGoals / count).toFixed(2)),
    avgActualGoals: Number((actualGoals / count).toFixed(2)),
    avgGoalBias: Number(((actualGoals - predictedGoals) / count).toFixed(2)),
    actualDrawRate: Number((rows.filter((row) => row.actualOutcome === "draw").length / count).toFixed(3)),
    actualAwayRate: Number((rows.filter((row) => row.actualOutcome === "away").length / count).toFixed(3))
  };
}

function main() {
  const teams = Object.fromEntries((data.teams || []).map((team) => [team.id, team]));
  const buckets = {
    all: [],
    strongFavorite: [],
    closeMatch: [],
    predictedDraw: [],
    actualDraw: [],
    underPredictedGoals: [],
    overPredictedGoals: [],
    wrongOutcome: [],
    favoriteFailed: [],
    awayUpsideMissed: []
  };

  for (const fixture of data.fixtures || []) {
    if (!(fixture.completed || fixture.status === "post") || !fixture.home || !fixture.away || !fixture.modelPrediction) continue;
    const prediction = fixture.currentModelPrediction || fixture.modelPrediction;
    const predictedHome = Number(prediction.home || 0);
    const predictedAway = Number(prediction.away || 0);
    const actualHome = Number(fixture.homeScore || 0);
    const actualAway = Number(fixture.awayScore || 0);
    const home = teams[fixture.home];
    const away = teams[fixture.away];
    const ratingGap = home && away ? home.elo - away.elo + (fixture.venueMode === "home" ? 65 : 0) : 0;
    const expectedHome = Number(fixture.ratingUpdate?.expectedHome);
    const row = {
      id: fixture.id,
      teams: `${home?.name || fixture.home} vs ${away?.name || fixture.away}`,
      predicted: `${predictedHome}:${predictedAway}`,
      actual: `${actualHome}:${actualAway}`,
      predictedTotal: predictedHome + predictedAway,
      actualTotal: actualHome + actualAway,
      predictedOutcome: outcome(predictedHome, predictedAway),
      actualOutcome: outcome(actualHome, actualAway),
      ratingGap: Number(ratingGap.toFixed(0)),
      expectedHome: Number.isFinite(expectedHome) ? expectedHome : null
    };

    buckets.all.push(row);
    if (Math.abs(ratingGap) >= 260) buckets.strongFavorite.push(row);
    if (Math.abs(ratingGap) < 180) buckets.closeMatch.push(row);
    if (row.predictedOutcome === "draw") buckets.predictedDraw.push(row);
    if (row.actualOutcome === "draw") buckets.actualDraw.push(row);
    if (row.predictedTotal < row.actualTotal) buckets.underPredictedGoals.push(row);
    if (row.predictedTotal > row.actualTotal) buckets.overPredictedGoals.push(row);
    if (row.predictedOutcome !== row.actualOutcome) buckets.wrongOutcome.push(row);
    if ((expectedHome >= 0.68 && row.actualOutcome !== "home") || (expectedHome <= 0.32 && row.actualOutcome !== "away")) buckets.favoriteFailed.push(row);
    if (row.predictedOutcome !== "away" && row.actualOutcome === "away") buckets.awayUpsideMissed.push(row);
  }

  const summary = Object.fromEntries(Object.entries(buckets).map(([key, rows]) => [key, summarize(rows)]));
  const worstUnderPredictions = [...buckets.underPredictedGoals]
    .sort((a, b) => (b.actualTotal - b.predictedTotal) - (a.actualTotal - a.predictedTotal))
    .slice(0, 10);

  console.log(JSON.stringify({
    modelVersion: data.modelVersion,
    calibration: data.predictionCalibration,
    summary,
    worstUnderPredictions
  }, null, 2));
}

main();
