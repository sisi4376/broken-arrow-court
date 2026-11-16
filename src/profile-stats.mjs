const DAY=86400000;
// Four stable groups spread calibration requests across 7, 8, 9 and 10 days.
export const profileCalibrationDays = playerId => 7+Number(BigInt(playerId)%4n);
export function profileCalibration(store,playerId,at=Date.now()) {
  const row=store.get('SELECT data_json,updated_at FROM profiles WHERE player_id=?',String(playerId));
  const saved=Date.parse(row?.updated_at??''),data=row?JSON.parse(row.data_json):null;
  const source=Date.parse(String(data?.statInfo?.updatedAt??'').replace(/^\$D/,''));
  // Importing an old snapshot today must not pretend it was calibrated today.
  const last=Number.isFinite(source)?Math.min(source,saved):saved;
  const days=profileCalibrationDays(playerId),next=Number.isFinite(last)?last+days*DAY:null;
  return {days,last_at:Number.isFinite(last)?new Date(last).toISOString():null,next_at:next===null?null:new Date(next).toISOString(),due:next===null||at>=next};
}

// Preserve the upstream baseline. Rebuild a local projection from unique match
// IDs on every read, so repeated imports and later detail repairs cannot add twice.
export function localProfile(store,account) {
  const row=store.get('SELECT * FROM profiles WHERE player_id=?',account.player_id);
  const data=row?JSON.parse(row.data_json):{info:{id:Number(account.player_id),name:account.name},statInfo:{}};
  data.info??={id:Number(account.player_id),name:account.name};data.statInfo??={};
  const stat=data.statInfo,covered=new Set((data.last_fights_data??[]).map(String));
  const sourceTime=Date.parse(String(stat.updatedAt??'').replace(/^\$D/,''));
  const cutoff=row?(Number.isFinite(sourceTime)?sourceTime:Date.parse(row.updated_at))/1000:-Infinity;
  const matches=store.all(`SELECT m.id,m.end_time,m.duration,m.mode,m.map_id,m.detail_state,m.updated_at,p.name,p.team_id,p.won,p.new_rating,p.raw_json
    FROM matches m JOIN participants p ON p.match_id=m.id WHERE p.player_id=? AND (p.team_id IS NULL OR p.team_id!=100) ORDER BY m.end_time,m.id`,account.player_id)
    .filter(m=>!covered.has(m.id)&&(row?m.end_time!==null&&m.end_time>cutoff:true));
  const fields=new Set();let missingDetail=0,unknownMode=0;
  function add(key,value){if(!Number.isFinite(value))return;stat[key]=(Number(stat[key])||0)+value;fields.add(key);}
  // Local archive modes 0/1 correspond to upstream Rt/Ct, verified against
  // consecutive saved profile snapshots and their newly added match IDs.
  const suffixes={'0':'Rt','1':'Ct','3':'Sk'};
  const detailFields={supplyPtsConsumed:'SupplyPointsConsumed',supplyPtsConsumedByAllies:'SupplyPointsConsumedByAllies',supplyPtsConsumedFromAllies:'SupplyPointsConsumedFromAllies',supplyCapturedCount:'SupplyCaptured',supplyCapturedByEnemyCount:'SupplyCapturedByEnemy',unitsKilledFriendlyFireCount:'DestructionFriendlyFire',unitsLostFriendlyFireCount:'LossesByFriendlyFire'};
  for(const m of matches){
    const p=JSON.parse(m.raw_json),suffix=suffixes[m.mode];
    if(!suffix){unknownMode++;continue;}
    add('fightsCount'+suffix,1);add('matchDurationTimeSec'+suffix,m.duration);
    add('zoneCapturedCount',Number(p.ObjectivesCaptured??0));
    stat.mapPlayCounts??={};stat.mapPlayCounts[m.map_id]=(Number(stat.mapPlayCounts[m.map_id])||0)+1;fields.add('mapPlayCounts');
    if(m.name)data.info.name=m.name;
    if(suffix==='Rt'&&Number.isFinite(m.new_rating)){data.info.rating=m.new_rating;fields.add('info.rating');}
    if(m.detail_state!=='complete'){missingDetail++;continue;}
    if(p.Deserter)add('leaveCount'+suffix,1);
    else if(m.won!==null)add((m.won?'winCount':'lossCount')+suffix,1);
    add('unitsKilledCount'+suffix,Number(p.Destruction??0));add('unitsLostCount'+suffix,Number(p.Losses??0));
    add('unitsKilledCost'+suffix,Number(p.DestructionScore??0));add('unitsLostCost'+suffix,Number(p.LossesScore??0));
    for(const [target,source] of Object.entries(detailFields))add(target,Number(p[source]??0));
  }
  const calibration=profileCalibration(store,account.player_id);
  return {account,data,metadata:row?JSON.parse(row.metadata_json):{},updated_at:row?.updated_at??null,calibration,
    local_update:{matches:matches.length,missing_details:missingDetail,unknown_modes:unknownMode,baseline_available:!!row,updated_fields:[...fields],
      updated_at:matches.length?matches.reduce((latest,m)=>m.updated_at>latest?m.updated_at:latest,''):row?.updated_at??null,
      note:'本地推算以最后校准为基准，只累加其后已归档对局；未归档对局和缺失详情由后续校准纠正。时长按战报总时长推算，可能与站方生涯口径不同。等级、排名、专精经验等不可推算字段保留上次校准值。'}};
}
