function buildTournamentSimulation() {
  const simulationTeams = new Map(teams.map((team) => [team.id, { ...team }]));
  const groups = inferTournamentGroups();
  const groupResults = new Map();

  const allGroupFixtures = groups.flatMap((group) => group.fixtures).sort((a, b) => new Date(a.date) - new Date(b.date));
  for (const fixture of allGroupFixtures) {
    const home = simulationTeams.get(fixture.home);
    const away = simulationTeams.get(fixture.away);
    if (!home || !away) continue;
    const result = simulateTournamentMatch(fixture, home, away, false);
    groupResults.set(fixture.id, result);
    if (result.source !== "actual") updateSimulationRatings(home, away, result, fixture);
  }

  const groupTables = groups.map((group) => ({
    ...group,
    standings: calculateGroupStandings(group, groupResults, simulationTeams),
    results: group.fixtures.map((fixture) => ({ fixture, result: groupResults.get(fixture.id) }))
  }));
  const bestThirds = groupTables
    .map((group) => ({ group: group.letter, ...group.standings[2] }))
    .sort(compareStandingRows)
    .slice(0, 8);
  const qualifiers = new Map(groupTables.map((group) => [group.letter, {
    first: group.standings[0]?.teamId,
    second: group.standings[1]?.teamId,
    third: group.standings[2]?.teamId,
    thirdQualified: bestThirds.some((row) => row.group === group.letter)
  }]));

  const round32Fixtures = stageFixtures("32 强赛");
  const thirdAssignments = assignThirdPlaceSlots(round32Fixtures, bestThirds);
  const round32 = simulateKnockoutRound(round32Fixtures, simulationTeams, (fixture, side) => {
    const actualId = fixture[side];
    if (actualId && simulationTeams.has(actualId)) return actualId;
    return resolveGroupPlaceholder(fixture[`${side}Team`]?.nameEn, qualifiers, thirdAssignments.get(`${fixture.id}:${side}`));
  });
  const round16 = simulateKnockoutRound(stageFixtures("16 强赛"), simulationTeams, (fixture, side) => resolveKnockoutPlaceholder(fixture, side, simulationTeams, round32, /Round of 32 (\d+) Winner/i));
  const quarterfinals = simulateKnockoutRound(stageFixtures("1/4 决赛"), simulationTeams, (fixture, side) => resolveKnockoutPlaceholder(fixture, side, simulationTeams, round16, /Round of 16 (\d+) Winner/i));
  const semifinals = simulateKnockoutRound(stageFixtures("半决赛"), simulationTeams, (fixture, side) => resolveKnockoutPlaceholder(fixture, side, simulationTeams, quarterfinals, /Quarterfinal (\d+) Winner/i));
  const thirdPlace = simulateKnockoutRound(stageFixtures("季军赛"), simulationTeams, (fixture, side) => resolveSemifinalPlaceholder(fixture, side, simulationTeams, semifinals, "loserId"));
  const final = simulateKnockoutRound(stageFixtures("决赛"), simulationTeams, (fixture, side) => resolveSemifinalPlaceholder(fixture, side, simulationTeams, semifinals, "winnerId"));
  const allResults = [...groupResults.values(), ...round32, ...round16, ...quarterfinals, ...semifinals, ...thirdPlace, ...final];

  return {
    generatedAt: new Date().toISOString(),
    groups: groupTables,
    bestThirds,
    rounds: [
      { name: "32 强赛", results: round32 },
      { name: "16 强赛", results: round16 },
      { name: "1/4 决赛", results: quarterfinals },
      { name: "半决赛", results: semifinals },
      { name: "季军赛", results: thirdPlace },
      { name: "决赛", results: final }
    ],
    championId: final[0]?.winnerId || null,
    runnerUpId: final[0]?.loserId || null,
    thirdId: thirdPlace[0]?.winnerId || null,
    actualCount: allResults.filter((result) => result.source === "actual").length,
    correctedCount: allResults.filter((result) => result.corrected).length,
    simulatedCount: allResults.filter((result) => result.source !== "actual").length
  };
}

