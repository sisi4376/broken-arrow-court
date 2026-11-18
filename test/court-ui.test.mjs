import test from 'node:test';
import assert from 'node:assert/strict';
import { courtText, courtHtml, setCourtMode } from '../public/court-ui.js';

test('court presentation translates authored copy without altering interpolated names or values',()=>{
  setCourtMode(false);
  assert.equal(courtText('朋友与账号'),'看守所');
  setCourtMode(true);
  assert.equal(courtText('朋友与账号'),'看守所');
  assert.equal(courtText('对局档案'),'对局卷宗');
  assert.equal(courtHtml`<h2>朋友表现</h2><span>${'朋友与账号'}</span><b>${0}</b>`, '<h2>被告表现</h2><span>朋友与账号</span><b>0</b>');
  assert.equal(courtText('伤害 / 补给 / 胜率'),'伤害 / 补给 / 胜率');
  assert.equal(courtText('最多使用单位 / 伤害最高单位 / 击杀最多单位'),'最多使用单位 / 伤害最高单位 / 击杀最多单位');
  setCourtMode(false);
  assert.equal(courtHtml`<h2>朋友表现</h2>`,'<h2>被告表现</h2>');
});
