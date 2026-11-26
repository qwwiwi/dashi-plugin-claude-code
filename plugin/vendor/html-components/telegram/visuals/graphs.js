const {nodes,edges}=data;
const flow=kind==='flowchart';
const ranks=nodes.map(()=>0);
if(flow) for(let pass=0;pass<nodes.length;pass++)
  for(const {source,target} of edges) ranks[target]=Math.max(ranks[target],ranks[source]+1);
const groups=[...new Set(nodes.map((n,i)=>flow?ranks[i]:n.lane))];
if(flow) groups.sort((a,b)=>a-b);
const points=[];
let y=0;
for(const key of groups){
  const members=nodes.map((n,i)=>i).filter(i=>(flow?ranks[i]:nodes[i].lane)===key);
  const rowHeight=flow?46:108;
  if(!flow){
    shape('rect',{x:4,y:y+2,width:312,height:104,rx:7,fill:'var(--zone)'});
    textAt(16,y+23,key,{'text-anchor':'start',fill:'var(--ink)','font-size':15,'font-weight':650});
  }
  members.forEach((i,j)=>points[i]={x:320*(j+.5)/members.length,y:y+(flow?23:56),w:Math.min(112,280/members.length-4)});
  y+=rowHeight;
}
for(const [i,{source,target,label}] of edges.entries()){
  const a=points[source],b=points[target],dx=b.x-a.x,dy=b.y-a.y;
  const factor=Math.max(Math.abs(dx)/(b.w/2+2),Math.abs(dy)/15);
  const end={x:b.x-dx/factor,y:b.y-dy/factor};
  const attrs={stroke:colors[i%3],'stroke-width':1.4};
  let angle=Math.atan2(dy,dx)*180/Math.PI;
  if(flow) line(a.x,a.y,end.x,end.y,{...attrs,class:'dash'});
  else{
    const side=Math.abs(dy)>108;
    const middleY=(a.y+b.y)/2;
    const laneTop=Math.floor(middleY/108)*108;
    const ly=side?laneTop+80:dy?Math.round(middleY/108)*108-27:laneTop+19;
    const bend=side?311:ly+15;

    let path;
    if(side){
      end.x=b.x+b.w/2;end.y=b.y;angle=180;
      path='M'+a.x+' '+a.y+'H'+bend+'V'+b.y+'H'+end.x;
    }else{
      end.x=b.x;const direction=Math.sign(b.y-bend);
      end.y=b.y-direction*14;angle=direction*90;
      path='M'+a.x+' '+a.y+'V'+bend+'H'+b.x+'V'+end.y;
    }
    shape('path',{d:path,fill:'none',...attrs});
    const width=label.length*8+14;
    const lx=Math.max(9+width/2,Math.min(311-width/2,side?bend-width/2-6:dx?(a.x+b.x)/2:a.x+(a.x>160?-1:1)*(width/2+6)));
    shape('rect',{x:lx-width/2,y:ly-9,width,height:18,rx:8,fill:'var(--panel)'});
    textAt(lx,ly+4,label,{'font-size':12});
  }
  shape('path',{d:'M0 0l-6 -3v6z',fill:attrs.stroke,transform:'translate('+end.x+' '+end.y+') rotate('+angle+')'});

}
nodes.forEach((n,i)=>{
  const {x,y,w}=points[i],attrs={stroke:colors[i%3],fill:'var(--panel)'};
  if(n.kind==='decision') shape('polygon',{points:[[x-w/2,y],[x,y-15],[x+w/2,y],[x,y+15]].join(' '),...attrs});
  else shape('rect',{x:x-w/2,y:y-14,width:w,height:28,rx:7,...attrs});
  textAt(x,y+5,n.label);
});
finish(y);
