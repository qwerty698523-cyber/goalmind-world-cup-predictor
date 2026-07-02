const MATCH_DETAIL_STORAGE_KEY = "goalmind-match-details-v1";
const MODEL_LEARNING_STORAGE_KEY = "goalmind-model-learning-v1";
let matchDetailStore = readInsightStorage(MATCH_DETAIL_STORAGE_KEY, {});
let modelLearning = readInsightStorage(MODEL_LEARNING_STORAGE_KEY, {
  samples: 0,
  learnedMatches: [],
  goalBias: 0,
  possessionBias: 0,
  shotBias: 0,
  cornerBias: 0,
  formationHits: 0,
  outcomeHits: 0
});
let currentInsightRequest = 0;
let learningRefreshPromise = null;

function readInsightStorage(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
  catch { return structuredClone(fallback); }
}

function writeInsightStorage(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { /* Private browsing can disable storage. */ }
}

function renderMatchIntelligence(fixture, home, away, prediction) {
  const confirmed = Boolean(fixture && fixture.home === home.id && fixture.away === away.id);
  $("insightEmpty").hidden = confirmed;
  $("preMatchInsight").hidden = !confirmed;
  $("postMatchInsight").hidden = !confirmed || fixture.status !== "post";
  if (!confirmed) {
    $("insightKicker").textContent = "MATCH INTELLIGENCE";
    $("insightTitle").textContent = "单场情报报告";
    $("insightStatus").textContent = "仅支持确定赛程";
    $("insightUpdatedAt").textContent = "";
    return;
  }

  const original = fixture.preMatchAnalysis || fallbackPreMatchAnalysis(home, away, fixture, prediction);
  const display = fixture.status === "pre" ? calibrateFutureAnalysis(original) : original;
  renderPreMatchReport(display, fixture, home, away);
  $("insightKicker").textContent = "PRE-MATCH INTELLIGENCE";
  $("insightTitle").textContent = "赛前预测";
  $("insightStatus").textContent = fixture.status === "post" ? "保留赛前快照 · 对照真实赛果" : fixture.status === "in" ? "比赛进行中 · 赛前判断已锁定" : "赛前预测已生成";
  $("insightUpdatedAt").textContent = original.createdAt ? `预测快照 ${formatSyncTime(original.createdAt)}` : "模型即时生成";

  const requestId = ++currentInsightRequest;
  hydrateForecastLineups(fixture, home, away, requestId);
  if (fixture.status === "post") {
    $("actualDataState").textContent = "正在载入官方比赛数据";
    getMatchDetailData(fixture).then((detail) => {
      if (requestId !== currentInsightRequest) return;
      renderPostMatchReport(fixture, home, away, original, detail);
    }).catch(() => {
      if (requestId !== currentInsightRequest) return;
      renderPostMatchFallback(fixture, home, away, original);
    });
  }
}

function fallbackPreMatchAnalysis(home, away, fixture, prediction) {
  const difference = home.elo - away.elo + (fixture.venueMode === "home" ? 55 : 0);
  const possessionHome = Math.round(clamp(50 + difference / 32 + ((home.control || 70) - (away.control || 70)) * 0.18, 31, 69));
  return {
    createdAt: fixture.modelPrediction?.createdAt || new Date().toISOString(),
    home: clientTeamPlan(home, away),
    away: clientTeamPlan(away, home),
    expected: {
      possessionHome,
      possessionAway: 100 - possessionHome,
      shotsHome: Math.round(clamp(10 + (home.attack - away.defense) / 7 + difference / 85, 5, 22)),
      shotsAway: Math.round(clamp(10 + (away.attack - home.defense) / 7 - difference / 95, 4, 20)),
      cornersHome: Math.round(clamp(4 + (home.attack - away.defense) / 15 + difference / 180, 2, 9)),
      cornersAway: Math.round(clamp(4 + (away.attack - home.defense) / 15 - difference / 200, 1, 9))
    },
    context: {
      weather: fixture.weather || { summary: "天气预报待同步", impact: { notes: ["天气预报临近比赛更新"] } },
      availability: {
        home: home.availability || { summary: "暂无官方伤病名单", unavailableCount: 0 },
        away: away.availability || { summary: "暂无官方伤病名单", unavailableCount: 0 }
      }
    },
    matchScript: difference > 120 ? `${home.name}预计控制比赛，${away.name}将更多依靠紧凑防守与反击。` : difference < -120 ? `${away.name}预计掌握主动，${home.name}需要提高转换效率。` : "双方实力接近，中场对抗、二点球与定位球将决定比赛走势。",
    scoringWindow: Math.abs(difference) > 150 ? "强势方在开场阶段和下半场体能下降阶段更具进球机会" : "55—75 分钟可能出现决定比赛的空间",
    confidence: Math.round(clamp(58 + Math.abs(difference) / 9, 55, 88)),
    predictedScore: { home: prediction.best.home, away: prediction.best.away }
  };
}

function clientTeamPlan(team, opponent) {
  const formation = team.defense >= 82 && team.attack < opponent.attack - 8 ? "5-4-1" : team.pace >= 84 && team.control < 78 ? "3-4-2-1" : team.control >= 84 && team.attack >= 80 ? "4-3-3" : team.defense >= 80 && team.control >= 76 ? "4-2-3-1" : team.attack >= 76 ? "4-2-3-1" : "4-4-2";
  return {
    formation,
    approach: team.elo >= opponent.elo ? "主动控制中场，并在夺回球权后迅速压到禁区前沿" : "保持阵型紧凑，利用反击和定位球寻找得分机会",
    lineupFramework: ({ "4-3-3": ["门将", "四后卫", "单后腰与双中前卫", "双边锋", "中锋"], "4-2-3-1": ["门将", "四后卫", "双后腰", "前腰与双边锋", "单中锋"], "3-4-2-1": ["门将", "三中卫", "双翼卫与双中场", "双前腰", "单中锋"], "5-4-1": ["门将", "三中卫与双翼卫", "四人中场", "单前锋"], "4-4-2": ["门将", "四后卫", "平行四中场", "双前锋"] })[formation],
    goalRoutes: team.pace >= 80 ? ["快速反击与身后球", "边路一对一和倒三角", "定位球第二落点"] : ["中路连续配合", "肋部渗透与后插上", "定位球和远射"],
    defensiveFocus: opponent.pace >= opponent.control ? "限制对手纵深跑动，边后卫前压时保留保护人数" : "封锁中路传球线路，迫使对手转向边路",
    pressing: team.form >= 82 ? "开场可采用积极前场压迫" : "以中位防守为主，控制阵型间距"
  };
}

