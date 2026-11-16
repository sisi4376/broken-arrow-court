import { courtEvidence } from './court-review.mjs';
import { STACKED_CORRECTIONS, stackedEvidence } from './court-model.mjs';
import { expandedZhanfanAnalysis, ZHANFAN_EXPANDED_MODEL, sentenceMonths, sentenceDetails } from './zhanfan.mjs';

const bounded=n=>Math.max(0,Math.min(100,n));
const round=n=>Math.round(n*10)/10;
const required=['destruction','losses','damage','objectives','friendly_fire','consumed','received','supplied'];
const valid=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=Number.MAX_SAFE_INTEGER;

export const STACKED_TRIAL_MODEL={
  version:'stacked-20-trial-v2',title:'叠加20分试算',prior_games:10,correction_cap:20,
  sentencing:ZHANFAN_EXPANDED_MODEL.sentencing,
  components:STACKED_CORRECTIONS,
};

export function stackedGameEvidence(g,team){
  return stackedEvidence(g,team,ZHANFAN_EXPANDED_MODEL);
}

export function stackedTrial(store,params=new URLSearchParams()){
  const current=expandedZhanfanAnalysis(store,params),{all}=courtEvidence(store,params),byMatch=new Map();
  for(const g of all){
    g.unit_evidence={heavy:{known:g.heavy_kills!==null,kills:g.heavy_kills??0},air:{known:g.air_kills!==null,kills:g.air_kills??0}};
    if(!byMatch.has(g.match_id))byMatch.set(g.match_id,[]);byMatch.get(g.match_id).push(g);
  }
  const members=current.members.map(formal=>{
    const games=[];
    for(const g of all){
      if(g.member_id!==formal.member_id||g.team_id===null||!Number.isFinite(g.duration)||g.duration<=0||!required.every(k=>valid(g.values[k])))continue;
      const team=byMatch.get(g.match_id).filter(p=>p.team_id===g.team_id&&required.every(k=>valid(p.values[k])));
      if(team.length<2)continue;
      const e=stackedGameEvidence(g,team);if(e)games.push({match_id:g.match_id,map:g.map_name,end_time:g.end_time,won:g.won,...e});
    }
    const n=games.length,reliability=n/(n+10),known=games.filter(g=>g.won!==null),wins=known.filter(g=>g.won).length;
    const core=n?50+(games.reduce((sum,g)=>sum+g.core,0)/n-50)*reliability:null;
    const components=STACKED_TRIAL_MODEL.components.map(d=>{
      if(d.key==='victory')return {...d,samples:known.length,unavailable:n-known.length,
        points:n?40*((known.length-wins+5)/(known.length+10)-.5):null,mean:null};
      const available=games.filter(g=>g.corrections[d.key]!==null),k=available.length;
      const mean=k?available.reduce((sum,g)=>sum+g.corrections[d.key],0)/k:null;
      return {...d,samples:k,unavailable:n-k,mean,points:n?(mean??0)*k/(k+10):null};
    });
    const before=n?core+components.reduce((sum,c)=>sum+c.points,0):null;
    const score=n?round(bounded(before)):null,months=sentenceMonths(score,STACKED_TRIAL_MODEL.sentencing);
    const examples=[...new Map([
      ...[...games].sort((a,b)=>b.before_outcome-a.before_outcome||a.match_id.localeCompare(b.match_id)).slice(0,3),
      ...[...games].filter(g=>g.relief>0).sort((a,b)=>b.relief-a.relief||a.match_id.localeCompare(b.match_id)).slice(0,2),
    ].map(g=>[g.match_id,g])).values()];
    const trial={score,sentence_months:months,...sentenceDetails(months),scored_matches:n,outcome_matches:known.length,wins,
      losses:known.length-wins,reliability,core,before_clamp:before,components,examples,eligible:n>=current.min_games,
      status:!n?'待取证':n<current.min_games?'样本不足':n<20?'初步试算':'实验结果',rank:null};
    return {member_id:formal.member_id,name:formal.name,formal,trial,
      delta_score:score===null||formal.score===null?null:round(score-formal.score),
      delta_months:months===null||formal.sentence_months===null?null:months-formal.sentence_months,
      same_samples:n===formal.scored_matches};
  });
  const ranking=members.filter(r=>r.trial.eligible).sort((a,b)=>b.trial.score-a.trial.score||b.trial.scored_matches-a.trial.scored_matches||a.member_id-b.member_id);
  let previous=null,rank=0;for(const [i,r]of ranking.entries()){if(r.trial.score!==previous)rank=i+1;r.trial.rank=rank;previous=r.trial.score;}
  return {kind:'stacked-court-trial',experimental:true,public:false,adopted_by:'zhanfan-v10-stacked',model:STACKED_TRIAL_MODEL,formal_model:current.model,
    min_games:current.min_games,members,summary:{members:members.length,ranked:ranking.length,
      changed:members.filter(r=>r.delta_score!==null&&r.delta_score!==0).length,sample_mismatches:members.filter(r=>!r.same_samples).length},
    limitations:[
      '保留战斗60%和价值交换40%的原始核心，但移除原三者取最大值的贡献减免，改为独立修正，避免旧信用再算一次。',
      '占点、重防、纯空优、净供给各可独立减0～20；净蹭补给、友伤、单位损耗各可独立加0～20；共同胜负改为−20～+20。',
      '净蹭补给保留35%互助额度，但不再乘战斗不足系数，也不被占点、重防或空优减免提前抵消；仅在最后合计时与其他修正相抵。高净依赖也可能是约定的集中保障，不证明搭便车。',
      '各项先按逐局程度计算，再独立按有效局数向0作10局先验收缩，核心向50收缩；最后合计截到0～100。',
      '单位损耗项与价值交换仍有关联，仅作为重叠不足条件下的实验附加项；不把低单位K/D单独判罪。',
      '未记录控制时长、视野、补给战术用途和牺牲意图；运输奖励不证明战术贡献，允许叠加也可能高估多项相关战果。',
      '此页保留旧v9与叠加v2的历史对照；正式v10已采用叠加v2规则。查看或导出此页不会写入数据，也不会触发发布；规则未经人工回放验证。',
    ]};
}
