import { AsyncLocalStorage } from 'node:async_hooks';
import {requestStatistics} from './request-statistics.mjs';

const context = new AsyncLocalStorage();
export const withRequestContext = (value, fn) => context.run(value, fn);
export const requestContext = () => context.getStore() ?? {};
export const REQUEST_LIMITS = Object.freeze({ minute:20, hour:200, day:1000 });
const HOUR=3600000, DAY=24*HOUR;
export const sourceDayStart = at => Math.floor((at+8*HOUR)/DAY)*DAY-8*HOUR;
export const requestBases=base=>['https://api.brokenarrowgame.tech','https://s3.brokenarrowgame.tech'].includes(base)?['https://api.brokenarrowgame.tech','https://s3.brokenarrowgame.tech']:[base];
export function requestLimits(store) {
  const s=store.settings();
  return Object.fromEntries(Object.entries(REQUEST_LIMITS).map(([key,fallback])=>{
    const value=s[`request_limit_${key}`];
    return [key,Number.isSafeInteger(value)&&value>0?value:fallback];
  }));
}
function category(resource) {
  const p=new URL(resource,'https://local').pathname;
  if(p==='/api/players/matches'||p.endsWith('/last_fights'))return '近期与历史列表';
  if(p.startsWith('/player/')||p.startsWith('/user/')||p.startsWith('/statistic/personal/'))return '玩家档案';
  if(p.startsWith('/match/')||p.startsWith('/fights/'))return '比赛详情';
  if(p.includes('/search'))return '玩家搜索';
  return '单位与目录';
}