function calibrateFutureAnalysis(analysis) {
  const adjusted = structuredClone(analysis);
  if (!modelLearning.samples) return adjusted;
  adjusted.expected.possessionHome = Math.round(clamp(adjusted.expected.possessionHome + modelLearning.possessionBias, 28, 72));
  adjusted.expected.possessionAway = 100 - adjusted.expected.possessionHome;
  adjusted.expected.shotsHome = Math.round(clamp(adjusted.expected.shotsHome + modelLearning.shotBias / 2, 3, 26));
  adjusted.expected.shotsAway = Math.round(clamp(adjusted.expected.shotsAway + modelLearning.shotBias / 2, 3, 26));
  adjusted.expected.cornersHome = Math.round(clamp(adjusted.expected.cornersHome + modelLearning.cornerBias / 2, 1, 12));
  adjusted.expected.cornersAway = Math.round(clamp(adjusted.expected.cornersAway + modelLearning.cornerBias / 2, 1, 12));
  return adjusted;
}

function renderPreMatchReport(analysis, fixture, home, away) {
  $("preMatchScript").textContent = analysis.matchScript;
  $("preScoringWindow").textContent = analysis.scoringWindow;
  $("preConfidence").textContent = `${analysis.confidence}%`;
  $("preCalibrationNote").textContent = fixture.status === "pre" && modelLearning.samples ? `已根据 ${modelLearning.samples} 场赛后复盘校准` : "原始赛前判断已锁定";
  const weather = analysis.context?.weather || fixture.weather;
  const homeAvailability = analysis.context?.availability?.home || home.availability || {};
  const awayAvailability = analysis.context?.availability?.away || away.availability || {};
  $("preExpectedStats").innerHTML = `
    <span>控球 <b>${analysis.expected.possessionHome}% : ${analysis.expected.possessionAway}%</b></span>
    <span>射门 <b>${analysis.expected.shotsHome} : ${analysis.expected.shotsAway}</b></span>
    <span>角球 <b>${analysis.expected.cornersHome} : ${analysis.expected.cornersAway}</b></span>
    <span>天气 <b>${weather?.summary || "待同步"}</b></span>
    <span>人员 <b>${homeAvailability.summary || "暂无伤病"} / ${awayAvailability.summary || "暂无伤病"}</b></span>`;
  renderInsightCards("preEvidenceGrid", buildPreMatchDeepCards(analysis, fixture, home, away, weather, homeAvailability, awayAvailability));
  hydrateAiAdviceCard(fixture);
  renderTeamPlan("home", home, analysis.home);
  renderTeamPlan("away", away, analysis.away);
}

function hydrateAiAdviceCard(fixture) {
  const grid = $("preEvidenceGrid");
  if (!grid || !fixture?.id) return;
  const card = document.createElement("article");
  card.dataset.aiAdvice = "true";
  card.innerHTML = `<span>AI 复核</span><p>正在基于战力、天气、伤病和赛后校准样本复核本场预测...</p>`;
  grid.appendChild(card);
  if (location.protocol === "file:") {
    card.innerHTML = `<span>AI 复核</span><p>请通过网站服务打开页面后使用 AI 复核；本地文件模式无法调用接口。</p>`;
    return;
  }
  fetch(`/api/ai-match-advice?id=${encodeURIComponent(fixture.id)}`, { cache: "no-store" })
    .then((response) => {
      if (!response.ok) throw new Error("AI 复核接口暂时不可用");
      return response.json();
    })
    .then((advice) => {
      const current = typeof currentFixture === "function" ? currentFixture() : null;
      if (current && current.id !== fixture.id) return;
      const title = advice.available ? "ChatGPT 复核" : "本地模型复核";
      card.classList.add("ai-advice-card");
      card.innerHTML = renderAiAdviceHtml(title, advice);
    })
    .catch((error) => {
      card.innerHTML = `<span>AI 复核</span><p>${escapeInsightHtml(error.message || "AI 复核暂时不可用")}</p>`;
    });
}

function renderAiAdviceHtml(title, advice) {
  const summary = advice.summary || "暂无复核摘要。";
  const checks = Array.isArray(advice.checks) ? advice.checks : [];
  const checkHtml = checks.length
    ? `<ul>${checks.map((item) => `<li>${escapeInsightHtml(item)}</li>`).join("")}</ul>`
    : "";
  const source = advice.source ? `<small>${escapeInsightHtml(advice.source)}</small>` : "";
  return `<span>${escapeInsightHtml(title)}</span><p>${escapeInsightHtml(summary)}</p>${checkHtml}${source}`;
}

