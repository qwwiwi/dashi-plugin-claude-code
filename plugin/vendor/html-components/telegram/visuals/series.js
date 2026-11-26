const {labels,series}=data;
if(kind==='line-area'){
  const all=series.flatMap(s=>s.values),low=Math.min(...all),high=Math.max(...all);
  const x=i=>44+194*i/(labels.length-1);
  const y=v=>148-114*(v-low)/(high-low||1);
  textAt(6,45,high,{'text-anchor':'start',fill:'var(--muted)'});
  textAt(6,147,low,{'text-anchor':'start',fill:'var(--muted)'});
  for(let i=0;i<4;i++) line(44,34+38*i,238,34+38*i,{'stroke-dasharray':'2 4'});
  line(44,32,44,148,{stroke:'var(--muted)'});
  line(44,148,238,148,{stroke:'var(--muted)'});
  series.forEach(({values},j)=>{
    const color=colors[j],gradient=shape('linearGradient',{id:'g'+j,x2:0,y2:'100%'});
    for(const [offset,opacity] of [[0,.22],[1,0]]) shape('stop',{offset,'stop-color':color,'stop-opacity':opacity},gradient);
    let path='M'+x(0)+' '+y(values[0]);
    values.slice(1).forEach((v,k)=>{
      const mid=(x(k)+x(k+1))/2;
      path+=' C'+[mid,y(values[k]),mid,y(v),x(k+1),y(v)].join(' ');
    });
    shape('path',{d:path+'  V148 H44 Z',fill:'url(#g'+j+')'});
    shape('path',{d:path,stroke:color,fill:'none','stroke-width':2.5,pathLength:1,class:'draw'});
    for(const v of new Set([Math.min(...values),Math.max(...values)]))
      shape('circle',{cx:x(values.indexOf(v)),cy:y(v),r:3,fill:color,stroke:'#202820'});
    const last=values[values.length-1];
    shape('circle',{cx:x(values.length-1),cy:y(last),r:3,fill:color});
    const labelY=22+j*17;
    line(242,y(last),258,labelY-3,{stroke:color,'stroke-opacity':.55});
    textAt(298,labelY,last,{'text-anchor':'end',fill:color});
  });
  textAt(12,173,labels[0],{'text-anchor':'start'});
  textAt(302,173,labels[labels.length-1],{'text-anchor':'end'});
  finish(184);
}else{
  const point=(i,r)=>{const a=2*Math.PI*i/labels.length-Math.PI/2;return [160+r*Math.cos(a),111+r*Math.sin(a)]};
  const floor=Math.min(80,20*Math.floor(Math.min(...series.flatMap(s=>s.values))/20));
  const radius=v=>72*(v-floor)/(100-floor);
  for(const v of [floor,(floor+100)/2,100]){
    const r=radius(v);
    shape('polygon',{points:labels.map((_,i)=>point(i,r)).join(' '),fill:'none',stroke:'var(--line)'});
  }
  labels.forEach((label,i)=>{
    line(160,111,...point(i,72));
    const [x,y]=point(i,79);
    const anchor=x<155?'start':x>165?'end':'middle';
    const width=label.length*8;
    textAt(x<155?Math.max(10,x-width):x>165?Math.min(310,x+width):x,y+3,label,{'text-anchor':anchor});
  });
  series.forEach(({values},i)=>shape('polygon',{points:values.map((v,j)=>point(j,radius(v))).join(' '),fill:colors[i],'fill-opacity':.18,stroke:colors[i],class:'grow'}));
  for(const v of [floor,(floor+100)/2,100]){
    const [x,y]=point(Math.floor(labels.length/2),radius(v));
    textAt(x-5,y+3,v+'%',{'text-anchor':'end','font-size':10});
  }
  finish(222);
}

document.getElementById('matrix').style.display='none';
