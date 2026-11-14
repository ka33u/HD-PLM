const { render } = require('../theme.cjs');
const slideConfig = {
  "type": "content",
  "layout": "phone",
  "title": "手机到现场，直接拍照上传",
  "image": "10-mobile-upload.png",
  "points": [
    [
      "1",
      "打开可访问的系统地址并登录"
    ],
    [
      "2",
      "质量管理 → 项目 → 草稿"
    ],
    [
      "3",
      "拍照或相册多选，核对说明后上传"
    ],
    [
      "4",
      "确认全部成功，再离开页面"
    ]
  ],
  "tip": "每批最多 20 张，自动缩小大图；保留原片。手机不能用 localhost 访问电脑上的系统。",
  "index": 9
};
function createSlide(pres,theme){return render(pres,theme,slideConfig)}
module.exports={slideConfig,createSlide};
