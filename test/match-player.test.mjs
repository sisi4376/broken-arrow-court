import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,mkdir,writeFile,unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createMatchPlayers,playerMetric,playerUnits,playerUnitTypes,playerHighlights,unitIconName,unitIconURL,installUnitDrag,unitFate,unitStatusLabel } from '../public/match-player.js';
import { publicMatch,STATIC_SOURCES,exportStatic,siteInventory } from '../src/static-export.mjs';
import { testStore,tempDir,member,rawMatch,detailFor } from './helpers.mjs';
import { matchDetail } from '../src/queries.mjs';
import { createApplication } from '../src/server.mjs';
import { Publication } from '../src/publication.mjs';

const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(n,p=0)=>n===null||n===undefined?'—':Number(n).toFixed(p);
const uiArgs={S:{},esc,fmt,icon:n=>`<i data-icon="${n}"></i>`,ratio:(a,b)=>a===null||b===null?'—':b?fmt(a/b,2):a>0?'∞':'—',
  delta:n=>n===null?'—':(n>0?'+':'')+fmt(n,1),badge:s=>esc(s),modal:()=>{},jsonTree:v=>esc(JSON.stringify(v)),unitName:(c,id)=>c?.hudName??'单位 #'+id,participantDeck:()=>'',closeModal:()=>{}};
const ui=createMatchPlayers({...uiArgs,showRaw:()=>true});
function fixture(){
  const p={player_id:'101',name:'Owner',team_id:0,registered:true,member_id:1,member_name:'Friend',destruction:500,losses:250,
    raw:{Destruction:4,Losses:2,OldRating:1000,NewRating:1005,SupplyPointsConsumed:9000,SupplyPointsConsumedFromAllies:8000,SupplyPointsConsumedByAllies:1000}};
  const q={player_id:'201',name:'Enemy',team_id:1,registered:false,raw:{Destruction:100}};
  const unit=(net,owner,options,extra={})=>({unit_id:'7',net_id:String(net),player_id:owner,spawn_time:1000,death_time:null,refunded:0,
    catalogue:{hudName:'Helicopter',categoryType:5,thumbnailFileName:'US_TEST-Label',cost:70},
    raw:{OptionIds:options,KilledCount:2,TotalDamageDealt:10,TotalDamageReceived:5,TotalSupplyPointsConsumed:100,...extra}});
  return {id:'800',map_name:'Map',detail_state:'complete',end_time:1200,duration:200,raw:{Data:{}},detail:{data:{StartTime:1000,Data:{}}},winner_team:0,participants:[p,q],
    units:[unit(1,'101',[2,1]),unit(2,'101',[1,2]),unit(3,'101',[3]),unit(4,'201',[2,1]) ]};
}

test('public player and unit details omit raw-field entry points without rendering their contents',()=>{
  const reader=createMatchPlayers({...uiArgs,jsonTree:()=>{throw Error('Raw fields must not render');}}),m=fixture(),p=m.participants[0];
  const player=reader.view(m,p),unit=reader.unitView(m,p,0).html;
  for(const html of [player,unit])for(const text of ['match-player-raw','全部玩家字段','单位目录字段','全部字段'])assert(!html.includes(text),text);
  assert(player.includes('战斗统计'));assert(unit.includes('本局实际挂载'));assert(ui.view(m,p).includes('全部玩家字段'));
});

test('player modal preserves missing versus omitted zero, explicit invalids, and normalized score aliases',()=>{
  const m=fixture(),p=m.participants[0];assert.equal(playerMetric(p,'DamageDealt',m),0);
  assert.equal(playerMetric(p,'DestructionScore',m),500);assert.equal(playerMetric(p,'SupplyPointsConsumedFromAllies',m),8000);
  for(const value of [null,'99',false,-1,Infinity])assert.equal(playerMetric({...p,raw:{DamageDealt:value}},'DamageDealt',m),null);
  assert.equal(playerMetric(p,'DamageDealt',{...m,detail_state:'summary'}),null);
  assert.equal(playerMetric(p,'DamageDealt',{...m,raw:{},detail:null}),null);
});

