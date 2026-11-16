import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createApplication,hashPassword} from '../src/server.mjs';
import {member,rawMatch} from '../test/helpers.mjs';
import {importHistoryEvidence} from '../src/request-statistics.mjs';

const out=path.resolve('.cache/request-monitor-ui');mkdirSync(out,{recursive:true});
const directory=mkdtempSync(path.join(out,'data-'));
const app=createApplication({directory,startScheduler:false,staticOutputDirectory:path.join(directory,'site'),sourceOptions:{fetcher:async()=>Response.json({players:[]})}});
app.store.setting('sync_enabled',false);app.store.setting('request_delay_ms',0);
app.store.run("INSERT INTO sync_runs(id,kind,status,started_at,finished_at,requests) VALUES(1,'incremental','complete','2026-10-15T10:00:00Z','2026-10-15T10:05:00Z',10)");app.store.setting('request_history_cutoff_run_id',1);
importHistoryEvidence(app.store,{metrics:{recorded_sync_attempts:10},daily:[{day:'2026-10-15',recorded_sync_attempts:10,outside_sync_snapshot_supplement:3}]});
member(app.store,'监控管理员');
app.store.run('INSERT INTO users(member_id,username,password_hash,role,created_at) VALUES(?,?,?,?,?)',1,'monitor-owner',await hashPassword('monitor-ui-test-password'),'admin',new Date().toISOString());
await app.source.search('demo');await app.source.read('/api/players/search?q=demo&limit=20',{snapshot:false});
for(let i=0;i<18;i++)app.store.run("INSERT INTO source_requests(base,resource,category,trigger,attempt,started_at,finished_at,status,bytes,outcome) VALUES(?,?,?,?,?,?,?,?,?,?)",app.source.base,'/fixture/'+i,'测试归档','离线测试',1,Date.now()-i*86400000,Date.now()-i*86400000+100,200,1024,'complete');
app.store.ingest('9101',rawMatch());app.store.ingest('9102',rawMatch());app.store.ingest('9101',rawMatch(undefined,{Type:3}));
await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${app.server.address().port}`;
const pw=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);let browser;
try{
  try{browser=await pw.chromium.launch({headless:true,channel:'chrome'});}catch{browser=await pw.chromium.launch({headless:true});}
  const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];
  await page.route('**/*',route=>route.request().url().startsWith(url+'/')?route.continue():route.abort());
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);await page.getByLabel('登录名',{exact:true}).fill('monitor-owner');await page.getByLabel('密码',{exact:true}).fill('monitor-ui-test-password');await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.locator('nav a[href="#sync"]').click();
  await page.getByRole('heading',{name:'数据源请求监控',exact:true}).waitFor();
  assert((await page.locator('#request-monitor-title').locator('..').locator('..').textContent()).includes('累计可核实请求33'));
  const daily=page.locator('section[aria-labelledby="request-statistics-title"]');
  await page.waitForFunction(()=>document.querySelectorAll('.request-daily-table tbody tr').length===15);
  assert.equal(await daily.locator('tbody tr').count(),15);
  assert((await daily.textContent()).includes('新增比赛'));
  assert((await daily.textContent()).includes('2 场比赛'));
  assert.equal(await page.locator('.request-detail-table tbody tr').count(),15);
  assert.equal(await page.locator('#request-details-title').locator('xpath=ancestor::details').count(),0);
  assert.equal(await page.locator('.secretary-room > section').last().getByRole('heading').textContent(),'查询顺序与静默');
  assert.equal(await page.locator('#query-quiet-toggle').isChecked(),false);
  for(const [prefix,table,lastRows] of [['request-stats','.request-daily-table',3],['request-details','.request-detail-table',5]]){
    await page.locator('[data-action="'+prefix+'-next"]').click();
    await page.waitForFunction(({table,n})=>document.querySelectorAll(table+' tbody tr').length===n,{table,n:lastRows});
    assert.equal(await page.locator(table+' tbody tr').count(),lastRows);
    await page.locator('[data-action="'+prefix+'-prev"]').click();
    await page.waitForFunction(table=>document.querySelectorAll(table+' tbody tr').length===15,table);
  }
  await page.locator('[data-action="request-details-next"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('.request-detail-table tbody tr').length===5);
  await page.waitForResponse(r=>r.url().endsWith('/api/sync/status'));
  await page.waitForResponse(r=>r.url().includes('/api/source/requests?page=2'));
  assert.equal(await page.locator('.request-detail-table tbody tr').count(),5);
  await page.locator('[data-action="request-details-prev"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('.request-detail-table tbody tr').length===15);
  await page.screenshot({path:path.join(out,'daily-desktop.png'),fullPage:true});
  assert((await page.locator('#main').textContent()).includes('今日接收正文'));
  assert((await page.locator('#sync-settings').textContent()).includes('06:00、12:00、18:00'));
  assert.equal(await page.locator('#auto-sync-toggle').isChecked(),false);
  let saved=page.waitForResponse(r=>r.url().endsWith('/api/settings')&&r.request().method()==='PATCH');
  await page.locator('#auto-sync-toggle').check();await saved;
  await page.waitForFunction(()=>document.querySelector('#auto-sync-toggle')?.checked===true&&!document.querySelector('#auto-sync-toggle').disabled);
  assert.equal(app.store.settings().sync_enabled,true);
  saved=page.waitForResponse(r=>r.url().endsWith('/api/settings')&&r.request().method()==='PATCH');
  await page.locator('#auto-sync-toggle').uncheck();await saved;
  await page.waitForFunction(()=>document.querySelector('#auto-sync-toggle')?.checked===false&&!document.querySelector('#auto-sync-toggle').disabled);
  assert.equal(app.store.settings().sync_enabled,false);
  for(const provider of ['official','batrace']){
    await page.locator('#source-provider-settings select').selectOption(provider);
    const changed=page.waitForResponse(r=>r.url().endsWith('/api/source/provider'));
    await page.getByRole('button',{name:'切换数据源',exact:true}).click();await changed;
    await page.waitForFunction(p=>document.querySelector('#source-provider-settings select')?.value===p,provider);
    assert.equal(app.store.settings().source_provider,provider);
  }
  await page.locator('#request-statistics-query select[name="group"]').selectOption('month');
  const queried=page.waitForResponse(r=>r.url().includes('/api/source/statistics?'));
  await page.getByRole('button',{name:'查询统计',exact:true}).click();await queried;
  await page.waitForFunction(()=>document.querySelectorAll('.request-daily-table tbody tr').length===1);
  assert((await daily.textContent()).includes('未知'));
  const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'导出 CSV',exact:true}).click();const csv=await downloaded;assert.equal(csv.suggestedFilename(),'request-statistics.csv');
  await page.getByLabel('每日上限',{exact:true}).fill('500');
  await page.getByRole('button',{name:'保存请求上限',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#request-settings input[name="day"]')?.value==='500');
  await page.getByText('今日同一地址多次请求（1 个高频地址）',{exact:true}).click();

  await page.screenshot({path:path.join(out,'desktop.png'),fullPage:true});
  assert.equal(app.store.settings().request_limit_day,500);assert.equal(app.store.settings().sync_enabled,false);
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(out,'mobile.png'),fullPage:true});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  assert.deepEqual(errors,[]);
  writeFileSync(path.join(out,'result.json'),JSON.stringify({requests:20,legacy:10,supplement:3,cumulative:33,new_matches:2,page_size:15,pagination_verified:true,query_group:'month',csv:true,bytes:app.store.get('SELECT SUM(bytes) n FROM source_requests').n,limit_saved:500,sync_enabled:false,toggle_verified:true,source_switch_verified:true,errors},null,2));
  console.log('Request monitor UI passed: desktop, mobile, limit save, request details, paused sync.');
}finally{await browser?.close();await app.close();}
