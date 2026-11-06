import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pluginRoot, workspace, dataRoot, runtimeHome, workflow, readJson, writeJson, launch, status } from './runtime-host.js';
export const name='dsh-plugin-gaoding-publisher';
export const inject=['tools'];
// The host validates raw JSON Schema when a tool registers, so the output root is
// declared as object and parameters use the standard object shape; the author-facing
// schema spec DSL (`{ required: true }`) only exists inside the host defineTool helper.
const output={schema:{type:'object'},render(_a,v){return [{type:'text',text:JSON.stringify(v,null,2)}];}};
function topics(){
 const runs=existsSync(join(dataRoot,'runs'))?readdirSync(join(dataRoot,'runs')).map(d=>readJson(join(dataRoot,'runs',d,'run.json'))).filter(Boolean):[];
 return Object.entries(readJson(join(workspace,'pipeline/topics.json'))).map(([key,t])=>({key,name:t.topic,specs:t.specs,hub:t.hub,specsNote:t.specs_note,completedRuns:runs.filter(r=>(r.requested_topic===t.topic||r.stages?.research_collect?.result?.topic?.name===t.topic)&&r.status==='complete').length}));
}
export const tools=[{
 name:'gaoding_topics',
 description:'列出稿定话题和规范摘要，返回本插件的完整 Agent 指引、运行路径与依赖状态。制作/投稿前先读返回的 guide 和 workflowGuide；用户已选题或授权随机选择时不要重复询问。',
 parameters:{type:'object',properties:{},additionalProperties:false},output,
 async execute(){return {topics:topics(),workspace,dataRoot,runtimeHome,workflow,workflowGuide:join(workspace,'pipeline/workflow/WORKFLOW.md'),guide:readFileSync(join(pluginRoot,'skill/SKILL.md'),'utf8'),dependenciesInstalled:existsSync(join(runtimeHome,'.venv/bin/python'))};}
},{
 name:'gaoding_subscribe',
 description:'记录用户已经选中的话题；生成每题明确绑定 --topic 的执行参数。space 和 repositoryId 必须来自本次实际浏览器空间和 DAM 查询。登记不代表已经投稿；随后调用 gaoding_workflow。',
 parameters:{type:'object',additionalProperties:false,required:['topics','space','repositoryId'],properties:{topics:{type:'array',items:{type:'string'},description:'gaoding_topics 返回的 key 数组'},space:{type:'number',description:'本次 ego-browser TaskSpace ID'},repositoryId:{type:'string',description:'当前用户实际 DAM 资源库 ID'}}},output,
 async execute(args){
  const all=topics();const keys=[...new Set(args.topics||[])];
  if(!keys.length||keys.some(k=>!all.some(t=>t.key===k)))throw Error('Unknown or empty topic selection');
  if(!Number.isInteger(args.space)||args.space<0||!args.repositoryId?.trim())throw Error('Actual TaskSpace and DAM repository ID required');
  const id='sub-'+randomUUID();
  const jobs=keys.map(key=>({topic:key,directory:join(dataRoot,'runs',id+'-'+key),args:['auto',join(dataRoot,'runs',id+'-'+key),'--topic',key,'--space',String(args.space),'--repository-id',args.repositoryId,'--watch']}));
  const job={id,createdAt:new Date().toISOString(),topics:keys,space:args.space,repositoryId:args.repositoryId,status:'queued',jobs};
  const file=join(dataRoot,'subscriptions',id+'.json');writeJson(file,job);
  return {job,file,instructions:'串行启动 jobs；gaoding_workflow 立即返回，用 ["status",directory] 查询。等 gate 时 Agent 读证据、看图并写真实验收结果。不要手改 run.json 跳阶段。'};
 }
},{
 name:'gaoding_workflow',
 description:'执行打包的稿定工作流。除 status 外命令均后台启动并立即返回 directory；用 ["status",directory] 查询进程、run.json、待处理 gate 和日志。首次 ["bootstrap"]，完成后 ["doctor"]；auto 使用订阅返回的 args。不要将启动成功当作生产完成。',
 parameters:{type:'object',additionalProperties:false,required:['args'],properties:{args:{type:'array',items:{type:'string'},description:'workflow.sh 参数；status 的第二项为运行目录或返回的操作目录'}}},output,
 async execute({args}){
  if(!Array.isArray(args)||!args.length||args.some(x=>typeof x!=='string'))throw Error('args must be a nonempty string array');
  if(args[0]==='status'){if(args.length!==2)throw Error('status requires one directory');return status(args[1]);}
  const allowed=['bootstrap','doctor','auto','job','localize','build','register','receipts','masters','browser','--help'];
  if(!allowed.includes(args[0]))throw Error('Unsupported workflow command');
  return launch(args);
 }
}];
export function apply(ctx){for(const tool of tools)ctx.effect(()=>ctx.tools.register(tool));}