test('unit groups isolate each account and actual loadout, sum deployments once and retain raw instances',()=>{
  const m=fixture(),original=JSON.stringify(m),groups=playerUnits(m,'101');assert.equal(groups.length,2);
  const first=groups.find(g=>g.instances.length===2);assert.deepEqual(first.options,[1,2]);assert.equal(first.kills,4);assert.equal(first.damage,20);assert.equal(first.supply,200);
  assert.equal(playerUnits(m,'201').reduce((n,g)=>n+g.kills,0),2);assert.equal(playerUnits(m,'missing').length,0);
  assert.equal(JSON.stringify(m),original);
  m.units[1].raw.TotalDamageDealt=null;assert.equal(playerUnits(m,'101').find(g=>g.instances.length===2).damage,null);
  m.units[0].catalogue=null;assert.equal(playerUnits(m,'101').find(g=>g.instances.length===2).category,-1);
});

test('highlights select individual deployments for this player, preserve variants and ignore invalid or zero results',()=>{
  const m=fixture();m.units[2].raw.TotalDamageDealt=15;m.units[2].display_name='Hero <variant>';
  m.units[1].raw.KilledCount=5;m.units[3].raw.TotalDamageDealt=999;
  const highlights=playerHighlights(m,'101'),[damage,kills]=highlights.filter(h=>h.scope==='instance');
  assert.equal(damage.best.unit.net_id,'3');assert.equal(damage.best.value,15); // Other group's total is 20.
  assert.equal(kills.best.unit.net_id,'2');assert.equal(kills.best.value,5);
  const [typeDamage,typeKills]=highlights.filter(h=>h.scope==='type');
  assert.equal(typeDamage.best.value,35);assert.equal(typeKills.best.value,9);
  assert.equal(typeDamage.best.group.instances.length,3);assert.equal(typeDamage.best.group.groups.length,2);
  assert.equal(playerUnits(m,'101')[damage.best.index].key,damage.best.group.key);
  const html=ui.view(m,m.participants[0]);assert(html.includes('伤害最高'));assert(html.includes('击杀最多'));assert(html.includes('Hero &lt;variant&gt;'));assert(html.includes('单次部署'));
  assert(ui.unitView(m,m.participants[0],damage.best.index).html.includes('match-player-back'));
  for(const u of m.units)Object.assign(u.raw,{TotalDamageDealt:null,KilledCount:0});
  assert(playerHighlights(m,'101').every(h=>h.best===null));assert(ui.view(m,m.participants[0]).includes('暂无战果'));
  assert(playerHighlights(m,'missing').every(h=>h.best===null));
});

test('individual and type champions differ, combine all loadouts once and navigate to the matching scope',()=>{
  const m=fixture();m.units[2].raw.TotalDamageDealt=15;m.units[1].raw.KilledCount=5;
  const other=structuredClone(m.units[0]);Object.assign(other,{unit_id:'9',net_id:'5',display_name:'Variant <ace>',icon:'US_VARIANT'});
  other.catalogue={...other.catalogue,hudName:'Other type',thumbnailFileName:'US_OTHER'};Object.assign(other.raw,{KilledCount:8,TotalDamageDealt:20});m.units.push(other);
  const original=JSON.stringify(m),h=playerHighlights(m,'101');assert.equal(h.length,4);
  for(const entry of h)assert.equal(entry.scope==='type'?entry.best.group.unit_id:entry.best.unit.unit_id,entry.scope==='type'?'7':'9');
  assert.equal(h.find(x=>x.scope==='type'&&x.key==='damage').best.value,35);
  assert.equal(h.find(x=>x.scope==='type'&&x.key==='kills').best.value,9);
  const type=playerUnitTypes(m,'101').find(t=>t.unit_id==='7');assert.equal(type.instances.length,3);assert.equal(type.groups.length,2);
  const team=ui.highlights(m,m.participants[0],{compact:true});assert.equal((team.match(/data-highlight-metric="damage"/g)||[]).length,2);assert(!team.includes('data-highlight-metric="kills"'));
  assert(team.includes('高光单位'));assert(team.includes('高光兵牌'));assert(team.includes('data-unit-id="7"'));assert(team.includes('Variant &lt;ace&gt;'));
  const detail=ui.typeView(m,m.participants[0],'7');assert.equal(detail.title,'Helicopter · 本局兵牌');assert(detail.html.includes('3 次部署 · 2 种挂载'));assert.equal((detail.html.match(/class="match-unit-card"/g)||[]).length,2);
  assert.equal(ui.typeView(m,m.participants[0],'missing'),null);assert.equal(JSON.stringify(m),original);
  m.units[0].raw.TotalDamageDealt=null;assert.equal(playerUnitTypes(m,'101').find(t=>t.unit_id==='7').damage,null);
  assert.equal(playerHighlights(m,'101').find(x=>x.scope==='type'&&x.key==='damage').best.group.unit_id,'9');
});

