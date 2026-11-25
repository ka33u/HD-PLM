const {render}=require('../theme.cjs');
const slideConfig={
  "type": "content",
  "title": "进入制造准备，确认图纸日期",
  "image": "02-stage-confirm.png",
  "focus": {
    "x": 390,
    "y": 320,
    "w": 660,
    "h": 360
  },
  "points": [
    [
      "1",
      "核对目标为“制造准备”"
    ],
    [
      "2",
      "填实际图纸完成日期，不能填未来日期"
    ],
    [
      "3",
      "点击“确认推进”，等待当前阶段更新"
    ]
  ],
  "tip": "后续阶段同样需要明确确认。系统记录操作人和时间，不支持跳过顺序。",
  "index": 4
};
function createSlide(pres,theme){return render(pres,theme,slideConfig)}
module.exports={slideConfig,createSlide};
