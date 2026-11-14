// Authoring only: NODE_PATH points to the approved workspace dependency bundle.
const PptxGenJS=require('pptxgenjs');const path=require('node:path');
const pres=new PptxGenJS();pres.layout='LAYOUT_16x9';pres.author='HD-PLM';pres.subject='质量部软件操作 SOP';pres.title='质量部软件操作 SOP';pres.company='无锡市亨达电机有限公司';pres.lang='zh-CN';
pres.theme={headFontFace:'Microsoft YaHei',bodyFontFace:'Microsoft YaHei',lang:'zh-CN'};
const theme={primary:'14333F',secondary:'344E59',accent:'177C66',light:'C9E4DA',bg:'FFFFFF'};
for(let i=1;i<=14;i++)require(`./slides/slide-${String(i).padStart(2,'0')}.cjs`).createSlide(pres,theme);
pres.writeFile({fileName:path.resolve(__dirname,'../../quality.pptx')});