// Reserve durably before calling fetch. A crash leaves a pending attempt counted,
// rather than silently losing traffic from a round that never finished.
export function reserveRequest(store,base,resource,attempt,at=Date.now()) {
  const limits=requestLimits(store), scope=requestContext(),bases=requestBases(base),placeholders=bases.map(()=>'?').join(',');
  return store.transaction(()=>{
    const windows=[['minute',at-60000],['hour',at-HOUR],['day',sourceDayStart(at)]];
    let retryAt=0; const exceeded=[];
    for(const [key,since] of windows){
      const row=store.get(`SELECT COUNT(*) n,MIN(started_at) first FROM source_requests WHERE base IN (${placeholders}) AND started_at>=?`,...bases,since);
      if(row.n>=limits[key]){
        exceeded.push(key);
        retryAt=Math.max(retryAt,key==='day'?since+DAY:row.first+(key==='hour'?HOUR:60000)+1);
      }
    }
    if(retryAt){
      const reason=`本机请求额度已达上限（${exceeded.map(k=>({minute:'每分钟',hour:'每小时',day:'每日'})[k]).join('、')}），已阻止发送`;
      store.run('INSERT INTO source_request_blocks(base,resource,created_at,retry_at,reason) VALUES(?,?,?,?,?)',base,resource,at,retryAt,reason);
      return {blocked:true,retryAt,reason};
    }
    const id=Number(store.run("INSERT INTO source_requests(base,resource,category,run_id,trigger,attempt,started_at,outcome) VALUES(?,?,?,?,?,?,?,'pending')",base,resource,category(resource),scope.run_id??null,scope.trigger??'手动或独立脚本',attempt,at).lastInsertRowid);
    return {id,run_id:scope.run_id??null,started_at:at};
  });
}
export function finishRequest(store,id,{status=null,bytes=0,error=null}={}) {
  store.run('UPDATE source_requests SET finished_at=?,status=?,bytes=?,outcome=?,error=? WHERE id=?',Date.now(),status,bytes,error?'error':'complete',error,id);
}
export function dailyRequests(store,base,at=Date.now(),days=30) {
  const end=sourceDayStart(at),start=end-(days-1)*DAY,bases=requestBases(base),placeholders=bases.map(()=>'?').join(',');
  const rows=store.all(`SELECT CAST((started_at+?)/? AS INTEGER) day,COUNT(*) requests,
    COALESCE(SUM(bytes),0) bytes,COALESCE(SUM(outcome='error'),0) errors,COALESCE(SUM(outcome='pending'),0) pending
    FROM source_requests WHERE base IN (${placeholders}) AND started_at>=? AND started_at<? GROUP BY day`,8*HOUR,DAY,...bases,start,end+DAY);
  const byDay=new Map(rows.map(row=>[row.day,row]));
  return Array.from({length:days},(_,i)=>{
    const stamp=end-i*DAY,row=byDay.get(Math.floor((stamp+8*HOUR)/DAY));
    return {date:new Date(stamp+8*HOUR).toISOString().slice(0,10),requests:row?.requests??0,bytes:row?.bytes??0,errors:row?.errors??0,pending:row?.pending??0};
  });
}
export function requestPage(store,base,page=1,pageSize=15) {
  page=Number(page);pageSize=Number(pageSize);
  if(!Number.isSafeInteger(page)||page<1||!Number.isInteger(pageSize)||pageSize<1||pageSize>15)throw Error('请求记录分页参数无效');
  const bases=requestBases(base),where=`base IN (${bases.map(()=>'?').join(',')})`;
  const total=store.get(`SELECT COUNT(*) n FROM source_requests WHERE ${where}`,...bases).n;
  const pages=Math.max(1,Math.ceil(total/pageSize));page=Math.min(page,pages);
  const rows=store.all(`SELECT * FROM source_requests WHERE ${where} ORDER BY started_at DESC,id DESC LIMIT ? OFFSET ?`,...bases,pageSize,(page-1)*pageSize);
  return {rows,page,page_size:pageSize,total_rows:total,total_pages:pages};
}
export function requestMonitor(store,base,at=Date.now()) {
  const day=sourceDayStart(at),limits=requestLimits(store),bases=requestBases(base),placeholders=bases.map(()=>'?').join(',');
  const totals=store.get(`SELECT COUNT(*) total,COALESCE(SUM(started_at>=?),0) today,COALESCE(SUM(started_at>=?),0) hour,COALESCE(SUM(started_at>=?),0) minute,
    COALESCE(SUM(started_at>=? AND outcome='error'),0) errors_today,COALESCE(SUM(started_at>=? AND status IN (403,429)),0) refusals_today,COALESCE(SUM(started_at>=? AND attempt>1),0) retries_today,
    COALESCE(SUM(started_at>=? AND outcome='pending'),0) pending_today,COALESCE(SUM(CASE WHEN started_at>=? THEN bytes ELSE 0 END),0) bytes_today,COALESCE(SUM(bytes),0) bytes_total,MIN(started_at) monitored_since
    FROM source_requests WHERE base IN (${placeholders})`,day,at-HOUR,at-60000,day,day,day,day,day,...bases);
  return {base,timezone:'Asia/Shanghai',day_started_at:day,limits,...totals,
    statistics:requestStatistics(store,{at}),
    details:requestPage(store,base),
    daily:dailyRequests(store,base,at),
    blocked_today:store.get(`SELECT COUNT(*) n FROM source_request_blocks WHERE base IN (${placeholders}) AND created_at>=?`,...bases,day).n,
    categories:store.all(`SELECT category,COUNT(*) requests FROM source_requests WHERE base IN (${placeholders}) AND started_at>=? GROUP BY category ORDER BY requests DESC`,...bases,day),
    repeated:store.all(`SELECT resource,COUNT(*) requests,MAX(started_at) last_at FROM source_requests WHERE base IN (${placeholders}) AND started_at>=? GROUP BY resource HAVING COUNT(*)>1 ORDER BY requests DESC LIMIT 10`,...bases,day),
    recent:store.all(`SELECT * FROM source_requests WHERE base IN (${placeholders}) ORDER BY started_at DESC,id DESC LIMIT 30`,...bases),
    latest_block:store.get(`SELECT * FROM source_request_blocks WHERE base IN (${placeholders}) ORDER BY id DESC LIMIT 1`,...bases)??null};
}