function buildPreMatchDeepCards(analysis, fixture, home, away, weather, homeAvailability, awayAvailability) {
  const prediction = analysis.predictedScore || fixture.modelPrediction || { home: 0, away: 0 };
  const eloGap = home.elo - away.elo + (fixture.venueMode === "home" ? 55 : 0);
  const expected = analysis.expected || { possessionHome: 50, possessionAway: 50, shotsHome: 10, shotsAway: 10 };
  const homePlan = analysis.home || {};
  const awayPlan = analysis.away || {};
  const controlSide = expected.possessionHome >= 54 ? home.name : expected.possessionHome <= 46 ? away.name : "双方";
  const shotGap = expected.shotsHome - expected.shotsAway;
  const weatherNotes = weather?.impact?.notes?.length ? weather.impact.notes.join("；") : "天气源尚未给出明确影响，暂按常规比赛节奏评估。";
  const availabilityText = [availabilityEvidenceText(home, homeAvailability), availabilityEvidenceText(away, awayAvailability)].filter(Boolean).join("；") || "暂无会显著改变首发结构的伤病变量。";
  const homeRoute = (homePlan.goalRoutes || []).slice(0, 2).join("、");
  const awayRoute = (awayPlan.goalRoutes || []).slice(0, 2).join("、");

  return [
    {
      title: "推理主线",
      text: `模型并不是只按排名给结论，而是先估计两队赛前战力差、主客场条件、控球能力和攻防结构。本场预估比分为 ${prediction.home}:${prediction.away}，${controlSide}更可能掌握比赛节奏；预期射门差为 ${shotGap >= 0 ? "+" : ""}${shotGap}，说明机会数量的优势${Math.abs(shotGap) >= 4 ? "较明显" : "并不绝对"}。`
    },
    {
      title: "关键对位与空间",
      text: `${home.name}预计以 ${homePlan.formation || "待定阵型"} 展开，主要进攻路径是${homeRoute || "阵地推进与定位球"}；${away.name}预计以 ${awayPlan.formation || "待定阵型"} 应对，主要进攻路径是${awayRoute || "转换进攻与第二落点"}。比赛的关键不是单纯控球多少，而是谁能在肋部、边路身后和禁区前沿把控球转化为有效射门。`
    },
    {
      title: "节奏与风险",
      text: `${analysis.scoringWindow}。若领先方过早回收，比赛会进入低节奏和定位球权重更高的状态；若弱势方能撑过前 25 分钟并减少禁区前失误，胜负概率会向平局或小比分方向移动。`
    },
    {
      title: "天气与人员影响",
      text: `${weatherNotes} 人员方面，${availabilityText} 这些变量只作为预测修正，不会覆盖原有赛程和战力主模型。`
    },
    {
      title: "证据来源",
      text: `本场报告综合了 ESPN 赛程与比赛编号、2022 年世界杯后国家队历史模型、球队实时 Elo/动态战力、已同步的天气预报和球队名单可用性。若官方首发或伤病名单临近开赛变化，报告会优先用新信息修正阵型与机会判断。`
    }
  ];
}

function availabilityEvidenceText(team, availability = {}) {
  const players = availability.players || [];
  if (!availability.unavailableCount && !players.length) return `${team.name}暂无官方伤病名单`;
  const keyPlayers = players.slice(0, 3).map((player) => `${player.name}${player.status ? `(${player.status})` : ""}`).join("、");
  const penalty = availability.ratingPenalty ? `，战力修正 -${availability.ratingPenalty}` : "";
  return `${team.name}${availability.summary || `${players.length} 名球员不可用/存疑`}${keyPlayers ? `：${keyPlayers}` : ""}${penalty}`;
}

function renderInsightCards(containerId, cards) {
  const node = $(containerId);
  if (!node) return;
  node.innerHTML = cards.map((card) => `
    <article>
      <span>${escapeInsightHtml(card.title)}</span>
      <p>${escapeInsightHtml(card.text)}</p>
    </article>
  `).join("");
}

function renderTeamPlan(side, team, plan) {
  $(`${side}PlanLogo`).innerHTML = teamMark(team);
  $(`${side}PlanName`).textContent = team.name;
  $(`${side}Formation`).textContent = plan.formation;
  $(`${side}Approach`).textContent = `${plan.approach}；${plan.pressing || "根据比赛节奏调整压迫高度"}。`;
  $(`${side}LineupFramework`).innerHTML = (plan.lineupFramework || []).map((item) => `<span>${item}</span>`).join("");
  $(`${side}GoalRoutes`).innerHTML = (plan.goalRoutes || []).map((item) => `<li>${item}</li>`).join("");
  $(`${side}DefensiveFocus`).textContent = plan.defensiveFocus;
}

async function hydrateForecastLineups(fixture, home, away, requestId) {
  if (fixture.status !== "post") {
    try {
      const current = await getMatchDetailData(fixture);
      if (requestId !== currentInsightRequest) return;
      const official = current.rosters?.filter((roster) => roster.lineupOfficial && roster.starters.length);
      if (official?.length) {
        renderForecastRoster("home", official.find((roster) => roster.abbr === home.abbr), "官方首发");
        renderForecastRoster("away", official.find((roster) => roster.abbr === away.abbr), "官方首发");
        return;
      }
    } catch {}
  }
  for (const [side, team] of [["home", home], ["away", away]]) {
    const previous = [...fixtures].filter((item) => item.status === "post" && new Date(item.date) < new Date(fixture.date) && (item.home === team.id || item.away === team.id)).sort((a, b) => new Date(b.date) - new Date(a.date))[0];
    if (!previous) continue;
    try {
      const detail = await getMatchDetailData(previous);
      if (requestId !== currentInsightRequest) return;
      const roster = detail.rosters?.find((item) => item.abbr === team.abbr && item.starters.length);
      if (roster) renderForecastRoster(side, roster, "预计首发 · 参考上一场");
    } catch {}
  }
}

function renderForecastRoster(side, roster, label) {
  if (!roster) return;
  $(`${side}Formation`).textContent = roster.formation || $(`${side}Formation`).textContent;
  $(`${side}LineupFramework`).innerHTML = `<em>${label}</em>${roster.starters.map((player) => `<span title="${player.position}">${player.shortName || player.name}</span>`).join("")}`;
}

async function getMatchDetailData(fixture) {
  const stored = matchDetailStore[fixture.id];
  const maxAge = fixture.status === "post" ? 24 * 60 * 60 * 1000 : 2 * 60 * 1000;
  if (stored && Date.now() - new Date(stored.fetchedAt).getTime() < maxAge) return stored;
  let detail;
  if (location.protocol !== "file:") {
    const response = await fetch(`/api/match-detail?id=${encodeURIComponent(fixture.id)}`, { cache: "no-store" });
    if (!response.ok) throw new Error("比赛详情接口暂不可用");
    detail = await response.json();
  } else {
    throw new Error("本地文件模式不支持比赛详情");
  }
  matchDetailStore[fixture.id] = detail;
  writeInsightStorage(MATCH_DETAIL_STORAGE_KEY, matchDetailStore);
  return detail;
}