function inferTournamentGroups() {
  const groupFixtures = fixtures.filter((fixture) => fixture.stage === "group" && fixture.home && fixture.away);
  const adjacency = new Map();
  for (const fixture of groupFixtures) {
    if (!adjacency.has(fixture.home)) adjacency.set(fixture.home, new Set());
    if (!adjacency.has(fixture.away)) adjacency.set(fixture.away, new Set());
    adjacency.get(fixture.home).add(fixture.away);
    adjacency.get(fixture.away).add(fixture.home);
  }
  const seen = new Set();
  const components = [];
  for (const teamId of adjacency.keys()) {
    if (seen.has(teamId)) continue;
    const queue = [teamId];
    const teamIds = [];
    while (queue.length) {
      const current = queue.shift();
      if (seen.has(current)) continue;
      seen.add(current);
      teamIds.push(current);
      for (const opponent of adjacency.get(current) || []) if (!seen.has(opponent)) queue.push(opponent);
    }
    const componentFixtures = groupFixtures.filter((fixture) => teamIds.includes(fixture.home) && teamIds.includes(fixture.away));
    components.push({ teamIds, fixtures: componentFixtures, firstDate: componentFixtures.map((fixture) => fixture.date).sort()[0] });
  }
  return components.sort((a, b) => new Date(a.firstDate) - new Date(b.firstDate)).map((group, index) => ({ ...group, letter: String.fromCharCode(65 + index) }));
}

function calculateGroupStandings(group, results, simulationTeams) {
  const rows = new Map(group.teamIds.map((teamId) => [teamId, { teamId, played: 0, wins: 0, draws: 0, losses: 0, gf: 0, ga: 0, gd: 0, points: 0, elo: simulationTeams.get(teamId)?.elo || 1500 }]));
  for (const fixture of group.fixtures) {
    const result = results.get(fixture.id);
    const home = rows.get(fixture.home);
    const away = rows.get(fixture.away);
    if (!result || !home || !away) continue;
    home.played += 1; away.played += 1;
    home.gf += result.homeScore; home.ga += result.awayScore;
    away.gf += result.awayScore; away.ga += result.homeScore;
    if (result.homeScore > result.awayScore) { home.wins += 1; away.losses += 1; home.points += 3; }
    else if (result.homeScore < result.awayScore) { away.wins += 1; home.losses += 1; away.points += 3; }
    else { home.draws += 1; away.draws += 1; home.points += 1; away.points += 1; }
  }
  for (const row of rows.values()) row.gd = row.gf - row.ga;
  return [...rows.values()].sort(compareStandingRows);
}

function compareStandingRows(a, b) {
  return b.points - a.points || b.gd - a.gd || b.gf - a.gf || b.elo - a.elo || a.teamId.localeCompare(b.teamId);
}

function stageFixtures(stageName) {
  return fixtures.filter((fixture) => fixture.stageName === stageName).sort((a, b) => new Date(a.date) - new Date(b.date));
}

function simulateTournamentMatch(fixture, home, away, knockout) {
  const actual = fixture.status === "post" && fixture.home === home.id && fixture.away === away.id;
  if (actual) {
    const actualWinner = fixture.winnerSide === "home" ? home.id : fixture.winnerSide === "away" ? away.id : fixture.homeScore === fixture.awayScore ? null : fixture.homeScore > fixture.awayScore ? home.id : away.id;
    const assessment = assessPrediction(fixture);
    return {
      fixtureId: fixture.id, homeId: home.id, awayId: away.id,
      homeScore: fixture.homeScore, awayScore: fixture.awayScore,
      winnerId: actualWinner, loserId: actualWinner === home.id ? away.id : actualWinner === away.id ? home.id : null,
      source: "actual", corrected: Boolean(assessment && assessment.className !== "prediction-correct"),
      correctionLabel: assessment?.label || "真实赛果", penalties: null
    };
  }
  const prediction = predict(home, away, fixture.venueMode || "neutral", fixture);
  let homeScore = prediction.best.home;
  let awayScore = prediction.best.away;
  let winnerId = homeScore > awayScore ? home.id : awayScore > homeScore ? away.id : null;
  let penalties = null;
  if (knockout && !winnerId) {
    const homeAdvances = prediction.homeWin >= prediction.awayWin;
    winnerId = homeAdvances ? home.id : away.id;
    penalties = homeAdvances ? "4 : 3" : "3 : 4";
  }
  return {
    fixtureId: fixture.id, homeId: home.id, awayId: away.id, homeScore, awayScore,
    winnerId, loserId: winnerId === home.id ? away.id : winnerId === away.id ? home.id : null,
    source: fixture.status === "in" ? "live-simulation" : "simulation", corrected: false,
    correctionLabel: fixture.status === "in" ? "直播中动态模拟" : "模型模拟", penalties
  };
}

