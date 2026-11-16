import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createApplication,hashPassword} from '../src/server.mjs';
import {exportStatic} from '../src/static-export.mjs';
import {member,rawMatch,detailFor} from '../test/helpers.mjs';

const out=path.resolve('.cache/game-modes-ui');mkdirSync(out,{recursive:true});
const directory=mkdtempSync(path.join(out,'data-'));let sent=0;
const app=createApplication({directory,startScheduler:false,staticOutputDirectory:path.join(directory,'site'),sourceOptions:{fetcher:async()=>{sent++;throw Error('UI must not contact source');}}});
app.store.setting('sync_enabled',false);member(app.store,'管理员',[101]);member(app.store,'朋友 B',[102]);member(app.store,'朋友 C',[103]);
app.store.run('INSERT INTO users(member_id,username,password_hash,role,created_at) VALUES(?,?,?,?,?)',1,'mode-owner',await hashPassword('mode-ui-test-password'),'admin',new Date().toISOString());
app.store.saveProfile('101',{info:{id:101,name:'本地账号'},statInfo:{fightsCountRt:20,fightsCountCt:5,fightsCountSk:2}});
const normal=detailFor(rawMatch(undefined,{Type:0})).data;delete normal.Type;
const legacy={...normal,Type:-1};app.store.snapshot('/fights/fight_900.json',normal);app.store.ingest('900',legacy);app.store.saveDetail('900',{data:legacy,metadata:{source:'official',mode_unknown:true}});app.store.migrate();
const custom=rawMatch(undefined,{Type:1});app.store.ingest('901',custom);app.store.saveDetail('901',detailFor(custom));
for(const[id,players]of [['902',[101,201,202,203]],['903',[101,102,201,202]],['904',[101,201,202,102]]]){
  const raw=rawMatch(players,{Type:0});app.store.ingest(id,raw);app.store.saveDetail(id,detailFor(raw));
}
await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${app.server.address().port}`;
const pw=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);let browser;
try{
  try{browser=await pw.chromium.launch({headless:true,channel:'chrome'});}catch{browser=await pw.chromium.launch({headless:true});}
  const context=await browser.newContext({viewport:{width:1440,height:1100}});
  await context.route('**/*',route=>new URL(route.request().url()).origin===url?route.continue():route.abort());
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  async function verifyPartyFilter(label){
    const team=page.locator('select[data-filter="team"]');
    const waitCount=n=>page.waitForFunction(n=>document.querySelectorAll('#main table a[aria-label^="查看对局 "]').length===n,n);
    await page.locator('[data-action="clear-filters"]').click();await waitCount(1);assert.equal(await team.inputValue(),'');
    await team.selectOption('all');await waitCount(4);await page.getByRole('link',{name:'查看对局 902',exact:true}).waitFor();
    assert.equal(await team.inputValue(),'all');assert.match(await page.locator('.rule-badge').innerText(),/所有比赛/);
    await page.screenshot({path:path.join(out,`${label}-all-matches.png`)});
    await team.selectOption('same');await waitCount(1);assert.equal(await team.inputValue(),'same');
    await team.selectOption('all');await waitCount(4);
    await page.locator('select[data-filter="mode"]').selectOption('1');await waitCount(1);await page.getByRole('link',{name:'查看对局 901',exact:true}).waitFor();
    await page.locator('[data-action="clear-filters"]').click();await waitCount(1);assert.equal(await team.inputValue(),'');
    assert.equal(await page.locator('select[data-filter="mode"]').inputValue(),'0');
  }
  await page.goto(url);await page.getByLabel('登录名',{exact:true}).fill('mode-owner');await page.getByLabel('密码',{exact:true}).fill('mode-ui-test-password');await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.locator('nav a[href="#matches"]').click();await page.getByRole('link',{name:'查看对局 900',exact:true}).waitFor();
  assert.equal(await page.locator('select[data-filter="mode"] option[value="1"]').textContent(),'自定义');
  await page.locator('select[data-filter="mode"]').selectOption('1');await page.getByRole('link',{name:'查看对局 901',exact:true}).waitFor();
  assert(!(await page.locator('#main').innerText()).includes('排位赛'));
  await page.screenshot({path:path.join(out,'desktop-custom.png')});
  await page.goto(url+'/#match/901');await page.getByText(/^自定义 ·/).first().waitFor();
  await page.goto(url+'/#members');await page.locator('[data-action="profile"]').first().click();await page.locator('dialog .profile-modes').waitFor();
  assert.deepEqual(await page.locator('dialog .profile-mode h3').allTextContents(),['普通模式','自定义','遭遇战']);
  app.store.setting('court_mode',true);await page.goto(url+'/#matches');await page.reload();
  await page.locator('select[data-filter="mode"]').selectOption('0');await page.locator('#candidate-toggle').check();
  await page.getByRole('link',{name:'查看对局 902',exact:true}).waitFor();
  const caption=id=>page.locator('tr').filter({has:page.locator(`a[href="#match/${id}"]`)}).locator('.friend-chips + .table-sub').innerText();
  assert.equal(await caption('902'),'1 位被告');
  assert.equal(await caption('903'),'2 位被告 · 同队');
  assert.equal(await caption('904'),'2 位被告 · 分处两队');
  await page.locator('#candidate-toggle').uncheck();await verifyPartyFilter('local');
  await exportStatic(app.store,{directory:app.staticDirectory});await page.goto(url+'/readonly/#matches');await page.getByRole('link',{name:'查看对局 900',exact:true}).waitFor();
  await page.locator('select[data-filter="mode"]').selectOption('1');await page.getByRole('link',{name:'查看对局 901',exact:true}).waitFor();
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(out,'mobile-readonly-custom.png')});
  await verifyPartyFilter('readonly-mobile');
  assert.equal(app.store.get("SELECT mode FROM matches WHERE id='900'").mode,'0');assert.equal(sent,0);assert.deepEqual(errors,[]);
  writeFileSync(path.join(out,'result.json'),JSON.stringify({normal_default_repaired:true,custom_label:true,profile_labels:true,readonly_filters:true,single_friend_caption:true,same_team_pair:true,opposing_team_pair:true,source_requests:sent,errors},null,2));
  console.log('Mode UI verified: custom labels, default normal repair, profile groups, private/read-only filters and zero upstream requests.');
}finally{await browser?.close();await app.close();}
