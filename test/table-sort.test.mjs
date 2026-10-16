import test from 'node:test';
import assert from 'node:assert/strict';
import {compareValues,scoreRatio,sortableTable} from '../public/table-sort.js';

test('numeric sorting uses underlying values, including negatives, decimals and zero',()=>{
  const rows=[9,100,0,-20,12.05,12.01];
  assert.deepEqual([...rows].sort((a,b)=>compareValues(a,b)),[100,12.05,12.01,9,0,-20]);
  assert.deepEqual([...rows].sort((a,b)=>compareValues(a,b,{direction:'asc'})),[-20,0,9,12.01,12.05,100]);
});
test('unknown values stay last in both directions and infinite exchange ratios remain valid',()=>{
  for(const direction of ['asc','desc']){
    const rows=[null,0,Infinity,-2,undefined,NaN,''];
    const sorted=rows.map((value,index)=>({value,index})).sort((a,b)=>compareValues(a.value,b.value,{direction})||a.index-b.index);
    assert.deepEqual(sorted.slice(0,3).map(r=>r.value),direction==='asc'?[-2,0,Infinity]:[Infinity,0,-2]);
    assert.deepEqual(sorted.slice(3).map(r=>r.index),[0,4,5,6]);
  }
  assert.equal(scoreRatio(10,0),Infinity);assert.equal(scoreRatio(0,0),null);assert.equal(scoreRatio(null,5),null);assert.equal(scoreRatio(0,5),0);
});
test('win rate sorting compares unrounded ratios and preserves ties in original order',()=>{
  const rows=[{name:'A',wins:5001,games:10000},{name:'B',wins:1,games:2},{name:'C',wins:2,games:4}];
  assert.deepEqual([...rows].sort((a,b)=>compareValues(a.wins/a.games,b.wins/b.games)).map(r=>r.name),['A','B','C']);
});
test('name sorting uses natural text ordering and does not treat numeric labels as scores',()=>{
  assert(compareValues('朋友 2','朋友 10',{type:'text',direction:'asc'})<0);
  assert.equal(compareValues('同名','同名',{type:'text'}),0);
});
test('sortable headers and raw row values are escaped without changing displayed scores',()=>{
  const rows=[{name:'A " <img>',score:Infinity},{name:'B',score:0}];
  const html=sortableTable('test-table','<div><table><thead><tr><th>朋友</th><th class="numeric">分数</th></tr></thead><tbody><tr><td>A</td><td>∞</td></tr><tr><td>B</td><td>0</td></tr></tbody></table></div>',rows,[{index:0,key:'name',label:'朋友',type:'text',value:r=>r.name},{index:1,key:'score',label:'分数',value:r=>r.score}]);
  assert(html.includes('aria-sort="none"'));assert(html.includes('data-table-sort="score"'));
  assert(html.includes('&lt;img&gt;'));assert(!html.includes('<img>'));assert(html.includes('&quot;Infinity&quot;'));
  assert(html.includes('<td>∞</td>'));assert(html.includes('data-sort-index="1"'));
});
