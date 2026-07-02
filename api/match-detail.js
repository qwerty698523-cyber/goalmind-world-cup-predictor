const { getMatchDetail } = require("../server");

module.exports = async function handler(request, response) {
  try {
    const data = await getMatchDetail(request.query?.id);
    response.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    response.status(200).json(data);
  } catch (error) {
    response.status(503).json({ error: "比赛详情暂时不可用", detail: error.message });
  }
};