test('match cards show recorded deaths beside refunds, including zeros, independently for each player and loadout',()=>{
  const m=fixture();m.units[0].death_time=1100;m.units[1].refunded=1;m.units[3].death_time=1100;
  const before=JSON.stringify(m),groups=playerUnits(m,'101');
  assert.equal(groups[0].deaths,1);assert.equal(groups[0].refunded,1);
  const html=ui.view(m,m.participants[0]);
  assert(html.includes('<span class="match-unit-fates"><span>阵亡 <b>1</b></span><span>退款 <b>1</b></span></span>'));
  assert(html.includes('<span class="match-unit-fates"><span>阵亡 <b>0</b></span><span>退款 <b>0</b></span></span>'));
  assert(ui.typeView(m,m.participants[0],'7').html.includes('match-unit-fates'));
  assert.equal(JSON.stringify(m),before);
});

test('self-destruction counts as a death without a timestamp, never guesses from self damage or duplicates a recorded death',()=>{
  const m=fixture();m.units[0].raw.SelfDestruction=true;
  m.units[1].raw.SelfDestruction=true;m.units[1].death_time=1100;
  m.units[2].raw.TotalSelfDamageDealt=1000;
  const before=JSON.stringify(m),g=playerUnits(m,'101')[0];assert.equal(g.deaths,2);assert.equal(g.refunded,0);
  assert.equal(unitFate(m.units[0]),'self-destroyed');assert.equal(unitStatusLabel(m.units[0]),'自毁 / 坠毁');
  assert.equal(unitFate(m.units[2]),'unknown');assert.equal(playerUnitTypes(m,'101')[0].deaths,2);
  const detail=ui.unitView(m,m.participants[0],0).html;
  assert(detail.includes('<td>未提供</td><td>自毁 / 坠毁</td>'));assert(!detail.includes('已存活'));
  assert.equal(JSON.stringify(m),before);
  for(const flag of [false,null,1,'true',{}])assert.equal(unitFate({...m.units[2],raw:{SelfDestruction:flag}}),'unknown');
  for(const death_time of [null,0,-1,'123',Infinity])assert.equal(unitFate({...m.units[2],death_time,raw:{}}),'unknown');
  assert.equal(unitFate({...m.units[0],refunded:1}),'refunded');
  assert.equal(unitFate({...m.units[0],raw:{WasRefunded:true,SelfDestruction:true}}),'refunded');
  m.units[0].refunded=1;assert.equal(playerUnits(m,'101')[0].deaths,1);assert.equal(playerUnits(m,'101')[0].refunded,1);
});

test('match and case highlights use detailed card names without assigning combined damage to a single variant or changing totals',()=>{
  const m=fixture();m.units[0].display_name=m.units[1].display_name='Variant <Arena>';m.units[2].display_name='Variant B';
  const before=JSON.stringify(m),expected=playerHighlights(m,'101').find(h=>h.scope==='type'&&h.key==='damage').best.value;
  assert.equal(expected,30);
  for(const compact of [false,true]){
    const html=ui.highlights(m,m.participants[0],{compact});
    const card=html.match(/<button[^>]*data-highlight-scope="type"[^]*?<\/button>/)[0];
    assert(card.includes('Variant &lt;Arena&gt; / Variant B'));assert(card.includes('兵牌'));assert(!card.includes('兵种'));assert(card.includes('30.0 伤害'));
    assert(!card.includes('<strong>Helicopter</strong>'));assert(!card.includes('Variant <Arena>'));
  }
  assert.equal(ui.typeView(m,m.participants[0],'7').title,'Variant <Arena> / Variant B · 本局兵牌');
  assert.equal(playerHighlights(m,'101').find(h=>h.scope==='type'&&h.key==='damage').best.value,expected);
  assert.equal(JSON.stringify(m),before);
  for(const u of m.units)u.display_name='Same detailed name';
  assert.equal(ui.typeView(m,m.participants[0],'7').title,'Same detailed name · 本局兵牌');
});

test('unknown hangars and unit art cannot invent local paths or turn unknown into an empty loadout',()=>{
  const m=fixture();m.units[0].raw.OptionIds=null;assert.equal(playerUnits(m,'101').length,3);
  for(const name of ['../secret','x.png','https://example.com/x','a/b','" onerror="x'])assert.equal(unitIconName({thumbnailFileName:name}),null);
  assert.equal(unitIconName(null),null);assert(unitIconURL({thumbnailFileName:'US_TEST-Label'}).endsWith('/unit-icon-US_TEST-Label.png'));
});