function renderPostMatchReport(fixture, home, away, pre, detail) {
  const homeStats = detail.statistics?.find((item) => item.abbr === home.abbr)?.values || {};
  const awayStats = detail.statistics?.find((item) => item.abbr === away.abbr)?.values || {};
  const homeRoster = detail.rosters?.find((item) => item.abbr === home.abbr);
  const awayRoster = detail.rosters?.find((item) => item.abbr === away.abbr);
  $("actualDataState").textContent = detail.statistics?.length ? "官方比赛数据已载入" : "官方统计尚未完整发布";
  $("actualMatchSummary").textContent = buildActualSummary(fixture, home, away, homeStats, awayStats, homeRoster, awayRoster, detail.events || []);
  renderInsightCards("actualDeepReport", buildPostMatchDeepCards(fixture, home, away, pre, homeStats, awayStats, homeRoster, awayRoster, detail.events || []));
  $("actualStats").innerHTML = renderActualStatRows(home, away, homeStats, awayStats);
  $("actualEvents").innerHTML = renderEventTimeline(detail.events || [], home, away);
  $("actualLineups").innerHTML = [homeRoster, awayRoster].map((roster) => renderActualRoster(roster, roster?.abbr === home.abbr ? home : away)).join("");
  renderPredictionComparison(fixture, home, away, pre, homeStats, awayStats, homeRoster, awayRoster);
  updateLearningFromMatch(fixture, pre, detail, home, away);
  renderLearningReview(fixture, pre, homeStats, awayStats, homeRoster, awayRoster);
}

function buildActualSummary(fixture, home, away, homeStats, awayStats, homeRoster, awayRoster, events) {
  const possessionHome = statNumber(homeStats, "possessionPct");
  const shotsHome = statNumber(homeStats, "totalShots");
  const shotsAway = statNumber(awayStats, "totalShots");
  const onTargetHome = statNumber(homeStats, "shotsOnTarget");
  const onTargetAway = statNumber(awayStats, "shotsOnTarget");
  const cornersHome = statNumber(homeStats, "wonCorners");
  const cornersAway = statNumber(awayStats, "wonCorners");
  const passHome = statNumber(homeStats, "passPct");
  const passAway = statNumber(awayStats, "passPct");
  const scoring = events.filter((event) => event.type === "goal");
  const cards = events.filter((event) => event.type === "red-card");
  const controlText = possessionHome >= 55 ? `${home.name}以 ${possessionHome.toFixed(1)}% 的控球率掌握更多球权` : possessionHome <= 45 ? `${away.name}在控球层面占优，${home.name}主要依靠转换` : "双方控球接近，比赛更多由局部对抗与机会效率决定";
  const shotText = Number.isFinite(shotsHome) && Number.isFinite(shotsAway) ? `射门数为 ${shotsHome}:${shotsAway}${Number.isFinite(onTargetHome) && Number.isFinite(onTargetAway) ? `，射正为 ${onTargetHome}:${onTargetAway}` : ""}` : "射门统计尚未完整发布";
  const passText = Number.isFinite(passHome) && Number.isFinite(passAway) ? `传球成功率为 ${formatPercentValue(passHome)}:${formatPercentValue(passAway)}` : "传球质量数据尚未完整发布";
  const cornerText = Number.isFinite(cornersHome) && Number.isFinite(cornersAway) ? `角球为 ${cornersHome}:${cornersAway}` : "角球数据尚未完整发布";
  const formationText = homeRoster?.formation || awayRoster?.formation ? `两队实际阵型为 ${homeRoster?.formation || "未知"} 对 ${awayRoster?.formation || "未知"}` : "官方阵型尚未发布";
  const eventText = scoring.length ? `进球发生在 ${scoring.map((event) => `${event.minute} ${event.scorer}`).join("、")}` : "比赛没有产生进球";
  const turningPoint = buildTurningPointText(events, home, away);
  return `${home.name} ${fixture.homeScore}:${fixture.awayScore} ${away.name}。${controlText}，${shotText}，${cornerText}，${passText}，这说明比赛的主要差异来自${describeChanceDifference(fixture, home, away, homeStats, awayStats)}。${formationText}。${eventText}${cards.length ? `；比赛还出现 ${cards.length} 张红牌，显著改变了原有战术条件` : ""}。${turningPoint}`;
}

