const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const REPORT_FILE = path.join(ROOT, "release-report.json");
const FALLBACK_FILE = path.join(ROOT, "fallback-data.js");
const nodeCommand = process.execPath;
const syntaxCheckFiles = [
  "server.js",
  "api/team-profile.js",
  "simulation.js",
  "match-insight.js",
  "app.js",
  "scripts/build-history-data.js",
  "scripts/audit-prediction-model.js",
  "scripts/analyze-prediction-errors.js",
  "scripts/model-evaluation.js",
  "scripts/model-baselines.js",
  "scripts/probability-calibration.js",
  "scripts/test-model-evaluation.js",
  "scripts/test-probability-calibration.js",
  "scripts/replay-prediction-model.js",
  "scripts/model-quality-gate.js",
  "scripts/release-check.js"
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: { ...process.env, GOALMIND_OPEN_BROWSER: "0" },
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit"
  });

  if (result.error) {
    throw result.error;
  }

  const step = {
    command: [command, ...args].join(" "),
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || ""
  };

  if (!step.ok && !options.allowFailure) {
    const details = [step.stderr, step.stdout].filter(Boolean).join("\n").trim();
    throw new Error(`${step.command} failed${details ? `\n${details}` : ""}`);
  }

  return step;
}

function parseJsonOutput(output) {
  const text = String(output || "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("No JSON object found in command output.");
  }
  return JSON.parse(text.slice(start, end + 1));
}

function rate(value) {
  return typeof value === "number" ? Number(value.toFixed(3)) : null;
}

function compareMetric(label, actual, operator, target) {
  let passed = false;
  if (typeof actual === "number") {
    if (operator === ">=") passed = actual >= target;
    if (operator === "<=") passed = actual <= target;
    if (operator === "<") passed = actual < target;
  }
  return { label, actual: rate(actual), target: `${operator} ${target}`, passed };
}

async function refreshDataSnapshot() {
  const { getData } = require("../server");
  const data = await getData(true);
  const fallback = {
    ...data,
    stale: true,
    source: {
      ...(data.source || {}),
      fallback: "local release snapshot"
    }
  };
  fs.writeFileSync(FALLBACK_FILE, `window.GOALMIND_FALLBACK = ${JSON.stringify(fallback)};\n`, "utf8");
  return data;
}

