import {SourceClient,SourceError} from './source.mjs';
import {numericId,parseSearchQuery} from './domain.mjs';
import {BUILD_POLICY} from './distribution.mjs';
export const sourceProviders=(policy=BUILD_POLICY)=>({official:{label:'官方上游（直连）',base:'https://api.brokenarrowgame.tech',reports:'https://s3.brokenarrowgame.tech'},batrace:{label:policy.fixed?'BATrace（暂时冻结）':'BATrace',base:'https://dash.batrace.top',disabled:policy.fixed}});
export const SOURCE_PROVIDERS=Object.freeze(sourceProviders());
export function sourceProvider(store){const value=store.settings().source_provider??'official',providers=sourceProviders(store.policy);if(!Object.hasOwn(providers,value))throw Error('未知数据源设置');return providers[value].disabled?'official':value;}
export function createSource(store,options={}){return !options.base&&sourceProvider(options.monitorStore??store)==='official'?new OfficialSource(store,options):new SourceClient(store,options);}
export class OfficialSource extends SourceClient{
  constructor(store,options={}){
    const transport={lastRequest:0,queue:Promise.resolve()};super(store,{...options,base:SOURCE_PROVIDERS.official.base,transport});
    this.provider='official';this.supportsCatalogues=false;this.reports=new SourceClient(store,{...options,base:SOURCE_PROVIDERS.official.reports,transport});this.idsCache=new Map();this.reportCache=new Map();
    this.blockedUntil=Math.max(this.blockedUntil,this.reports.blockedUntil);
  }
  async read(resource,options={}){
    if(!/^\/(user(?:[/?]|$)|statistic\/personal\/)/.test(resource))throw new SourceError('官方源未提供此目录接口，请使用已有本地目录');
    this.blockedUntil=Math.max(this.blockedUntil,this.reports?.blockedUntil??0);
    try{return await super.read(resource,options);}finally{if(this.reports)this.reports.blockedUntil=Math.max(this.reports.blockedUntil,this.blockedUntil);}
  }
  async ids(id,{force=false}={}){
    id=numericId(id);const cache=this.idsCache.get(id);if(!force&&cache&&cache.expires>Date.now())return cache.ids;
    const data=await this.read(`/user/${id}/last_fights`);
    if(!Array.isArray(data)||!data.every(x=>/^[1-9]\d{0,19}$/.test(String(x)))||new Set(data.map(String)).size!==data.length)throw new SourceError('官方近期对局索引格式变化');
    const ids=data.map(String).sort((a,b)=>BigInt(a)>BigInt(b)?-1:BigInt(a)<BigInt(b)?1:0);this.idsCache.set(id,{ids,expires:Date.now()+120000});return ids;
  }
  async report(id,options={}){
    id=numericId(id,'对局 ID');const local=this.store.get('SELECT raw_json,detail_json,mode FROM matches WHERE id=?',id);
    if(local?.detail_json)return JSON.parse(local.detail_json);
    if(this.reportCache.has(id))return structuredClone(await this.reportCache.get(id));
    const operation=(async()=>{
      this.reports.blockedUntil=Math.max(this.blockedUntil,this.reports.blockedUntil);this.reports.onRequest=(...args)=>this.onRequest?.(...args);
      try{
        const raw=await this.reports.read(`/fights/fight_${id}.json`,options);
        if(!raw?.Data||typeof raw.Data!=='object'||!Number.isFinite(raw.EndTime))throw new SourceError('官方战报缺少比赛与玩家数据');
        // Official protobuf JSON omits the default Type=0 (normal mode).
        // Non-zero values remain explicit, including Type=1 custom games.
        const mode=raw.Type??0;
        return {data:{...raw,Type:mode},metadata:{source:'official',mode_unknown:mode===-1,mode_defaulted:raw.Type==null}};
      }finally{this.blockedUntil=Math.max(this.blockedUntil,this.reports.blockedUntil);}
    })();
    this.reportCache.set(id,operation);try{const value=structuredClone(await operation);if(this.reportCache.size>128)this.reportCache.delete(this.reportCache.keys().next().value);return value;}catch(error){this.reportCache.delete(id);throw error;}
  }
  async matches(id,offset=0,{force=false}={}){
    const ids=await this.ids(id,{force}),matches=[];
    for(const matchId of ids.slice(offset,offset+10)){
      const local=this.store.get('SELECT raw_json FROM matches WHERE id=?',matchId);
      if(local){matches.push({matchId,data:JSON.parse(local.raw_json)});continue;}
      try{const detail=await this.report(matchId);matches.push({matchId,data:detail.data});}
      catch(error){if(error.status!==404)throw error;}
    }return {totalCount:ids.length,matches};
  }
  async detail(id,options={}){return this.report(id,options);}
  async search(input){
    const query=parseSearchQuery(input);if(!/^\d{1,20}$/.test(query))throw new SourceError('官方源请使用游戏数字 ID 或 Steam64；昵称搜索暂不可用');
    const raw=await this.read(`/user/${numericId(query)}${query.length>10?'?steam=true':''}`);
    if(!raw?.id)throw new SourceError('官方玩家资料格式变化');return {players:[{id:raw.id,name:raw.name,steam_id:raw.steamId,rating:raw.rt??raw.rating}]};
  }
  async profile(id){
    id=numericId(id);const user=await this.read(`/user/${id}`);if(String(user?.id)!==id||!user.marketId)throw new SourceError('官方玩家资料缺少用户或统计标识');
    const stats=await this.read(`/statistic/personal/${encodeURIComponent(user.marketId)}`),ids=await this.ids(id);
    if(!stats?.statisticByLobbyType)throw new SourceError('官方生涯统计格式变化');
    const statInfo={updatedAt:stats.updateDate};
    for(const [lobby,suffix]of [['Rating','Rt'],['Custom','Ct'],['Skirmish','Sk']])for(const [src,dst]of Object.entries({fightsCount:'fightsCount',winsCount:'winCount',losesCount:'lossCount',killsCount:'unitsKilledCount',deathsCount:'unitsLostCount',totalMatchTimeSec:'matchDurationTimeSec'})){
      const value=stats.statisticByLobbyType[lobby]?.[src];if(Number.isFinite(value))statInfo[dst+suffix]=value;
    }
    for(const [src,dst]of Object.entries({capturedZonesCount:'zoneCapturedCount',supplyPointsConsumed:'supplyPtsConsumed',supplyCapturedCount:'supplyCapturedCount',supplyCapturedByEnemyCount:'supplyCapturedByEnemyCount'}))if(Number.isFinite(stats[src]))statInfo[dst]=stats[src];
    return {playerData:{info:{...user,rating:user.rt??user.rating,level:user.lvl??user.level,rank:user.rk??user.rank},statInfo,last_fights_data:ids},matchMap:{},metadata:{source:'official',raw_statistics:stats}};
  }
  async units(){return [];}
}
