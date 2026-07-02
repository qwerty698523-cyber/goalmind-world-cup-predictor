const OUTCOMES = ["home", "draw", "away"];
const PROBABILITY_FLOOR = 1e-9;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, digits = 3) {
  return Number(Number(value || 0).toFixed(digits));
}

function outcomeFromScore(home, away) {
  const homeGoals = Number(home || 0);
  const awayGoals = Number(away || 0);
  if (homeGoals > awayGoals) return "home";
  if (homeGoals < awayGoals) return "away";
  return "draw";
}

function normalizeOutcomeProbabilities(input = {}) {
  const raw = {
    home: Number(input.home ?? input.homeWin ?? input.home_win ?? 0),
    draw: Number(input.draw ?? 0),
    away: Number(input.away ?? input.awayWin ?? input.away_win ?? 0)
  };
  let total = raw.home + raw.draw + raw.away;
  if (!Number.isFinite(total) || total <= 0) {
    raw.home = raw.draw = raw.away = 1 / 3;
    total = 1;
  }
  return {
    homeWin: clamp(raw.home / total, PROBABILITY_FLOOR, 1),
    draw: clamp(raw.draw / total, PROBABILITY_FLOOR, 1),
    awayWin: clamp(raw.away / total, PROBABILITY_FLOOR, 1)
  };
}

function probabilityForOutcome(probabilities, outcome) {
  const normalized = normalizeOutcomeProbabilities(probabilities);
  if (outcome === "home") return normalized.homeWin;
  if (outcome === "away") return normalized.awayWin;
  return normalized.draw;
}

function brierScore(probabilities, actualOutcome) {
  const normalized = normalizeOutcomeProbabilities(probabilities);
  return OUTCOMES.reduce((sum, outcome) => {
    const predicted = outcome === "home" ? normalized.homeWin : outcome === "away" ? normalized.awayWin : normalized.draw;
    const actual = outcome === actualOutcome ? 1 : 0;
    return sum + (predicted - actual) ** 2;
  }, 0);
}

function logLoss(probabilities, actualOutcome) {
  return -Math.log(clamp(probabilityForOutcome(probabilities, actualOutcome), PROBABILITY_FLOOR, 1));
}

function predictedOutcome(probabilities) {
  const normalized = normalizeOutcomeProbabilities(probabilities);
  if (normalized.homeWin >= normalized.draw && normalized.homeWin >= normalized.awayWin) return "home";
  if (normalized.awayWin >= normalized.draw) return "away";
  return "draw";
}

function deterministicProbabilities(home, away) {
  const outcome = outcomeFromScore(home, away);
  return normalizeOutcomeProbabilities({
    homeWin: outcome === "home" ? 1 : 0,
    draw: outcome === "draw" ? 1 : 0,
    awayWin: outcome === "away" ? 1 : 0
  });
}

function predictionProbabilities(prediction = {}) {
  if (prediction.probabilities) return normalizeOutcomeProbabilities(prediction.probabilities);
  if (Number.isFinite(Number(prediction.homeWin)) || Number.isFinite(Number(prediction.draw)) || Number.isFinite(Number(prediction.awayWin))) {
    return normalizeOutcomeProbabilities(prediction);
  }
  return deterministicProbabilities(prediction.home, prediction.away);
}

function scoreKey(home, away) {
  return `${Number(home || 0)}:${Number(away || 0)}`;
}

function scoreCandidates(prediction = {}) {
  const candidates = Array.isArray(prediction.scoreCandidates) ? prediction.scoreCandidates : [];
  if (candidates.length) {
    return candidates
      .map((candidate) => ({
        home: Number(candidate.home || 0),
        away: Number(candidate.away || 0),
        probability: Number(candidate.probability || 0)
      }));
  }
  return [{
    home: Number(prediction.home || 0),
    away: Number(prediction.away || 0),
    probability: Number(prediction.probability || prediction.scoreProbability || 1)
  }];
}

