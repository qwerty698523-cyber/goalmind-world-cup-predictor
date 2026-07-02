const assert = require("assert");
const {
  brierScore,
  logLoss,
  expectedCalibrationError,
  evaluatePredictionRecords,
  fixedScoreBaseline,
  randomOutcomeBaseline
} = require("./model-evaluation");
const {
  eloOutcomeBaselinePrediction,
  eloPoissonBaselinePrediction
} = require("./model-baselines");

function approx(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);
}

function run() {
  approx(
    brierScore({ homeWin: 0.5, draw: 0.3, awayWin: 0.2 }, "home"),
    (0.5 - 1) ** 2 + (0.3 - 0) ** 2 + (0.2 - 0) ** 2
  );
  approx(logLoss({ homeWin: 0.5, draw: 0.3, awayWin: 0.2 }, "draw"), -Math.log(0.3));

  const records = [
    {
      prediction: {
        home: 1,
        away: 0,
        probabilities: { homeWin: 0.7, draw: 0.2, awayWin: 0.1 },
        scoreCandidates: [
          { home: 1, away: 0, probability: 0.14 },
          { home: 1, away: 1, probability: 0.13 },
          { home: 2, away: 0, probability: 0.1 }
        ],
        scoreDistribution: [{ home: 1, away: 0, probability: 0.14 }]
      },
      actual: { home: 1, away: 1 }
    },
    {
      prediction: {
        home: 2,
        away: 0,
        probabilities: { homeWin: 0.55, draw: 0.25, awayWin: 0.2 },
        scoreCandidates: [
          { home: 2, away: 0, probability: 0.12 },
          { home: 1, away: 0, probability: 0.11 },
          { home: 2, away: 1, probability: 0.09 }
        ],
        scoreDistribution: [{ home: 2, away: 0, probability: 0.12 }]
      },
      actual: { home: 2, away: 0 }
    },
    {
      prediction: {
        home: 0,
        away: 1,
        probabilities: { homeWin: 0.2, draw: 0.25, awayWin: 0.55 },
        scoreCandidates: [
          { home: 0, away: 1, probability: 0.12 },
          { home: 1, away: 1, probability: 0.11 },
          { home: 0, away: 2, probability: 0.09 }
        ],
        scoreDistribution: [{ home: 0, away: 1, probability: 0.12 }]
      },
      actual: { home: 1, away: 2 }
    }
  ];

  const summary = evaluatePredictionRecords(records);
  approx(summary.outcomeAccuracy, 2 / 3, 0.001);
  approx(summary.firstScoreAccuracy, 1 / 3, 0.001);
  approx(summary.top3ScoreCoverage, 2 / 3, 0.001);
  approx(summary.totalGoalWithinOneRate, 2 / 3, 0.001);
  approx(summary.homeGoalMae, 1 / 3, 0.01);
  approx(summary.awayGoalMae, 2 / 3, 0.01);
  approx(summary.combinedGoalMae, 0.5);
  assert.strictEqual(summary.drawRecall, 0);
  assert.ok(summary.logLoss > 0);
  assert.ok(summary.brierScore > 0);
  assert.ok(summary.macroF1 > 0 && summary.macroF1 <= 1);

  const ece = expectedCalibrationError(records, 5);
  assert.ok(ece >= 0 && ece <= 1);

  const random = randomOutcomeBaseline(records);
  approx(random.brierScore, 2 / 3, 1e-3);
  approx(random.logLoss, Math.log(3), 1e-3);

  const fixed = fixedScoreBaseline(records, 1, 1);
  approx(fixed.firstScoreAccuracy, 1 / 3, 0.001);
  approx(fixed.outcomeAccuracy, 1 / 3, 0.001);

  const home = { elo: 1800, attack: 78, defense: 75, form: 80 };
  const away = { elo: 1600, attack: 70, defense: 72, form: 70 };
  const elo = eloOutcomeBaselinePrediction(home, away, { venueMode: "neutral" });
  assert.ok(elo.probabilities.homeWin > elo.probabilities.awayWin);
  assert.strictEqual(elo.regularTimeOnly, true);

  const poisson = eloPoissonBaselinePrediction(home, away, { venueMode: "neutral" });
  assert.ok(poisson.xg.home > poisson.xg.away);
  assert.ok(poisson.scoreCandidates.length >= 3);
  assert.ok(poisson.scoreDistribution.length > poisson.scoreCandidates.length);
}

run();
