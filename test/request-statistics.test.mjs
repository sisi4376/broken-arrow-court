import test from 'node:test';import assert from 'node:assert/strict';
import {mkdir,writeFile,symlink} from 'node:fs/promises';import path from 'node:path';
import {testStore,tempDir,rawMatch} from './helpers.mjs';
import {requestStatistics,importHistoryEvidence,BATRACE,OFFICIAL} from '../src/request-statistics.mjs';
import {reserveRequest,finishRequest} from '../src/request-monitor.mjs';
import {localStorage} from '../src/local-storage.mjs';
test('new matches use first archive day in UTC+8, survive re-fetch and sum across pages and groups',t=>{
  const s=testStore(t),at=Date.parse('2026-10-28T12:00:00+08:00');
  s.ingest('901',rawMatch());s.ingest('902',rawMatch());s.ingest('903',rawMatch());
  s.run("UPDATE matches SET imported_at='2026-09-30T15:59:59Z' WHERE id='901'");
  s.run("UPDATE matches SET imported_at='2026-09-30T16:00:00Z' WHERE id='902'");
  s.run("UPDATE matches SET imported_at='2026-10-01T00:00:00Z' WHERE id='903'");
  s.ingest('901',rawMatch(undefined,{Type:3}));
  const result=requestStatistics(s,{at});assert.equal(result.page_size,15);assert.equal(result.rows.length,15);assert.equal(result.summary.new_matches,3);
  const last=requestStatistics(s,{at,page:2});assert.equal(last.rows.length,14);assert.equal(last.rows.find(r=>r.date==='2026-10-01').new_matches,2);assert.equal(last.rows.find(r=>r.date==='2026-09-30').new_matches,1);
  const monthly=requestStatistics(s,{at,group:'month',provider:'official'});assert.equal(monthly.rows[0].new_matches,2);assert.equal(monthly.rows[1].new_matches,1);
  assert.equal(requestStatistics(s,{at,group:'year'}).summary.new_matches,3);
});
test('all-time history deduplicates round counters and granular requests, separates evidence, groups and paginates',t=>{
  const s=testStore(t),at=Date.parse('2026-10-27T12:00:00+08:00');
  s.run("INSERT INTO sync_runs(id,kind,started_at,requests,imported,changed) VALUES(1,'incremental','2026-09-30T15:59:00Z',10,2,1)");
  s.setting('request_history_cutoff_run_id',1);
  const r=reserveRequest(s,BATRACE,'/old',1,Date.parse('2026-09-30T23:59:00+08:00'));s.run('UPDATE source_requests SET run_id=1 WHERE id=?',r.id);finishRequest(s,r.id,{status:200,bytes:100});
  const other=reserveRequest(s,OFFICIAL[1],'/report',1,at);finishRequest(s,other.id,{status:200,bytes:200});
  const report={metrics:{recorded_sync_attempts:10},daily:[{day:'2026-09-30',recorded_sync_attempts:10,outside_sync_snapshot_supplement:3}]};
  assert.equal(importHistoryEvidence(s,report).added,1);assert.equal(importHistoryEvidence(s,report).added,0);
  let result=requestStatistics(s,{at});assert.equal(result.summary.requests,14);assert.equal(result.summary.legacy_requests,9);assert.equal(result.summary.recorded_requests,2);assert.equal(result.summary.unknown_bytes_requests,12);assert.equal(result.summary.bytes,300);
  result=requestStatistics(s,{at,from:'2026-09-01',group:'month',page_size:1});assert.equal(result.total_pages,2);assert.equal(result.rows[0].date,'2026-10');assert.equal(result.summary.requests,14);
  result=requestStatistics(s,{at,provider:'official'});assert.equal(result.summary.requests,1);assert.equal(result.summary.bytes,200);
  assert.equal(requestStatistics(s,{at,from:'2026-10-01',to:'2026-10-26'}).summary.requests,0);
  for(const query of [{from:'2026-02-30'},{from:'2026-11-01',to:'2026-10-01'},{group:'sql'},{page:0},{provider:'unknown'}])assert.throws(()=>requestStatistics(s,{...query,at}));
});
test('local storage counts file sizes, database journals and backups without following links',async t=>{
  const root=tempDir(t);await mkdir(path.join(root,'data/backups'),{recursive:true});await mkdir(path.join(root,'site'));await mkdir(path.join(root,'.cache'));
  await writeFile(path.join(root,'data/court.sqlite'),'1234');await writeFile(path.join(root,'data/court.sqlite-wal'),'12');await writeFile(path.join(root,'data/backups/a.sqlite'),'12345');await writeFile(path.join(root,'site/index.html'),'abc');await writeFile(path.join(root,'.cache/file'),'xy');
  const result=await localStorage(root);assert.equal(result.database_bytes,6);assert.equal(result.backup_bytes,5);assert.equal(result.data_bytes,11);assert.equal(result.project_bytes,16);assert.equal(result.site_bytes,3);
});
