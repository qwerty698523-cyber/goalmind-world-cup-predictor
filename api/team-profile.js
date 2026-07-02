const { getTeamProfile } = require("../server");

module.exports = async function handler(request, response) {
  try {
    const data = await getTeamProfile(request.query?.id);
    response.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=1800");
    response.status(200).json(data);
  } catch (error) {
    response.status(503).json({ error: "球队名单暂时不可用", detail: error.message });
  }
};
