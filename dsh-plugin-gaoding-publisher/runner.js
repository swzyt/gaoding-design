import { spawn } from 'node:child_process';
import { readJson, writeJson, workflow, environment, workspace } from './runtime-host.js';
const file=process.argv[2];const record=readJson(file);
if(!record||record.status!=='launching')throw Error('Invalid launch record');
record.pid=process.pid;record.status='running';writeJson(file,record);
const child=spawn('/bin/bash',[workflow,...record.args],{cwd:workspace,env:environment,stdio:'inherit'});
record.childPid=child.pid;writeJson(file,record);
let finished=false;
function finish(code,signal,error){if(finished)return;finished=true;writeJson(file,{...record,status:code===0?'exited':'failed',exitCode:code,signal,error,finishedAt:new Date().toISOString()});}
child.on('error',error=>finish(null,null,String(error)));
child.on('exit',(code,signal)=>finish(code,signal));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
