const stage=document.getElementById('stage'),canvas=document.createElement('canvas');
canvas.width=640;canvas.height=400;
const ctx=canvas.getContext('2d');
if(!ctx) return;
ctx.scale(2,2);
const bars=kind==='bars3d',items=bars?data.items:data.nodes;
const colors=['#d4ff00','#80c9ef','#ffa77f','#b4a3fa','#81d8b0','#f1bb64','#ed96bf','#c8d1cc'];
let angle=-.62,timer,phase=0;
function project(x,y,z){
  const depth=x*Math.sin(angle)+z*Math.cos(angle);
  const side=x*Math.cos(angle)-z*Math.sin(angle),scale=230/(240-depth*.45);
  return {x:160+side*scale,y:(bars?153:100)+(depth*.38-y)*scale,depth,scale};
}
function face(points,color){
  ctx.beginPath();
  points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));
  ctx.closePath();ctx.fillStyle=color;ctx.fill();
}
function label(p,value){
  ctx.fillStyle=globalThis.matchMedia?.('(prefers-color-scheme:dark)').matches?'#faf8f2':'#252c25';ctx.font='bold 14px sans-serif';ctx.textAlign='center';
  ctx.fillText(String(value),p.x,p.y-7);
}
function frame(){
  ctx.clearRect(0,0,320,200);
  const n=items.length,peak=bars?Math.max(1,...items.map(v=>v.value)):1;
  const points=items.map((v,i)=>{
    const z=1-2*(i+.5)/n,r=Math.sqrt(1-z*z);
    const x=bars?(i-(n-1)/2)*Math.min(60,262/n):95*r*Math.cos(i*2.4);
    const y=bars?0:66*z;
    const depth=bars?0:90*r*Math.sin(i*2.4);
    return {i,x,y,z:depth,p:project(x,y,depth)};
  });
  const edges=bars?[]:data.edges.map(e=>[points[e.source].p,points[e.target].p]);
  for(const [a,b] of edges){
    ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.lineWidth=2;ctx.strokeStyle='#639b8a';ctx.stroke();
  }
  const captions=[];
  for(const {i,x,y,z,p} of points.sort((a,b)=>a.p.depth-b.p.depth)){
    if(bars){
      const h=items[i].value/peak*89,w=Math.min(10,70/n);
      const corners=[[-w,-w],[w,-w],[w,w],[-w,w]];
      const layer=height=>corners.map(([dx,dz])=>project(x+dx,height,z+dz));
      const bottom=layer(0),top=layer(h);
      const sides=corners.map((_,j)=>{
        const k=(j+1)%4;
        return {depth:bottom[j].depth+bottom[k].depth,points:[bottom[j],bottom[k],top[k],top[j]],color:colors[i],shade:j%2?.24:.48};
      });
      for(const side of sides.sort((a,b)=>a.depth-b.depth)){
        face(side.points,side.color);face(side.points,'rgba(0,0,0,'+side.shade+')');
      }
      face(top,colors[i]);captions.push([project(x,h,z),items[i].value]);

    }else{
      ctx.globalAlpha=.68+(p.depth+90)/560;
      ctx.beginPath();ctx.arc(p.x,p.y,9+p.depth/32,0,2*Math.PI);ctx.fillStyle=i?'#8ecfc2':'#d4ff00';ctx.fill();
      ctx.globalAlpha=1;
    }
  }
  for(const [p,value] of captions) label(p,value);
  if(!bars){
    const occupied=[];
    ctx.font='bold 14px sans-serif';
    for(const {i,p} of points.reverse()){
      const value=items[i].label,width=ctx.measureText(value).width;
      let best,score=Infinity;
      for(let y=18;y<=194;y+=7)for(let x=width/2+4;x<=316-width/2;x+=8){
        const distance=Math.hypot(x-p.x,y-5-p.y);
        if(distance>=score)continue;
        const half=width/2+4,cy=y-5,h=13;
        const overlaps=occupied.some(b=>Math.abs(x-b.x)<half+b.half && Math.abs(cy-b.cy)<2*h);
        const hitsNode=points.some(({p:q})=>Math.hypot(Math.max(0,Math.abs(x-q.x)-half),
          Math.max(0,Math.abs(cy-q.y)-h))<9+q.depth/32);
        // Separating axes for a segment and the padded text rectangle.
        const crosses=edges.some(([a,b])=>{
          const dx=b.x-a.x,dy=b.y-a.y;
          return Math.abs(x-(a.x+b.x)/2)<=half+Math.abs(dx)/2 &&
            Math.abs(cy-(a.y+b.y)/2)<=h+Math.abs(dy)/2 &&
            Math.abs(dx*(cy-a.y)-dy*(x-a.x))<=Math.abs(dx)*h+Math.abs(dy)*half;
        });
        const cost=distance+(crosses?400:0)+(hitsNode?800:0)+(overlaps?1600:0);
        if(cost<score){score=cost;best={x,cy,half,y:y+7}}
      }
      if(best){occupied.push(best);label(best,value)}
    }
  }
}
frame();stage.appendChild(canvas);
const toggle=document.createElement('button');
function rotation(on){
  clearInterval(timer);
  if(on) timer=setInterval(()=>{phase+=.009;angle=bars?-.42+.2*Math.sin(phase-Math.PI/2):angle+.009;frame()},75);
  toggle.textContent=on?'Пауза':'Вращать';
  toggle.setAttribute('aria-pressed',String(on));
}
toggle.onclick=()=>rotation(toggle.getAttribute('aria-pressed')!=='true');
stage.appendChild(toggle);
rotation(true);
