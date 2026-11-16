import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createApplication,hashPassword} from '../src/server.mjs';
import {member,rawMatch,detailFor} from '../test/helpers.mjs';

const out=path.resolve('.cache/profile-stats-ui');mkdirSync(out,{recursive:true});
const directory=mkdtempSync(path.join(out,'data-'));let sent=0;
const app=createApplication({directory,startScheduler:false,staticOutputDirectory:path.join(directory,'site'),sourceOptions:{fetcher:async()=>{sent++;throw Error('UI must not contact source');}}});
app.store.setting('sync_enabled',false);member(app.store,'生涯管理员',[101]);
app.store.run('INSERT INTO users(member_id,username,password_hash,role,created_at) VALUES(?,?,?,?,?)',1,'profile-owner',await hashPassword('profile-ui-test-password'),'admin',new Date().toISOString());
app.store.saveProfile('101',{info:{id:101,name:'本地账号',rating:1500,rank:40,level:10},statInfo:{fightsCountRt:100,winCountRt:60,lossCountRt:40,updatedAt:'$D2026-10-20T00:00:00Z'}});
const raw=rawMatch(undefined,{Type:0,EndTime:Date.parse('2026-10-21T00:00:00Z')/1000});app.store.ingest('901',raw,1);app.store.saveDetail('901',detailFor(raw));
await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${app.server.address().port}`;
const pw=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);let browser;
try{
  try{browser=await pw.chromium.launch({headless:true,channel:'chrome'});}catch{browser=await pw.chromium.launch({headless:true});}
  const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);await page.getByLabel('登录名',{exact:true}).fill('profile-owner');await page.getByLabel('密码',{exact:true}).fill('profile-ui-test-password');await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.locator('nav a[href="#members"]').click();await page.locator('[data-action="profile"]').first().click();
  await page.locator('dialog .profile-modes').waitFor();const text=await page.locator('dialog').innerText();
  assert(text.includes('101'));assert(text.includes('其后 1 局由本地更新'));assert(text.includes('间隔 8 天'));assert(text.includes('时长按战报总时长推算'));
  await page.screenshot({path:path.join(out,'desktop.png')});await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(out,'mobile.png')});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.equal(sent,0);assert.deepEqual(errors,[]);
  writeFileSync(path.join(out,'result.json'),JSON.stringify({source_requests:sent,local_games:1,calibration_days:8,errors},null,2));
  console.log('Local profile UI passed: live totals, calibration dates, desktop/mobile and zero source requests.');
}finally{await browser?.close();await app.close();}
