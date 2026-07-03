const { getAiMatchAdvice } = require("../server");

module.exports = async function handler(request, response) {
  try {
    const data = await getAiMatchAdvice(request.query?.id);
    response.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    response.status(200).json(data);
  } catch (error) {
    response.status(503).json({ error: "AI 复核暂时不可用", detail: error.message });
  }
};
