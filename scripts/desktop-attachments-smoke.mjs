import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
// Optional desktop protocol smoke: isolated storage and a localhost-only fake model.
// Run with Node 22+; never reads desktop credentials or opens a real workspace.
const binary=process.env.ZCODE_BINARY || '/opt/ZCode/resources/glm/zcode.cjs';
const bundled=process.env.ZCODE_TEST_BUILTIN_CONFIG || path.resolve(path.dirname(binary),'../config/provider/zcode-builtin.json');
const root=await mkdtemp(path.join(tmpdir(),'zcode-isolated-attachments-'));
await mkdir(path.join(root,'workspace'));
let imageDelivered=false; let modelRequests=0; const events=[];
const server=http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{modelRequests++; imageDelivered ||= body.includes('data:image/');res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'fake',object:'chat.completion.chunk',created:1,model:'test',choices:[{index:0,delta:{role:'assistant',content:'Image received.'},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'fake',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})+'\n\ndata: [DONE]\n\n');});});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
await mkdir(path.join(root,'.zcode','cli'),{recursive:true});
await writeFile(path.join(root,'.zcode','cli','config.json'),JSON.stringify({model:'fake/test',provider:{fake:{name:'Local fake',kind:'openai-compatible',options:{apiKey:'TEST-ONLY',baseURL:'http://127.0.0.1:'+port+'/v1'},models:{test:{name:'Test',limit:{context:8192,output:128},modalities:{input:['text','image'],output:['text']}}}}}}));
const personal=path.join(root,'personal-providers.json');
await writeFile(personal,JSON.stringify({schemaVersion:1,config:{providerConfigRules:{providerRules:[{providerId:'fake',providerName:'Local fake',enabled:true,config:{group:'standard-personal',access:{type:'api-key',apiKey:'TEST-ONLY'},api:{type:'openai-chat-completions',baseUrl:'http://127.0.0.1:'+port+'/v1'},personalModelIds:['test'],modelOrder:['test']}}]},modelConfigRules:{providerModelRules:[{providerId:'fake',modelId:'test',config:{properties:{contextWindow:8192,inputFormat:{supportsImage:true}}}}],manualProviderModelRules:[]}}}));
const proc=spawn(process.execPath,[binary,'app-server'],{cwd:path.join(root,'workspace'),env:{PATH:process.env.PATH,HOME:root,XDG_CONFIG_HOME:path.join(root,'config'),XDG_DATA_HOME:path.join(root,'data'),XDG_CACHE_HOME:path.join(root,'cache'),LANG:'C.UTF-8',ZCODE_PERSONAL_PROVIDER_CONFIG_FILE:personal,ZCODE_BUILTIN_PROVIDER_CONFIG_FILE:bundled,ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE:bundled},stdio:['pipe','pipe','pipe']});
const pending=new Map();let next=0;let sessionId='';let stderr='';
const write=message=>proc.stdin.write(JSON.stringify(message)+'\n');
proc.stderr.on('data',data=>{stderr=(stderr+data).slice(-4000)});
const rl=readline.createInterface({input:proc.stdout});
rl.on('line',line=>{let message;try{message=JSON.parse(line)}catch{return}if(message.method&&!('id' in message))events.push(message); if(message.id!=null&&message.method){if(message.method==='session/requestRuntimePreferences')sessionId=message.params.sessionId;write({id:message.id,result:{nativeSearchEnhancementsEnabled:false,memoryEnabled:false}});}else if(message.id!=null){const slot=pending.get(message.id);if(slot){pending.delete(message.id);clearTimeout(slot.timer);message.error?slot.reject(new Error(JSON.stringify(message.error))):slot.resolve(message.result);}}});
function rpc(method,params){return new Promise((resolve,reject)=>{const id=++next;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('RPC timeout: '+method))},15000);pending.set(id,{resolve,reject,timer});write({id,method,params});});}
try{
 await rpc('session/create',{workspace:{workspacePath:path.join(root,'workspace'),workspaceKey:path.join(root,'workspace')},mode:'build'});
 assert.ok(sessionId,'session was not created');
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGMM6LnDgA0wYRUdtBIAWtsByEY277MAAAAASUVORK5CYII=','base64');
 const base={connectionId:'zcode-vscode',uploadId:randomUUID(),sessionId};
 await rpc('v4/attachment/begin',{...base,fileName:'test.png',mime:'image/png',totalBytes:bytes.length,totalChunks:1,checksum:'sha256:'+createHash('sha256').update(bytes).digest('hex')});
 await rpc('v4/attachment/chunk',{...base,chunkIndex:0,dataBase64:bytes.toString('base64')});
 const committed=await rpc('v4/attachment/commit',base);assert.ok(committed.ref);
 const fixtureDb=new DatabaseSync(path.join(root,'.zcode/cli/db/db.sqlite'));
 fixtureDb.prepare('INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(?,?,?,?,?,?,?,?)').run(sessionId,'fixture-project','fixture-session',path.join(root,'workspace'),'Fixture','3.14.4',Date.now(),Date.now());
 fixtureDb.close();
 const configured=await rpc('v4/command',{commandId:randomUUID(),clientId:'zcode-vscode',sessionId,type:'switchModelConfig',baseRevision:0,payload:{provider:'fake',model:'test',thought:'disabled'},issuedAt:Date.now()});
 assert.equal(configured.status,'accepted',JSON.stringify(configured));
 const admission=await rpc('v4/command',{commandId:randomUUID(),clientId:'zcode-vscode',sessionId,type:'sendText',payload:{text:'',attachments:[{ref:committed.ref,fileName:'test.png',mime:'image/png',bytes:bytes.length}],requestedDelivery:'startNow'},issuedAt:Date.now()});
 assert.equal(admission.status,'accepted',JSON.stringify(admission));
 let result;
 for(let attempt=0;attempt<40;attempt++) { try { result=await rpc('v4/attachment/read',{sessionId,ref:committed.ref,offset:0,limit:512*1024}); break; } catch(error) { if(!String(error).includes('previewRefNotAuthorized'))throw error; await new Promise(resolve=>setTimeout(resolve,100)); } }
 assert.ok(result,'image did not become authorized after send');

 assert.deepEqual(Buffer.from(result.dataBase64,'base64'),bytes);assert.equal(result.nextOffset,null);assert.equal(result.mediaType,'image/png');
 // Cold backend startup can exceed four seconds under parallel regression load.
 // Wait only until delivery; retain a bounded deadline for genuine failures.
 for(let attempt=0;attempt<150&&!imageDelivered;attempt++)await new Promise(resolve=>setTimeout(resolve,100));
 assert.ok(imageDelivered,'image was not forwarded to the local fake model; requests='+modelRequests+' events='+JSON.stringify(events.slice(-3)).slice(-3500));
 console.log('Isolated desktop attachment upload/send/read passed; image delivered to localhost fake model, no real account or user storage.');
}catch(error){console.error(String(error));console.error(stderr);process.exitCode=1;}
finally{server.closeAllConnections();server.close();rl.close();for(const slot of pending.values())clearTimeout(slot.timer);proc.kill('SIGTERM');await new Promise(resolve=>{proc.once('exit',resolve);setTimeout(()=>{proc.kill('SIGKILL');resolve()},2000).unref()});await rm(root,{recursive:true,force:true});}