function updateSimulationRatings(home, away, result, fixture) {
  const update = objectiveRatingUpdate(home, away, {
    ...fixture,
    homeScore: result.homeScore,
    awayScore: result.awayScore,
    completed: true
  });
  home.elo += update.homeDelta;
  away.elo += update.awayDelta;
  home.form = Math.round(clamp(home.form * 0.88 + performanceSignal(update.actualHome, update.expectedHome) * 0.12, 35, 98));
  away.form = Math.round(clamp(away.form * 0.88 + performanceSignal(update.actualAway, update.expectedAway) * 0.12, 35, 98));
}

function assignThirdPlaceSlots(roundFixtures, bestThirds) {
  const slots = [];
  for (const fixture of roundFixtures) {
    for (const side of ["home", "away"]) {
      const name = fixture[`${side}Team`]?.nameEn || "";
      const match = name.match(/Third Place Group ([A-L/]+)/i);
      if (match) slots.push({ key: `${fixture.id}:${side}`, allowed: match[1].split("/") });
    }
  }
  const teamByGroup = new Map(bestThirds.map((row) => [row.group, row.teamId]));
  const ordered = [...slots].sort((a, b) => a.allowed.filter((letter) => teamByGroup.has(letter)).length - b.allowed.filter((letter) => teamByGroup.has(letter)).length);
  const assignment = new Map();
  const used = new Set();
  function search(index) {
    if (index >= ordered.length) return true;
    const slot = ordered[index];
    const candidates = slot.allowed.filter((letter) => teamByGroup.has(letter) && !used.has(letter));
    for (const letter of candidates) {
      used.add(letter); assignment.set(slot.key, teamByGroup.get(letter));
      if (search(index + 1)) return true;
      used.delete(letter); assignment.delete(slot.key);
    }
    return false;
  }
  search(0);
  return assignment;
}

function resolveGroupPlaceholder(name, qualifiers, assignedThird) {
  if (assignedThird) return assignedThird;
  const first = String(name || "").match(/Group ([A-L]) Winner/i);
  if (first) return qualifiers.get(first[1])?.first || null;
  const second = String(name || "").match(/Group ([A-L]) 2nd Place/i);
  if (second) return qualifiers.get(second[1])?.second || null;
  return null;
}

function resolveKnockoutPlaceholder(fixture, side, simulationTeams, previousRound, pattern) {
  if (fixture[side] && simulationTeams.has(fixture[side])) return fixture[side];
  const match = String(fixture[`${side}Team`]?.nameEn || "").match(pattern);
  return match ? previousRound[Number(match[1]) - 1]?.winnerId || null : null;
}

function resolveSemifinalPlaceholder(fixture, side, simulationTeams, semifinals, resultKey) {
  if (fixture[side] && simulationTeams.has(fixture[side])) return fixture[side];
  const match = String(fixture[`${side}Team`]?.nameEn || "").match(/Semifinal (\d+) (Winner|Loser)/i);
  return match ? semifinals[Number(match[1]) - 1]?.[resultKey] || null : null;
}

function simulateKnockoutRound(roundFixtures, simulationTeams, resolver) {
  return roundFixtures.map((fixture) => {
    const homeId = resolver(fixture, "home");
    const awayId = resolver(fixture, "away");
    const home = simulationTeams.get(homeId);
    const away = simulationTeams.get(awayId);
    if (!home || !away) return { fixtureId: fixture.id, homeId, awayId, source: "pending", winnerId: null, loserId: null };
    const result = simulateTournamentMatch(fixture, home, away, true);
    if (result.source !== "actual") updateSimulationRatings(home, away, result, fixture);
    return result;
  });
}

