const { render } = require('../theme.cjs');
const slideConfig = {
  "type": "content",
  "title": "来料检验先写清物料和批次",
  "image": "02-incoming-form.png",
  "focus": true,
  "points": [
    [
      "1",
      "填写供应商、物料编码与批次"
    ],
    [
      "2",
      "填来料数量、检验数量和日期"
    ],
    [
      "3",
      "写标准、实测结果及真实判定"
    ]
  ],
  "tip": "检验数量须大于零且不超过来料数量；检验日期不能填未来日期。",
  "index": 5
};
function createSlide(pres,theme){return render(pres,theme,slideConfig)}
module.exports={slideConfig,createSlide};
