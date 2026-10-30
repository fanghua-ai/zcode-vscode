import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {build} from 'esbuild';
import assert from 'node:assert/strict';
// Optional real-client session regression: isolated storage and a localhost-only fake model.
// Run with Node 22+; never reads desktop credentials or opens a real workspace.
const binary=process.env.ZCODE_BINARY || '/opt/ZCode/resources/glm/zcode.cjs';
const bundled=process.env.ZCODE_TEST_BUILTIN_CONFIG || path.resolve(path.dirname(binary),'../config/provider/zcode-builtin.json');
const root=await mkdtemp(path.join(tmpdir(),'zcode-isolated-sessions-'));
await mkdir(path.join(root,'workspace'));
let modelRequests=0;
let unavailableRequests=0;
const server=http.createServer((req,res)=>{
 let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
  modelRequests++;const input=JSON.parse(body);const prompt=JSON.stringify(input.messages?.filter(message=>message.role==='user').at(-1)?.content ?? body);const tag=prompt.match(/REGRESSION_[A-Z_]+/g)?.at(-1);
  if(tag==='REGRESSION_UNAVAILABLE')unavailableRequests++;
  if(tag)console.log('Local fake model:',tag);
  const slow=tag && /ROOT|SWITCH_A|STOP/.test(tag);
  const pieces=tag?Array.from({length:slow?16:3},(_,index)=>'['+tag+':'+index+']') : ['Image received.'];
  res.writeHead(200,{'Content-Type':'text/event-stream'});let index=0;
  const frame=(delta,finish_reason=null)=>'data: '+JSON.stringify({id:'fake',object:'chat.completion.chunk',model:'test',choices:[{index:0,delta,finish_reason}]})+'\n\n';
  const timer=setInterval(()=>{
   if(index<pieces.length)res.write(frame({content:pieces[index++]}));
   else {clearInterval(timer);res.end(frame({},'stop')+'data: [DONE]\n\n');}
  },slow?150:30);
  res.on('close',()=>clearInterval(timer));
 });
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
await mkdir(path.join(root,'.zcode','cli'),{recursive:true});
await writeFile(path.join(root,'.zcode','cli','config.json'),JSON.stringify({model:'fake/test',provider:{fake:{name:'Local fake',kind:'openai-compatible',options:{apiKey:'TEST-ONLY',baseURL:'http://127.0.0.1:'+port+'/v1'},models:{test:{name:'Test',limit:{context:131072,output:128},modalities:{input:['text','image'],output:['text']}}}}}}));
await mkdir(path.join(root,'.zcode','v2'),{recursive:true});
await writeFile(path.join(root,'.zcode','v2','config.json'),await readFile(path.join(root,'.zcode','cli','config.json')));
const personal=path.join(root,'.zcode','v2','provider_config.json');
await writeFile(personal,JSON.stringify({schemaVersion:1,config:{providerConfigRules:{providerRules:[{providerId:'fake',providerName:'Local fake',enabled:true,config:{group:'standard-personal',access:{type:'api-key',apiKey:'TEST-ONLY'},api:{type:'openai-chat-completions',baseUrl:'http://127.0.0.1:'+port+'/v1'},personalModelIds:['test'],modelOrder:['test']}}]},modelConfigRules:{providerModelRules:[{providerId:'fake',modelId:'test',config:{properties:{contextWindow:131072,inputFormat:{supportsImage:true}}}}],manualProviderModelRules:[]}}}));

// A second enabled provider lets the user recover an old chat by selecting a
// valid model, without relying on the backend's asynchronous registry reload.
const registry=JSON.parse(await readFile(personal,'utf8'));
registry.config.providerConfigRules.providerRules.push({...structuredClone(registry.config.providerConfigRules.providerRules[0]),providerId:'other'});
registry.config.modelConfigRules.providerModelRules.push({...structuredClone(registry.config.modelConfigRules.providerModelRules[0]),providerId:'other'});
await writeFile(personal,JSON.stringify(registry));
for(const configFile of [path.join(root,'.zcode','cli','config.json'),path.join(root,'.zcode','v2','config.json')]){
 const config=JSON.parse(await readFile(configFile,'utf8'));config.provider.other=structuredClone(config.provider.fake);
 await writeFile(configFile,JSON.stringify(config));
}

// Exercise desktops that no longer mirror providers into legacy config.json.
if(process.env.ZCODE_TEST_PROVIDER_CONFIG_ONLY==='1'){
 for(const configFile of [path.join(root,'.zcode','cli','config.json'),path.join(root,'.zcode','v2','config.json')]){
  await writeFile(configFile,JSON.stringify({model:'fake/test',provider:{}}));
 }
}

