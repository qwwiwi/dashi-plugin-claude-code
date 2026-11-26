import {readFileSync} from 'node:fs';
const read=name=>readFileSync(new URL('./visuals/'+name+'.js',import.meta.url),'utf8');
const base=read('base');
const programs={flowchart:base+read('graphs'),architecture:base+read('graphs'),'line-area':base+read('series'),radar:base+read('series'),donut:base+read('donut'),bars3d:read('space'),network3d:read('space'),'timeline-roadmap':''};
const colors=['#d4ff00','#80c9ef','#ffa77f','#b4a3fa','#81d8b0','#f1bb64','#ed96bf','#c8d1cc'];
const states={done:'Готово',now:'Сейчас',next:'Далее'};
export function validVisual(name,d){
  if(d.series) return d.series.every(s=>s.values.length===d.labels.length);
  if(name==='donut') return d.items.some(s=>s.value>0);
  if(!d.nodes) return true;
  if(d.edges.some(e=>e.source>=d.nodes.length || e.target>=d.nodes.length || e.target===e.source)) return false;
  if(name!=='flowchart') return true;
  const visited=new Set();
  for(let i=0;i<d.nodes.length;i++)
    d.nodes.forEach((_,j)=>{if(d.edges.every(e=>e.target!==j||visited.has(e.source))) visited.add(j)});
  return visited.size===d.nodes.length;
}
function rows(d){
  if(d.nodes) return d.nodes.map((n,i)=>[n.label,[n.lane,...d.edges.filter(e=>e.source===i).map(e=>(e.label?e.label+' ':'')+'→ '+(e.target+1))].filter(Boolean).join(' · ')]);
  if(d.series) return d.series.map(s=>[s.label,s.values.join(' · ')]);
  return d.items.map(v=>[v.label,v.state?v.date+' · '+states[v.state]:v.value,v.state]);
}
export function visualPacks(escape){
  return Object.fromEntries(Object.entries(programs).map(([kind,source])=>[kind,{
    visual:true,
    caption:d=>[...(d.labels?[d.labels.join(' · ')]:[]),...rows(d).map(([l,v])=>l+' '+v)].join('\n'),
    body(d,enhanced=true){
      const legend=rows(d).map(([label,value,state],i)=>{
        const name=enhanced&&kind==='donut'?'<button aria-pressed="false">'+escape(label)+'</button>':'<span>'+escape(label)+'</span>';
        let metric=value;
        if(kind==='donut') metric=value+' · '+Math.round(100*value/d.items.reduce((sum,v)=>sum+v.value,0))+'%';
        if(kind==='line-area') metric='· '+d.series[i].values.at(-1)+' к '+d.labels.at(-1);
        if(kind==='radar'){
          const scores=d.series[i].values;
          metric='Среднее '+Math.round(scores.reduce((sum,v)=>sum+v,0)/scores.length)+'%';
        }
        return '<li class="'+(state??'')+'">'+(d.series||kind==='donut'||kind==='bars3d'?'<i style="background:'+colors[i]+'"></i>':'')+name+'<b>'+escape(metric)+'</b></li>';
      }).join('');
      // Keep axis/value pairs available even when SVG or JavaScript is unavailable.
      const matrix=d.series?'<table id="matrix"><thead><tr><td></td>'+d.series.map(s=>'<th>'+escape(s.label)+'</th>').join('')+
        '</tr></thead><tbody>'+d.labels.map((label,i)=>'<tr><th>'+escape(label)+'</th>'+d.series.map(s=>'<td>'+s.values[i]+'</td>').join('')+'</tr>').join('')+'</tbody></table>':'';
      const json=JSON.stringify(d).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
      const summary=d.nodes?d.nodes.length+' узлов · '+d.edges.length+' связей':'';
      return (enhanced?'<div id="stage"></div>':'')+(summary?'<div class="summary">'+summary+'</div>':'')+'<ol class="ledger">'+legend+'</ol>'+matrix+(enhanced&&source?'<script>(()=>{const kind='+JSON.stringify(kind)+',data='+json+';'+source+'})();</script>':'');
    }
  }]));
}
