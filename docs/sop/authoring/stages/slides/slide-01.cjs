const {render}=require('../theme.cjs');
const slideConfig={
  "type": "cover",
  "title": "项目阶段推进操作 SOP",
  "subtitle": "适用：当前项目负责人 · 设计 / 技术岗位",
  "image": "01-stage-overview.png",
  "index": 1
};
function createSlide(pres,theme){return render(pres,theme,slideConfig)}
module.exports={slideConfig,createSlide};