function buildPostMatchDeepCards(fixture, home, away, pre, homeStats, awayStats, homeRoster, awayRoster, events) {
  const possessionHome = statNumber(homeStats, "possessionPct");
  const shotsHome = statNumber(homeStats, "totalShots");
  const shotsAway = statNumber(awayStats, "totalShots");
  const onTargetHome = statNumber(homeStats, "shotsOnTarget");
  const onTargetAway = statNumber(awayStats, "shotsOnTarget");
  const cornersHome = statNumber(homeStats, "wonCorners");
  const cornersAway = statNumber(awayStats, "wonCorners");
  const passHome = statNumber(homeStats, "passPct");
  const passAway = statNumber(awayStats, "passPct");
  const goals = events.filter((event) => event.type === "goal");
  const redCards = events.filter((event) => event.type === "red-card");
  const actualShotsTotal = safeSum(shotsHome, shotsAway);
  const predictedShotsTotal = (pre.expected?.shotsHome || 0) + (pre.expected?.shotsAway || 0);
  const actualPossessionText = Number.isFinite(possessionHome) ? `${possessionHome.toFixed(1)}% : ${(100 - possessionHome).toFixed(1)}%` : "待发布";
  const formationActual = `${homeRoster?.formation || "待发布"} 对 ${awayRoster?.formation || "待发布"}`;
  const formationPredicted = `${pre.home?.formation || "--"} 对 ${pre.away?.formation || "--"}`;
  const prediction = fixture.modelPrediction || pre.predictedScore || { home: 0, away: 0 };
  const scoreReview = assessPrediction(fixture);

  return [
    {
      title: "比赛走向",
      text: buildMatchFlowText(fixture, home, away, goals, redCards)
    },
    {
      title: "控制权与推进质量",
      text: `实际控球为 ${actualPossessionText}，赛前预计为 ${pre.expected?.possessionHome ?? "--"}% : ${pre.expected?.possessionAway ?? "--"}%。${buildControlInterpretation(home, away, possessionHome, shotsHome, shotsAway)}`
    },
    {
      title: "机会质量",
      text: `射门 ${statPair(shotsHome, shotsAway)}，射正 ${statPair(onTargetHome, onTargetAway)}。${describeChanceDifference(fixture, home, away, homeStats, awayStats)}`
    },
    {
      title: "纪律与定位球",
      text: `红牌 ${statPair(statNumber(homeStats, "redCards"), statNumber(awayStats, "redCards"))}，黄牌 ${statPair(statNumber(homeStats, "yellowCards"), statNumber(awayStats, "yellowCards"))}，角球 ${statPair(cornersHome, cornersAway)}。${buildDisciplineInterpretation(home, away, homeStats, awayStats, events)}`
    },
    {
      title: "传球与压迫承受",
      text: `传球成功率 ${statPairPercent(passHome, passAway)}，长传成功率 ${statPairPercent(statNumber(homeStats, "longballPct"), statNumber(awayStats, "longballPct"))}。${buildPassingInterpretation(home, away, possessionHome, passHome, passAway, shotsHome, shotsAway)}`
    },
    {
      title: "战术兑现与偏差",
      text: `赛前预计阵型为 ${formationPredicted}，实际为 ${formationActual}。${buildFormationInterpretation(pre, homeRoster, awayRoster, home, away)}`
    },
    {
      title: "预测复盘",
      text: `赛前比分判断为 ${prediction.home}:${prediction.away}，真实比分为 ${fixture.homeScore}:${fixture.awayScore}，结论为“${scoreReview?.label || "等待评估"}”。射门总量预测 ${predictedShotsTotal}，实际 ${Number.isFinite(actualShotsTotal) ? actualShotsTotal : "待发布"}，这会进入后续模型校准。`
    },
    {
      title: "信息源与客观性",
      text: "本段复盘优先使用 ESPN 官方比赛详情中的事件、技术统计、阵型与首发，再与赛前锁定快照、动态战力和天气/人员变量对照；不使用社交媒体情绪作为判断依据。"
    }
  ];
}

function buildMatchFlowText(fixture, home, away, goals, redCards) {
  if (!goals.length && !redCards.length) return "官方事件流尚未给出关键事件，当前只能从比分和技术统计判断比赛走向。";
  const firstGoal = goals[0];
  const firstGoalMinute = firstGoal ? minuteNumber(firstGoal.minute) : null;
  const firstGoalTeam = firstGoal?.teamAbbr === home.abbr ? home.name : away.name;
  const redText = redCards.length ? `红牌出现在 ${redCards.map((event) => `${event.minute} ${event.scorer || ""}`.trim()).join("、")}，这会改变压迫强度、阵型高度和反击空间。` : "没有红牌事件，比赛走势主要由进球时点和机会效率决定。";
  if (!firstGoal) return `${redText} 比分最终为 ${fixture.homeScore}:${fixture.awayScore}，需要结合技术统计判断哪一方更接近主动。`;
  const phase = firstGoalMinute <= 15 ? "很早" : firstGoalMinute <= 45 ? "上半场中段" : firstGoalMinute <= 70 ? "下半场前段" : "比赛末段";
  return `${firstGoalTeam}在${phase}取得首个进球，这通常会迫使落后一方提高推进风险，也让领先方可以选择更耐心地控制节奏或等待转换机会。${redText}`;
}

function buildTurningPointText(events, home, away) {
  const important = events.filter((event) => event.type === "goal" || event.type === "red-card");
  if (!important.length) return "官方事件流暂未提供足够的转折点信息。";
  const firstRed = important.find((event) => event.type === "red-card");
  const firstGoal = important.find((event) => event.type === "goal");
  if (firstRed) {
    const team = firstRed.teamAbbr === home.abbr ? home.name : away.name;
    return `最重要的转折点是 ${firstRed.minute} ${team}出现红牌，之后比赛空间和攻守风险都会被重新分配。`;
  }
  if (firstGoal) {
    const team = firstGoal.teamAbbr === home.abbr ? home.name : away.name;
    return `最重要的转折点是 ${firstGoal.minute} ${team}取得进球，比赛从原本的均衡状态转向追赶与反击的结构。`;
  }
  return "";
}

function buildControlInterpretation(home, away, possessionHome, shotsHome, shotsAway) {
  if (!Number.isFinite(possessionHome) || !Number.isFinite(shotsHome) || !Number.isFinite(shotsAway)) return "由于官方统计尚未完整发布，暂不能判断控球是否真正转化为推进质量。";
  if (possessionHome >= 56 && shotsHome > shotsAway + 5) return `${home.name}不只是控球更多，也把控球转化成了更高的射门产量，比赛重心长期压在对手半场。`;
  if (possessionHome >= 56 && shotsHome <= shotsAway + 2) return `${home.name}控球占优，但射门优势不明显，说明对手防线限制了进入禁区后的最后处理。`;
  if (possessionHome <= 44 && shotsAway > shotsHome + 5) return `${away.name}控球和机会都占优，${home.name}的防守反击没有形成足够稳定的出口。`;
  return "控球和射门没有形成单边压制，比赛更接近局部效率和关键事件决定胜负。";
}

