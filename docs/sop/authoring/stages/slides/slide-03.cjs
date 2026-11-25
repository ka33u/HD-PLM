const {render}=require('../theme.cjs');
const slideConfig={
  "type": "content",
  "title": "在项目流程找到推进按钮",
  "image": "01-stage-overview.png",
  "focus": {
    "x": 250,
    "y": 420,
    "w": 1160,
    "h": 520
  },
  "points": [
    [
      "1",
      "左侧看当前阶段，右侧看下一阶段"
    ],
    [
      "2",
      "当前项目负责人点击“推进阶段”"
    ],
    [
      "3",
      "没有记录也可以推进；不要为推进补造资料"
    ]
  ],
  "tip": "主管、生产和采购按权限查看。管理员身份不自动取得其他负责人的推进权限。",
  "index": 3
};
function createSlide(pres,theme){return render(pres,theme,slideConfig)}
module.exports={slideConfig,createSlide};
