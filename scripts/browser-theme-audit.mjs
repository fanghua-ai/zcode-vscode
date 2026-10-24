import {build} from 'esbuild';
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';
import assert from 'node:assert/strict';

// Render the actual webview with a fake VS Code bridge and installed stock themes.
// Screenshots/report stay outside the repository. No desktop UI or live model calls.
// Missing JSON entries use registered VS Code defaults, including translucent description text.
const output=path.resolve(process.env.ZCODE_AUDIT_DIR || '/tmp/zcode-theme-audit');
await mkdir(output,{recursive:true});
const themeDir=process.env.VSCODE_THEME_DIR || '/usr/share/code/resources/app/extensions/theme-defaults/themes';
async function theme(name){const file=path.join(themeDir,name);const parsed=ts.parseConfigFileTextToJson(file,await readFile(file,'utf8'));assert.ok(!parsed.error);const t=parsed.config;return {...(t.include?await theme(t.include):{}),...t.colors};}
await build({entryPoints:['src/webviewHtml.ts'],outfile:path.join(output,'html.cjs'),bundle:true,platform:'node',format:'cjs',alias:{vscode:path.resolve('src/testSupport/vscode.ts')}});
const {getWebviewHtml}=createRequire(import.meta.url)(path.join(output,'html.cjs'));
const report=[];
for(const name of ['light_plus','light_modern','dark_plus','dark_modern']){
 const light=name.startsWith('light');
 const defaults={foreground:light?'#616161':'#cccccc',descriptionForeground:light?'#717171':'#ccccccb3',errorForeground:light?'#a1260d':'#f48771','editor.background':light?'#ffffff':'#1e1e1e','editor.foreground':light?'#000000':'#d4d4d4','sideBar.background':light?'#f3f3f3':'#252526','input.background':light?'#ffffff':'#3c3c3c','input.foreground':light?'#616161':'#cccccc','panel.border':light?'#80808059':'#80808059','focusBorder':light?'#0090f1':'#007fd4','textLink.foreground':light?'#006ab1':'#3794ff','button.background':light?'#007acc':'#0e639c','button.foreground':'#ffffff','button.hoverBackground':light?'#0062a3':'#1177bb','button.secondaryBackground':light?'#e5e5e5':'#3a3d41','button.secondaryForeground':light?'#333333':'#ffffff','toolbar.hoverBackground':light?'#00000010':'#ffffff10','dropdown.background':light?'#ffffff':'#3c3c3c','dropdown.foreground':light?'#333333':'#cccccc','dropdown.border':light?'#cecece':'#3c3c3c','widget.shadow':light?'#00000029':'#00000059','input.placeholderForeground':light?'#767676':'#a6a6a6','editorWidget.background':light?'#f3f3f3':'#252526','textCodeBlock.background':light?'#dcdcdc66':'#0a0a0a66','charts.green':light?'#388a34':'#89d185','charts.red':light?'#e51400':'#f14c4c','charts.yellow':light?'#bf8803':'#cca700','editorWarning.foreground':light?'#bf8803':'#cca700','debugTokenExpression.name':light?'#9b46b0':'#c586c0','debugTokenExpression.string':light?'#a31515':'#ce9178','debugTokenExpression.number':light?'#098658':'#b5cea8','symbolIcon.keywordForeground':light?'#616161':'#cccccc','symbolIcon.propertyForeground':light?'#007acc':'#9cdcfe','symbolIcon.classForeground':light?'#d67e00':'#ee9d28'};
 const colors={...defaults,...await theme(name+'.json')};
 for(const width of [280,420])for(const state of ['conversation','running','waiting','permission','settings','error','disabled','history','queue','question','question-jump-hidden','empty','attachments','edit','image-analysis','question-resolved','file-search','math','setup','composer-long']){
  if(process.env.ZCODE_AUDIT_STATES&&!process.env.ZCODE_AUDIT_STATES.split(',').includes(state))continue;
  const key=`${name}-${width}-${state}`;const nonce='theme-audit';
  let html=getWebviewHtml({cspSource:'file:',asWebviewUri:u=>u},pathToFileURL(process.cwd()).href,nonce);html=html.replace('<body>',`<body class="vscode-${light?'light':'dark'}">`);
  const vars=Object.entries(colors).map(([k,v])=>`--vscode-${k.replaceAll('.','-')}:${v}`).join(';');
  html=html.replace('</style>',`:root{${vars};--vscode-font-family:system-ui;--vscode-font-size:13px}body{width:${width}px}*{animation:none!important}</style>`);
  const start=html.indexOf('<script');html=html.slice(0,start)+`<script nonce="${nonce}">window.errors=[];window.addEventListener('error',e=>errors.push(e.message));window.acquireVsCodeApi=()=>({getState:()=>undefined,setState:()=>{},postMessage:()=>{}});</script>`+html.slice(start);
  const fixture=`
  const emit=data=>window.dispatchEvent(new MessageEvent('message',{data}));
  emit({type:'session_ready',sessionId:'audit',title:'设计与主题检查',viewGen:1});
  emit({type:'history',sessionId:'audit',viewGen:1,items:[{id:'question',role:'user',text:'请检查这段代码，并解释改动。',tools:[]},{id:'answer',role:'assistant',text:'已检查。\\n\\n保持清晰的视觉层级和一致的交互。\\n\\n\\x60\\x60\\x60js\\n// A readable comment\\nconst count = 42;\\nfunction greet(name) { return "Hello " + name; }\\n\\x60\\x60\\x60',tools:[],steps:[{kind:'reasoning',text:'先检查默认状态，再检查生成、警告与错误。'},{kind:'text',text:'已检查。\\n\\n保持清晰的视觉层级。\\n\\n\\x60\\x60\\x60js\\n// A readable comment\\nconst count = 42;\\nfunction greet(name) { return "Hello " + name; }\\n\\x60\\x60\\x60'}]}]});
  emit({type:'conversation_sync',sessionId:'audit',editable:{target:{rowId:1,entityId:'question'},text:'请检查这段代码，并解释改动。'},turns:[]});
  emit({type:'models',current:{providerId:'vendor',modelId:'GLM-5.3'}});
  emit({type:'session_controls',mode:'build',thoughtEnabled:true,thoughtLevel:'high',thoughtLevels:[{value:'high',label:'High'}]});
  emit({type:'context_usage',used:102400,max:128000,quota:[{label:'5 小时',remainingPercent:60,nextResetTime:Date.now()+7200000},{label:'每周',remainingPercent:5,nextResetTime:Date.now()+604800000}]});
  document.getElementById('context-meter').click();
  document.querySelectorAll('.work-fold-btn').forEach(button=>button.click());
  emit({type:'tool_call',toolCallId:'theme-shell-1',toolName:'shell',status:'completed',inputText:JSON.stringify({command:'git status --short'})});
  emit({type:'tool_call',toolCallId:'theme-shell-2',toolName:'shell',status:'running',inputText:JSON.stringify({command:'npm run check'})});
  emit({type:'tool_call',toolCallId:'theme-shell-3',toolName:'shell',status:'completed',inputText:JSON.stringify({command:'echo ready'})});
  if(${JSON.stringify(state)}==='composer-long'){const input=document.getElementById('input');input.value='长草稿 mixed English line\\n'.repeat(24);input.dispatchEvent(new Event('input'));}
  if(${JSON.stringify(state)}==='running'){emit({type:'status',sessionId:'audit',status:'running'});document.getElementById('input').value='继续检查';document.getElementById('input').dispatchEvent(new Event('input'));}
  if(${JSON.stringify(state)}==='waiting'){emit({type:'view_reset',clear:true,viewGen:2});emit({type:'session_ready',sessionId:'audit',title:'等待首段输出',viewGen:2});emit({type:'history',sessionId:'audit',viewGen:2,items:[]});emit({type:'stream_release'});const input=document.getElementById('input');input.value='请检查这段代码。';input.dispatchEvent(new Event('input'));document.getElementById('send-btn').click();}
  if(${JSON.stringify(state)}==='permission')emit({type:'permission_request',requestId:'audit-permission',toolName:'shell',reason:'需要确认后继续',options:[{optionId:'allow_once',kind:'allow_once',name:'允许一次'},{optionId:'deny_once',kind:'deny_once',name:'拒绝'}]});
  if(${JSON.stringify(state)}==='attachments'){
   emit({type:'file_added',sessionId:'audit',chip:{path:'/project/src/very-long-component-file.ts',relPath:'src/very-long-component-file.ts'}});
   emit({type:'image_pending',sessionId:'audit',imageId:'theme-image',fileName:'design-reference-light-and-dark.png',mime:'image/png',bytes:100});
   emit({type:'image_ready',sessionId:'audit',imageId:'theme-image',attachment:{ref:'image-ref',fileName:'design-reference-light-and-dark.png',mime:'image/png',bytes:100},dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGMM6LnDgA0wYRUdtBIAWtsByEY277MAAAAASUVORK5CYII='});
   document.getElementById('input').value='按这个设计继续完善';document.getElementById('input').dispatchEvent(new Event('input'));
  }
  if(${JSON.stringify(state)}==='settings')document.getElementById('btn-settings').click();
  if(${JSON.stringify(state)}==='setup')emit({type:'setup',reason:'No saved credentials',hint:'Original diagnostic',picker:[]});
  if(${JSON.stringify(state)}==='error')emit({type:'session_error',message:'同步失败，请稍后重试。'});
  if(${JSON.stringify(state)}==='disabled')emit({type:'view_reset',viewGen:2});
  if(${JSON.stringify(state)}==='history'){emit({type:'sessions',currentId:'audit',sessions:[{sessionId:'audit',title:'设计与主题检查',status:'running',model:{modelId:'GLM-5.3'},updatedAt:Date.now()},{sessionId:'archived-test',title:'上一轮检查',status:'completed',updatedAt:Date.now()-3600000}]});document.getElementById('btn-sessions').click();}
  if(${JSON.stringify(state)}==='queue'){emit({type:'status',sessionId:'audit',status:'running'});const input=document.getElementById('input');input.value='排队继续检查';input.dispatchEvent(new Event('input'));document.getElementById('send-btn').click();}
  if(${JSON.stringify(state)}==='question')emit({type:'user_input_request',requestId:'theme-choice',questions:[{header:'设计',question:'要保留哪种布局？',options:[{value:'compact',label:'紧凑布局'},{value:'wide',label:'宽松布局'}]}]});
  if(${JSON.stringify(state)}==='question-jump-hidden'){const setting=document.getElementById('show-question-jump');setting.checked=false;setting.dispatchEvent(new Event('change'));}
  if(${JSON.stringify(state)}==='empty'){emit({type:'status',sessionId:'audit',status:'completedSuccess'});emit({type:'view_reset',clear:true,viewGen:2});emit({type:'session_ready',sessionId:'empty-audit',viewGen:2});emit({type:'history',sessionId:'empty-audit',viewGen:2,items:[]});}

  if(${JSON.stringify(state)}==='edit') document.querySelector('.turn-edit-btn').click();
  if(${JSON.stringify(state)}==='image-analysis') {
    emit({type:'status',sessionId:'audit',status:'running'});
    emit({type:'tool_call',toolCallId:'theme-image',toolName:'analyze_image',status:'completed',inputText:JSON.stringify({imageSource:'https://example.invalid/screenshot.png?Signature=PRIVATE',prompt:'解释截图'}),outputText:JSON.stringify([{text:'完整分析结果：界面清晰，附件和文件引用保持紧凑。'}])});
    document.getElementById('tool-theme-image').querySelector('.tool-head').click();
  }

  if(${JSON.stringify(state)}==='question-resolved') {
    emit({type:'status',sessionId:'audit',status:'running'});
    emit({type:'user_input_request',requestId:'theme-resolved-question',questions:[{header:'范围',question:'要修改哪些部分？',multiSelect:true,options:[{value:'code',label:'代码'},{value:'docs',label:'文档'}]}]});
    const card=document.getElementById('ask-theme-resolved-question');card.querySelector('[data-val="code"]').click();card.querySelector('[data-val="docs"]').click();card.querySelector('[data-act="submit"]').click();
  }

  if(${JSON.stringify(state)}==='file-search') {
    emit({type:'sessions',currentId:'audit',includeArchived:false,sessions:[{sessionId:'audit',title:'设计与主题检查'},{sessionId:'sess_theme_review',title:'ZCL 会话同步设计记录'}]});
    const input=document.getElementById('input');input.value='@zcl';input.dispatchEvent(new Event('input'));
    emit({type:'workspace_files',requestId:'files-1',sessionId:'audit',files:[{path:'/test/src/zcodeClient.ts',relPath:'src/zcodeClient.ts'},{path:'/test/src/zcodeClient.test.ts',relPath:'src/zcodeClient.test.ts'},{path:'/test/packages/long/directory/zcodeClient.ts',relPath:'packages/long/directory/zcodeClient.ts'}]});
  }
  if(${JSON.stringify(state)}==='math') {
    emit({type:'assistant_text_delta',partId:'math-audit',fullText:${JSON.stringify(String.raw`行内公式 $E=mc^2$，分数 \(\frac{a}{b}\)。

$$\int_0^1 x^2\,dx = \frac{1}{3}$$

$$\begin{pmatrix}1&2\\3&4\end{pmatrix}$$

$$a_1+a_2+a_3+a_4+a_5+a_6+a_7+a_8+a_9+a_{10}+a_{11}+a_{12}=b$$`)}});emit({type:'status',sessionId:'audit',status:'completedSuccess'});
  }
  function rgba(s){const nums=s.match(/[\\d.]+/g);if(!nums)return [0,0,0,0];const c=nums.map(Number);if(s.startsWith('color(srgb'))for(let i=0;i<3;i++)c[i]*=255;return c;}
  function mix(f,b){const a=f.length>3?f[3]:1;return f.slice(0,3).map((v,i)=>v*a+b[i]*(1-a));}
  function background(el){const stack=[];for(let n=el;n;n=n.parentElement)stack.push(rgba(getComputedStyle(n).backgroundColor));let b=${light?'[255,255,255]':'[30,30,30]'};for(const f of stack.reverse())b=mix(f,b);return b;}
  function luminance(c){return c.map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4}).reduce((v,x,i)=>v+x*[.2126,.7152,.0722][i],0);}
  const samples=[];
  for(const selector of ['.image-chip','#attach-files','.empty-title','#conn-label','#pending-action','#copy-diagnostics','#model-chip','#mode-chip','#thought-chip','.usage-cell-label','.usage-cell-value','.usage-cell-detail','.katex','.hljs-keyword','.hljs-string','.hljs-number','.hljs-title','.hljs-comment','.hljs-attr','.hljs-built_in','.work-note','.reasoning-head','.tool-name','.tool-preview','.process-group','.process-icon','.turn-edit-btn','.turn-collapse-btn','.msg-copy','.md p','.msg-meta','.work-fold-label','.code-toolbar','.queued-tag','.queued-actions button','.overlay-group','.oi-title','.oi-live','.oi-sub','.tab-btn','.ask-q','.ask-prompt','#input::placeholder','.perm-actions button','.perm-reason','.err-actions button','.err-guidance','.error-details summary','#setup-hint','.message.error > div:first-child','.icon-btn','.context-meter','#rail-toggle','.send:not([hidden]):not(:disabled)'])for(const el of document.querySelectorAll(selector.replace('::placeholder',''))){
   if(!el.getBoundingClientRect().height)continue;const style=getComputedStyle(el,selector.endsWith('::placeholder')?'::placeholder':null);let opacity=1;for(let n=el;n;n=n.parentElement)opacity*=Number(getComputedStyle(n).opacity);const bg=background(el),color=rgba(style.color),fg=mix([...color.slice(0,3),opacity*(color.length>3?color[3]:1)],bg);const a=luminance(fg),b=luminance(bg);samples.push({selector,text:el.textContent.slice(0,24),contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),color:style.color});
  }
  const toggle=document.getElementById('rail-toggle'),composer=document.querySelector('.composer-card');
  const toggleRect=toggle.getBoundingClientRect(),composerRect=composer.getBoundingClientRect();
  const questionJump={hidden:toggle.hidden,parent:toggle.parentElement.className,borderTop:getComputedStyle(composer).borderTopColor,background:getComputedStyle(toggle).backgroundColor,height:toggleRect.height,centerOnBorder:Math.abs((toggleRect.top+toggleRect.bottom)/2-composerRect.top)<1.5};
  const composerInput=document.getElementById('input'),composerRail=document.querySelector('#input-area > .soft-scroll.y');
  const composerScroll={hidden:composerRail.hidden,thumbWidth:parseFloat(getComputedStyle(composerRail.querySelector('.soft-thumb')).width),nativeHidden:getComputedStyle(composerInput).scrollbarWidth==='none',height:composerInput.clientHeight,overflow:composerInput.scrollHeight>composerInput.clientHeight+1};
  const pre=document.createElement('pre');pre.id='theme-report';pre.hidden=true;pre.textContent=JSON.stringify({samples,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,errors:window.errors,questionJump,composerScroll});document.body.appendChild(pre);
  if(${JSON.stringify(state)}==='math')document.fonts.ready.then(()=>{const data=JSON.parse(pre.textContent);data.mathFontsLoaded=[...document.fonts].some(face=>face.family.replaceAll('"','')==='KaTeX_Main'&&face.status==='loaded');pre.textContent=JSON.stringify(data);});
  `;
  html=html.replace('</body>',()=>`<script nonce="${nonce}">${fixture}</script></body>`);
  const file=path.join(output,key+'.html');await writeFile(file,html);
  const r=spawnSync(process.env.CHROME_BIN || 'google-chrome',['--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--no-first-run',`--user-data-dir=${path.join(output,'profile-'+key)}`,'--hide-scrollbars',`--window-size=${width},760`,'--virtual-time-budget=1500',`--screenshot=${path.join(output,key+'.png')}`,'--dump-dom',pathToFileURL(file).href],{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
  assert.equal(r.status,0,r.stderr);const match=r.stdout.match(/<pre id="theme-report" hidden="">([\s\S]*?)<\/pre>/);assert.ok(match,`No report for ${key}`);const data=JSON.parse(match[1].replaceAll('&quot;','"').replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&'));assert.deepEqual(data.errors,[]);if(state==='composer-long'){assert.equal(data.composerScroll.hidden,false,key+' composer rail visible');assert.equal(data.composerScroll.thumbWidth,2,key+' composer hairline');assert.equal(data.composerScroll.nativeHidden,true,key+' native scrollbar hidden');assert.equal(data.composerScroll.overflow,true,key+' long composer overflow');assert.equal(data.composerScroll.height,160,key+' composer height cap');}if(state==='math')assert.equal(data.mathFontsLoaded,false,key+' formula fonts should not be bundled');if(state==='question'){assert.equal(data.questionJump.hidden,false,key+' visible jump toggle');assert.equal(data.questionJump.parent,'composer-toggles',key+' toggle in top-edge wrapper');assert.equal(data.questionJump.centerOnBorder,true,key+' toggle centered on composer border');assert.equal(data.questionJump.height,10,key+' compact top-edge background height');assert.notEqual(data.questionJump.background,'rgba(0, 0, 0, 0)',key+' toggle masks border with composer surface');assert.notEqual(data.questionJump.borderTop,'rgba(0, 0, 0, 0)',key+' native composer border');}if(state==='question-jump-hidden'){assert.equal(data.questionJump.hidden,true,key+' hidden jump toggle');assert.notEqual(data.questionJump.borderTop,'rgba(0, 0, 0, 0)',key+' complete composer border');}assert.equal(data.overflow,false,key+' overflow');report.push({key,...data});await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log('Rendered '+key);await rm(path.join(output,'profile-'+key),{recursive:true,force:true});
 }
}
await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
for(const row of report){const low=row.samples.filter(s=>s.contrast<4.5&&!s.selector.includes('send')&&!s.selector.includes('icon-btn')&&!s.selector.includes('context-meter')&&!s.selector.includes('rail-toggle'));if(low.length)console.log(row.key,JSON.stringify(low));}
// Compare unrounded ratios so a marginal failure cannot round up to the threshold.
const failures=report.flatMap(r=>r.samples.filter(s=>s.contrast < (s.selector.includes('icon-btn')||s.selector.includes('context-meter')||s.selector.includes('rail-toggle')||s.selector.includes('send')?3:4.5)).map(s=>({case:r.key,...s})));await writeFile(path.join(output,'contrast-failures.json'),JSON.stringify(failures,null,2));assert.deepEqual(failures,[],'Readable text/icon contrast regression');
console.log(`Rendered ${report.length} stock-theme cases; screenshots and contrast samples: ${output}`);
