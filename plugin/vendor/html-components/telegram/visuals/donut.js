const total=data.items.reduce((sum,item)=>sum+item.value,0);
let offset=0;
shape('circle',{cx:160,cy:92,r:65,stroke:'#424a40','stroke-width':21,fill:'none'});
const rings=data.items.map(({value},i)=>{
  const share=100*value/total;
  const ring=shape('circle',{cx:160,cy:92,r:65,fill:'none',stroke:colors[i],'stroke-width':21,pathLength:100,'stroke-dasharray':share+' '+(100-share),'stroke-dashoffset':-offset,transform:'rotate(-90 160 92)',class:'sweep'});
  offset+=share;
  return ring;
});
textAt(160,98,total,{'font-size':27,'font-weight':700});
textAt(160,116,'ВСЕГО',{'letter-spacing':2,'font-size':9});
const buttons=document.querySelectorAll('.ledger button');
buttons.forEach((button,i)=>button.onclick=()=>{
  const active=button.getAttribute('aria-pressed')!=='true';
  buttons.forEach((b,j)=>b.setAttribute('aria-pressed',String(active && i===j)));
  rings.forEach((r,j)=>r.setAttribute('opacity',!active||i===j?1:.2));
});
finish(184);
