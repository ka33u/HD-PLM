const {render}=require('../theme.cjs');
const slideConfig={
  "type": "content",
  "title": "照片与附件按需添加",
  "layout": "phone",
  "image": "06-mobile-files.png",
  "points": [
    [
      "1",
      "打开记录，展开“照片与附件（选填）”"
    ],
    [
      "2",
      "拍照、相册多选或选择报告文件"
    ],
    [
      "3",
      "确认上传成功，再关闭页面"
    ],
    [
      "4",
      "不上传任何资料，也可以保存和推进"
    ]
  ],
  "tip": "每批最多 20 张；登录过期可原地恢复。手机使用公司可访问地址，不能用电脑的 localhost。",
  "index": 7
};
function createSlide(pres,theme){return render(pres,theme,slideConfig)}
module.exports={slideConfig,createSlide};
