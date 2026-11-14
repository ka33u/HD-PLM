const { render } = require('../theme.cjs');
const slideConfig = {
  "type": "content",
  "title": "过程检验定位到工序与实物",
  "image": "06-process-detail.png",
  "focus": true,
  "points": [
    [
      "1",
      "填零件 / 整机编码、工序与批次"
    ],
    [
      "2",
      "逐项记录限值、实测值及判定"
    ],
    [
      "3",
      "上传工序、测量及异常近照"
    ]
  ],
  "tip": "示例：径向跳动要求 ≤ 0.03 mm，记录实际测量值，不能只写“合格”。",
  "index": 7
};
function createSlide(pres,theme){return render(pres,theme,slideConfig)}
module.exports={slideConfig,createSlide};
