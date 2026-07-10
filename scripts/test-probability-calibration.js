const assert = require("assert");
const { calibrateOutcomeProbabilities } = require("./probability-calibration");

function approx(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);
}

function run() {
  const closeRaw = { homeWin: 0.48, draw: 0.18, awayWin: 0.34 };
  const matureCalibration = {
    samples: 70,
    drawRisk: 0.18,
    resistanceDraw: 0.22
  };
  const close = calibrateOutcomeProbabilities(closeRaw, {
    ratingDifference: 45,
    calibration: matureCalibration
  });
  approx(close.homeWin + close.draw + close.awayWin, 1, 1e-9);
  assert.ok(close.draw > closeRaw.draw, "close-match draw probability should increase when completed samples show draw underprediction");
  assert.ok(close.homeWin < closeRaw.homeWin, "draw correction should be funded from non-draw probabilities");

  const lowSample = calibrateOutcomeProbabilities(closeRaw, {
    ratingDifference: 45,
    calibration: { ...matureCalibration, samples: 3 }
  });
  assert.ok(lowSample.draw < close.draw, "low sample calibration should be shrunk toward the raw model");

  const favorite = calibrateOutcomeProbabilities(closeRaw, {
    ratingDifference: 620,
    calibration: matureCalibration
  });
  assert.ok(favorite.draw < close.draw, "heavy favorites should not receive the same draw lift as close matches");

  const alreadyHighDraw = calibrateOutcomeProbabilities({ homeWin: 0.32, draw: 0.4, awayWin: 0.28 }, {
    ratingDifference: 20,
    calibration: matureCalibration
  });
  assert.ok(alreadyHighDraw.draw <= 0.42, "calibration should not inflate already-high draw probabilities");

  const marginalDraw = calibrateOutcomeProbabilities({ homeWin: 0.352, draw: 0.335, awayWin: 0.313 }, {
    ratingDifference: 53,
    xg: { home: 1.01, away: 1.09 },
    calibration: matureCalibration
  });
  assert.ok(
    marginalDraw.draw > marginalDraw.homeWin && marginalDraw.draw > marginalDraw.awayWin,
    "near-even matches with an already-competitive draw probability should be allowed to rank draw first"
  );

  const openFavorite = calibrateOutcomeProbabilities({ homeWin: 0.55, draw: 0.31, awayWin: 0.14 }, {
    ratingDifference: 240,
    xg: { home: 1.95, away: 0.75 },
    calibration: matureCalibration
  });
  assert.ok(
    openFavorite.homeWin > openFavorite.draw,
    "clear favorites with a wide xG gap should not be promoted into draw predictions"
  );

  const moderateFavorite = calibrateOutcomeProbabilities({ homeWin: 0.52, draw: 0.27, awayWin: 0.21 }, {
    ratingDifference: 160,
    xg: { home: 1.6, away: 0.9 },
    calibration: matureCalibration
  });
  assert.ok(
    moderateFavorite.homeWin > 0.52,
    "moderate-confidence favorites should be sharpened after historical calibration shows underconfidence"
  );
  assert.ok(
    moderateFavorite.homeWin > moderateFavorite.draw && moderateFavorite.homeWin > moderateFavorite.awayWin,
    "confidence calibration should preserve the predicted outcome"
  );

  const veryStrongFavorite = calibrateOutcomeProbabilities({ homeWin: 0.76, draw: 0.16, awayWin: 0.08 }, {
    ratingDifference: 460,
    xg: { home: 2.3, away: 0.5 },
    calibration: matureCalibration
  });
  assert.ok(
    veryStrongFavorite.homeWin < 0.76,
    "very-high-confidence favorites should be softened to avoid overconfident probabilities"
  );
  assert.ok(
    veryStrongFavorite.homeWin > veryStrongFavorite.draw && veryStrongFavorite.homeWin > veryStrongFavorite.awayWin,
    "softening should not flip the predicted outcome"
  );

  const underconfidentFavorite = calibrateOutcomeProbabilities({ homeWin: 0.46, draw: 0.28, awayWin: 0.26 }, {
    ratingDifference: 80,
    xg: { home: 1.45, away: 1.05 },
    calibration: {
      samples: 85,
      outcomeReliability: 0.71,
      drawRisk: 0.02,
      resistanceDraw: 0.02
    }
  });
  assert.ok(
    underconfidentFavorite.homeWin > 0.46,
    "low-mid confidence favorites can be sharpened, but should not use broad replay accuracy to overfit every close match"
  );

}

run();
