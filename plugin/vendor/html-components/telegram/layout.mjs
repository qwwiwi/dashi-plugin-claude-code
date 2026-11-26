// At a 320px bubble these capacities reserve up to two em per character
// for wide glyphs and space lost to word wrapping. Heights include borders,
// gaps and padding. Count every job as expanded, including optional details.
const lines=(text,capacity)=>Math.max(1,Math.ceil([...String(text??'')].length/capacity));
const sum=(items,fn)=>items.reduce((total,item)=>total+fn(item),0);
function legacyHeight(name,d){
  const heading=36+(d.title?27*lines(d.title,6):0);
  switch(name){
    case 'steps':return heading+sum(d.steps,s=>27+Math.max(28,21*lines(s,7)));
    case 'faq':return heading+sum(d.items,i=>42+22*lines(i.question,8)+21*lines(i.answer,8));
    case 'bars':return heading+32+sum(d.rows,r=>14+21*lines(r.label,3));
    case 'progress':return heading+60+Math.max(46,21*lines(d.label,5));
    case 'compare':return heading+2+sum([d.columns,...d.rows],row=>18+21*Math.max(...row.map(v=>lines(v,2))));
    case 'pros-cons':return heading+sum([[d.prosLabel??'Плюсы',d.pros],[d.consLabel??'Минусы',d.cons]],([label,items])=>
      44+22*lines(label,8)+sum(items,v=>14+21*lines(v,7)));
    case 'kpi':{
      let height=heading;
      for(let i=0;i<d.metrics.length;i+=2) height+=48+Math.max(...d.metrics.slice(i,i+2).map(m=>
        15*lines(m.label,4)+68*lines(m.value,1)));
      return height;
    }
    case 'status':
      if(!d.m)return heading+38+21*(lines(d.state,8)+lines(d.detail,8));
      return 16+sum(d.m,([label,rows])=>24+14*lines('[ '+(label||'Этапы')+' ]',11)+Math.max(16,sum(rows,([name])=>15*lines(name||'Без названия',8))))+
        (d.j.length?38:0)+sum(d.j,([name,,,info={}])=>{
          const details=Object.entries(info).map(([key,v])=>({m:'Модель: ',s:'Шаг: ',t:'Минут: ',r:'Итог: '})[key]+v);
          return 10+16*lines(name||'Без названия',7)+Math.max(15,sum(details,v=>15*lines(v,12)));
        })+(d.l?5+14*lines(d.l,12):0);
  }
}

// The compact view uses at most 23 fixed 22px lines plus one omission count.
// Wrap at word boundaries when possible, preserving a readable no-script view.
function compactLines(text){
  return text.split('\n').flatMap(line=>{
    const chars=Array.from(line),out=[];
    while(chars.length>20){
      const space=chars.slice(0,21).lastIndexOf(' ');
      const cut=space>0?space:20;
      out.push(chars.splice(0,cut).join(''));
      if(chars[0]===' ')chars.shift();
    }
    return [...out,chars.join('')];
  });
}
export function layoutFor(name,d,template){
  if(template.visual){
    const entries=(d.nodes??d.series??d.items).length;
    const road=name==='timeline-roadmap';
    const heading=28+26*lines(d.title,22);
    const legendRows=d.nodes?1:name==='radar'?entries:Math.ceil(entries/2);
    const plot=name==='donut'||name==='line-area'?173:name.endsWith('3d')?234:name==='radar'?209:240;
    if(name==='architecture')return {height:Math.min(360,heading+6+plot+22),omitted:0};
    return {height:heading+6+(road?48*entries:plot+22*legendRows),omitted:0};
  }
  const height=legacyHeight(name,d);
  if(height<=600)return {height,omitted:0};
  const all=compactLines([d.title,template.caption(d)].filter(Boolean).join('\n'));
  const shown=all.slice(0,23),omitted=all.length-shown.length;
  return {height:24+22*(shown.length+Number(omitted>0)),omitted,shown};
}
