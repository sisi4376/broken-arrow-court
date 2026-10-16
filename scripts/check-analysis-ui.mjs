import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createApplication,hashPassword} from '../src/server.mjs';
import {exportStatic} from '../src/static-export.mjs';
import {member,rawMatch,detailFor} from '../test/helpers.mjs';

const out=path.resolve('.cache/analysis-ui');mkdirSync(out,{recursive:true});
const app=createApplication({directory:mkdtempSync(path.join(out,'data-')),startScheduler:false,sourceOptions:{fetcher:async()=>new Response('{}',{status:404})}});
app.store.setting('sync_enabled',false);
member(app.store,'院长',[101]);member(app.store,'朋友甲',[102]);member(app.store,'朋友乙',[103]);member(app.store,'暂无战绩',[]);
member(app.store,'朋友丙',[105]);
app.store.run('INSERT INTO users(member_id,username,password_hash,role,created_at) VALUES(?,?,?,?,?)',1,'analysis-test',await hashPassword('analysis-ui-password'),'admin',new Date().toISOString());
const model={specializations:[{id:3,name:'USMC',countryId:2},{id:4,name:'Armored Brigade',countryId:2},{id:5,name:'Airborne infantry',countryId:2}],units:{238:{country_id:2,spec_ids:[3]},239:{country_id:2,spec_ids:[4]}}};
app.store.run("INSERT INTO analysis_catalogue VALUES('deck_model',?,'2026-10-15')",JSON.stringify(model));
for(let i=0;i<12;i++){
  const raw=rawMatch(i<4?[101,102,103,105]:[101,102,103],{Type:0,MapId:i%2?4:9,WinnerTeam:i<8?0:1,EndTime:1792050000+i*86400});raw.Data['103'].TeamId=1;
  if(raw.Data['105'])raw.Data['105'].TeamId=0;
  app.store.ingest(String(800+i),raw);const detail=detailFor(raw);
  for(const [pid,p] of Object.entries(detail.data.Data))p.UnitData={['1'+pid]:{Id:238,SpawnTime:raw.EndTime-100,KilledCount:2,TotalDamageDealt:50},['2'+pid]:{Id:239,SpawnTime:raw.EndTime-90,DeathTime:raw.EndTime-20,KilledCount:1,TotalDamageDealt:25}};
  app.store.saveDetail(String(800+i),detail);
}
for(const [id,name]of [['238','M1A2 Abrams'],['239','AH-64 Apache']])app.store.run('INSERT INTO unit_catalogue VALUES(?,?,?)',id,JSON.stringify({id:Number(id),hudName:name}),new Date().toISOString());
await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${app.server.address().port}`;
const pw=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);let browser;
async function checkSort(page,id) {
  const table=page.locator(`[data-sort-table="${id}"]`);
  const columns=await table.evaluate(t=>JSON.parse(t.dataset.sortColumns));
  for(const column of columns){
    for(let toggle=0;toggle<2;toggle++){
      await table.locator(`[data-table-sort="${column.key}"]`).click();
      const result=await table.evaluate((t,c)=>{
        const direction=t.querySelector(`[data-table-sort="${c.key}"]`).closest('th').getAttribute('aria-sort');
        const rows=Array.from(t.tBodies[0].rows).map(r=>({value:JSON.parse(r.dataset.sortValues)[c.key]??null,index:Number(r.dataset.sortIndex)}));
        let missing=false;
        for(let i=0;i<rows.length;i++){
          const r=rows[i];if(r.value===null){missing=true;continue;}if(missing)return {ok:false,reason:'missing data moved before known values'};
          if(i===0||rows[i-1].value===null)continue;
          const prev=rows[i-1],diff=c.type==='text'?new Intl.Collator('zh-CN',{numeric:true,sensitivity:'base'}).compare(prev.value,r.value):Number(prev.value)===Number(r.value)?0:Number(prev.value)<Number(r.value)?-1:1;
          if(direction==='ascending'?diff>0:diff<0)return{ok:false,reason:'values out of order'};
          if(diff===0&&prev.index>r.index)return{ok:false,reason:'tie order changed'};
        }
        return {ok:true,direction};
      },column);
      assert(result.ok,`${id}/${column.key}: ${result.reason}`);
      assert.equal(result.direction,(toggle===0?column.first:column.first==='asc'?'desc':'asc')==='asc'?'ascending':'descending');
    }
  }
  await page.locator(`[data-table-sort-reset="${id}"]`).click();
  assert.deepEqual(await table.locator('tbody tr').evaluateAll(rows=>rows.map(r=>Number(r.dataset.sortIndex))),Array.from({length:await table.locator('tbody tr').count()},(_,i)=>i));
}
try{
  browser=await pw.chromium.launch({headless:true,channel:'chrome'});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url+'/#analytics');await page.getByLabel('登录名',{exact:true}).fill('analysis-test');await page.getByLabel('密码',{exact:true}).fill('analysis-ui-password');await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.locator('nav a[href="#analytics"]').click();await page.locator('[data-sort-table="friends"]').waitFor();
  const apiCalls=[];page.on('request',r=>{if(/\/api\/(dashboard|analytics|members)/.test(r.url()))apiCalls.push(r.url());});
  await checkSort(page,'friends');assert.equal(apiCalls.length,0,'Column sorting must not refetch data');
  await page.locator('[data-sort-table="friends"] [data-table-sort="win_rate"]').click();
  assert.match(await page.locator('[data-sort-table="friends"] tbody tr').first().textContent(),/朋友丙/);
  await page.reload();await page.locator('[data-sort-table="friends"] th[aria-sort="descending"]').waitFor();
  assert.match(await page.locator('[data-sort-table="friends"] tbody tr').first().textContent(),/朋友丙/);
  await page.locator('[data-sort-table="friends"] [data-table-sort="win_rate"]').click();
  assert.match(await page.locator('[data-sort-table="friends"] tbody tr').first().textContent(),/朋友乙/);
  await page.locator('[data-action="analytics-tab"][data-value="combos"]').click();await page.locator('[data-sort-table="combos"]').waitFor();await checkSort(page,'combos');
  await page.locator('[data-action="analytics-tab"][data-value="members"]').click();await page.locator('[data-sort-table="friends"] th[aria-sort="ascending"]').waitFor();
  await page.locator('#main a[href="#friend/1"]').first().click();
  await page.getByRole('heading',{name:'院长 · 详细分析',exact:true}).waitFor();
  assert.equal(await page.locator('.insight-card').count(),6);assert.match(await page.locator('.insight-card').nth(1).textContent(),/M1A2 Abrams/);
  await page.screenshot({path:path.join(out,'friend-overview-desktop.png'),fullPage:true});
  for(const tab of ['decks','teammates','maps','units','matches']){
    await page.locator(`[data-action="friend-tab"][data-value="${tab}"]`).click();await page.locator('tbody tr').first().waitFor();
    if(tab!=='matches')await checkSort(page,'friend-'+tab);
    if(tab==='decks')await checkSort(page,'friend-deck-maps');
    await page.screenshot({path:path.join(out,`friend-${tab}-desktop.png`),fullPage:true});
  }
  await page.locator('[data-action="friend-tab"][data-value="teammates"]').click();
  await page.locator('[data-sort-table="friend-teammates"] [data-table-sort="win_rate"]').focus();await page.keyboard.press('Enter');
  assert.match(await page.locator('[data-sort-table="friend-teammates"] tbody tr').first().textContent(),/朋友丙/);
  await page.keyboard.press('Space');assert.match(await page.locator('[data-sort-table="friend-teammates"] tbody tr').first().textContent(),/朋友甲/);
  assert.match(await page.locator('tbody tr').filter({hasText:'朋友乙'}).textContent(),/12/);
  await page.locator('#analysis-min').selectOption('20');await page.locator('#analysis-min').waitFor();await page.waitForFunction(()=>document.querySelector('#analysis-min')?.value==='20'&&!document.querySelector('.loading-page'));
  await page.locator('[data-action="friend-tab"][data-value="overview"]').click();assert.match(await page.locator('.insight-card').nth(3).textContent(),/样本不足/);
  await page.locator('#friend-switch').selectOption('4');await page.getByRole('heading',{name:'暂无战绩 · 详细分析',exact:true}).waitFor();
  await page.locator('#friend-switch').selectOption('1');await page.getByRole('heading',{name:'院长 · 详细分析',exact:true}).waitFor();
  await page.setViewportSize({width:390,height:844});
  for(const tab of ['overview','decks','teammates','maps','units','matches']){
    await page.locator(`[data-action="friend-tab"][data-value="${tab}"]`).click();
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${tab} overflows`);
    await page.screenshot({path:path.join(out,`friend-${tab}-mobile.png`),fullPage:true});
  }
  await page.goto(url+'/#match/800');await page.getByRole('heading',{name:'对局 #800',exact:true}).waitFor();
  await page.locator('[data-action="edit-deck"][data-id="101"]').click();await page.locator('#deck-spec1').selectOption('3');await page.locator('#deck-spec2').selectOption('5');
  await page.getByRole('button',{name:'确认组合',exact:true}).click();await page.locator('dialog').waitFor({state:'hidden'});
  assert.equal(app.store.get("SELECT spec2 FROM match_decks WHERE player_id='101'").spec2,5);
  await page.locator('[data-action="edit-deck"][data-id="101"]').click();await page.getByRole('button',{name:'清除人工确认，恢复推定',exact:true}).click();await page.locator('dialog').waitFor({state:'hidden'});
  assert.equal(app.store.get('SELECT COUNT(*) n FROM match_decks').n,0);
  await page.locator('nav a[href="#analytics"]').click();await page.getByRole('heading',{name:'开黑分析',exact:true}).waitFor();
  for(const tab of ['decks','maps','units']){
    await page.locator(`[data-action="analytics-tab"][data-value="${tab}"]`).click();await page.locator('tbody tr').first().waitFor();
    await checkSort(page,'overall-'+tab);if(tab==='decks')await checkSort(page,'overall-deck-maps');
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.screenshot({path:path.join(out,`overall-${tab}-mobile.png`),fullPage:true});
  }
  await exportStatic(app.store,{directory:app.staticDirectory});
  const viewer=await browser.newPage({viewport:{width:390,height:844}});viewer.on('pageerror',e=>errors.push(e.message));
  await viewer.goto(url+'/readonly/#friend/1');await viewer.getByRole('heading',{name:'院长 · 详细分析',exact:true}).waitFor();
  await viewer.locator('[data-action="friend-tab"][data-value="decks"]').click();await viewer.locator('tbody tr').first().waitFor();
  await checkSort(viewer,'friend-decks');
  await viewer.locator('[data-action="friend-tab"][data-value="units"]').click();await viewer.getByRole('heading',{name:'常用单位',exact:true}).waitFor();
  await checkSort(viewer,'friend-units');
  await viewer.goto(url+'/readonly/#match/800');await viewer.getByRole('heading',{name:'对局 #800',exact:true}).waitFor();assert.equal(await viewer.locator('[data-action="edit-deck"]').count(),0);
  assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,checks:['friend reports','all report tabs','sample thresholds','empty friend','favorite units','deck confirmation and clear','overall decks and maps','mobile layout','read-only reports and no edit controls'],screenshots:out}));
}finally{await browser?.close();await app.close();}
