const states = {r:'в работе', q:'в очереди', d:'готово', f:'ошибка', b:'блок'};
const percent = value => Math.max(0, Math.min(100, Math.round(value)));
const label = (text, fallback) => text?.trim() ? text : fallback;
const fields = ({m,t,s,r} = {}) => [
  m && 'Модель: '+m, t >= 0 && 'Минут: '+Math.floor(t),
  s && 'Шаг: '+s, r && 'Итог: '+r
].filter(Boolean);

export function statusPack(escape) {
  const cut = text => '<div class="cut">'+escape(text)+'</div>';
  const card = (title,body) => '<section class="card"><h2 class="cut">[ '+title+' ]</h2>'+body+'</section>';
  function group([title,rows]) {
    const mean = rows.length ? Math.round(rows.reduce((sum,row) => sum+percent(row[1]),0)/rows.length) : 0;
    const summary = '<span class="mean"> · '+mean+'%</span>';
    const lines = rows.map(([name,value]) => {
      const p = percent(value);
      const stop = Math.max(0,Math.round(p/20)*12-2);
      return '<div class="row"><span class="name cut">'+escape(label(name,'Без названия'))+'</span>'+
        '<i class="cells" style="--stop:'+stop+'px"></i><b class="pct">'+p+'%</b></div>';
    });
    return card(escape(label(title,'Этапы'))+summary,'<div class="rows">'+(lines.join('') || 'нет данных')+'</div>');
  }
  function job([name,value,state,details],active) {
    const p = percent(value);
    const step = active && details?.s ? '<div class="step cut">'+escape(details.s)+'</div>' : '';
    const info = fields(details);
    return '<details class="job s-'+state+'" name="jobs"><summary><span class="top"><span class="name cut">'+
      escape(label(name,'Без названия'))+'</span><span class="state">'+states[state]+'</span><b class="pct">'+p+
      '%</b></span><span class="bar"><i style="width:'+p+'%"></i></span>'+step+'</summary><div class="detail">'+
      (info.length ? info : ['нет данных']).map(cut).join('')+'</div></details>';
  }
  return {
    body(d) {
      if (!d.m) return '<section><strong>'+cut(d.state)+'</strong><p>'+escape(d.detail)+'</p></section>';
      const active = d.j.findIndex(j => j[2] === 'r');
      const jobs = d.j.map((j,i) => job(j,i === active)).join('');
      const footer = label(d.l,'');
      return d.m.map(group).join('')+(jobs ? card('Задачи',jobs) : '')+
        (!d.m.length && !jobs ? '<div class="empty">нет данных</div>' : '')+
        (footer ? '<footer class="foot cut">'+escape(footer)+'</footer>' : '');
    },
    caption(d) {
      if (!d.m) return [d.state,d.detail].join('\n');
      return [...d.m.flatMap(([title,rows]) => [label(title,'Этапы'),...rows.map(([n,p]) => label(n,'Без названия')+' '+percent(p)+'%')]),
        ...d.j.flatMap(([n,p,state,details]) => [label(n,'Без названия')+' · '+states[state]+' '+percent(p)+'%',...fields(details)]),
        d.l].filter(Boolean).join('\n') || 'нет данных';
    }
  };
}
