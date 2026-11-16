import { sortableTable, installTableSorting } from './table-sort.js';

const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(n,d=1)=>n===null||n===undefined?'—':Number(n).toLocaleString('zh-CN',{minimumFractionDigits:d,maximumFractionDigits:d});
const signed=n=>n===null?'—':`${n>0?'+':''}${fmt(n,2)}`;
const icons=()=>window.lucide?.createIcons();
let latest=null,generation=0;
async function api(path){const r=await fetch(path,{credentials:'same-origin'});const data=await r.json();if(!r.ok)throw new Error(data.error??`HTTP ${r.status}`);return data;}
const verdict=r=>r.scored_matches?r.eligible?esc(r.sentence):`暂估：${esc(r.sentence)}`:'待取证';
function evidence(r){
  const t=r.trial;
  return `<details class="trial-parts"><summary>分项与逐局依据</summary><div class="trial-part"><span>基础核心</span><b>${fmt(t.core,2)}</b><span>${t.scored_matches} 局</span></div>${t.components.map(c=>`<div class="trial-part"><span>${esc(c.name)}</span><b class="${c.points<0?'positive':c.points>0?'negative':''}">${signed(c.points)}</b><span>${c.samples} 局${c.unavailable?' / 缺'+c.unavailable:''}</span></div>`).join('')}<p>裁剪前 ${fmt(t.before_clamp,2)} → 最终 ${fmt(t.score)}；个人证据收缩 ${fmt(t.reliability*100)}%。胜负未知 ${t.scored_matches-t.outcome_matches} 局；未知项不作零战果。</p>${t.examples.map(g=>`<div class="trial-example"><a href="/#match/${esc(g.match_id)}" target="_blank" rel="noopener">#${esc(g.match_id)}</a> · ${esc(g.map)} · ${g.won===null?'胜负未知':g.won?'胜':'负'}<br>战斗 ${fmt(g.combat)} · 价值交换 ${fmt(g.exchange)} · 原始核心 ${fmt(g.core)}<br>占点 ${fmt(g.corrections.objectives)} · 重防 ${fmt(g.corrections.heavy)} · 空优 ${fmt(g.corrections.air)} · 净供给 ${fmt(g.corrections.transport)}<br>蹭补给 ${signed(g.corrections.dependency)} · 友伤 ${signed(g.corrections.discipline)} · 单位损耗 ${signed(g.corrections.unit_kd)}<br>摧毁/损失 ${fmt(g.values.destruction,0)}/${fmt(g.values.losses,0)} · 单位击杀/损失 ${fmt(g.values.kills,0)}/${fmt(g.values.units_lost,0)} · 净供给 ${fmt(g.net_supplied,0)} · 净吃补给 ${fmt(g.net_received,0)}</div>`).join('')}</details>`;
}
function render(data){
  const rows=data.members;
  const table=sortableTable('local-stacked-trial',`<div class="table-wrap"><table class="trial-table"><thead><tr><th>朋友</th><th class="numeric">旧v9指数</th><th class="numeric">叠加v2指数</th><th class="numeric">指数变化</th><th>旧v9刑期</th><th>叠加v2刑期</th><th class="numeric">同批局数</th><th>计算依据</th></tr></thead><tbody>${rows.map(r=>`<tr><td class="table-title"><a href="/#friend/${r.member_id}">${esc(r.name)}</a></td><td class="numeric mono">${fmt(r.formal.score)}</td><td class="numeric mono">${fmt(r.trial.score)}<div class="table-sub">${esc(r.trial.status)}${r.trial.rank?' · #'+r.trial.rank:''}</div></td><td class="numeric mono ${r.delta_score<0?'positive':r.delta_score>0?'negative':''}">${signed(r.delta_score)}</td><td>${verdict(r.formal)}</td><td>${verdict(r.trial)}</td><td class="numeric mono">${r.trial.scored_matches}<div class="table-sub">旧v9 ${r.formal.scored_matches}${r.same_samples?'':' · 样本不一致'}</div></td><td>${evidence(r)}</td></tr>`).join('')}</tbody></table></div>`,rows,[
    {index:0,key:'name',label:'朋友',type:'text',value:r=>r.name},
    {index:1,key:'formal',label:'旧v9指数',value:r=>r.formal.score},
    {index:2,key:'trial',label:'叠加v2指数',value:r=>r.trial.score},
    {index:3,key:'delta',label:'指数变化',value:r=>r.delta_score},
    {index:6,key:'samples',label:'同批局数',value:r=>r.trial.scored_matches},
  ]);
  $('#result').innerHTML=`<div class="trial-counts"><div>参与对照<b>${data.summary.members} 人</b></div><div>达到 ${data.min_games} 局门槛<b>${data.summary.ranked} 人</b></div><div>指数发生变化<b>${data.summary.changed} 人</b></div></div><p class="trial-warning">历史对照：叠加v2已采用于正式v10，左列保留旧v9。独立修正各最多20分，可叠加；25分及以下免刑，75分起无期。${data.summary.sample_mismatches?`有 ${data.summary.sample_mismatches} 人的样本不一致，须复核。`:''}</p>${table}<details class="trial-rules" open><summary>试算标准与边界 · ${esc(data.model.version)}</summary>${data.limitations.map(v=>`<p>${esc(v)}</p>`).join('')}${data.model.components.map(c=>`<h3>${esc(c.name)} · ${c.direction==='signed'?'−20～+20':c.direction==='relief'?'−20～0':'0～+20'}</h3><p>${esc(c.rule)}</p>`).join('')}</details>`;
}
async function refresh(){
  const own=++generation;latest=null;$('#download').disabled=true;$('#refresh').disabled=true;$('#result').innerHTML='';$('#result').setAttribute('aria-busy','true');$('#status').className='';$('#status').textContent='正在按同一批归档试算…';
  try{
    const q=new URLSearchParams(new FormData($('#filters')));const data=await api('/api/analytics/zhanfan/trial?'+q);
    if(own!==generation)return;latest=data;render(data);$('#status').textContent=`旧版 ${data.formal_model.version} / 已采用 ${data.model.version} → ${data.adopted_by}`;$('#download').disabled=false;
  }catch(e){if(own===generation){$('#status').textContent=e.message;$('#status').className='trial-error';}}
  finally{if(own===generation){$('#refresh').disabled=false;$('#result').setAttribute('aria-busy','false');icons();}}
}
$('#filters').addEventListener('submit',e=>{e.preventDefault();refresh();});
$('#download').addEventListener('click',()=>{if(!latest)return;const url=URL.createObjectURL(new Blob([JSON.stringify(latest,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='court-stacked-20-trial.json';a.click();URL.revokeObjectURL(url);});
installTableSorting();
try{
  const session=await api('/api/session');if(session.user?.role!=='admin')throw new Error('请先登录本地管理员账号');
  const maps=await api('/api/maps'),people=await api('/api/members');
  $('#map').insertAdjacentHTML('beforeend',maps.maps.map(m=>`<option value="${esc(m.map_id)}">${esc(m.name)}</option>`).join(''));
  $('#member').insertAdjacentHTML('beforeend',people.members.filter(m=>m.active).map(m=>`<option value="${m.id}">${esc(m.name)}</option>`).join(''));
  await refresh();
}catch(e){$('#status').textContent=e.message;$('#status').className='trial-error';$('#result').setAttribute('aria-busy','false');}
icons();
