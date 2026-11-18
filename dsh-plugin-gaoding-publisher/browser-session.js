/**
 * 登录态：不收集账号密码，直接使用 ego-browser 里已登录的稿定会话。
 * probe 只读检查；openLogin 打开创作者中心让用户自行完成扫码/短信/密码登录。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const creatorCenter = 'https://creator.huaban.com/inspiration';
const marker = 'GAODING_SESSION:';

export function egoBinary(executable) {
  if (executable) return executable;
  if (process.env.EGO_BROWSER_BIN) return process.env.EGO_BROWSER_BIN;
  const local = join(homedir(), '.local/bin/ego-browser');
  return existsSync(local) ? local : 'ego-browser';
}

function spaceExpression(space) {
  return Number.isInteger(space)
    ? String(space)
    : JSON.stringify('稿定投稿-' + randomUUID());
}

function pagePreamble(space) {
  return `const task=await taskSpace(${spaceExpression(space)});
const pages=await task.pages();
const blank=pages.length===1&&(await task.page(pages[0].label).url())==='about:blank';
const p=blank?task.page(pages[0].label):await task.newPage();`;
}

function evaluateSource() {
  return `async()=>{
 let parsed=null;
 try{parsed=JSON.parse(localStorage.getItem('token')||'null')}catch(e){}
 const token=parsed&&parsed.access_token?parsed.access_token:null;
 const expiresAt=parsed&&parsed.access_token_expires_at?parsed.access_token_expires_at:null;
 const expired=expiresAt?Date.parse(expiresAt)<=Date.now():false;
 let status=0;
 try{
  const headers={accept:'application/json'};
  if(token)headers.authorization='Bearer '+token;
  const r=await fetch('/api/create/creator-center/inspiration/topics',{headers});
  status=r.status;
 }catch(e){status=-1;}
 return {token:!!token,expired,status,userId:parsed?parsed.user_id:null,huabanId:parsed?parsed.huaban_id:null,url:location.href,title:document.title};
}`;
}

function runNode(script, { executable, spawnProcess = spawn, timeout = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(egoBinary(executable), ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(Error('浏览器检查超时')); }, timeout);
    const finish = (error, value) => { clearTimeout(timer); error ? reject(error) : resolve(value); };
    child.on('error', error => finish(error));
    child.stdout.on('data', data => { stdout += data; if (stdout.length > 2e6) child.kill(); });
    child.stderr.on('data', data => { stderr += data; if (stderr.length > 2e6) child.kill(); });
    child.on('close', code => {
      if (code !== 0) return finish(Error('浏览器检查失败：' + (stderr.trim().slice(-400) || 'exit ' + code)));
      const line = (stdout + '\n' + stderr).split('\n').find(row => row.startsWith(marker));
      if (!line) return finish(Error('浏览器没有返回登录状态'));
      try { finish(null, JSON.parse(line.slice(marker.length))); } catch (error) { finish(error); }
    });
    child.stdin.end(script);
  });
}

/** 只读探测：当前浏览器里稿定创作者中心是否已登录。 */
export async function probeSession(options = {}) {
  const script = pagePreamble(options.space) + `
try{
 await p.goto(${JSON.stringify(creatorCenter)},{waitUntil:'domcontentloaded'});
 await p.waitForTimeout(3000);
 const out=await p.evaluate(${evaluateSource()});
 console.log(${JSON.stringify(marker)}+JSON.stringify({space:task.spaceId,...out}));
}finally{if(!blank)await p.close();}
`;
  const value = await runNode(script, options);
  const loggedIn = value.status === 200 && value.token === true && value.expired !== true;
  const accountId = value.huabanId ?? value.userId ?? null;
  return {
    space: value.space,
    loggedIn,
    account: accountId === null ? null : { id: String(accountId) },
    apiStatus: value.status,
    tokenExpired: value.expired === true,
    url: value.url,
    title: value.title,
    checkedAt: new Date().toISOString(),
    hint: loggedIn ? '已登录' : value.expired ? '登录已过期，请重新登录' : value.token ? '登录态不可用，请重新登录' : '未登录，请在浏览器中登录'
  };
}

/** 打开创作者中心页并保留，等用户自己完成登录。 */
export async function openLogin(options = {}) {
  const script = pagePreamble(options.space) + `
try{
 await p.goto(${JSON.stringify(creatorCenter)},{waitUntil:'domcontentloaded'});
 await p.waitForTimeout(1500);
 const out=await p.evaluate(${evaluateSource()});
 console.log(${JSON.stringify(marker)}+JSON.stringify({space:task.spaceId,page:p.label,...out}));
}catch(error){
 if(!blank)await p.close();
 throw error;
}
`;
  const value = await runNode(script, options);
  return {
    space: value.space,
    page: value.page,
    url: value.url,
    loggedIn: value.status === 200 && value.token === true && value.expired !== true,
    instruction: '请在弹出的浏览器窗口中完成稿定登录（扫码、短信或账号密码均可），完成后回到这里点『我已完成登录』。'
  };
}
