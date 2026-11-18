import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApplication, hashPassword } from '../src/server.mjs';
import { exportStatic } from '../src/static-export.mjs';
import { member, rawMatch, detailFor, selfDestructionPrices } from '../test/helpers.mjs';

const out=path.resolve('.cache/court-ui');mkdirSync(out,{recursive:true});
const directory=mkdtempSync(path.join(out,'data-'));
const app=createApplication({directory,startScheduler:false,staticOutputDirectory:path.join(directory,'site'),sourceOptions:{fetcher:async()=>new Response('{}',{status:404})}});
app.store.setting('sync_enabled',false);
member(app.store,'院长',[101]);member(app.store,'朋友与账号',[102]);member(app.store,'后勤科长',[103]);member(app.store,'空降薯条',[104]);
selfDestructionPrices(app.store);
app.store.run('INSERT INTO users(member_id,username,password_hash,role,created_at) VALUES(?,?,?,?,?)',1,'court-ui-owner',await hashPassword('court-ui-test-password'),'admin',new Date().toISOString());
for(let i=0;i<14;i++){
  const raw=rawMatch(undefined,{Type:0,MapId:i%2?4:12,WinnerTeam:i%3?0:1,EndTime:1792050000-i*86400});
  app.store.ingest(String(800+i),raw);const detail=detailFor(raw);
  Object.entries(detail.data.Data).forEach(([id,p],index)=>Object.assign(p,{Destruction:[3,1,10,0][index],Losses:1,SupplyPointsConsumedFromAllies:[500,700,0,100][index],SupplyPointsConsumedByAllies:[400,200,900,0][index]}));
  detail.data.Data['101'].UnitData['10101'].SelfDestruction=i%2===0;
  app.store.saveDetail(String(800+i),detail);
}
const legacyRaw=rawMatch(undefined,{Type:0,EndTime:1792050000-20*86400}),legacy=detailFor(legacyRaw);
for(const p of Object.values(legacy.data.Data)){p.Losses=1;for(const u of Object.values(p.UnitData)){delete u.SpawnTime;delete u.DeathTime;}}
legacy.data.Data['101'].UnitData['10101'].SelfDestruction=true;
app.store.ingest('899',legacyRaw);app.store.saveDetail('899',legacy);
app.store.run('INSERT INTO unit_catalogue VALUES(?,?,?)','238',JSON.stringify({id:238,hudName:'Patriot PAC-3',role:15}),new Date().toISOString());
await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${app.server.address().port}`;
const pw=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);let browser;
try{
  try{browser=await pw.chromium.launch({headless:true,channel:'chrome'});}catch{browser=await pw.chromium.launch({headless:true});}
  const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1});
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('response',r=>{if(r.status()>=400)errors.push(`${r.status()} ${r.url()}`);});
  await page.goto(url);await page.getByLabel('登录名',{exact:true}).fill('court-ui-owner');await page.getByLabel('密码',{exact:true}).fill('court-ui-test-password');await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.getByRole('heading',{name:'审判大厅',exact:true}).waitFor();
  assert.equal(await page.locator('[data-action="toggle-court-mode"]').count(),0);
  assert.equal(app.store.settings().court_mode,true);
  await page.screenshot({path:path.join(out,'court-dashboard-desktop.png'),fullPage:true});
  for(const [route,label]of [['members','看守所'],['matches','对局卷宗'],['sync','书记官室']]){
    await page.locator(`nav a[href="#${route}"]`).click();await page.getByRole('heading',{name:label,exact:true}).waitFor();
    if(route==='members')assert.equal(await page.locator('.member-heading h2 a[href="#friend/2"]').textContent(),'朋友与账号');
    if(route==='sync'){
      assert.equal(await page.locator('.court-mode-panel').count(),0);
      assert.equal(await page.locator('#source-provider-settings select').inputValue(),'official');
      assert.equal(await page.locator('#source-provider-settings option[value="batrace"]').evaluate(el=>el.disabled),true);
    }
  }
  await page.screenshot({path:path.join(out,'court-settings-desktop.png'),fullPage:true});
  app.store.setting('court_mode',false);
  await page.reload();await page.getByRole('heading',{name:'书记官室',exact:true}).waitFor();
  assert.equal(await page.locator('html').getAttribute('data-court-mode'),'on');
  await page.goto(url+'/#match/800');await page.getByRole('button',{name:'当庭对质',exact:true}).waitFor();
  await page.getByRole('button',{name:'证据清单',exact:true}).waitFor();
  await page.screenshot({path:path.join(out,'court-case-desktop.png'),fullPage:true});
  await page.goto(url+'/#analytics');await page.locator('#main h1').waitFor();
  await page.goto(url+'/#friend/2');await page.locator('#main h1').waitFor();
  assert.deepEqual(await page.locator('.profile-unit-highlights .insight-label').allTextContents(),['最多使用单位','伤害最高单位','击杀最多单位']);
  assert.equal(await page.locator('.profile-unit-highlights > .hint').count(),0);
  await page.screenshot({path:path.join(out,'court-profile-units-desktop.png'),fullPage:true});
  await page.goto(url+'/#analytics');await page.locator('[data-action="analytics-tab"][data-value="supply"]').click();
  await page.getByRole('heading',{name:'蘸饭罪名榜',exact:true}).waitFor();
  assert.equal(await page.locator('[data-charge]').count(),10);
  assert.equal(await page.locator('[data-charge-group="sentencing"] [data-charge]').count(),7);
  await page.getByRole('heading',{name:'自毁长城罪',exact:true}).waitFor();
  assert.equal(await page.locator('[data-charge="self_destruction"] [data-table-sort="avg_self_destruction_score"]').count(),1);
  const selfBoard=page.locator('[data-charge="self_destruction"]');
  assert(await selfBoard.locator('.table-wrap').evaluate(el=>el.scrollWidth<800),'self-destruction evidence must wrap instead of widening the ranking');
  assert.equal(JSON.parse(await selfBoard.locator('tbody tr').first().getAttribute('data-sort-values')).avg_self_destruction_score,55);
  await selfBoard.locator('details summary').first().click();
  await selfBoard.locator('.self-match-evidence>summary').first().click();
  assert((await selfBoard.locator('.self-unit-list').first().textContent()).includes('标准装甲'));
  assert((await selfBoard.locator('.self-unit-list').first().textContent()).includes('110.0 分'));
  assert.equal(await selfBoard.locator('a[href="#match/800"]').count(),1);
  assert.equal(await page.locator('.self-coverage').count(),0);
  assert.equal(await page.getByText('按场均自毁损失分排名：',{exact:false}).count(),0);
  assert.equal(await page.locator('[data-charge-group="mitigation"] [data-charge="transport"]').count(),1);
  await page.getByRole('heading',{name:'运输大队长',exact:true}).waitFor();
  assert.equal(await page.locator('[data-charge-group="mitigation"] [data-charge]').count(),3);
  await page.getByRole('heading',{name:'空优立功榜',exact:true}).waitFor();
  const left=await page.locator('[data-charge-group="sentencing"]').boundingBox(),right=await page.locator('[data-charge-group="mitigation"]').boundingBox();
  assert(Math.abs(left.y-right.y)<2&&right.x>left.x+left.width,'boards must be side by side');
  const tabs=await page.locator('[data-action="analytics-tab"]').evaluateAll(els=>els.map(e=>e.dataset.value));assert(tabs.indexOf('supply')<tabs.indexOf('combos'));
  await page.getByRole('heading',{name:'KD失职罪',exact:true}).waitFor();await page.getByRole('heading',{name:'占点旷工罪',exact:true}).waitFor();
  assert.equal(await page.locator('[data-charge="kd"] [data-table-sort="score_ratio"]').count(),1);
  assert((await page.locator('[data-charge="kd"]').textContent()).includes('分数交换比'));
  assert((await page.locator('[data-charge="kd"]').textContent()).includes('摧毁分'));
  assert.equal(await page.locator('[data-charge="rating"]').count(),0);
  assert.equal(await page.locator('[data-charge="kills"] [data-table-sort="avg_destruction"]').count(),1);
  await page.getByRole('heading',{name:'重防赎罪榜',exact:true}).waitFor();
  await page.locator('[data-charge="heavy_aa_kills"] details').first().locator('summary').click();
  assert((await page.locator('[data-charge="heavy_aa_kills"] details').first().textContent()).includes('Patriot PAC-3'));
  assert.equal(await page.locator('[data-charge="heavy_aa"]').count(),0);
  const table=page.locator('[data-sort-table="mitigation-transport"]');
  const numbers=()=>table.locator('tbody tr').evaluateAll(rows=>rows.map(r=>JSON.parse(r.dataset.sortValues).avg_supplied_allies));
  const descending=await numbers();assert.deepEqual(descending,[...descending].sort((a,b)=>b-a));
  await table.locator('[data-table-sort="avg_supplied_allies"]').click();
  await table.locator('[data-table-sort="avg_supplied_allies"]').click();assert.deepEqual(await numbers(),[...descending].sort((a,b)=>a-b));
  await page.locator('[data-table-sort-reset="mitigation-transport"]').click();assert.deepEqual(await numbers(),descending);
  await page.screenshot({path:path.join(out,'court-charges-desktop.png'),fullPage:true});
  await page.locator('[data-action="analytics-tab"][data-value="court"]').click();await page.getByRole('heading',{name:'蘸饭刑期榜',exact:true}).waitFor();
  await page.setViewportSize({width:390,height:844});
  for(const route of ['dashboard','members','matches','sync','match/800','analytics','friend/2']){
    await page.goto(url+'/#'+route);await page.locator('#main h1').waitFor();
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),route+' overflows mobile');
    if(['dashboard','members'].includes(route))await page.screenshot({path:path.join(out,`court-${route}-mobile.png`),fullPage:true});
  }
  await exportStatic(app.store,{directory:app.staticDirectory});
  const viewer=await browser.newPage({viewport:{width:1440,height:1000}});viewer.on('pageerror',e=>errors.push(e.message));
  await viewer.goto(url+'/readonly/');await viewer.getByRole('heading',{name:'审判大厅',exact:true}).waitFor();
  assert.equal(await viewer.locator('[data-action="toggle-court-mode"]').count(),0);
  await viewer.screenshot({path:path.join(out,'court-readonly-desktop.png'),fullPage:true});
  await viewer.goto(url+'/readonly/#analytics');await viewer.locator('[data-action="analytics-tab"][data-value="supply"]').click();
  await viewer.getByRole('heading',{name:'蘸饭罪名榜',exact:true}).waitFor();assert.equal(await viewer.locator('[data-charge]').count(),10);
  assert.equal(await viewer.locator('[data-charge="kd"] [data-table-sort="score_ratio"]').count(),1);
  assert.equal(JSON.parse(await viewer.locator('[data-charge="self_destruction"] tbody tr').first().getAttribute('data-sort-values')).avg_self_destruction_score,55);
  assert.equal(await viewer.locator('.self-coverage').count(),0);
  assert.equal(await viewer.getByText('按场均自毁损失分排名：',{exact:false}).count(),0);
  const publicSelf=viewer.locator('[data-charge="self_destruction"]');
  await publicSelf.locator('.heavy-aa-evidence>summary').first().click();
  await publicSelf.locator('.self-match-evidence>summary').first().click();
  assert((await publicSelf.locator('.self-unit-list').first().textContent()).includes('标准装甲'));
  const heavy=viewer.locator('[data-charge="heavy_aa_kills"] tbody tr').first();
  assert.equal(await heavy.getAttribute('data-sort-values').then(JSON.parse).then(r=>r.avg_heavy_aa_kills),3);
  assert.equal(await viewer.locator('[data-charge="heavy_aa_kills"] [data-table-sort="avg_heavy_aa_kills"]').count(),1);
  await viewer.setViewportSize({width:390,height:844});assert(await viewer.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await publicSelf.locator('.self-unit-list').first().scrollIntoViewIfNeeded();
  assert(await publicSelf.locator('.self-unit-list').first().evaluate(el=>el.scrollWidth<=el.clientWidth+1),'unit details overflow their mobile container');
  await viewer.screenshot({path:path.join(out,'court-charges-mobile.png')});
  app.store.setting('court_mode',false);await exportStatic(app.store,{directory:app.staticDirectory});
  await viewer.goto(url+'/readonly/');await viewer.getByRole('heading',{name:'审判大厅',exact:true}).waitFor();
  assert.equal(await viewer.locator('html').getAttribute('data-court-mode'),'on');
  assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,screenshots:out,checks:['permanent court UI','legacy setting compatibility','authored copy only','all routes on mobile','read-only court UI','no theme controls','no browser errors']},null,2));
}finally{await browser?.close();await app.close();}
