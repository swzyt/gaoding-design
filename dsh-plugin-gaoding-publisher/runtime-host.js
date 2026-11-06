import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, closeSync, renameSync, statSync, rmSync, readSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
export const pluginRoot=dirname(fileURLToPath(import.meta.url));
export const workspace=resolve(process.env.GAODING_WORKSPACE || (existsSync(join(pluginRoot,'runtime/workflow.sh'))?join(pluginRoot,'runtime'):join(pluginRoot,'..')));
export const dataRoot=resolve(process.env.GAODING_DATA_DIR || join(homedir(),'.local/share/dsh-gaoding-publisher'));
export const runtimeHome=resolve(process.env.GAODING_RUNTIME_HOME || join(dataRoot,'dependencies'));
export const workflow=join(workspace,'workflow.sh');
export const environment={...process.env,GAODING_DATA_DIR:dataRoot,GAODING_RUNTIME_HOME:runtimeHome,NODE_PATH:join(runtimeHome,'workflow/node_modules')};
export function readJson(file,fallback=null){try{return JSON.parse(readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
export function writeJson(file,value){mkdirSync(dirname(file),{recursive:true});const tmp=file+'.'+randomUUID()+'.tmp';writeFileSync(tmp,JSON.stringify(value,null,2)+'\n');renameSync(tmp,file);}
function alive(pid){if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}}
export function status(directory){
 const root=resolve(directory);const processState=readJson(join(root,'.plugin-process.json'));
 const running=!!processState&&!processState.finishedAt&&(alive(processState.pid)||alive(processState.childPid));
 const run=readJson(join(root,'run.json'));const gate=run?.gate?readJson(join(run.gate,'request.json')):null;
 let log='';const file=join(root,'workflow.log');
 if(existsSync(file)){const fd=openSync(file,'r');try{const size=statSync(file).size;const bytes=Buffer.alloc(Math.min(size,12000));readFileTail(fd,bytes,Math.max(0,size-bytes.length));log=bytes.toString();}finally{closeSync(fd);}}
 return {directory:root,running,process:processState,run,gate,log};
}
function readFileTail(fd,bytes,start){readSync(fd,bytes,0,bytes.length,start);}
export function launch(argv){
 if(!Array.isArray(argv)||!argv.length||argv.some(x=>typeof x!=='string'))throw Error('args must be a nonempty string array');
 const isAuto=argv[0]==='auto';
 if(isAuto&&(!argv[1]||!isAbsolute(argv[1])))throw Error('auto requires an absolute run directory');
 // Every invocation runs outside the tool call, so the Agent can answer gates.
 const directory=isAuto?resolve(argv[1]):join(dataRoot,'operations',randomUUID());
 mkdirSync(directory,{recursive:true});const file=join(directory,'.plugin-process.json');
 const lock=join(directory,'.plugin-launch.lock');
 try{mkdirSync(lock);}catch(e){if(e.code==='EEXIST')throw Error('Concurrent or interrupted launch; inspect '+lock);throw e;}
 try{
 const previous=readJson(file);
 if(previous&&!previous.finishedAt){
  const current=status(directory);
  if(current.running&&JSON.stringify(previous.args)===JSON.stringify(argv))return current;
  throw Error('Existing or uncertain process. Inspect gaoding_workflow status and reconcile PID/log/run state before restarting: '+directory);
 }
 // Exclusive creation closes the cross-call race; completed records remain in logs.
 if(previous)renameSync(file,join(directory,'.plugin-process-'+previous.id+'.json'));
 let fd;try{fd=openSync(file,'wx');}catch(e){if(e.code==='EEXIST')throw Error('Another launch is being recorded; query status: '+directory);throw e;}
 const record={id:randomUUID(),args:argv,directory,startedAt:new Date().toISOString(),status:'launching'};
 try{writeFileSync(fd,JSON.stringify(record,null,2));}finally{closeSync(fd);}
 const logfd=openSync(join(directory,'workflow.log'),'a');
 try{
  const child=spawn('node',[join(pluginRoot,'runner.js'),file],{cwd:workspace,env:environment,detached:true,stdio:['ignore',logfd,logfd]});
  child.on('error',error=>writeJson(file,{...record,status:'failed',error:String(error),finishedAt:new Date().toISOString()}));
  child.unref();
 }finally{closeSync(logfd);}
 return {directory,started:true,process:record,next:['status',directory]};
 }finally{rmSync(lock,{recursive:true});}
}