function buildDisciplineInterpretation(home, away, homeStats, awayStats, events) {
  const homeReds = statNumber(homeStats, "redCards");
  const awayReds = statNumber(awayStats, "redCards");
  const homeCorners = statNumber(homeStats, "wonCorners");
  const awayCorners = statNumber(awayStats, "wonCorners");
  const redEvents = events.filter((event) => event.type === "red-card");
  if (redEvents.length) {
    const first = redEvents[0];
    const team = first.teamAbbr === home.abbr ? home.name : away.name;
    return `${first.minute} ${team}的红牌是比赛状态的关键变量，之后少打一方必须降低前压强度，另一方则更容易把控球推进到危险区域。`;
  }
  if (Number.isFinite(homeCorners) && Number.isFinite(awayCorners) && Math.abs(homeCorners - awayCorners) >= 4) {
    const side = homeCorners > awayCorners ? home.name : away.name;
    return `${side}制造了更多定位球压力，说明边路推进或禁区压迫更持续。`;
  }
  if (Number.isFinite(homeReds) && Number.isFinite(awayReds) && homeReds + awayReds === 0) return "纪律层面没有极端事件，比赛更接近常规技战术对抗。";
  return "纪律与定位球数据不足以单独解释结果，需要结合进球时间和射门质量判断。";
}

function buildPassingInterpretation(home, away, possessionHome, passHome, passAway, shotsHome, shotsAway) {
  if (!Number.isFinite(passHome) || !Number.isFinite(passAway)) return "官方传球数据尚未完整发布，暂不能判断推进稳定性。";
  const homePass = normalizePercent(passHome);
  const awayPass = normalizePercent(passAway);
  if (possessionHome >= 55 && homePass >= awayPass + 7 && shotsHome >= shotsAway + 4) {
    return `${home.name}的传球稳定性、控球份额和射门产量形成一致证据，说明优势不是表面控球，而是持续推进后的机会积累。`;
  }
  if (possessionHome <= 45 && awayPass >= homePass + 7 && shotsAway >= shotsHome + 4) {
    return `${away.name}的传球稳定性、控球份额和射门产量形成一致证据，比赛主动权更清晰。`;
  }
  if (Math.abs(homePass - awayPass) <= 5 && Math.abs(shotsHome - shotsAway) >= 6) {
    return "双方传球稳定性接近，但射门差距明显，说明决定因素更可能来自前场跑动、禁区触球或转换效率。";
  }
  return "传球成功率没有单独拉开比赛，仍需结合压迫强度、最后一传质量和射门选择理解比赛。";
}

function describeChanceDifference(fixture, home, away, homeStats, awayStats) {
  const shotsHome = statNumber(homeStats, "totalShots");
  const shotsAway = statNumber(awayStats, "totalShots");
  const onTargetHome = statNumber(homeStats, "shotsOnTarget");
  const onTargetAway = statNumber(awayStats, "shotsOnTarget");
  if (!Number.isFinite(shotsHome) || !Number.isFinite(shotsAway)) return "官方射门数据暂未完整发布";
  const homeConversion = shotsHome ? fixture.homeScore / shotsHome : 0;
  const awayConversion = shotsAway ? fixture.awayScore / shotsAway : 0;
  if (shotsHome >= shotsAway * 2 && fixture.homeScore > fixture.awayScore) return `${home.name}的机会产量明显更高，并最终把数量优势转化为比分优势`;
  if (shotsAway >= shotsHome * 2 && fixture.awayScore > fixture.homeScore) return `${away.name}的机会产量明显更高，并最终把数量优势转化为比分优势`;
  if (Number.isFinite(onTargetHome) && Number.isFinite(onTargetAway) && onTargetHome === onTargetAway && fixture.homeScore !== fixture.awayScore) return "双方射正接近，比分差更多来自终结质量、门前选择或关键防守失误";
  if (Math.abs(homeConversion - awayConversion) >= 0.18) return "双方机会转化率差异明显，效率比单纯控球更能解释结果";
  return "机会数量和转化效率都没有形成极端差距，关键事件对比分影响较大";
}

function buildFormationInterpretation(pre, homeRoster, awayRoster, home, away) {
  const homeHit = homeRoster?.formation && homeRoster.formation === pre.home?.formation;
  const awayHit = awayRoster?.formation && awayRoster.formation === pre.away?.formation;
  if (homeHit && awayHit) return "两队实际阵型与赛前判断一致，后续复盘重点会放在执行质量，而不是阵型识别。";
  const misses = [];
  if (homeRoster?.formation && !homeHit) misses.push(`${home.name}实际使用 ${homeRoster.formation}`);
  if (awayRoster?.formation && !awayHit) misses.push(`${away.name}实际使用 ${awayRoster.formation}`);
  if (!misses.length) return "官方阵型尚未完整发布，暂不能确认赛前阵型判断是否命中。";
  return `${misses.join("，")}，说明赛前报告需要更重视最近一场官方首发、教练临场保守/激进倾向和对位需求。`;
}

function renderActualStatRows(home, away, homeStats, awayStats) {
  const rows = [
    ["控球率", statDisplay(homeStats, "possessionPct", "%"), statDisplay(awayStats, "possessionPct", "%")],
    ["射门", statDisplay(homeStats, "totalShots"), statDisplay(awayStats, "totalShots")],
    ["射正", statDisplay(homeStats, "shotsOnTarget"), statDisplay(awayStats, "shotsOnTarget")],
    ["角球", statDisplay(homeStats, "wonCorners"), statDisplay(awayStats, "wonCorners")],
    ["传球成功率", percentageStat(homeStats, "passPct"), percentageStat(awayStats, "passPct")]
  ];
  return `<div class="actual-stat-head"><b>${home.name}</b><span>实际数据</span><b>${away.name}</b></div>${rows.map(([label, left, right]) => `<div><b>${left}</b><span>${label}</span><b>${right}</b></div>`).join("")}`;
}

function renderEventTimeline(events, home, away) {
  const important = events.filter((event) => ["goal", "red-card"].includes(event.type));
  if (!important.length) return `<p class="insight-muted">暂无进球或红牌事件</p>`;
  return important.map((event) => `<div class="${event.type}"><time>${event.minute}</time><span>${event.type === "goal" ? "进球" : "红牌"}</span><b>${event.scorer || "未知球员"}</b><small>${event.teamAbbr === home.abbr ? home.name : away.name}${event.assist ? ` · 助攻 ${event.assist}` : ""}${event.penalty ? " · 点球" : ""}</small></div>`).join("");
}

