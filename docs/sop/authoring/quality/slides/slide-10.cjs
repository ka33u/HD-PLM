const { render } = require('../theme.cjs');
const slideConfig = {
  "type": "content",
  "title": "异常关闭时填写处置与复验",
  "image": "04-resolution.png",
  "focus": true,
  "points": [
    [
      "1",
      "先提交异常记录，保留原判定"
    ],
    [
      "2",
      "填写处置措施、依据与复验结果"
    ],
    [
      "3",
      "确认关闭异常后，列表显示已关闭"
    ]
  ],
  "tip": "关闭异常不把原“不合格”改成“合格”；措施已执行但未复验，不能当作处理完成。",
  "index": 10
};
function createSlide(pres,theme){return render(pres,theme,slideConfig)}
module.exports={slideConfig,createSlide};