const harness=path.join(root,'session-client.cjs');
await build({stdin:{contents:`
import {ZCodeClient} from ${JSON.stringify(path.resolve(process.env.ZCODE_REVIEW_SOURCE || 'src/zcodeClient.ts'))};
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {persistCliSession,loadSessionExecutionState} from ${JSON.stringify(path.resolve('src/taskIndex.ts'))};
import fs from 'node:fs';
import {isSessionModelAvailable, resolveRuntimeForSession} from ${JSON.stringify(path.resolve('src/desktop.ts'))};
import path from 'node:path';
(async()=>{
const events=[];let seededVersion=false;
const makeClient=()=>new ZCodeClient({isSessionModelAvailable,resolveSessionRuntime:resolveRuntimeForSession,binaryPath:process.env.TEST_BINARY,workspacePath:process.env.TEST_WORKSPACE,compileCachePath:path.join(process.env.HOME,"compile-cache"),
 env:{ZCODE_PERSONAL_PROVIDER_CONFIG_FILE:process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE,ZCODE_BUILTIN_PROVIDER_CONFIG_FILE:process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE:process.env.ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE},
 runtime:{providerId:'builtin:bigmodel-coding-plan',providerName:'Missing legacy provider',modelId:'test',kind:'openai',baseURL:'http://127.0.0.1',apiKey:'TEST-ONLY',models:{},source:'custom-provider'},
 onEvent:event=>{events.push(event);if(event.type==='session_title'){
 if(!seededVersion){
 const db=new DatabaseSync(path.join(process.env.HOME,'.zcode/cli/db/db.sqlite'));
 db.exec('PRAGMA busy_timeout=5000');
 // Match the host: index the empty identity before applying post-create defaults.
 db.prepare('INSERT OR IGNORE INTO session (id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(?,?,?,?,?,?,?,?)').run('version-fixture','fixture-project','version-fixture',process.env.TEST_WORKSPACE,'Fixture','3.14.4',Date.now(),Date.now());db.close();seededVersion=true;
 }
 assert.ok(persistCliSession({sessionId:event.data.sessionId,workspacePath:process.env.TEST_WORKSPACE,title:event.data.title,mode:client.currentMode()}));

 }}});
let client=makeClient();

const baseline=process.env.TEST_BASELINE==='1';if(baseline){const create=client.newSession.bind(client);client.newSession=async()=>{await create();await client.setModel('fake','test');};}
try {
 await client.start({createNew:true});if(baseline)await client.setModel('fake','test');

 if(!baseline){
  const restart=async()=>{
   const id=client.currentSessionId;client.dispose();client=makeClient();
   await client.start({resumeSessionId:id});assert.equal(client.currentSessionId,id);
  };
  for(const mode of ['yolo','edit','plan']){
   await client.newSession({mode});assert.equal(client.currentMode(),mode);
   await restart();assert.equal(client.currentMode(),mode,'empty default lost after restart: '+mode);
  }
  await client.setMode('yolo');await client.setMode('plan');
  await restart();assert.equal(client.currentMode(),'plan');
  assert.equal(client.confirmedControls().baseMode,'yolo','plan must preserve the full-access base permission');
  await client.setMode('edit');await restart();assert.equal(client.currentMode(),'edit');
  await client.setMode('build');await restart();assert.equal(client.currentMode(),'build');
  console.log('Real backend: empty-session defaults and manual permissions survive process restarts, including plan/base separation.');
  for(const [initial,requested] of [['yolo','build'],['build','yolo']]){
   await client.newSession({mode:initial});const source=client.currentSessionId;
   await client.newSession();const destination=client.currentSessionId;
   assert.notEqual(source,destination,'new session reused the previous identity');
   await client.switchSession(source);
   const rpc=client.sendRequest.bind(client);let accepted,release;
   const ack=new Promise(resolve=>accepted=resolve),gate=new Promise(resolve=>release=resolve);
   client.sendRequest=async(method,params,...rest)=>{
    const result=await rpc(method,params,...rest);
    if(method==='session/setMode'&&params.sessionId===source){accepted();await gate;}
    return result;
   };
   const changing=client.setMode(requested);await ack;
   await client.switchSession(destination);const destinationMode=client.currentMode();
   release();await changing;client.sendRequest=rpc;
   assert.equal(client.currentMode(),destinationMode,'late acknowledgement changed destination controls');
   await client.switchSession(source);await restart();
   assert.equal(client.currentMode(),requested,'accepted permission lost after switch/restart: '+requested);
  }
  console.log('Real backend: late permission upgrade/downgrade acknowledgements persist the source without changing destination controls.');
  await client.newSession();
 }
 const first=client.currentSessionId;assert.ok(first);
 for(let round=0;round<2;round++){
  if(round) {await client.newSession();assert.notEqual(client.currentSessionId,first);}
  const session=client.currentSessionId;
  const ready=events.filter(event=>event.type==='session_ready'&&event.data.sessionId===session);
  assert.ok(ready.length,'new session not ready');
  const models=await client.readAvailableModels();if(models.current)assert.equal(models.current.providerId,'fake');
  await client.sendMessage('Session regression test '+round);
  const deadline=Date.now()+15000;
  const received=()=>events.some(event=>event.type==='assistant_text_delta'&&event.data.fullText?.includes('Image received.') ||
    event.type==='transcript_sync'&&event.data.sessionId===session&&event.data.items?.some(item=>item.role==='assistant'&&item.text?.includes('Image received.')));
  while(Date.now()<deadline&&!received())await new Promise(resolve=>setTimeout(resolve,100));
  assert.ok(received(),'real backend did not deliver model output: '+JSON.stringify(events.slice(-10)));
  events.length=0;
 }

 if(!baseline){
  for(const failure of ['base','plan','plan-after-ack','manual-override']){
   await client.setMode('yolo');await client.setMode('plan');
   const id=client.currentSessionId;client.dispose();client=makeClient();
   await client.start({createNew:true});
   const rpc=client.sendRequest.bind(client);let injected=false;
   client.sendRequest=async(method,params,...rest)=>{
    if(method==='session/setMode'&&params.sessionId===id&&!injected&&params.mode===(failure==='base'?'yolo':'plan')){
     injected=true;if(failure==='plan-after-ack')await rpc(method,params,...rest);
     throw new Error('Injected restore failure');
    }
    return rpc(method,params,...rest);
   };
   await assert.rejects(client.switchSession(id),/Injected restore failure/);
   assert.ok(injected);
   await assert.rejects(client.sendMessage('MUST_NOT_SEND_AFTER_PARTIAL_RESTORE'),/会话权限尚未恢复完成/);
   assert.deepEqual(loadSessionExecutionState(id),{mode:'yolo',planEnabled:true},'partial restore overwrote the full target: '+failure);
   if(failure==='manual-override')await client.setMode('edit');
   client.dispose();client=makeClient();await client.start({resumeSessionId:id});
   assert.equal(client.currentSessionId,id);
   assert.equal(client.currentMode(),failure==='manual-override'?'edit':'plan');
   assert.equal(client.confirmedControls().baseMode,failure==='manual-override'?'edit':'yolo');
   const db=new DatabaseSync(path.join(process.env.HOME,'.zcode/cli/db/db.sqlite'));
   assert.equal(db.prepare("SELECT count(*) AS n FROM session_entry WHERE session_id=? AND type='zcode-vscode/permission_restore'").get(id).n,0);
   db.close();
  }
  console.log('Real backend: base/plan failures, lost acknowledgements and process-restart retries preserve the full target; explicit choices replace failed restore targets.');
  await client.setMode('yolo');await client.setMode('plan');
  const id=client.currentSessionId;client.dispose();client=makeClient();
  await client.start({resumeSessionId:id});
  assert.equal(client.currentMode(),'plan','history-bearing chat lost plan after restart');
  assert.equal(client.confirmedControls().baseMode,'yolo');
  assert.ok((await client.loadHistory()).items.some(item=>item.role==='user'&&item.text==='Session regression test 1'));
  console.log('Real backend: history-bearing chats preserve plan/base state and history across process restart.');
 }
 await client.setMode('plan');assert.equal(client.currentMode(),'plan');
 await client.newSession();assert.equal(client.currentMode(),'build','new session inherited previous plan mode');
 console.log('Real backend: new session clears previous plan state.');

 const expected=tag=>Array.from({length:/ROOT|SWITCH_A|STOP/.test(tag)?16:3},(_,index)=>'['+tag+':'+index+']').join('');
 async function waitFor(predicate,label){const deadline=Date.now()+20000;while(Date.now()<deadline){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('Timeout: '+label+' history='+JSON.stringify(await client.loadHistory())+' status='+JSON.stringify(events.filter(event=>event.type==='status').slice(-4)));}
 async function waitReply(tag){
  await waitFor(async()=>{const history=await client.loadHistory();return history.items.some(item=>item.role==='assistant'&&item.text===expected(tag)&&!item.running);},'complete reply '+tag);
  const history=await client.loadHistory();assert.equal(history.items.filter(item=>item.role==='assistant'&&item.text===expected(tag)).length,1,'reply duplicated: '+tag);
 }
 let metadataOnlySubscriptions=0;
 const request=client.sendRequest.bind(client);
 client.sendRequest=async(method,params)=>{
  if(method==='session/subscribe' && params.includeSnapshot===false){
   metadataOnlySubscriptions++;
   assert.equal(params.afterSeq,0,'resume must preserve interaction replay');
  }
  return request(method,params);
 };
 async function switchTo(id){await client.prepareViewChange();try{await client.switchSession(id);}finally{client.endViewChange();}}
 await client.newSession();const early=client.currentSessionId;
 await client.sendMessage('REGRESSION_EARLY_ROOT');
 await client.prepareViewChange();try{await client.newSession();}finally{client.endViewChange();}
 await client.sendMessage('REGRESSION_EARLY_B');await waitReply('REGRESSION_EARLY_B');
 await switchTo(early);await waitReply('REGRESSION_EARLY_ROOT');
 console.log('Real backend: switching away before first output preserves the complete reply.');
 await client.newSession();const a=client.currentSessionId;
 await client.sendMessage('REGRESSION_SWITCH_A');
 await waitFor(()=>events.some(event=>event.type==='assistant_text_delta'&&event.data.fullText?.includes('[REGRESSION_SWITCH_A:0]')),'A starts streaming');
 await client.prepareViewChange();try{await client.newSession();}finally{client.endViewChange();}const b=client.currentSessionId;assert.notEqual(a,b);
 await client.sendMessage('REGRESSION_SWITCH_B');await waitReply('REGRESSION_SWITCH_B');
 await switchTo(a);await waitReply('REGRESSION_SWITCH_A');
 for(let round=0;round<2;round++){await switchTo(b);await waitReply('REGRESSION_SWITCH_B');await switchTo(a);await waitReply('REGRESSION_SWITCH_A');}
 console.log('Real backend: streaming switch, background completion, repeated restore and exact reply text passed.');
 await client.sendMessage('REGRESSION_QUEUE_ROOT');
 await waitFor(()=>events.some(event=>event.type==='assistant_text_delta'&&event.data.fullText?.includes('[REGRESSION_QUEUE_ROOT:0]')),'queue root streams');
 const command=await client.insertQueuedMessage('REGRESSION_QUEUE_FOLLOW');assert.ok(command);
 await waitReply('REGRESSION_QUEUE_ROOT');await waitReply('REGRESSION_QUEUE_FOLLOW');
 console.log('Real backend: queued follow-up drains and preserves both exact replies.');
 await client.sendMessage('REGRESSION_IMMEDIATE_ROOT');
 await waitFor(()=>events.some(event=>event.type==='assistant_text_delta'&&event.data.fullText?.includes('[REGRESSION_IMMEDIATE_ROOT:0]')),'immediate root streams');
 await client.insertQueuedMessage('REGRESSION_IMMEDIATE_FOLLOW',{immediate:true});await waitReply('REGRESSION_IMMEDIATE_FOLLOW');
 console.log('Real backend: immediate follow-up receives a complete reply.');
 events.length=0;await client.sendMessage('REGRESSION_STOP');
 await waitFor(()=>events.some(event=>event.type==='assistant_text_delta'&&event.data.fullText?.includes('[REGRESSION_STOP:0]')),'stop root streams');
 await client.stopGeneration();await waitFor(()=>events.some(event=>event.type==='status'&&event.data.status==='completedInterrupted'),'stop settles');
 await client.sendMessage('REGRESSION_AFTER_CANCEL');await waitReply('REGRESSION_AFTER_CANCEL');
 const view=events.filter(event=>event.type==='conversation_sync').at(-1)?.data;assert.ok(view?.editable?.target,'no editable last question');
 await client.editUserQuery(view.editable.target,'REGRESSION_EDITED','preserve');await waitReply('REGRESSION_EDITED');
 assert.ok((await client.loadHistory()).items.some(item=>item.role==='user'&&item.text==='REGRESSION_EDITED'));
 // Editing with every image removed sends an explicit empty attachment list.
 const afterEdit=events.filter(event=>event.type==='conversation_sync').at(-1)?.data;assert.ok(afterEdit?.editable?.target,'no editable after edit');
 await client.editUserQuery(afterEdit.editable.target,'REGRESSION_EDIT_NO_IMAGES','preserve',[]);await waitReply('REGRESSION_EDIT_NO_IMAGES');
 assert.ok((await client.loadHistory()).items.some(item=>item.role==='user'&&item.text==='REGRESSION_EDIT_NO_IMAGES'));
 console.log('Real backend: stop, next send, edit/reply and empty-attachment edit passed.');
 if(!baseline)assert.ok(metadataOnlySubscriptions>0,'resume snapshot optimization was never exercised');
 console.log('Real backend: resume avoids duplicate full snapshots and preserves final reply text.');
 const registryFile=process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
 const enabledRegistry=JSON.parse(fs.readFileSync(registryFile,'utf8'));
 const originalChat=client.currentSessionId;
 await client.newSession(); const otherChat=client.currentSessionId;
 for(const variant of ['removed','disabled-provider','disabled-model']){
  fs.writeFileSync(registryFile,JSON.stringify(enabledRegistry));
  if(client.currentSessionId!==otherChat){await client.prepareViewChange();await client.switchSession(otherChat);client.endViewChange();}
  const unavailable=structuredClone(enabledRegistry);
  if(variant==='removed')unavailable.config.providerConfigRules.providerRules=unavailable.config.providerConfigRules.providerRules.filter(rule=>rule.providerId!=='fake');
  if(variant==='disabled-provider')unavailable.config.providerConfigRules.providerRules[0].enabled=false;
  if(variant==='disabled-model')unavailable.config.modelConfigRules.providerModelRules[0].config.enabled=false;
  fs.writeFileSync(registryFile,JSON.stringify(unavailable));
  await client.prepareViewChange();await client.switchSession(originalChat);client.endViewChange();
  await assert.rejects(()=>client.sendMessage('REGRESSION_UNAVAILABLE'),/该模型已不可用/);
  await assert.rejects(()=>client.insertQueuedMessage('REGRESSION_UNAVAILABLE'),/该模型已不可用/);
  await assert.rejects(()=>client.sendQueuedNow('unavailable-queue'),/该模型已不可用/);
  assert.ok(!(await client.loadHistory()).items.some(item=>item.text==='REGRESSION_UNAVAILABLE'),'rejected prompt persisted');
 }
 await client.setModel('other','test');
 await client.sendMessage('REGRESSION_VALID_MODEL');await waitReply('REGRESSION_VALID_MODEL');
 console.log('Real backend: deleted/disabled providers and models block old-chat sends; selecting an enabled model restores exact replies.');

 console.log('Real ZCode client: initial creation, first send, consecutive creation and second send passed.');
}finally{client.dispose();}
})().catch(error=>{console.error(error);process.exitCode=1;});
`,resolveDir:process.cwd(),sourcefile:'session-client.ts'},outfile:harness,bundle:true,platform:'node',format:'cjs',plugins:[{name:'isolated-vscode',setup(builder){builder.onResolve({filter:/^vscode$/},()=>({path:path.resolve('src/testSupport/vscode.ts')}));builder.onResolve({filter:/^\.\/log$/},()=>({path:'log',namespace:'mock'}));builder.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const logInfo=()=>{},logWarn=()=>{},logError=()=>{},logDebug=()=>{};'}));}}]});
try {
 const child=spawn(process.execPath,[harness],{env:{PATH:process.env.PATH,HOME:root,XDG_CONFIG_HOME:path.join(root,'config'),XDG_DATA_HOME:path.join(root,'data'),XDG_CACHE_HOME:path.join(root,'cache'),LANG:'C.UTF-8',TEST_BINARY:binary,TEST_WORKSPACE:path.join(root,'workspace'),TEST_BASELINE:process.env.ZCODE_REVIEW_SOURCE?'1':'0',ZCODE_PERSONAL_PROVIDER_CONFIG_FILE:personal,ZCODE_BUILTIN_PROVIDER_CONFIG_FILE:bundled,ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE:bundled},stdio:'inherit'});
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve)});
 assert.equal(code,0,'isolated real-client session regression failed; modelRequests='+modelRequests);
 assert.ok(modelRequests>=2,'new sessions did not both reach fake model');
 assert.equal(unavailableRequests,0,'a rejected model request reached the server with stale credentials');
}finally{server.close();await rm(root,{recursive:true,force:true});}
