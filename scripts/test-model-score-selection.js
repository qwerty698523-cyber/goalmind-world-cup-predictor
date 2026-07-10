const assert = require("assert");
const { modelPredictedScore } = require("../server");

const matureCalibration = {
  samples: 90,
  goalLift: 0.23,
  modeLift: 0.3,
  drawAdjustment: 0.043,
  drawRisk: 0.12,
  conservativeIndex: 0.43,
  favoriteRisk: 0.13,
  underdogLift: 0.2,
  lowTotalPressure: 0.1,
  favoriteSurge: 0.16,
  drawCaution: 0.05,
  resistanceDraw: 0.17,
  highScorePressure: 0.42,
  source: "test"
};

function team(overrides) {
  return {
    id: "team",
    elo: 1800,
    attack: 75,
    defense: 75,
    form: 75,
    availability: {},
    ...overrides
  };
}

function run() {
  const highPressure = modelPredictedScore(
    team({ id: "fav", elo: 2050, attack: 90, defense: 82, form: 88 }),
    team({ id: "dog", elo: 1680, attack: 62, defense: 65, form: 60 }),
    "neutral",
    { venueMode: "neutral" },
    matureCalibration
  );
  assert.ok(
    highPressure.xg.home + highPressure.xg.away >= 3,
    "test fixture should represent a high expected-goals favorite scenario"
  );
  assert.ok(
    highPressure.home + highPressure.away >= 3,
    "high expected-goals favorites should not be compressed into a low-score first candidate"
  );
  assert.ok(
    highPressure.scoreCandidates.some((candidate) => candidate.home + candidate.away >= 4),
    "high expected-goals favorites should keep four-goal outcomes in the leading candidate set"
  );

  const compact = modelPredictedScore(
    team({ id: "compactHome", elo: 1850, attack: 70, defense: 83, form: 75 }),
    team({ id: "compactAway", elo: 1790, attack: 68, defense: 82, form: 74 }),
    "neutral",
    { venueMode: "neutral" },
    matureCalibration
  );
  assert.ok(
    compact.home + compact.away <= 2,
    "compact low-xG matches should not be pushed into artificial high scores"
  );
}

run();
