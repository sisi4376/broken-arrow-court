import {readFileSync} from 'node:fs';

export const RELEASE_POLICY=Object.freeze({edition:'release',fixed:true,request_delay_ms:2000,request_limits:Object.freeze({minute:40,hour:100,day:1000}),sync_cooldown_ms:30*60000,random_windows:Object.freeze([Object.freeze([2,3]),Object.freeze([14,15])])});
export const LOCAL_POLICY=Object.freeze({edition:'local',fixed:false,sync_cooldown_ms:0});
// A checkout/package without an edition marker is always the public release.
// The private workstation marker is ignored by Git; builds generate their own.
let edition='release';
try{const marker=JSON.parse(readFileSync(new URL('../.distribution.json',import.meta.url),'utf8'));if(marker.edition==='local')edition='local';}
catch(error){if(error.code!=='ENOENT')throw error;}
export const BUILD_POLICY=edition==='local'?LOCAL_POLICY:RELEASE_POLICY;
export const effectiveSettings=(settings,policy=BUILD_POLICY)=>policy.fixed?{...settings,request_delay_ms:policy.request_delay_ms,...Object.fromEntries(Object.entries(policy.request_limits).map(([key,value])=>['request_limit_'+key,value]))}:settings;