function buildReadiness(data, replay, gateStep) {
  const fixtures = data.fixtures || [];
  const teams = data.teams || [];
  const completedFixtures = fixtures.filter((fixture) => fixture.completed || fixture.status === "post");
  const predictedFixtures = fixtures.filter((fixture) => fixture.home && fixture.away && fixture.modelPrediction);
  const probabilityEvaluation = replay.probabilityEvaluation || data.probabilityEvaluation || {};
  const eloPoisson = replay.baselines?.eloPoisson || data.predictionBaselines?.eloPoisson || {};

  const functionalChecks = [
    { label: "fixtures >= 100", actual: fixtures.length, target: ">= 100", passed: fixtures.length >= 100 },
    { label: "teams >= 48", actual: teams.length, target: ">= 48", passed: teams.length >= 48 },
    { label: "predicted fixtures present", actual: predictedFixtures.length, target: ">= 1", passed: predictedFixtures.length >= 1 },
    { label: "completed fixtures present", actual: completedFixtures.length, target: ">= 1", passed: completedFixtures.length >= 1 },
    { label: "model metrics present", actual: probabilityEvaluation.count || 0, target: ">= 1", passed: (probabilityEvaluation.count || 0) >= 1 },
    { label: "fallback snapshot generated", actual: fs.existsSync(FALLBACK_FILE), target: "true", passed: fs.existsSync(FALLBACK_FILE) }
  ];

  const modelChecks = [
    compareMetric("sample size", probabilityEvaluation.count || 0, ">=", 500),
    compareMetric("outcome accuracy", probabilityEvaluation.outcomeAccuracy, ">=", 0.53),
    compareMetric("log loss", probabilityEvaluation.logLoss, "<", 1),
    compareMetric("brier score", probabilityEvaluation.brierScore, "<", 0.58),
    compareMetric("ECE", probabilityEvaluation.ece, "<", 0.04),
    compareMetric("first score accuracy", probabilityEvaluation.firstScoreAccuracy, ">=", 0.11),
    compareMetric("top-3 score coverage", probabilityEvaluation.top3ScoreCoverage, ">=", 0.3),
    compareMetric("total goals within one", probabilityEvaluation.totalGoalWithinOneRate, ">=", 0.65),
    compareMetric("combined goal MAE", probabilityEvaluation.combinedGoalMae, "<=", 1),
    compareMetric("beats Elo+Poisson log loss", probabilityEvaluation.logLoss, "<=", (eloPoisson.logLoss || Infinity) * 0.95),
    compareMetric("beats Elo+Poisson brier", probabilityEvaluation.brierScore, "<=", (eloPoisson.brierScore || Infinity) * 0.95)
  ];

  return {
    status: functionalChecks.every((check) => check.passed) ? "publishable-beta" : "blocked",
    generatedAt: new Date().toISOString(),
    modelQualityGatePassed: gateStep.ok,
    functionalChecks,
    modelChecks,
    summary: {
      fixtures: fixtures.length,
      teams: teams.length,
      completedFixtures: completedFixtures.length,
      predictedFixtures: predictedFixtures.length,
      fetchedAt: data.fetchedAt,
      modelVersion: data.modelVersion,
      metrics: {
        outcomeAccuracy: rate(probabilityEvaluation.outcomeAccuracy),
        logLoss: rate(probabilityEvaluation.logLoss),
        brierScore: rate(probabilityEvaluation.brierScore),
        ece: rate(probabilityEvaluation.ece),
        firstScoreAccuracy: rate(probabilityEvaluation.firstScoreAccuracy),
        top3ScoreCoverage: rate(probabilityEvaluation.top3ScoreCoverage),
        totalGoalWithinOneRate: rate(probabilityEvaluation.totalGoalWithinOneRate),
        combinedGoalMae: rate(probabilityEvaluation.combinedGoalMae),
        drawRecall: rate(probabilityEvaluation.drawRecall),
        macroF1: rate(probabilityEvaluation.macroF1)
      }
    }
  };
}

async function main() {
  const steps = [];
  steps.push(run(nodeCommand, ["scripts/test-model-evaluation.js"]));
  steps.push(run(nodeCommand, ["scripts/test-probability-calibration.js"]));
  for (const file of syntaxCheckFiles) {
    steps.push(run(nodeCommand, ["--check", file]));
  }

  const data = await refreshDataSnapshot();
  const replayStep = run(nodeCommand, ["scripts/replay-prediction-model.js"], { capture: true });
  steps.push({ ...replayStep, stdout: "[json omitted]" });
  const replay = parseJsonOutput(replayStep.stdout);
  const gateStep = run(nodeCommand, ["scripts/model-quality-gate.js"], { capture: true, allowFailure: true });
  steps.push({
    ...gateStep,
    stdout: gateStep.ok ? "[json omitted]" : gateStep.stdout,
    stderr: gateStep.stderr
  });

  const readiness = buildReadiness(data, replay, gateStep);
  const report = {
    ...readiness,
    steps: steps.map((step) => ({
      command: step.command,
      ok: step.ok,
      status: step.status
    })),
    modelGateFailureSummary: gateStep.ok ? null : readiness.modelChecks
      .filter((check) => !check.passed)
      .map((check) => ({
        label: check.label,
        actual: check.actual,
        target: check.target
      }))
  };

  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), "utf8");

  console.log(JSON.stringify({
    status: report.status,
    report: path.basename(REPORT_FILE),
    fetchedAt: report.summary.fetchedAt,
    fixtures: report.summary.fixtures,
    teams: report.summary.teams,
    modelVersion: report.summary.modelVersion,
    modelQualityGatePassed: report.modelQualityGatePassed,
    metrics: report.summary.metrics
  }, null, 2));

  if (report.status !== "publishable-beta") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