function simulationTeam(teamId) {
  return teamById(teamId) || { id: teamId, name: "待定", abbr: "TBD", logo: "" };
}

function simulationScore(result) {
  if (!Number.isFinite(result.homeScore) || !Number.isFinite(result.awayScore)) return "待定";
  return `${result.homeScore} : ${result.awayScore}${result.penalties ? `　点球 ${result.penalties}` : ""}`;
}

function renderSimulation() {
  const simulation = buildTournamentSimulation();
  const champion = simulationTeam(simulation.championId);
  const runnerUp = simulationTeam(simulation.runnerUpId);
  const third = simulationTeam(simulation.thirdId);
  $("simulationActualCount").textContent = simulation.actualCount;
  $("simulationCorrectedCount").textContent = simulation.correctedCount;
  $("simulationRemainingCount").textContent = simulation.simulatedCount;
  $("simulationUpdatedAt").textContent = formatSyncTime(sourceMeta.fetchedAt || simulation.generatedAt);
  $("simulationChampion").innerHTML = `${teamMark(champion)}<div><span>冠军预测</span><b>${champion.name}</b><small>亚军 ${runnerUp.name} · 季军 ${third.name}</small></div>`;

  $("simulationGroups").innerHTML = simulation.groups.map((group) => `
    <article class="simulation-group-card">
      <header><div><span>GROUP</span><b>${group.letter}</b></div><small>${group.standings[0] ? `${simulationTeam(group.standings[0].teamId).name} 领跑` : "待模拟"}</small></header>
      <div class="simulation-table">
        ${group.standings.map((row, index) => `<div class="${index < 2 ? "qualified" : simulation.bestThirds.some((thirdRow) => thirdRow.teamId === row.teamId) ? "third-qualified" : ""}"><span>${index + 1}</span><span>${teamMark(simulationTeam(row.teamId), true)}${simulationTeam(row.teamId).name}</span><span>${row.gd >= 0 ? "+" : ""}${row.gd}</span><b>${row.points}</b></div>`).join("")}
      </div>
      <div class="simulation-group-matches">
        ${group.results.map(({ fixture, result }) => `<div class="${result?.source === "actual" ? result.corrected ? "corrected" : "actual" : "simulated"}"><span>${simulationTeam(fixture.home).name}</span><b>${simulationScore(result || {})}</b><span>${simulationTeam(fixture.away).name}</span><small>${result?.source === "actual" ? result.corrected ? "真实 · 已修正" : "真实" : result?.source === "live-simulation" ? "直播中模拟" : "模拟"}</small></div>`).join("")}
      </div>
    </article>`).join("");

  $("simulationBracket").innerHTML = simulation.rounds.map((round) => `
    <section class="simulation-round ${round.name === "决赛" ? "final-round" : ""}">
      <div class="simulation-round-head"><h3>${round.name}</h3><span>${round.results.length} 场</span></div>
      <div class="simulation-round-grid">
        ${round.results.map((result) => {
          const home = simulationTeam(result.homeId);
          const away = simulationTeam(result.awayId);
          return `<article class="${result.source === "actual" ? result.corrected ? "corrected" : "actual" : result.source}">
            <span class="simulation-source">${result.source === "actual" ? result.corrected ? "真实结果 · 已重算后续" : "真实结果" : result.source === "live-simulation" ? "直播中动态模拟" : result.source === "pending" ? "等待对阵" : "模型模拟"}</span>
            <div class="${result.winnerId === home.id ? "winner" : ""}">${teamMark(home, true)}<b>${home.name}</b><strong>${Number.isFinite(result.homeScore) ? result.homeScore : "-"}</strong></div>
            <div class="${result.winnerId === away.id ? "winner" : ""}">${teamMark(away, true)}<b>${away.name}</b><strong>${Number.isFinite(result.awayScore) ? result.awayScore : "-"}</strong></div>
            ${result.penalties ? `<small>点球 ${result.penalties}</small>` : ""}
          </article>`;
        }).join("")}
      </div>
    </section>`).join("");
}