test('registered friends and unregistered enemies both render comprehensive personal and unit views with escaped source data',()=>{
  const m=fixture();let html=ui.view(m,m.participants[0]);
  for(const text of ['战斗统计','单位经济','补给统计','经验统计','单位详细数据','乘数后经验','补给队友','从队友补给','全部玩家字段','href="#friend/1"','match-unit','8000'])assert(html.includes(text),text);
  const enemy=ui.view(m,m.participants[1]);assert(html.includes('value="201"'));assert(enemy.includes('Enemy · 队伍 B'));
  assert(!enemy.includes('href="#friend/'));
  m.participants[0].name='<img src=x onerror=alert(1)>';m.units[0].catalogue.hudName='<script>bad</script>';
  html=ui.view(m,m.participants[0]);assert(!html.includes('<script>'));assert(!html.includes('<img src=x'));assert(html.includes('&lt;script&gt;'));
  const result=ui.unitView(m,m.participants[0],0);assert(result.html.includes('返回 &lt;img'));assert(result.html.includes('实例 NetID'));assert.equal(ui.unitView(m,m.participants[0],999),null);
  for(const text of ['NaN','undefined'])assert(!result.html.includes(text),text);
});

test('loadout variant names label cards and their details without renaming the base catalogue or merging other loadouts',()=>{
  const m=fixture();m.units[0].display_name='Variant <Arena>';m.units[1].display_name='Variant <Arena>';
  const html=ui.view(m,m.participants[0]);assert(html.includes('Variant &lt;Arena&gt;'));assert(!html.includes('Variant <Arena>'));
  assert(html.includes('<strong>Helicopter</strong>'));assert.equal(ui.unitView(m,m.participants[0],0).title,'Variant <Arena> · 本局单位');
  assert.equal(m.units[0].catalogue.hudName,'Helicopter');assert.equal(playerUnits(m,'101').length,2);
});

test('unit cards put equipped reference price at the top and show readable actual loadouts and cost breakdown',()=>{
  const m=fixture();for(const u of m.units)u.loadout={version:'unit-loadouts-v1',base_cost:70,cost:100,status:'complete',db_file:'test.db',options:[{id:1,slot:'Wing',name:'2x R-77',cost:30},{id:2,slot:'Armor',name:'<Extra armor>',cost:0}]};
  let html=ui.view(m,m.participants[0]);assert(html.includes('match-unit-price'));assert(html.includes('100<small>分'));assert(html.includes('含挂载参考分'));assert(html.includes('2x R-77'));assert(html.includes('&lt;Extra armor&gt;'));assert(!html.includes('<Extra armor>'));
  html=ui.unitView(m,m.participants[0],0).html;for(const text of ['本局实际挂载','挂载槽','增减分','基价 70 + 已选挂载 30 = 100 分','test.db'])assert(html.includes(text),text);
  for(const u of m.units)u.loadout=null;html=ui.view(m,m.participants[0]);assert(html.includes('目录基价'));assert(!html.includes('含挂载参考分'));assert(html.includes('挂载 #1'));
});

test('historical matches and price ambiguity render separately from unknown option errors and game supplements are labelled',()=>{
  const m=fixture();for(const u of m.units)u.loadout={basis:'historical',resolution:'complete',status:'unknown',base_cost:null,cost:null,issues:['ambiguous_price'],catalogue_versions:[{name:'1.1.3'}],options:[{id:1,slot:'Armor',name:'Old APS',cost:null},{id:2,slot:'Engine',name:'Engine',cost:15}]};
  let html=ui.unitView(m,m.participants[0],0).html;assert(html.includes('挂载已解析，但匹配版本的价格不一致'));assert(html.includes('比赛具体版本未确认'));assert(html.includes('Old APS'));assert(!html.includes('挂载目录不完整'));
  for(const u of m.units){u.loadout.status='complete';u.loadout.cost=150;u.loadout.base_cost=100;u.loadout.issues=[];}
  assert(ui.view(m,m.participants[0]).includes('旧版挂载参考分'));
  for(const u of m.units){u.loadout.basis='supplement';u.loadout.options[0].source='game_extract';}
  html=ui.unitView(m,m.participants[0],0).html;assert(html.includes('游戏原始目录补录'));
});

