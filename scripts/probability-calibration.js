function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value || 0)));
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

  const xg = context.xg || context.expectedGoals || {};
  const xgHome = Number(xg.home ?? context.homeXg);
  const xgAway = Number(xg.away ?? context.awayXg);
  const hasXg = Number.isFinite(xgHome) && Number.isFinite(xgAway);
  const xgDiff = hasXg ? Math.abs(xgHome - xgAway) : Infinity;
  const xgTotal = hasXg ? xgHome + xgAway : Infinity;
  const topNonDraw = Math.max(homeWin, awayWin);
  const drawGap = topNonDraw - draw;
  const matureSamples = samples >= 10;
  const nearEvenGame = matureSamples
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

module.exports = {
  calibrateOutcomeProbabilities,
  calibrateConfidenceShape,
  normalizeOutcomeProbabilities
};
