const { render } = require('../theme.cjs');
const slideConfig = {
  "type": "cover",
  "title": "质量部软件操作 SOP",
  "subtitle": "来料检验  ·  过程检验  ·  样机报告",
  "image": "01-projects.png",
  "points": [
    "HD-PLM 4.3.0",
    "质量岗位独立课件 · 2026.11",
    "按项目留档，按事实作结论"
  ],
  "index": 1
};
function createSlide(pres,theme){return render(pres,theme,slideConfig)}
module.exports={slideConfig,createSlide};