function scoreDistribution(prediction = {}) {
  const distribution = Array.isArray(prediction.scoreDistribution)
    ? prediction.scoreDistribution
    : Array.isArray(prediction.scoreMatrix)
      ? prediction.scoreMatrix
      : [];
  if (distribution.length) {
    return distribution.map((item) => ({
      home: Number(item.home || 0),
      away: Number(item.away || 0),
      probability: Number(item.probability || 0)
    }));
  }
  return scoreCandidates(prediction);
}

function scoreProbability(prediction, home, away) {
  const key = scoreKey(home, away);
  const match = scoreDistribution(prediction).find((item) => scoreKey(item.home, item.away) === key);
  return clamp(Number(match?.probability || 0), PROBABILITY_FLOOR, 1);
}

function scoreLogLoss(prediction, actualHome, actualAway) {
  return -Math.log(scoreProbability(prediction, actualHome, actualAway));
}

function expectedCalibrationError(records, bins = 10) {
  if (!records.length) return 0;
  const buckets = Array.from({ length: bins }, () => ({ count: 0, confidence: 0, hits: 0 }));
  records.forEach((record) => {
    const probabilities = predictionProbabilities(record.prediction);
    const actualOutcome = outcomeFromScore(record.actual.home, record.actual.away);
    const options = [
      { outcome: "home", probability: probabilities.homeWin },
      { outcome: "draw", probability: probabilities.draw },
      { outcome: "away", probability: probabilities.awayWin }
    ].sort((a, b) => b.probability - a.probability);
    const confidence = options[0].probability;
    const index = Math.min(bins - 1, Math.floor(confidence * bins));
    buckets[index].count += 1;
    buckets[index].confidence += confidence;
    buckets[index].hits += options[0].outcome === actualOutcome ? 1 : 0;
  });
  return buckets.reduce((sum, bucket) => {
    if (!bucket.count) return sum;
    const avgConfidence = bucket.confidence / bucket.count;
    const accuracy = bucket.hits / bucket.count;
    return sum + (bucket.count / records.length) * Math.abs(avgConfidence - accuracy);
  }, 0);
}

function classMetrics(rows) {
  const metrics = {};
  OUTCOMES.forEach((outcome) => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;
    rows.forEach((row) => {
      if (row.predictedOutcome === outcome && row.actualOutcome === outcome) tp += 1;
      else if (row.predictedOutcome === outcome && row.actualOutcome !== outcome) fp += 1;
      else if (row.predictedOutcome !== outcome && row.actualOutcome === outcome) fn += 1;
      else tn += 1;
    });
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    metrics[outcome] = {
      precision: round(precision),
      recall: round(recall),
      f1: round(f1),
      accuracy: round((tp + tn) / Math.max(1, rows.length)),
      support: tp + fn
    };
  });
  return metrics;
}