function renderActualRoster(roster, team) {
  if (!roster?.starters?.length) return `<section><header>${teamMark(team, true)}<b>${team.name}</b><span>首发待发布</span></header></section>`;
  return `<section><header>${teamMark(team, true)}<b>${team.name}</b><span>${roster.formation || "阵型未知"}</span></header><div>${roster.starters.map((player) => `<span><i>${player.jersey || "-"}</i>${player.shortName || player.name}<small>${player.position}</small></span>`).join("")}</div></section>`;
}

function renderPredictionComparison(fixture, home, away, pre, homeStats, awayStats, homeRoster, awayRoster) {
  const prediction = fixture.modelPrediction || { home: 0, away: 0 };
  const resultAssessment = assessPrediction(fixture);
  const actualPossession = statNumber(homeStats, "possessionPct");
  const possessionDifference = Number.isFinite(actualPossession) ? Math.abs(actualPossession - pre.expected.possessionHome) : null;
  const actualShots = statNumber(homeStats, "totalShots") + statNumber(awayStats, "totalShots");
  const predictedShots = pre.expected.shotsHome + pre.expected.shotsAway;
  const formationHit = homeRoster?.formation === pre.home.formation && awayRoster?.formation === pre.away.formation;
  $("comparisonVerdict").className = resultAssessment?.className || "";
  $("comparisonVerdict").textContent = resultAssessment?.label || "等待评估";
  $("predictionComparison").innerHTML = [
    comparisonItem("比分与赛果", `预测 ${prediction.home}:${prediction.away}`, `实际 ${fixture.homeScore}:${fixture.awayScore}`, resultAssessment?.className === "prediction-correct" ? "完全命中" : resultAssessment?.className === "prediction-close" ? "赛果命中，比分偏差" : "赛果方向错误"),
    comparisonItem("比赛控制", `预计控球 ${pre.expected.possessionHome}%:${pre.expected.possessionAway}%`, Number.isFinite(actualPossession) ? `实际 ${actualPossession.toFixed(1)}%:${(100 - actualPossession).toFixed(1)}%` : "实际数据待发布", possessionDifference === null ? "待评估" : possessionDifference <= 6 ? "判断接近" : `偏差 ${possessionDifference.toFixed(1)} 个百分点`),
    comparisonItem("机会数量", `预计射门 ${pre.expected.shotsHome}:${pre.expected.shotsAway}`, Number.isFinite(actualShots) ? `实际 ${statNumber(homeStats, "totalShots")}:${statNumber(awayStats, "totalShots")}` : "实际数据待发布", Number.isFinite(actualShots) ? `总量偏差 ${Math.abs(actualShots - predictedShots)} 次` : "待评估"),
    comparisonItem("阵型判断", `预计 ${pre.home.formation} 对 ${pre.away.formation}`, `${homeRoster?.formation || "待发布"} 对 ${awayRoster?.formation || "待发布"}`, formationHit ? "阵型命中" : "阵型需要修正")
  ].join("");
}

function comparisonItem(title, predicted, actual, verdict) {
  return `<article><span>${title}</span><div><small>赛前</small><b>${predicted}</b></div><div><small>赛后</small><b>${actual}</b></div><em>${verdict}</em></article>`;
}

function updateLearningFromMatch(fixture, pre, detail, home, away) {
  if (modelLearning.learnedMatches.includes(fixture.id)) return;
  const homeStats = detail.statistics?.find((item) => item.abbr === home.abbr)?.values || {};
  const awayStats = detail.statistics?.find((item) => item.abbr === away.abbr)?.values || {};
  const actualPossession = statNumber(homeStats, "possessionPct");
  const actualShots = statNumber(homeStats, "totalShots") + statNumber(awayStats, "totalShots");
  const actualCorners = statNumber(homeStats, "wonCorners") + statNumber(awayStats, "wonCorners");
  if (!Number.isFinite(actualPossession) || !Number.isFinite(actualShots)) return;
  const nextSamples = modelLearning.samples + 1;
  const weight = 1 / Math.min(nextSamples, 12);
  modelLearning.possessionBias = rollingValue(modelLearning.possessionBias, actualPossession - pre.expected.possessionHome, weight);
  modelLearning.shotBias = rollingValue(modelLearning.shotBias, actualShots - pre.expected.shotsHome - pre.expected.shotsAway, weight);
  if (Number.isFinite(actualCorners)) modelLearning.cornerBias = rollingValue(modelLearning.cornerBias, actualCorners - pre.expected.cornersHome - pre.expected.cornersAway, weight);
  const predictedGoals = (fixture.modelPrediction?.home || 0) + (fixture.modelPrediction?.away || 0);
  modelLearning.goalBias = rollingValue(modelLearning.goalBias, fixture.homeScore + fixture.awayScore - predictedGoals, weight);
  const homeRoster = detail.rosters?.find((item) => item.abbr === home.abbr);
  const awayRoster = detail.rosters?.find((item) => item.abbr === away.abbr);
  if (homeRoster?.formation === pre.home.formation && awayRoster?.formation === pre.away.formation) modelLearning.formationHits += 1;
  if (scoreOutcome(fixture.modelPrediction?.home || 0, fixture.modelPrediction?.away || 0) === (fixture.winnerSide || scoreOutcome(fixture.homeScore, fixture.awayScore))) modelLearning.outcomeHits += 1;
  modelLearning.samples = nextSamples;
  modelLearning.learnedMatches.push(fixture.id);
  writeInsightStorage(MODEL_LEARNING_STORAGE_KEY, modelLearning);
}

function rollingValue(current, next, weight) {
  return Math.round((current * (1 - weight) + next * weight) * 10) / 10;
}

