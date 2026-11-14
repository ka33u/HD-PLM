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
  "tip": "质量记录不会自动创建阻拦流程的问题；原有阶段结论、交付和问题闭环要求继续有效。",
  "index": 12
};
function createSlide(pres,theme){return render(pres,theme,slideConfig)}
module.exports={slideConfig,createSlide};
