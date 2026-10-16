import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from '../src/db.mjs';
import { exportStatic } from '../src/static-export.mjs';
import { serveStatic } from '../src/static-host.mjs';
import { member, rawMatch, detailFor } from '../test/helpers.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=path.join(root,'.cache/readonly-ui');mkdirSync(out,{recursive:true});
const directory=mkdtempSync(path.join(out,'run-'));const site=path.join(directory,'site');
let store=new Store(directory);member(store,'院长',[101]);member(store,'朋友甲',[102]);member(store,'朋友乙',[103]);
for(let i=0;i<8;i++){const raw=rawMatch(undefined,{EndTime:Math.floor(Date.now()/1000)-i*86400,Type:0,MapId:i%2?22:12});store.ingest(String(800+i),raw);store.saveDetail(String(800+i),detailFor(raw));}
store.ingest('900',rawMatch(undefined,{Type:1}));store.ingest('9999999',rawMatch([101,201,202]));
store.run('INSERT INTO unit_catalogue(unit_id,data_json,updated_at) VALUES(?,?,?)','238',JSON.stringify({id:238,hudName:'T-90M'}),new Date().toISOString());
await exportStatic(store,{directory:site});store.close();store=null;
const paths=[];
const server=http.createServer((req,res)=>{paths.push(new URL(req.url,'http://localhost').pathname);serveStatic(req,res,site,new URL(req.url,'http://localhost').pathname.slice('/court/'.length));});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/court/`;
const pw=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
let browser;
try{
  try{browser=await pw.chromium.launch({headless:true,channel:'chrome'});}catch{browser=await pw.chromium.launch({headless:true});}
  const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);await page.getByRole('heading',{name:'法庭总览',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'登记游戏账号',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'账号设置',exact:true}).count(),0);
  assert.equal(await page.getByLabel('游戏模式',{exact:true}).inputValue(),'0');
  await page.waitForFunction(()=>document.querySelector('.kpi-value')?.textContent.trim()==='8');
  const plotted=await page.locator('#activity-chart').evaluate(canvas=>{const p=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let count=0;for(let i=0;i<p.length;i+=4)if(p[i]===138&&p[i+1]===213&&p[i+2]===172&&p[i+3]>0)count++;return count;});assert(plotted>50);
  await page.screenshot({path:path.join(out,'dashboard-desktop.png'),fullPage:true});
  await page.getByLabel('地图',{exact:true}).selectOption('22');await page.waitForFunction(()=>document.querySelector('.kpi-value')?.textContent.trim()==='4');
  await page.getByRole('button',{name:'清除筛选',exact:true}).click();
  await page.getByRole('link',{name:'对局档案',exact:true}).click();await page.getByRole('heading',{name:'对局档案',exact:true}).waitFor();assert.equal(await page.locator('tbody tr').count(),8);
  await page.getByLabel('游戏模式',{exact:true}).selectOption('');await page.waitForFunction(()=>document.querySelectorAll('tbody tr').length===9);
  await page.getByRole('button',{name:'清除筛选',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('tbody tr').length===8);
  await page.locator('a[href="#match/800"]').first().click();await page.getByRole('heading',{name:'对局 #800',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'补抓详情',exact:true}).count(),0);
  await page.getByRole('button',{name:'单位与时间轴',exact:true}).click();await page.locator('#timeline-player').selectOption('*');assert.equal(await page.locator('.timeline-row').count(),4);
  await page.screenshot({path:path.join(out,'detail-desktop.png'),fullPage:true});
  await page.getByRole('button',{name:'玩家对比',exact:true}).click();assert.equal(await page.locator('.comparison-row').count(),11);
  await page.getByRole('link',{name:'开黑分析',exact:true}).click();await page.getByRole('columnheader',{name:'场均摧毁分',exact:true}).waitFor();
  await page.getByRole('button',{name:'单位表现',exact:true}).click();await page.locator('.table-title').filter({hasText:'T-90M'}).waitFor();
  await page.getByRole('link',{name:'朋友与账号',exact:true}).click();await page.getByRole('heading',{name:'朋友与账号',exact:true}).waitFor();
  for(const name of ['登记账号','添加朋友','邀请注册','修改称呼','查看账号生涯'])assert.equal(await page.getByRole('button',{name,exact:true}).count(),0);
  const rejected=await page.evaluate(async()=>{try{await window.COURT_READONLY_API.request('/api/members',{method:'POST'});return false;}catch{return true;}});assert(rejected);
  assert.equal((await fetch(url+'manifest.json',{method:'POST'})).status,405);
  store=new Store(directory);store.run("UPDATE members SET name='更新后的朋友' WHERE id=2");await exportStatic(store,{directory:site});store.close();store=null;
  assert.equal(await page.evaluate(()=>window.COURT_READONLY_API.hasUpdate()),true);
  await page.getByRole('button',{name:'刷新当前页面',exact:true}).click();await page.getByRole('heading',{name:'更新后的朋友',exact:true}).waitFor();
  await page.setViewportSize({width:390,height:844});
  for(const view of ['dashboard','matches','analytics','members']){
    await page.locator(`nav a[href="#${view}"]`).click();await page.getByRole('heading',{name:({dashboard:'法庭总览',matches:'对局档案',analytics:'开黑分析',members:'朋友与账号'})[view],exact:true}).waitFor();
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(out,`${view}-mobile.png`),fullPage:true});
  }
  assert(!paths.some(p=>p.includes('/api/')),'Static page must never call a backend API');assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,backendRunning:false,checks:['read-only controls','no backend API requests','WASM query parity','normal mode default','map filters','all modes','match detail lazy loading','unit timeline','comparison','averages','unit aggregates','revision refresh','write rejection','subdirectory hosting','desktop/mobile layout','nonblank chart'],screenshots:out},null,2));
}finally{await browser?.close();store?.close();await new Promise(resolve=>server.close(resolve));}
