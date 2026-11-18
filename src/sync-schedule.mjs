import {createHash} from 'node:crypto';
import {BUILD_POLICY} from './distribution.mjs';
const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;
const OFFSET = 8 * 60 * MINUTE;
export const SYNC_SCHEDULE = Object.freeze({ timezone:'Asia/Shanghai',day_hours:Object.freeze([6,12,18]),fast_start_hour:20,fast_end_hour:1,fast_minutes:10 });
const slots = [
  ...Array.from({length:6},(_,i)=>i*10),
  ...SYNC_SCHEDULE.day_hours.map(hour=>hour*60),
  ...Array.from({length:24},(_,i)=>20*60+i*10),
];

export function syncSchedule(at=Date.now(),policy=BUILD_POLICY,seed='') {
  const day=Math.floor((at+OFFSET)/DAY)*DAY-OFFSET;
  if(policy.fixed){
    const date=new Date(day+OFFSET).toISOString().slice(0,10);
    const randomSlot=(start,index)=>start+policy.random_windows[index][0]*60*MINUTE+(createHash('sha256').update(seed+':'+new Date(start+OFFSET).toISOString().slice(0,10)+':'+index).digest().readUInt32BE(0)%3541)*1000;
    const today=policy.random_windows.map((_,i)=>randomSlot(day,i));
    const candidates=[...policy.random_windows.map((_,i)=>randomSlot(day-DAY,i)),...today,...policy.random_windows.map((_,i)=>randomSlot(day+DAY,i))];
    const slot=candidates.findLast(value=>value<=at),next=candidates.find(value=>value>at);
    return {timezone:'Asia/Shanghai',random:true,description:'每天 02:00–03:00、14:00–15:00 各随机一次',date,day_hours:[2,14],random_windows:policy.random_windows,current_minutes:null,slot_started_at:new Date(slot).toISOString(),next_slot_at:new Date(next).toISOString(),slot_expires_at:new Date(slot+60000).toISOString()};
  }
  const minute=(at-day)/MINUTE;
  const index=slots.findLastIndex(slot=>slot<=minute);
  const slot=day+slots[index]*MINUTE;
  const next=index+1<slots.length?day+slots[index+1]*MINUTE:day+DAY;
  const hour=new Date(at+OFFSET).getUTCHours();
  const fast=hour>=20||hour<1;
  // Daytime runs may start within the named minute. Never catch up a missed
  // daytime slot on an unrelated hour after a restart or a long-running task.
  const window=slots[index]<60||slots[index]>=20*60?10:1;
  return {...SYNC_SCHEDULE,current_minutes:fast?10:null,slot_started_at:new Date(slot).toISOString(),next_slot_at:new Date(next).toISOString(),slot_expires_at:new Date(slot+window*MINUTE).toISOString()};
}

export function syncIsDue(lastStarted,at=Date.now(),policy=BUILD_POLICY,seed='') {
  const last=Date.parse(lastStarted??'');
  const schedule=syncSchedule(at,policy,seed);
  return at<Date.parse(schedule.slot_expires_at)&&(!Number.isFinite(last)||last<Date.parse(schedule.slot_started_at));
}