function renderLearningReview(fixture, pre, homeStats, awayStats, homeRoster, awayRoster) {
  const actualPossession = statNumber(homeStats, "possessionPct");
  const actualShots = statNumber(homeStats, "totalShots") + statNumber(awayStats, "totalShots");
  const predictedShots = pre.expected.shotsHome + pre.expected.shotsAway;
  const possessionError = Number.isFinite(actualPossession) ? actualPossession - pre.expected.possessionHome : 0;
  const shotError = Number.isFinite(actualShots) ? actualShots - predictedShots : 0;
  const formationMismatch = homeRoster?.formation !== pre.home.formation || awayRoster?.formation !== pre.away.formation;
  const items = [
    { title: "控球校准", value: `${modelLearning.possessionBias >= 0 ? "+" : ""}${modelLearning.possessionBias.toFixed(1)}%`, text: Math.abs(possessionError) > 6 ? "本场控球判断偏差较大，后续会降低单纯 Elo 差值对控球率的影响，并提高实际比赛风格权重。" : "本场控球走势接近预测，继续保留当前控制力权重。" },
    { title: "机会数量", value: `${modelLearning.shotBias >= 0 ? "+" : ""}${modelLearning.shotBias.toFixed(1)} 次`, text: Math.abs(shotError) > 5 ? "本场射门总量与预测差异明显，后续将修正比赛开放度与攻防节奏估计。" : "射门总量处于合理误差范围，机会生成模型保持稳定。" },
    { title: "阵型识别", value: modelLearning.samples ? `${Math.round(modelLearning.formationHits / modelLearning.samples * 100)}%` : "--", text: formationMismatch ? "实际阵型与预计框架不同，后续同队比赛会优先参考最近一场官方阵型和首发。" : "两队实际阵型符合赛前判断，阵型选择规则获得正向样本。" },
    { title: "赛果判断", value: modelLearning.samples ? `${Math.round(modelLearning.outcomeHits / modelLearning.samples * 100)}%` : "--", text: "命中率用于调整后续赛前报告的可信度，不会修改已经锁定的历史预测。" }
  ];
  $("learningSampleCount").textContent = `累计 ${modelLearning.samples} 场复盘样本`;
  $("learningAdjustments").innerHTML = items.map((item) => `<article><span>${item.title}</span><b>${item.value}</b><p>${item.text}</p></article>`).join("");
}

function renderPostMatchFallback(fixture, home, away, pre) {
  $("actualDataState").textContent = "官方技术统计暂时不可用";
  $("actualMatchSummary").textContent = `${home.name} ${fixture.homeScore}:${fixture.awayScore} ${away.name}。最终比分已经同步，阵型、首发和技术统计将在数据源恢复后自动补充。`;
  renderInsightCards("actualDeepReport", [
    { title: "当前可读信息", text: `目前只能确认最终比分 ${fixture.homeScore}:${fixture.awayScore}、赛前预测 ${fixture.modelPrediction?.home ?? pre.predictedScore?.home ?? "--"}:${fixture.modelPrediction?.away ?? pre.predictedScore?.away ?? "--"} 和赛程状态。` },
    { title: "等待补全内容", text: "官方事件、技术统计、首发阵型和红黄牌数据载入后，系统会重新生成比赛走向、关键转折点、机会质量和模型校准结论。" }
  ]);
  $("actualStats").innerHTML = `<p class="insight-muted">等待官方统计</p>`;
  $("actualEvents").innerHTML = "";
  $("actualLineups").innerHTML = `<p class="insight-muted">等待官方首发与阵型数据</p>`;
  renderPredictionComparison(fixture, home, away, pre, {}, {}, null, null);
  $("learningSampleCount").textContent = "本场尚未纳入校准";
  $("learningAdjustments").innerHTML = `<p class="insight-muted">技术统计载入后自动生成模型复盘。</p>`;
}

async function refreshCompletedMatchLearning() {
  if (learningRefreshPromise) return learningRefreshPromise;
  const pending = fixtures.filter((fixture) => fixture.status === "post" && fixture.home && fixture.away && !modelLearning.learnedMatches.includes(fixture.id));
  learningRefreshPromise = (async () => {
    for (let index = 0; index < pending.length; index += 3) {
      await Promise.all(pending.slice(index, index + 3).map(async (fixture) => {
        try {
          const home = teamById(fixture.home);
          const away = teamById(fixture.away);
          const pre = fixture.preMatchAnalysis || fallbackPreMatchAnalysis(home, away, fixture, predict(home, away, fixture.venueMode, fixture));
          const detail = await getMatchDetailData(fixture);
          updateLearningFromMatch(fixture, pre, detail, home, away);
        } catch {}
      }));
    }
  })().finally(() => { learningRefreshPromise = null; });
  return learningRefreshPromise;
}

function statNumber(stats, key) {
  const value = Number(stats?.[key]);
  return Number.isFinite(value) ? value : NaN;
}

function statDisplay(stats, key, suffix = "") {
  const value = statNumber(stats, key);
  return Number.isFinite(value) ? `${Number.isInteger(value) ? value : value.toFixed(1)}${suffix}` : "--";
}

function percentageStat(stats, key) {
  const value = statNumber(stats, key);
  if (!Number.isFinite(value)) return "--";
  return `${Math.round(value <= 1 ? value * 100 : value)}%`;
}

function safeSum(...values) {
  const finite = values.filter(Number.isFinite);
  return finite.length === values.length ? finite.reduce((sum, value) => sum + value, 0) : NaN;
}

function statPair(left, right, suffix = "") {
  const leftText = Number.isFinite(left) ? `${Number.isInteger(left) ? left : left.toFixed(1)}${suffix}` : "--";
  const rightText = Number.isFinite(right) ? `${Number.isInteger(right) ? right : right.toFixed(1)}${suffix}` : "--";
  return `${leftText}:${rightText}`;
}

function normalizePercent(value) {
  return value <= 1 ? value * 100 : value;
}

function formatPercentValue(value) {
  if (!Number.isFinite(value)) return "--";
  return `${Math.round(normalizePercent(value))}%`;
}

function statPairPercent(left, right) {
  return `${formatPercentValue(left)}:${formatPercentValue(right)}`;
}

function minuteNumber(value) {
  const match = String(value || "").match(/\d+/);
  return match ? Number(match[0]) : 0;
}

function escapeInsightHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}