test('match-bound prices show their release and pending new loadouts do not fall back to the current base price',()=>{
  const m=fixture();for(const u of m.units)u.loadout={price_bound:true,price_version:'1.2.1',price_source:'official_patch',base_cost:40,cost:40,status:'complete',options:[]};
  let html=ui.view(m,m.participants[0]);assert(html.includes('本局含挂载价格 · 1.2.1'));assert(html.includes('40<small>分'));assert(!html.includes('非历史对局价格'));
  for(const u of m.units)Object.assign(u.loadout,{base_cost:null,cost:null,status:'unknown',issues:['version_catalogue_pending']});
  html=ui.view(m,m.participants[0]);assert(html.includes('本局版本价格待确认'));assert(html.includes('—<small>分'));
  assert(!/match-unit-price[^>]*><b>\d/.test(html));
  html=ui.unitView(m,m.participants[0],0).html;assert(html.includes('新版挂载目录待补齐'));assert(html.includes('本局价格版本 1.2.1'));assert(!html.includes('非历史价格'));
});

test('unit categories stay in a compact horizontal scroll region without mobile column wrapping',async()=>{
  const html=ui.view(fixture(),fixture().participants[0]);assert(html.includes('tabindex="0" role="region" aria-label="本局单位分类"'));assert(html.includes('draggable="false"'));
  const css=await readFile(new URL('../public/style.css',import.meta.url),'utf8');
  assert(css.includes('grid-auto-flow:column;grid-auto-columns:144px'));
  assert(!/\.match-unit-columns\{[^}]*grid-template-columns/.test(css));assert(css.includes('overscroll-behavior-x:contain'));
});

function dragFixture(){
  const handlers=new Map(),classes=new Set();let capture=null;
  const root={scrollLeft:120,scrollWidth:900,clientWidth:300,isConnected:true,classList:{add:n=>classes.add(n),remove:n=>classes.delete(n)},
    setPointerCapture:id=>capture=id,hasPointerCapture:id=>capture===id,releasePointerCapture:()=>capture=null,
    contains:target=>target===root||target===card,closest:()=>root};
  const card={closest:()=>root};
  installUnitDrag({addEventListener:(type,fn)=>handlers.set(type,fn)});
  const fire=(type,extra={})=>{const e={type,target:card,pointerId:1,pointerType:'mouse',button:0,buttons:1,clientX:200,clientY:100,detail:1,
    preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;},...extra};handlers.get(type)(e);return e;};
  return {root,classes,fire};
}
test('mouse dragging scrolls equipment horizontally, captures release and suppresses only the drag-generated click',()=>{
  const {root,classes,fire}=dragFixture();fire('pointerdown');assert(!fire('pointermove',{clientX:197}).prevented);assert.equal(root.scrollLeft,120);
  assert(fire('pointermove',{clientX:140}).prevented);assert.equal(root.scrollLeft,180);assert(classes.has('is-dragging'));
  fire('pointerup',{clientX:140,buttons:0});assert(!classes.has('is-dragging'));
  const click=fire('click');assert(click.prevented&&click.stopped);
  fire('pointerdown');fire('pointerup');assert(!fire('click').prevented);
});
test('touch/vertical gestures, cancellation, keyboard activation and nonoverflowing lists retain native behavior',()=>{
  let f=dragFixture();f.fire('pointerdown',{pointerType:'touch'});assert(!f.fire('pointermove',{pointerType:'touch',clientX:100}).prevented);assert.equal(f.root.scrollLeft,120);
  f=dragFixture();f.fire('pointerdown');f.fire('pointermove',{clientY:130,clientX:198});f.fire('pointermove',{clientX:100});assert.equal(f.root.scrollLeft,120);
  f=dragFixture();f.fire('pointerdown');f.fire('pointermove',{clientX:100});f.fire('pointercancel');assert(!f.classes.has('is-dragging'));assert(!f.fire('click').prevented);
  f=dragFixture();f.fire('pointerdown');f.fire('pointermove',{clientX:100});f.fire('pointerup');assert(!f.fire('click',{detail:0}).prevented);
  f=dragFixture();f.root.scrollWidth=300;f.fire('pointerdown');f.fire('pointermove',{clientX:100});assert.equal(f.root.scrollLeft,120);
});

