const { getData } = require("../server");

module.exports = async function handler(request, response) {
  try {
    const force = request.query?.force === "1";
    const data = await getData(force);
    response.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    response.status(200).json(data);
  } catch (error) {
    response.status(503).json({ error: "赛事数据暂时不可用", detail: error.message });
  }
};
