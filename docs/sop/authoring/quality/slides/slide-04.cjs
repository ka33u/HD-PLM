const { render } = require('../theme.cjs');
const slideConfig = {
  "type": "content",
  "title": "进入质量管理，先找对应项目",
  "image": "01-projects.png",
  "points": [
    [
      "1",
      "按编号、型号或负责人搜索"
    ],
    [
      "2",
      "点击项目卡片进入记录列表"
    ],
    [
      "3",
      "卡片显示记录数与待处理异常"
    ]
  ],
  "tip": "不要凭电机类型判断实物归属：相同类型可能对应多个项目。",
  "index": 4
};
function createSlide(pres,theme){return render(pres,theme,slideConfig)}
module.exports={slideConfig,createSlide};
