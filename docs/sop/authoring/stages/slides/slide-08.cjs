const {render}=require('../theme.cjs');
const slideConfig={
  "type": "content",
  "title": "按钮不可用，按提示处理业务事项",
  "image": "07-closure-check.png",
  "focus": {
    "x": 820,
    "y": 675,
    "w": 570,
    "h": 185
  },
  "points": [
    [
      "1",
      "交付任务：规定零件、工装及整机确认完成"
    ],
    [
      "2",
      "BOM：处理待复核和未分配任务"
    ],
    [
      "3",
      "问题闭环：结项前关闭全部已建问题"
    ]
  ],
  "tip": "进入客户试用前仍须关闭高等级问题。质量异常仅提醒，不自动拦截流程。",
  "index": 8
};
function createSlide(pres,theme){return render(pres,theme,slideConfig)}
module.exports={slideConfig,createSlide};