function evaluatePredictionRecords(records = []) {
  const rows = records
    .filter((record) => record?.prediction && record?.actual)
    .map((record) => {
      const prediction = record.prediction;
      const actualHome = Number(record.actual.home || 0);
      const actualAway = Number(record.actual.away || 0);
      const predictedHome = Number(prediction.home || 0);
      const predictedAway = Number(prediction.away || 0);
      const probabilities = predictionProbabilities(prediction);
      const candidates = scoreCandidates(prediction);
      const actualScoreKey = scoreKey(actualHome, actualAway);
      return {
        prediction,
        actual: record.actual,
        probabilities,
        predictedHome,
        predictedAway,
        actualHome,
        actualAway,
        predictedOutcome: predictedOutcome(probabilities),
        scoreOutcome: outcomeFromScore(predictedHome, predictedAway),
        actualOutcome: outcomeFromScore(actualHome, actualAway),
        firstScoreHit: scoreKey(candidates[0]?.home, candidates[0]?.away) === actualScoreKey,
        top3ScoreHit: candidates.slice(0, 3).some((candidate) => scoreKey(candidate.home, candidate.away) === actualScoreKey),
        predictedTotal: predictedHome + predictedAway,
        actualTotal: actualHome + actualAway,
        scoreLogLoss: scoreLogLoss(prediction, actualHome, actualAway)
      };
    });
  const count = rows.length || 1;
  const metrics = classMetrics(rows);
  const homeGoalAbs = rows.reduce((sum, row) => sum + Math.abs(row.predictedHome - row.actualHome), 0);
  const awayGoalAbs = rows.reduce((sum, row) => sum + Math.abs(row.predictedAway - row.actualAway), 0);
  const outcomeHits = rows.filter((row) => row.predictedOutcome === row.actualOutcome).length;
  const actualDraws = rows.filter((row) => row.actualOutcome === "draw").length;
  const marginDirectionHits = rows.filter((row) => Math.sign(row.predictedHome - row.predictedAway) === Math.sign(row.actualHome - row.actualAway)).length;

  return {
    count: rows.length,
    outcomeAccuracy: round(outcomeHits / count),
    firstScoreAccuracy: round(rows.filter((row) => row.firstScoreHit).length / count),
    top3ScoreCoverage: round(rows.filter((row) => row.top3ScoreHit).length / count),
    totalGoalWithinOneRate: round(rows.filter((row) => Math.abs(row.predictedTotal - row.actualTotal) <= 1).length / count),
    homeGoalMae: round(homeGoalAbs / count, 2),
    awayGoalMae: round(awayGoalAbs / count, 2),
    combinedGoalMae: round((homeGoalAbs + awayGoalAbs) / count / 2, 2),
    marginDirectionAccuracy: round(marginDirectionHits / count),
    outcomeAndMarginAccuracy: round(rows.filter((row) =>
      row.predictedOutcome === row.actualOutcome
      && Math.sign(row.predictedHome - row.predictedAway) === Math.sign(row.actualHome - row.actualAway)
    ).length / count),
    logLoss: round(rows.reduce((sum, row) => sum + logLoss(row.probabilities, row.actualOutcome), 0) / count, 3),
    brierScore: round(rows.reduce((sum, row) => sum + brierScore(row.probabilities, row.actualOutcome), 0) / count, 3),
    scoreLogLoss: round(rows.reduce((sum, row) => sum + row.scoreLogLoss, 0) / count, 3),
    ece: round(expectedCalibrationError(rows), 3),
    drawRecall: actualDraws ? round(rows.filter((row) => row.actualOutcome === "draw" && row.predictedOutcome === "draw").length / actualDraws) : 0,
    macroF1: round(OUTCOMES.reduce((sum, outcome) => sum + metrics[outcome].f1, 0) / OUTCOMES.length),
    classMetrics: metrics,
    predictedRates: Object.fromEntries(OUTCOMES.map((outcome) => [outcome, round(rows.filter((row) => row.predictedOutcome === outcome).length / count)])),
    actualRates: Object.fromEntries(OUTCOMES.map((outcome) => [outcome, round(rows.filter((row) => row.actualOutcome === outcome).length / count)]))
  };
}

function randomOutcomeBaseline(records = []) {
  return evaluatePredictionRecords(records.map((record) => ({
    actual: record.actual,
    prediction: {
      home: 1,
      away: 1,
      probabilities: { homeWin: 1 / 3, draw: 1 / 3, awayWin: 1 / 3 },
      scoreCandidates: [{ home: 1, away: 1, probability: 1 }],
      scoreDistribution: [{ home: 1, away: 1, probability: 1 }]
    }
  })));
}

function fixedScoreBaseline(records = [], home = 1, away = 0) {
  return evaluatePredictionRecords(records.map((record) => ({
    actual: record.actual,
    prediction: {
      home,
      away,
      probabilities: deterministicProbabilities(home, away),
      scoreCandidates: [{ home, away, probability: 1 }],
      scoreDistribution: [{ home, away, probability: 1 }]
    }
  })));
}

module.exports = {
  OUTCOMES,
  normalizeOutcomeProbabilities,
  outcomeFromScore,
  brierScore,
  logLoss,
  scoreLogLoss,
  expectedCalibrationError,
  evaluatePredictionRecords,
  randomOutcomeBaseline,
  fixedScoreBaseline
};
