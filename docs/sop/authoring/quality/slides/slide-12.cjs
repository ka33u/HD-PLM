const { render } = require('../theme.cjs');
const slideConfig = {
  "type": "content",
  "title": "项目负责人看同一份质量台账",
  "image": "08-owner.png",
  "points": [
    [
      "1",
      "项目内“质量记录”查看三类资料"
    ],
    [
      "2",
      "在阶段记录引用报告编号与结论"
    ],
    [
      "3",
      "需要跨部门整改时引用原记录建问题"
    ]
  ],
  "tip": "质量记录只提醒，不拦截推进；交付、BOM及已建项目问题检查继续有效。",
  "index": 12
};
function createSlide(pres,theme){return render(pres,theme,slideConfig)}
module.exports={slideConfig,createSlide};
