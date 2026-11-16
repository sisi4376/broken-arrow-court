import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyPagesDeployment} from '../src/pages-deployment.mjs';

const commit='a'.repeat(40),revision='b'.repeat(64);
function fixture({builds=[{commit,status:'built'}],live=revision,fail=false}={}) {
  let time=1000,index=0;const calls=[];
  const command=async(cmd,args)=>{
    calls.push([cmd,args]);if(fail)throw Error('Network unavailable');
    if(cmd==='curl.exe')return JSON.stringify({revision:live});
    if(args.includes('POST'))return JSON.stringify({status:'queued'});
    if(args.at(-1).endsWith('/pages'))return JSON.stringify({build_type:'legacy',html_url:'https://example.github.io/court/'});
    return JSON.stringify(builds[Math.min(index++,builds.length-1)]);
  };
  return {calls,options:{command,clock:()=>time,wait:async ms=>{time+=ms;},timeoutMs:50,pollMs:10,rebuildAfterMs:20}};
}
const target={remote:'https://github.com/owner/court.git',directory:'unused',commit,revision};

test('deployment needs the exact built commit and the live manifest revision',async()=>{
  const f=fixture(),result=await verifyPagesDeployment(target,f.options);
  assert.equal(result.status,'complete');assert.equal(result.commit,commit);
  assert(f.calls.some(([cmd,args])=>cmd==='curl.exe'&&args.at(-1).includes('verify=')));
});
test('a failed build is rebuilt once and then verified without another push',async()=>{
  const f=fixture({builds:[{commit,status:'errored'},{commit,status:'building'},{commit,status:'built'}]});
  assert.equal((await verifyPagesDeployment(target,f.options)).status,'complete');
  assert.equal(f.calls.filter(([,args])=>args.includes('POST')).length,1);
});
test('a stuck build gets one bounded rebuild and a visible timeout',async()=>{
  const f=fixture({builds:[{commit,status:'building'}]});
  await assert.rejects(verifyPagesDeployment(target,f.options),/部署确认超时/);
  assert.equal(f.calls.filter(([,args])=>args.includes('POST')).length,1);
});
test('another commit or stale public content can never report success',async()=>{
  for(const options of [{builds:[{commit:'c'.repeat(40),status:'built'}]},{live:'d'.repeat(64)}]){
    const f=fixture(options);await assert.rejects(verifyPagesDeployment(target,f.options),/部署确认超时/);
  }
});
test('network errors and shutdown cannot turn into successful deployment',async()=>{
  const f=fixture({fail:true});await assert.rejects(verifyPagesDeployment(target,f.options),/Network unavailable/);
  const stopped=fixture();await assert.rejects(verifyPagesDeployment({...target,stopped:()=>true},stopped.options),/检查已中断/);
});
