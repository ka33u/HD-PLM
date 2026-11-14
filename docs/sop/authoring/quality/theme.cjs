const path=require('node:path');
const font='Microsoft YaHei';
function text(s,t,x,y,w,h,size,color,bold=false){s.addText(t,{x,y,w,h,fontFace:font,fontSize:size,color,bold,margin:0,breakLine:false,vertAnchor:'ctr',valign:'mid',paraSpaceAfter:4,lang:'zh-CN'});}
function rect(s,p,x,y,w,h,color){s.addShape(p.ShapeType.rect,{x,y,w,h,fill:{color},line:{color,width:0.1}})}
function circle(s,p,t,x,y,color){s.addShape(p.ShapeType.ellipse,{x,y,w:.33,h:.33,fill:{color},line:{color}});s.addText(t,{x,y,w:.33,h:.33,fontFace:'Arial',fontSize:11,color:'FFFFFF',bold:true,align:'center',valign:'mid',margin:0})}
function image(s,p,name,x,y,w,h){const img=path.join(__dirname,'imgs',name);const b=require('node:fs').readFileSync(img);const iw=b.readUInt32BE(16),ih=b.readUInt32BE(20);const scale=Math.min(w/iw,h/ih);s.addImage({path:img,x:x+(w-iw*scale)/2,y:y+(h-ih*scale)/2,w:iw*scale,h:ih*scale,altText:name})}
function focus(s,img,x,y,w,h){const b=require('node:fs').readFileSync(img),iw=b.readUInt32BE(16),ih=b.readUInt32BE(20);const crop=img.includes('07-report')?{x:270,y:500,w:900,h:450}:img.includes('04-resolution')?{x:270,y:350,w:900,h:540}:{x:250,y:210,w:940,h:600};const scale=Math.min(w/crop.w,h/crop.h);s.addImage({path:img,x:x+(w-crop.w*scale)/2,y:y+(h-crop.h*scale)/2,w:iw*scale,h:ih*scale,sizing:{type:'crop',x:crop.x*scale,y:crop.y*scale,w:crop.w*scale,h:crop.h*scale},altText:'质量记录真实界面局部'})}

function render(p,T,c){const s=p.addSlide();s.background={color:T.bg};const dark=c.type==='cover'||c.type==='summary';if(dark)s.background={color:T.primary};
 if(c.type==='cover'){
  text(s,'HD-PLM  /  质量部',.55,.5,8,.3,12,T.light,true);text(s,c.title,.55,1.12,8.9,.75,36,'FFFFFF',true);text(s,c.subtitle,.55,2.04,8.8,.4,18,'B7DBD2');
  rect(s,p,.55,2.9,4.15,1.8,'183F4B');text(s,'质量岗位',.8,3.14,3.5,.4,24,'FFFFFF',true);text(s,'检验事实  →  照片与报告\n异常处置  →  复验留档',.8,3.74,3.5,.65,16,'DBECE7');
  image(s,p,c.image,5.1,2.7,4.35,2.3);text(s,'适用 HD-PLM 4.3.0  ·  2026.11',.55,5.02,7,.25,11,'B7DBD2');
 }else if(c.type==='summary'){
  text(s,c.title,.55,.6,8.8,.6,30,'FFFFFF',true);c.points.forEach((t,i)=>{circle(s,p,String(i+1),.6,1.65+i*.72,T.accent);text(s,t,1.12,1.6+i*.72,8.15,.5,17,'FFFFFF')});text(s,c.tip,.6,4.8,8.3,.45,14,'B7DBD2');
 }else{
  text(s,c.title,.5,.42,9,.6,28,T.primary,true);
  if(c.layout==='flow'){
   c.steps.forEach(([a,b],i)=>{const x=.55+i*2.32;circle(s,p,String(i+1),x,1.52,T.accent);text(s,a,x,2.1,2,.45,20,T.primary,true);text(s,b,x,2.78,1.95,1.15,16,T.secondary);if(i<3)s.addShape(p.ShapeType.chevron,{x:x+1.92,y:2.15,w:.26,h:.34,fill:{color:'B8CEC7'},line:{color:'B8CEC7'}})});
  }else if(c.layout==='roles'){
   const xs=[.55,2.45,6.1],ws=[1.65,3.35,3.3];['岗位','进入方式','负责内容'].forEach((t,i)=>text(s,t,xs[i],1.25,ws[i],.35,13,T.accent,true));
   c.rows.forEach((row,i)=>{rect(s,p,.5,1.8+i*.94,9,.8,i%2?'FFFFFF':'EFF6F3');row.forEach((t,j)=>text(s,t,xs[j],1.91+i*.94,ws[j],.6,j===0?15:14,j===0?T.primary:T.secondary,j===0))});
  }else if(c.layout==='cards'){
   c.cards.forEach(([a,b],i)=>{const x=.55+(i%2)*4.6,y=1.38+Math.floor(i/2)*1.55;rect(s,p,x,y,4.3,1.3,'EFF6F3');text(s,a,x+.16,y+.12,3.95,.3,17,T.primary,true);text(s,b,x+.16,y+.5,3.95,.65,14,T.secondary)});
  }else if(c.layout==='phone'){
   image(s,p,c.image,.68,1.2,2.0,3.83);c.points.forEach(([n,t],i)=>{circle(s,p,n,3.25,1.45+i*.75,T.accent);text(s,t,3.8,1.42+i*.75,5.5,.6,17,T.secondary)});
  }else{
   // Keep screenshot pixels intact; PowerPoint applies editable native crops.
   const img=path.join(__dirname,'imgs',c.image);
   if(c.focus){focus(s,img,.55,1.24,5.9,3.65)}else image(s,p,c.image,.5,1.17,6.0,3.75);
   c.points.forEach(([n,t],i)=>{circle(s,p,n,6.83,1.47+i*1.05,T.accent);text(s,t,7.27,1.39+i*1.05,2.15,.83,15,T.secondary)});
  }
  if(c.tip)text(s,c.tip,.55,4.92,8.35,.4,11,T.accent);
 }
 if(c.type!=='cover'){circle(s,p,String(c.index),9.25,5.12,T.accent);if(c.type!=='summary')text(s,'质量部 SOP · HD-PLM 4.3.0 · 界面为演示数据',.55,5.37,8.2,.16,8,'73877E')}
 s.addNotes([c.title,c.tip||'',...(c.points||[]).map(x=>Array.isArray(x)?x.join(' '):x)].join('\n'));return s;
}
module.exports={render};