test('personal match summaries and loadout group totals are identical after public-field projection and export',async t=>{
  const s=testStore(t);member(s,'A',[101]);member(s,'B',[102]);member(s,'C',[103]);
  s.run('INSERT INTO unit_catalogue VALUES(?,?,?)','7',JSON.stringify({hudName:'Helicopter',categoryType:5,thumbnailFileName:'US_TEST-Label',private:'SECRET'}),'now');
  const raw=rawMatch([101,102,103,201]);s.ingest('800',raw);const d=detailFor(raw);
  for(const [id,p]of Object.entries(d.data.Data))Object.assign(p,{RawExpWithMultipliers:1234,SupplyPointsConsumedFromAllies:456,UnitData:{[id+'01']:{Id:7,OptionIds:[2,1],KilledCount:3,TotalDamageDealt:50}}});
  s.saveDetail('800',d);const full=matchDetail(s,'800'),pub=publicMatch(full);
  for(const p of full.participants){const next=pub.participants.find(q=>q.player_id===p.player_id);
    assert.equal(playerMetric(next,'RawExpWithMultipliers',pub),1234);assert.equal(playerMetric(next,'SupplyPointsConsumedFromAllies',pub),456);
    assert.deepEqual(playerUnits(pub,p.player_id).map(g=>[g.unit_id,g.options,g.kills,g.damage]),playerUnits(full,p.player_id).map(g=>[g.unit_id,g.options,g.kills,g.damage]));
    assert.equal(pub.units[0].catalogue.thumbnailFileName,'US_TEST-Label');assert(!JSON.stringify(pub).includes('SECRET'));
  }
  assert.equal(STATIC_SOURCES['match-player.js'],'public/match-player.js');
  const exported=await exportStatic(s,{directory:s.directory+'/site'}),inventory=await siteInventory(s.directory+'/site');
  assert(exported.revision);assert(inventory.files.some(f=>f.endsWith('/match-player.js')));
  const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  assert(app.includes("'match-player','match-unit'"));assert(app.includes('aria-label="查看 ${esc(p.name)} 的本局详情"'));
});

test('cached PNGs are same-origin, whitelist-selected, exported with the module and served with PNG MIME',async t=>{
  const name='TEST_'+randomUUID().replaceAll('-',''),file=new URL('../public/unit-icons/'+name+'.png',import.meta.url);
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6pcAAAAASUVORK5CYII=','base64');
  await mkdir(new URL('../public/unit-icons/',import.meta.url),{recursive:true});await writeFile(file,bytes);t.after(()=>unlink(file));
  let app;const directory=tempDir(t,()=>app?.close());app=createApplication({directory,startScheduler:false,staticOutputDirectory:directory+'/site'});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;
  let r=await fetch(base+'/unit-icon-'+name+'.png');assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes);
  assert((await fetch(base+'/match-player.js')).headers.get('content-type').includes('text/javascript'));
  assert((await fetch(base+'/match-version.js')).headers.get('content-type').includes('text/javascript'));
  assert.equal((await fetch(base+'/unit-icon-NO_SUCH_ICON.png')).status,404);
  const s=app.store;member(s,'A',[101]);member(s,'B',[102]);member(s,'C',[103]);const raw=rawMatch();s.ingest('800',raw);s.saveDetail('800',detailFor(raw));
  s.run('INSERT INTO unit_catalogue VALUES(?,?,?)','238',JSON.stringify({thumbnailFileName:name}),'now');
  await exportStatic(s,{directory:directory+'/site'});const inventory=await siteInventory(directory+'/site');
  const asset=inventory.files.find(f=>f.endsWith('/unit-icon-'+name+'.png'));assert(asset);
  assert.deepEqual(await readFile(directory+'/site/'+asset),bytes);
  r=await fetch(base+'/readonly/'+asset);assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'image/png');
  assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes);
  const publisher=new Publication(s,{directory:directory+'/site'});await publisher.run();
  const nextBytes=Buffer.concat([bytes,Buffer.from([0])]);await writeFile(file,nextBytes);
  const changed=await publisher.run();assert.equal(changed.changed,true);
  const nextAsset=(await siteInventory(directory+'/site')).marker.generations[0].files.find(f=>f.endsWith('/unit-icon-'+name+'.png'));
  assert(nextAsset&&nextAsset!==asset);assert.deepEqual(await readFile(directory+'/site/'+nextAsset),nextBytes);
  assert.deepEqual(await readFile(directory+'/site/'+asset),bytes);
});
