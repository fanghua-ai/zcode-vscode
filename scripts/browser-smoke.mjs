import { build } from "esbuild";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

// Uses a fresh browser profile and a fake VS Code message bridge. No app-server.
const root = await mkdtemp(path.join(tmpdir(), "zcode-browser-test-"));
try {
  const modulePath = path.join(root, "html.cjs");
  await build({ entryPoints: ["src/webviewHtml.ts"], outfile: modulePath, bundle: true,
    platform: "node", format: "cjs", alias: { vscode: path.resolve("src/testSupport/vscode.ts") } });
  const { getWebviewHtml } = createRequire(import.meta.url)(modulePath);
  const scenarioPath = path.join(root, "handoff.cjs");
  const baselineAt = process.argv.indexOf("--client-source");
  const baseline = baselineAt >= 0 ? await readFile(process.argv[baselineAt + 1], "utf8") : undefined;
  const require = createRequire(import.meta.url);
  await build({ entryPoints: ["src/testSupport/handoffScenario.ts"], outfile: scenarioPath,
    bundle: true, platform: "node", format: "cjs",
    external: [require.resolve("node-sqlite3-wasm")],
    plugins: baseline === undefined ? [] : [{ name: "baseline-client", setup(builder) {
      builder.onLoad({ filter: /[\\/]zcodeClient\.ts$/ }, () => ({
        contents: baseline, loader: "ts", resolveDir: path.resolve("src"),
      }));
    } }],
    alias: { vscode: path.resolve("src/testSupport/vscode.ts"),
      "node-sqlite3-wasm": require.resolve("node-sqlite3-wasm") },
  });
  const fixtureAt = process.argv.indexOf("--reasoning-fixture");
  const pasted = fixtureAt >= 0 ? await readFile(process.argv[fixtureAt + 1], "utf8") : undefined;
  const reasoning = pasted ? pasted.slice(pasted.indexOf("Now I have everything I need."))
    : "Now I have everything I need.\n" + "Middle paragraph that must survive every switch.\n".repeat(120)
      + "Final fixture paragraph — retain punctuation.\nI'll answer in Chinese.";
  const scenario = await require(scenarioPath).handoffScenario(reasoning);
  const workbarBackendHistory = await require(scenarioPath).workbarBackendScenario();
  const duplicatesAt = process.argv.indexOf("--duplicate-fixtures");
  const canonical = duplicatesAt >= 0 ? await readFile(process.argv[duplicatesAt + 2], "utf8")
    : "A canonical paragraph that must appear once.\n".repeat(220);
  const polluted = duplicatesAt >= 0 ? await readFile(process.argv[duplicatesAt + 1], "utf8")
    : canonical + canonical + "A tail from an old replay.";
  const repaired = await require(scenarioPath).handoffScenario(canonical, polluted);
  const nonce = "smoke-test";
  let html = getWebviewHtml({ cspSource: "file:", asWebviewUri: (uri) => uri }, pathToFileURL(process.cwd()).href, nonce);
  const scriptStart = html.indexOf("<script");
  html = html.slice(0, scriptStart) + `<script nonce="${nonce}">
    window.sent=[];
    const frameTimers=new Map();let nextFrameId=0;
    window.requestAnimationFrame=callback=>{const id=++nextFrameId;const timer=window.setTimeout(()=>{frameTimers.delete(id);callback(performance.now());},0);frameTimers.set(id,timer);return id;};
    window.cancelAnimationFrame=id=>{const timer=frameTimers.get(id);if(timer!==undefined){window.clearTimeout(timer);frameTimers.delete(id);}};
    window.workbarBackendHistory=${JSON.stringify(workbarBackendHistory).replace(/</g, "\\u003c")};
    window.acquireVsCodeApi=()=>({postMessage:msg=>window.sent.push(msg),getState:()=>window.savedState,setState:state=>{window.savedState=state}});
  </script>` + html.slice(scriptStart);
  html = html.replace("</body>", () => `<script nonce="${nonce}">
  try {
    const check=(condition,message)=>{if(!condition)throw new Error(message)};
    const emit=data=>window.dispatchEvent(new MessageEvent('message',{data}));
    emit({type:'session_ready',sessionId:'A',title:'Test',viewGen:1});
    const quoted='say "hello"';
    emit({type:'user_input_request',requestId:'multi',questions:[{
      question:'Features',header:'Select features',multiSelect:true,
      options:[{value:quoted,label:quoted},{value:'B',label:'B'}]
    }]});
    const card=document.getElementById('ask-multi');
    const choices=card.querySelectorAll('button[data-val]');
    check(choices.length===2 && choices[0].dataset.val===quoted,'quoted option corrupted');
    const submit=card.querySelector('[data-act="submit"]');
    check(submit && submit.disabled,'multi-select submit must start disabled');
    choices[0].click(); choices[1].click();
    check(!window.sent.some(m=>m.type==='userInputAnswer'),'multi-select submitted prematurely');
    choices[0].click(); check(choices[0].getAttribute('aria-pressed')==='false','deselection failed');
    choices[0].click(); submit.click();
    const answer=window.sent.find(m=>m.type==='userInputAnswer');
    check(answer.content.answers.Features===quoted+', B','multi-select answer lost choices');
    check([...card.querySelectorAll('.ask-details button')].every(b=>b.disabled),'resolved card remains editable');
    emit({type:'permission_request',requestId:'permission',toolName:'edit',options:[{
      optionId:'allow_once "quoted"',kind:'allow_once',name:'Allow',description:'Use "quotes" safely'
    }]});
    document.querySelector('#perm-permission button[data-opt]').click();
    check(window.sent.some(m=>m.type==='permissionAnswer' && m.optionId==='allow_once "quoted"'),'permission ID corrupted');
    emit({type:'session_ready',sessionId:'B',title:'B',viewGen:2});
    emit({type:'historyOlder',sessionId:'A',viewGen:1,items:[{id:'old',role:'user',text:'STALE_HISTORY_MARKER',tools:[]}],more:false});
    check(!document.getElementById('messages').textContent.includes('STALE_HISTORY_MARKER'),'stale history rendered');
    emit({type:'history',sessionId:'B',viewGen:2,items:[{
      id:'reasoning-history',role:'assistant',text:'Answer',tools:[],steps:[
        {kind:'reasoning',text:'EARLY_REASONING'},
        {kind:'text',text:'Answer'},
        {kind:'reasoning',text:'TRAILING_REASONING'}
      ]
    }]});
    let messages=document.getElementById('messages');
    check(messages.textContent.includes('EARLY_REASONING'),'early historical reasoning lost');
    check(messages.textContent.includes('TRAILING_REASONING'),'reasoning after answer lost');
    emit({type:'history',sessionId:'B',viewGen:2,activeSince:Date.now(),items:[{
      id:'running-reasoning',role:'assistant',text:'',tools:[],running:true,
      steps:[{kind:'reasoning',text:'RESTORED_REASONING_FULL'}]
    }]});
    emit({type:'assistant_reasoning_delta',delta:'RESTORED_',fullText:'RESTORED_'});
    check(messages.textContent.includes('RESTORED_REASONING_FULL'),'short resumed stream truncated history');
    emit({type:'assistant_reasoning_delta',delta:'REASONING_FULL_MORE',fullText:'RESTORED_REASONING_FULL_MORE'});
    check(messages.textContent.includes('RESTORED_REASONING_FULL_MORE'),'resumed stream failed to extend reasoning');
    emit({type:'history',sessionId:'B',viewGen:2,activeSince:Date.now(),items:[{
      id:'identified-reasoning',role:'assistant',text:'',tools:[],running:true,
      steps:[{kind:'reasoning',partId:'first',text:'SAME_PREFIX_FIRST'},
        {kind:'reasoning',partId:'second',text:'SAME_PREFIX_SECOND_FULL'}]
    }]});
    emit({type:'assistant_reasoning_delta',partId:'second',fullText:'SAME_PREFIX_SECOND'});
    check(messages.textContent.includes('SAME_PREFIX_SECOND_FULL'),'identified snapshot shrank');
    emit({type:'assistant_reasoning_delta',partId:'second',fullText:'SAME_PREFIX_SECOND_FULL_TAIL'});
    const notes = [...messages.querySelectorAll('.work-note')];
    check(notes.length === 2,'second reasoning duplicated or merged with first');
    check(notes[0].textContent === 'SAME_PREFIX_FIRST','first reasoning was overwritten');
    check(notes[1].textContent === 'SAME_PREFIX_SECOND_FULL_TAIL','second reasoning continuation lost');
    emit({type:'status',status:'completedSuccess'});
    emit({type:'history',sessionId:'B',viewGen:2,activeSince:Date.now(),items:[{
      id:'identified-body',role:'assistant',text:'BODY_SECOND_COMPLETE',tools:[],running:true,
      steps:[{kind:'text',partId:'body-first',text:'BODY_FIRST_COMPLETE'},
        {kind:'reasoning',partId:'between',text:'BETWEEN_BODIES'},
        {kind:'text',partId:'body-second',text:'BODY_SECOND_COMPLETE'}]
    }]});
    emit({type:'assistant_text_delta',partId:'body-second',fullText:'BODY_SECOND'});
    check(messages.textContent.includes('BODY_SECOND_COMPLETE'),'body shrank on replay');
    emit({type:'assistant_text_delta',partId:'body-second',fullText:'BODY_SECOND_COMPLETE_TAIL'});
    const bodies = [...messages.querySelectorAll('.message.assistant')]
      .filter(node => node.dataset.copyText);
    check(bodies.length === 2,'body replay created a duplicate');
    check(bodies[0].dataset.copyText === 'BODY_FIRST_COMPLETE','previous body overwritten');
    check(bodies[1].dataset.copyText === 'BODY_SECOND_COMPLETE_TAIL','restored nested body lost continuation');
    emit({type:'status',status:'completedSuccess'});
    emit({type:'history',sessionId:'B',viewGen:2,items:[{
      id:'settled-body',role:'assistant',text:'FINAL_BODY_COMPLETE',tools:[],
      steps:[{kind:'text',partId:'final-body',text:'FINAL_BODY_COMPLETE'}]
    }]});
    emit({type:'assistant_text_delta',partId:'final-body',fullText:'FINAL_BODY'});
    check(messages.textContent.includes('FINAL_BODY_COMPLETE'),'settled body shrank on replay');
    emit({type:'status',status:'completedSuccess'});
    // Older servers without part IDs still must not shrink an existing answer.
    emit({type:'assistant_text_delta',fullText:'FINAL_BODY'});
    check(messages.textContent.includes('FINAL_BODY_COMPLETE'),'legacy body shrank on replay');
    emit({type:'status',status:'completedSuccess'});
    const handoff = ${JSON.stringify(scenario).replace(/</g, "\\u003c")};
    for (const message of handoff.messages) emit(message);
    const finalNotes = [...messages.querySelectorAll('.work-note')];
    check(finalNotes.length === 2,'repeated handoffs duplicated or lost reasoning blocks');
    check(finalNotes[0].textContent === 'Earlier reasoning stays intact.','handoff overwrote earlier reasoning');
    check(finalNotes[1].textContent === handoff.reasoning,'handoff lost part of the full reasoning fixture');
    const finalBodies = [...messages.querySelectorAll('.message.assistant')].filter(node => node.dataset.copyText);
    check(finalBodies.length === 2,'repeated handoffs duplicated or lost bodies');
    check(finalBodies[1].dataset.copyText === handoff.answer,'handoff lost answer text');
    emit({type:'status',status:'completedSuccess'});
    const repaired = ${JSON.stringify(repaired).replace(/</g, "\\u003c")};
    for (const message of repaired.messages) emit(message);
    const repairedNotes = [...messages.querySelectorAll('.work-note')];
    check(repairedNotes.length === 2,'completed history repair duplicated blocks');
    check(repairedNotes[1].textContent === repaired.reasoning,'completed history kept duplicated reasoning');
    const shortCorrect = '已完成的段用持久化文本**整体替换**实时缓冲并打上 complete 标记，迟到的重放直接被拒';
    const shortPolluted = shortCorrect.replace('迟到', '迟文本**整体替换**实时缓冲并打上 complete 标记，迟到');
    const targetId = repairedNotes[1].dataset.partId;
    emit({type:'assistant_reasoning_delta',partId:targetId,fullText:shortPolluted,authoritative:true,streaming:false});
    emit({type:'assistant_reasoning_delta',partId:targetId,fullText:shortCorrect,authoritative:true,streaming:false});
    const shortNotes = [...messages.querySelectorAll('.work-note')];
    check(shortNotes.length === 2,'short authoritative correction created another reasoning block');
    check(shortNotes[1].textContent === shortCorrect,'short authoritative correction retained duplicated text');
    const answerNode = [...messages.querySelectorAll('.message.assistant')].find(node => node.dataset.copyText === repaired.answer);
    check(!!answerNode,'repaired answer missing before authoritative correction');
    emit({type:'assistant_text_delta',partId:answerNode.dataset.partId,fullText:'正文哈哈abcabc。',authoritative:true,streaming:false});
    emit({type:'assistant_text_delta',partId:answerNode.dataset.partId,fullText:'正文哈哈',authoritative:true,streaming:false});
    check(answerNode.dataset.copyText === '正文哈哈','authoritative body correction was blocked by the old length guard');
    emit({type:'status',status:'completedSuccess'});
    emit({type:'history',sessionId:'A',items:[
      {role:'assistant',text:'',createdAt:1000000,endedAt:1120000,workDurationMs:65000,
        steps:[{kind:'reasoning',text:'完整思考',partId:'timed-reasoning'}]},
      {role:'assistant',text:'完整正文',createdAt:1000000,endedAt:1120000,workDurationMs:65000,
        steps:[{kind:'text',text:'完整正文',partId:'timed-body'}]},
      {role:'user',text:'权限与工具语言测试',createdAt:1130000},
    ]});
    check(messages.querySelector('.work-fold-label')?.textContent === '已工作 1 分 5 秒',
      'restored fold did not retain desktop work duration');
    emit({type:'status',sessionId:'A',status:'running',message:'等待模型响应…'});
    check(document.getElementById('conn-label').textContent === '等待模型响应','first token wait was mislabeled');
    emit({type:'status',sessionId:'B',status:'completedInterrupted'});
    check(document.getElementById('conn-label').textContent === '等待模型响应','another session stopped this view');
    emit({type:'status',sessionId:'A',status:'completedInterrupted'});
    check(document.getElementById('conn-label').textContent === '已停止','stopped session remained generating');
    check(!document.getElementById('send-btn').classList.contains('stop'),'stopped session retained stop button');
    // Dynamic labels retain their source parameters; user data never undergoes conversion.
    const literalTool='已工作 \"头发、后台、发布\" 需要权限';
    emit({type:'permission_request',requestId:'language-permission',toolName:literalTool,reason:'用户理由：头发、后台、发布',options:[{optionId:'allow_once',kind:'allow_once',name:'Allow'}]});
    emit({type:'tool_call',toolCallId:'language-tool',toolName:literalTool,status:'completed',inputText:'用户输入：头发、后台、发布',outputText:'用户输出：头发、后台、发布'});
    emit({type:'status',sessionId:'A',status:'completedInterrupted'});
    const languageTool=document.getElementById('tool-language-tool');
    const permissionTitle=document.querySelector('#perm-language-permission .perm-title');
    check(languageTool.dataset.toolStatus==='completed','tool did not retain its raw status');
    const draft = document.getElementById('input');
    draft.value = '未发送的草稿 Copy 已工作';
    const transcriptBefore = [...messages.querySelectorAll('.md,.work-note')].map(node => node.textContent);
    const menuButton = document.getElementById('btn-settings');
    menuButton.click();
    check(!document.getElementById('settings-menu').hidden,'settings menu did not open');
    const languageSelect = document.getElementById('ui-language');
    languageSelect.value = 'en';
    languageSelect.dispatchEvent(new Event('change'));
    check(window.sent.some(message => message.type === 'setLanguage' && message.language === 'en'),'language choice was not sent to extension');
    emit({type:'ui_language',language:'en',setting:'en'});
    check(document.documentElement.lang === 'en','document language did not change');
    check(document.getElementById('language-label').textContent === 'Interface language','language label was not translated');
    check(document.getElementById('input').placeholder === 'Ask ZCode, @ to add context, / to choose capabilities','composer placeholder was not translated');
    check(document.getElementById('conn-label').textContent === 'Stopped','existing status was not translated');
    check(messages.querySelector('.work-fold-label')?.textContent === 'Worked 1m 5s','work fold did not change language');
    check(permissionTitle.textContent===literalTool+' requires approval','dynamic permission label was reverse-matched or untranslated');
    check(languageTool.querySelector('.tool-status').textContent==='Completed','tool status was not translated');
    check(languageTool.querySelector('.tool-name').textContent===literalTool,'language change modified tool name');
    check(languageTool.querySelector('.tool-io.out').textContent==='用户输出：头发、后台、发布','language change modified tool output');
    emit({type:'tool_call',toolCallId:'language-tool',status:'running'});
    check(languageTool.dataset.toolStatus==='completed','translated completed tool regressed to running');
    emit({type:'status',sessionId:'A',status:'completedInterrupted'});
    check(draft.value === '未发送的草稿 Copy 已工作' ,'language change modified draft');
    check(JSON.stringify([...messages.querySelectorAll('.md,.work-note')].map(node => node.textContent)) === JSON.stringify(transcriptBefore),'language change modified transcript');
    emit({type:'ui_language',language:'zh-TW',setting:'zh-TW'});
    check(document.getElementById('language-label').textContent === '介面語言','Traditional Chinese language was not applied');
    check(permissionTitle.textContent===literalTool+' 需要權限','Traditional Chinese modified dynamic tool name');
    check(languageTool.querySelector('.tool-status').textContent==='已完成','Traditional Chinese tool status failed');
    emit({type:'ui_language',language:'zh-CN',setting:'auto'});
    check(languageSelect.value === 'auto','automatic language preference was not retained');
    check(document.getElementById('conn-label').textContent === '已停止','switching language back failed');
    languageSelect.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    check(document.getElementById('settings-menu').hidden,'Escape did not close settings menu');
    const usageToggle=document.getElementById('context-meter');
    const usagePanel=document.getElementById('usage-panel');
    check(usagePanel.hidden,'usage panel should start collapsed');
    usageToggle.click();
    check(!usagePanel.hidden && usageToggle.getAttribute('aria-expanded')==='true','usage panel did not open');
    check(window.savedState?.usagePanelOpen===true,'usage expansion preference was not saved');
    check([...usagePanel.querySelectorAll('.usage-cell-value')].every(node=>node.textContent==='—'),'missing usage data must not look like zero usage');
    const railBefore=document.getElementById('question-rail').hidden;
    emit({type:'context_usage',used:24000,max:128000,quota:[{label:'5 小时',remainingPercent:62,usedPercent:38,remainingCount:6200,nextResetTime:Date.now()+3600000},{label:'每周',remainingPercent:8,usedPercent:92}]});
    check(document.getElementById('usage-context').title.includes('24,000 / 128,000 tokens'),'exact context counts were not preserved in hover');
    check(document.getElementById('usage-context-percent').textContent==='19%','context percent was wrong');
    check(document.getElementById('usage-five-hour').querySelector('.usage-cell-value').textContent==='38%','five-hour progress must use the percentage used');
    check(document.getElementById('usage-weekly').querySelector('.usage-cell-value').textContent==='92%','weekly progress must use the percentage used');
    check(document.getElementById('usage-five-hour').querySelector('.usage-fill').style.width==='38%','five-hour progress fill was incorrect');
    check(document.getElementById('usage-weekly').classList.contains('hot'),'low quota warning missing');
    check(document.getElementById('question-rail').hidden===railBefore,'usage toggle changed question navigation');
    check(usagePanel.getBoundingClientRect().height<=52,'usage panel exceeds compact labels and details');
    const prevWidth=document.body.style.width;
    document.body.style.width='260px';
    const cells=[...usagePanel.querySelectorAll('.usage-cell')].map(node=>node.getBoundingClientRect());
    check(cells.length===3 && cells.every(rect=>rect.top===cells[0].top),'usage regions wrapped in a narrow sidebar');
    check(cells[0].right<=cells[1].left && cells[1].right<=cells[2].left,'usage regions overlap');
    check(usagePanel.scrollWidth<=usagePanel.clientWidth,'usage panel overflows a narrow sidebar');
    document.body.style.width=prevWidth;
    emit({type:'ui_language',language:'en',setting:'en'});
    check(usagePanel.getAttribute('aria-label')==='Quota and context','usage title did not change language');
    check(document.getElementById('usage-context-label').textContent==='Context','context label did not change language');
    check(document.getElementById('usage-five-hour').title.includes('62% remaining'),'quota tooltip did not change language');
    check(document.getElementById('usage-five-hour').querySelector('.usage-cell-label').textContent==='5h','five-hour label was not compact');
    check(document.getElementById('usage-five-hour').title.includes('Remaining count: 6,200'),'quota count was lost');
    usageToggle.click();
    check(usagePanel.hidden && usageToggle.getAttribute('aria-expanded')==='false','usage panel did not collapse');
    const contextRing=document.getElementById('context-meter');
    check(!contextRing.hidden && contextRing.closest('.composer-toolbar'),'context ring must stay visible in the toolbar when the panel is collapsed');
    check(document.getElementById('context-ring-tip').title.includes('24,000 / 128,000 tokens'),'context ring tooltip lost exact usage');
    check(!document.getElementById('context-ring-tip').title.includes('5 hours'),'context ring tooltip should not include the five-hour quota');
    const fiveHourRingTip=document.getElementById('five-hour-ring-tip');
    check(fiveHourRingTip.title.includes('5 hours') && fiveHourRingTip.title.includes('62% remaining') && fiveHourRingTip.title.includes('Resets:'),'five-hour ring hover lost quota and reset time');
    contextRing.click();
    check(!usagePanel.hidden && contextRing.getAttribute('aria-expanded')==='true','context ring did not open the usage panel');
    contextRing.click();
    check(usagePanel.hidden,'context ring did not collapse the usage panel');
    emit({type:'context_usage',used:256000,max:128000,quota:[]});
    check(document.getElementById('usage-context').getAttribute('aria-valuenow')==='100','over-limit context was not bounded');
    emit({type:'context_usage',quota:[{label:'每周',remainingPercent:40,usedPercent:60}]});
    check(!contextRing.hidden && document.getElementById('usage-weekly').title.includes('Weekly') && document.getElementById('usage-weekly').title.includes('40% remaining'),'weekly quota hover was hidden');
    const draftOwnerBeforeReset=window.savedState.draftSessionId;
    emit({type:'view_reset',clear:true,viewGen:99});
    usageToggle.click();
    check([...usagePanel.querySelectorAll('.usage-cell-value')].every(node=>node.textContent==='—'),'switch retained previous usage values');
    check(window.savedState.composerDrafts[draftOwnerBeforeReset].text==='未发送的草稿 Copy 已工作','switch discarded source draft');
    emit({type:'session_ready',sessionId:draftOwnerBeforeReset,viewGen:99});
    check(draft.value==='未发送的草稿 Copy 已工作','usage panel modified restored draft');
    document.body.setAttribute('data-smoke','passed');
  } catch(error) {
    document.body.setAttribute('data-smoke','failed');
    const errorReport=document.createElement('pre');
    errorReport.id='smoke-error';errorReport.textContent=String(error.stack);document.body.append(errorReport);
  }
  </script></body>`);
  const regressions = await readFile(new URL("./browser-regression-cases.js", import.meta.url), "utf8");
  html = html.replace("</body>", () => `<script nonce="${nonce}">${regressions.replaceAll("</script>", "<\\/script>")}</script></body>`);
  const file = path.join(root, "test.html");
  await writeFile(file, html);
  const result = spawnSync(process.env.CHROME_BIN || "google-chrome", [
    "--headless", "--no-sandbox", "--disable-gpu", "--disable-background-networking",
    "--no-first-run", `--user-data-dir=${path.join(root, "profile")}`,
    "--virtual-time-budget=90000", "--dump-dom", pathToFileURL(file).href,
  ], { encoding: "utf8", timeout: 90000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  if (process.env.SMOKE_DEBUG_DOM) await writeFile("/tmp/smoke-dom.html", result.stdout);
  assert.ok(result.stdout.includes('data-smoke="passed"'), result.stdout.match(/<pre id="smoke-error">([\s\S]*?)<\/pre>/)?.[1] ?? result.stdout.slice(-6000));
  const report = result.stdout.match(/<pre id="audit-results">([\s\S]*?)<\/pre>/);
  assert.ok(report, "Extended browser scenarios did not finish: " + result.stdout.match(/data-audit-test="([^"]*)"/)?.[1]);
  const checks = JSON.parse(report[1].replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"));
  assert.deepEqual(checks.tests.filter(test => test.skipped), [], "Browser regression report contains skipped scenarios after a timeout.");
  assert.deepEqual(checks.tests.filter(test => !test.pass), []);
  assert.deepEqual(checks.errors, []);
  console.log(`Extended browser regression checks passed: ${checks.tests.length}.`);
  console.log("Browser smoke passed: multi-select, quoted options/permissions, stale history, restored reasoning, repeated handoffs, language switching, canonical tool status and quota/context panel (full fixture).");
} finally {
  await rm(root, { recursive: true, force: true });
}
