import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { githubRepository } from './github-deploy.mjs';

export function deploymentCommand(command, args) {
  return new Promise((resolve, reject) => {
    const proxy = process.env.CLOUD_BACKUP_PROXY;
    const child = spawn(command, args, { windowsHide:true, shell:false, env:{...process.env, GH_PROMPT_DISABLED:'1', ...(proxy?{HTTPS_PROXY:proxy,HTTP_PROXY:proxy}:{})} });
    let output=''; child.stdout.on('data', b=>{output+=b;}); child.stderr.resume();
    const timer=setTimeout(()=>child.kill(),20000);
    child.on('error',()=>{clearTimeout(timer);reject(Error('无法运行部署检查，请检查 GitHub CLI、curl 和登录状态'));});
    child.on('close',code=>{clearTimeout(timer);code===0?resolve(output.trim()):reject(Error('部署检查请求失败，请检查 GitHub 登录或网络；尚未确认网页上线'));});
  });
}

// Verify both the exact commit and the manifest actually served by Pages.
export async function verifyPagesDeployment({remote,directory,revision,commit,onProgress=()=>{},stopped=()=>false},
  {command=deploymentCommand,wait=sleep,clock=Date.now,timeoutMs=300000,pollMs=10000,rebuildAfterMs=60000}={}) {
  if(!/^(?:https:\/\/github\.com\/|git@github\.com:)/.test(remote))return {status:'uploaded'};
  const repository=githubRepository(remote);
  commit ||= await command('git',['-C',directory,'rev-parse','HEAD']);
  if(!/^[a-f0-9]{40,64}$/.test(commit))throw Error('无法确定本次网页提交，尚未确认部署');
  const api=async(endpoint,method)=>JSON.parse(await command('gh',['api',...(method?['--method',method]:[]),`repos/${repository}/${endpoint}`]));
  const config=await api('pages');
  const url=new URL(config.html_url);
  if(url.protocol!=='https:'||!url.hostname.endsWith('.github.io'))throw Error('Pages 返回了无法验证的公开地址');
  const manifestUrl=new URL('manifest.json',url.href.endsWith('/')?url.href:url.href+'/');
  const start=clock();let rebuilt=false,lastError='尚未取得部署结果';
  onProgress('deploying');
  while(clock()-start<timeoutMs&&!stopped()) {
    try {
      const build=await api('pages/builds/latest');
      if(build.commit===commit&&build.status==='built') {
        const args=['--fail','--silent','--show-error','--max-time','20'];
        if(process.env.CLOUD_BACKUP_PROXY)args.push('--proxy',process.env.CLOUD_BACKUP_PROXY);
        manifestUrl.searchParams.set('verify',String(clock()));args.push(manifestUrl.href);
        const live=JSON.parse(await command('curl.exe',args));
        if(live.revision===revision)return {status:'complete',commit,url:url.href,verified_at:new Date(clock()).toISOString()};
        lastError='Pages 构建成功，但公开网页仍返回旧版本';
      } else lastError=build.status==='errored'?'GitHub Pages 构建失败': 'GitHub Pages 构建尚未完成';
      if(!rebuilt&&config.build_type==='legacy'&&((build.commit===commit&&build.status==='errored')||clock()-start>=rebuildAfterMs)) {
        // One recovery attempt per verification, never a stream of empty commits.
        rebuilt=true;await api('pages/builds','POST');onProgress('rebuilding');
      }
    }catch(error){lastError=error.message;}
    await wait(pollMs);
  }
  throw Error(stopped()?'部署检查已中断，重启后继续确认':`网页已提交，但部署确认超时：${lastError}；请重试更新网页`);
}
