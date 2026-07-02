const { normalizeOutcomeProbabilities } = require("./model-evaluation");

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function rounded(value, digits = 4) {
  return Number(Number(value || 0).toFixed(digits));
}

function poisson(lambda, goals) {
  let factorial = 1;
  for (let value = 2; value <= goals; value += 1) factorial *= value;
  return Math.exp(-lambda) * Math.pow(lambda, goals) / factorial;
}

function outcomeFromProbabilities(probabilities) {
  if (probabilities.homeWin >= probabilities.draw && probabilities.homeWin >= probabilities.awayWin) return "home";
  if (probabilities.awayWin >= probabilities.draw) return "away";
  return "draw";
}

function scoreForOutcome(outcome) {
  if (outcome === "home") return { home: 1, away: 0 };
  if (outcome === "away") return { home: 0, away: 1 };
  return { home: 1, away: 1 };
}

function eloOutcomeBaselinePrediction(home, away, fixture = {}) {
  const venueBonus = fixture.venueMode === "home" ? 55 : 0;
  const difference = Number(home.elo || 1500) - Number(away.elo || 1500) + venueBonus;
  const expectedHome = 1 / (1 + Math.pow(10, -difference / 400));
  const draw = clamp(0.27 - Math.abs(difference) / 1900, 0.16, 0.31);
  const probabilities = normalizeOutcomeProbabilities({
    homeWin: expectedHome * (1 - draw),
    draw,
    awayWin: (1 - expectedHome) * (1 - draw)
  });
  const score = scoreForOutcome(outcomeFromProbabilities(probabilities));
  return {
    modelVersion: "baseline-elo",
    regularTimeOnly: true,
    home: score.home,
    away: score.away,
    probabilities,
    homeWin: probabilities.homeWin,
    draw: probabilities.draw,
    awayWin: probabilities.awayWin,
    scoreCandidates: [{ ...score, probability: 1 }],
    scoreDistribution: [{ ...score, probability: 1 }]
  };
}

function scoreDistributionFromXg(homeXg, awayXg) {
  const distribution = [];
  for (let homeGoals = 0; homeGoals <= 5; homeGoals += 1) {
    for (let awayGoals = 0; awayGoals <= 5; awayGoals += 1) {
      distribution.push({
        home: homeGoals,
        away: awayGoals,
        probability: poisson(homeXg, homeGoals) * poisson(awayXg, awayGoals)
      });
    }
  }
  const covered = distribution.reduce((sum, item) => sum + item.probability, 0) || 1;
  return distribution
    .map((item) => ({ ...item, probability: rounded(item.probability / covered) }))
    .sort((a, b) => b.probability - a.probability);
}

function eloPoissonBaselinePrediction(home, away, fixture = {}) {
  const venueBonus = fixture.venueMode === "home" ? 0.12 : 0;
  const ratingDifference = Number(home.elo || 1500) - Number(away.elo || 1500);
  const attackGap = Number(home.attack || 70) - Number(away.defense || 70);
  const awayAttackGap = Number(away.attack || 70) - Number(home.defense || 70);
  const homeXg = clamp(1.25 + attackGap / 42 + ratingDifference / 760 + venueBonus, 0.25, 3.8);
  const awayXg = clamp(1.05 + awayAttackGap / 42 - ratingDifference / 820, 0.25, 3.6);
  const distribution = scoreDistributionFromXg(homeXg, awayXg);
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  distribution.forEach((item) => {
    if (item.home > item.away) homeWin += item.probability;
    else if (item.home < item.away) awayWin += item.probability;
    else draw += item.probability;
  });
  const probabilities = normalizeOutcomeProbabilities({ homeWin, draw, awayWin });
  const best = distribution[0] || { home: 1, away: 1, probability: 1 };
  return {
    modelVersion: "baseline-elo-poisson",
    regularTimeOnly: true,
    home: best.home,
    away: best.away,
    probabilities,
    homeWin: probabilities.homeWin,
    draw: probabilities.draw,
    awayWin: probabilities.awayWin,
    xg: { home: rounded(homeXg, 2), away: rounded(awayXg, 2) },
    scoreCandidates: distribution.slice(0, 5),
    scoreDistribution: distribution
  };
}

module.exports = {
  eloOutcomeBaselinePrediction,
  eloPoissonBaselinePrediction
};
