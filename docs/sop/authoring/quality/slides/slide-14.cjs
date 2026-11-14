const { render } = require('../theme.cjs');
const slideConfig = {
  "type": "summary",
  "title": "练习：完成一次检验与复验",
  "points": [
    "建立一条来料记录，填明物料、批次和检验依据。",
    "保存草稿，上传现场照片，提交一次不合格判定。",
    "补充处置和复验结论，关闭异常，查看原判定与历史。",
    "建立样机报告，上传文件并完成分析，核对后提交。"
  ],
  "tip": "交付标准：找得到实物、看得到依据、读得懂结论、查得到修改历史。",
  "index": 14
};
function createSlide(pres,theme){return render(pres,theme,slideConfig)}
module.exports={slideConfig,createSlide};
