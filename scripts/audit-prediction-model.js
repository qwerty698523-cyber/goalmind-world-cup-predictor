const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const cachePath = path.join(ROOT, "live-cache.json");

function outcome(home, away) {
  return home > away ? "home" : home < away ? "away" : "draw";
}

function pct(value) {
  return `${Math.round(value * 100)}%`;
}

function main() {
  const data = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  const completed = (data.fixtures || []).filter((fixture) =>
    (fixture.completed || fixture.status === "post")
    && fixture.home
    && fixture.away
    && fixture.modelPrediction
  );
  const future = (data.fixtures || []).filter((fixture) =>
    !(fixture.completed || fixture.status === "post")
    && fixture.home
    && fixture.away
    && fixture.modelPrediction
  );

  if (!completed.length) {
    throw new Error("No completed fixtures with predictions were found.");
  }

  let exact = 0;
  let outcomeHits = 0;
  let predictedGoals = 0;
  let actualGoals = 0;
  let under = 0;
  completed.forEach((fixture) => {
    const prediction = fixture.currentModelPrediction || fixture.modelPrediction;
    const predHome = Number(prediction.home || 0);
    const predAway = Number(prediction.away || 0);
    const actualHome = Number(fixture.homeScore || 0);
    const actualAway = Number(fixture.awayScore || 0);
    if (predHome === actualHome && predAway === actualAway) exact += 1;
    if (outcome(predHome, predAway) === outcome(actualHome, actualAway)) outcomeHits += 1;
    predictedGoals += predHome + predAway;
    actualGoals += actualHome + actualAway;
    if (predHome + predAway < actualHome + actualAway) under += 1;
  });

  const futureAverage = future.reduce((sum, fixture) =>
    sum + Number(fixture.modelPrediction.home || 0) + Number(fixture.modelPrediction.away || 0), 0) / Math.max(1, future.length);
  const summary = {
    modelVersion: data.modelVersion,
    completed: completed.length,
    future: future.length,
    exactRate: exact / completed.length,
    outcomeRate: outcomeHits / completed.length,
    avgPredictedGoals: predictedGoals / completed.length,
    avgActualGoals: actualGoals / completed.length,
    underRate: under / completed.length,
    futureAverage,
    underdogLift: data.predictionCalibration?.underdogLift,
    lowTotalPressure: data.predictionCalibration?.lowTotalPressure,
    favoriteSurge: data.predictionCalibration?.favoriteSurge,
    drawCaution: data.predictionCalibration?.drawCaution,
    resistanceDraw: data.predictionCalibration?.resistanceDraw,
    highScorePressure: data.predictionCalibration?.highScorePressure
  };

  console.log(JSON.stringify({
    ...summary,
    exactRateText: pct(summary.exactRate),
    outcomeRateText: pct(summary.outcomeRate),
    underRateText: pct(summary.underRate),
    avgPredictedGoals: Number(summary.avgPredictedGoals.toFixed(2)),
    avgActualGoals: Number(summary.avgActualGoals.toFixed(2)),
    futureAverage: Number(summary.futureAverage.toFixed(2))
  }, null, 2));

  if (data.modelVersion !== "goalmind-dynamic-power-v4") {
    throw new Error(`Unexpected model version: ${data.modelVersion}`);
  }
  if (future.length && summary.futureAverage < 2.15) {
    throw new Error(`Future predictions are too conservative: ${summary.futureAverage.toFixed(2)} goals per match.`);
  }
  if (completed.length >= 20 && !data.predictionAudit) {
    throw new Error("Prediction audit is missing from live-cache.json.");
  }
  if (completed.length >= 20 && !data.predictionCalibration) {
    throw new Error("Prediction calibration is missing from live-cache.json.");
  }
  if (completed.length >= 20 && !Number.isFinite(Number(data.predictionCalibration.underdogLift))) {
    throw new Error("Prediction calibration is missing underdogLift.");
  }
  if (completed.length >= 20 && !Number.isFinite(Number(data.predictionCalibration.lowTotalPressure))) {
    throw new Error("Prediction calibration is missing lowTotalPressure.");
  }
  if (completed.length >= 20 && !Number.isFinite(Number(data.predictionCalibration.favoriteSurge))) {
    throw new Error("Prediction calibration is missing favoriteSurge.");
  }
  if (completed.length >= 20 && !Number.isFinite(Number(data.predictionCalibration.drawCaution))) {
    throw new Error("Prediction calibration is missing drawCaution.");
  }
  if (completed.length >= 20 && !Number.isFinite(Number(data.predictionCalibration.resistanceDraw))) {
    throw new Error("Prediction calibration is missing resistanceDraw.");
  }
  if (completed.length >= 20 && !Number.isFinite(Number(data.predictionCalibration.highScorePressure))) {
    throw new Error("Prediction calibration is missing highScorePressure.");
  }
}

main();
