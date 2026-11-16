export const BATRACE='https://dash.batrace.top';
export const OFFICIAL=['https://api.brokenarrowgame.tech','https://s3.brokenarrowgame.tech'];
const DAY=86400000;
const date=at=>new Date(at+8*3600000).toISOString().slice(0,10);
function dayValue(value){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw Error('日期格式需为 YYYY-MM-DD');
  const at=Date.parse(value+'T00:00:00+08:00');if(!Number.isFinite(at)||date(at)!==value)throw Error('日期无效');return at;
}
function scope(provider){
  if(!provider||provider==='all')return()=>true;
  if(provider==='batrace')return base=>base===BATRACE;
  if(provider==='official')return base=>OFFICIAL.includes(base);
  if(/^https?:\/\//.test(provider))return base=>base===provider;
  throw Error('数据源筛选无效');
}
export function requestStatistics(store,{from,to,group='day',provider='all',page=1,page_size=15,at=Date.now()}={}){
  if(!['day','month','year'].includes(group))throw Error('统计分组需为 day、month 或 year');
  page=Number(page);page_size=Number(page_size);if(!Number.isInteger(page)||page<1||!Number.isInteger(page_size)||page_size<1||page_size>1000)throw Error('统计分页参数无效');
  const include=scope(provider),days=new Map();
  const add=(day,values)=>{if(!days.has(day))days.set(day,{date:day,requests:0,recorded_requests:0,legacy_requests:0,supplement_requests:0,bytes:0,errors:0,pending:0,runs:0,new_matches:0,imported:0,changed:0,unknown_bytes_requests:0});const row=days.get(day);for(const[key,n]of Object.entries(values))row[key]=(row[key]??0)+n;};
  for(const row of store.all(`SELECT base,date(started_at/1000,'unixepoch','+8 hours') day,COUNT(*) requests,SUM(bytes) bytes,SUM(outcome='error') errors,SUM(outcome='pending') pending FROM source_requests GROUP BY base,day`))if(include(row.base))add(row.day,{requests:row.requests,recorded_requests:row.requests,bytes:row.bytes??0,errors:row.errors??0,pending:row.pending??0});
  const cutoff=Number(store.get("SELECT value FROM settings WHERE key='request_history_cutoff_run_id'")?.value)||0;
  // Saved round counters already include retry attempts. Subtract any granular
  // records belonging to the same round before adding historical counters.
  if(include(BATRACE))for(const row of store.all(`SELECT r.*, (SELECT COUNT(*) FROM source_requests q WHERE q.run_id=r.id) recorded FROM sync_runs r WHERE r.id<=?`,cutoff)){
    const n=Math.max(0,row.requests-row.recorded);add(date(Date.parse(row.started_at)),{requests:n,legacy_requests:n,unknown_bytes_requests:n});
  }
  for(const row of store.all('SELECT base,day,SUM(requests) requests FROM request_history_evidence GROUP BY base,day'))if(include(row.base))add(row.day,{requests:row.requests,supplement_requests:row.requests,unknown_bytes_requests:row.requests});
  // Site-wide archive activity is independent of the selected upstream host.
  for(const row of store.all("SELECT date(started_at,'+8 hours') day,COUNT(*) runs,SUM(imported) imported,SUM(changed) changed FROM sync_runs GROUP BY day"))add(row.day,{runs:row.runs,imported:row.imported??0,changed:row.changed??0});
  // Count each archived match once, including interrupted rounds and manual imports.
  // Re-fetching a match changes updated_at but preserves imported_at.
  for(const row of store.all("SELECT date(imported_at,'+8 hours') day,COUNT(*) n FROM matches GROUP BY day"))if(row.day)add(row.day,{new_matches:row.n});
  const first=[...days.keys()].sort()[0]??date(at),last=date(at);
  const start=dayValue(from||first),end=dayValue(to||last);
  if(start>end||end-start>36600*DAY)throw Error('起止日期范围无效或超过 100 年');
  const grouped=new Map();
  for(let stamp=start;stamp<=end;stamp+=DAY){const day=date(stamp),key=group==='month'?day.slice(0,7):group==='year'?day.slice(0,4):day;
    if(!grouped.has(key))grouped.set(key,{date:key,requests:0,recorded_requests:0,legacy_requests:0,supplement_requests:0,bytes:0,errors:0,pending:0,runs:0,new_matches:0,imported:0,changed:0,unknown_bytes_requests:0});
    const value=days.get(day);if(value)for(const[k,n]of Object.entries(value))if(k!=='date')grouped.get(key)[k]+=n;
  }
  const rows=[...grouped.values()].sort((a,b)=>b.date.localeCompare(a.date)),summary={requests:0,recorded_requests:0,legacy_requests:0,supplement_requests:0,bytes:0,errors:0,pending:0,runs:0,new_matches:0,imported:0,changed:0,unknown_bytes_requests:0};
  for(const row of rows)for(const key of Object.keys(summary))summary[key]+=row[key];
  return {from:date(start),to:date(end),first_date:first,group,provider,page,page_size,total_rows:rows.length,total_pages:Math.max(1,Math.ceil(rows.length/page_size)),summary,rows:rows.slice((page-1)*page_size,page*page_size),notes:['历史同步按任务开始日期归属；跨日轮次不代表精确日分布。','补证为去重后的可核实下限；历史数据量未知。']};
}
export function importHistoryEvidence(store,report){
  if(!Array.isArray(report?.daily)||!Number.isSafeInteger(report.metrics?.recorded_sync_attempts)||report.daily.reduce((n,d)=>n+d.recorded_sync_attempts,0)!==report.metrics.recorded_sync_attempts)throw Error('历史审计报告格式或基线不匹配');
  return store.transaction(()=>{
    let added=0;for(const d of report.daily)for(const [field,kind]of [['outside_sync_snapshot_supplement','snapshot'],['interrupted_run_supplement','interrupted'],['verification_supplement','verification']]){
      dayValue(d.day);const count=Number(d[field]||0);if(!Number.isSafeInteger(count)||count<0)throw Error('历史证据计数无效');if(!count)continue;
      const key=`audit-20261027:${kind}:${d.day}`;
      const existing=store.get('SELECT requests FROM request_history_evidence WHERE evidence_key=?',key);
      if(existing){if(existing.requests!==count)throw Error('历史证据与已有记录冲突');continue;}
      added+=Number(store.run('INSERT INTO request_history_evidence VALUES(?,?,?,?,?,?,?)',key,BATRACE,d.day,count,kind,JSON.stringify({report:'request-audit-2026-10-27',field,counts_are_lower_bounds:true}),new Date().toISOString()).changes);
    }return {added,total:store.get('SELECT SUM(requests) n FROM request_history_evidence').n??0};
  });
}
