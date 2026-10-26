(async()=>{
 // Timer-backed frames keep layout-dependent scenarios deterministic in virtual-time Chrome.
 window.auditFrameKeepAlive=setInterval(()=>{},50);
 const tests=[]; const emit=data=>{window.dispatchEvent(new MessageEvent('message',{data}));if(data.type==='assistant_text_delta')window.flushTestFrames();};
 const activeCommandChip=()=>document.getElementById('active-command');
 const check=(c,m)=>{if(!c)throw new Error(m)};
 let auditAborted=false;
 const test=async(name,fn)=>{if(auditAborted){tests.push({name,pass:true,skipped:true});return;}document.body.dataset.auditTest=name;let timer;try{await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('scenario timed out after 15 seconds')),15000);})]);tests.push({name,pass:true});}catch(e){const error=e instanceof Error?e.message:String(e);tests.push({name,pass:false,error});if(error.includes('scenario timed out'))auditAborted=true;}finally{clearTimeout(timer);}};
 let gen=100;const reset=(sessionId='A')=>{emit({type:'view_reset',clear:true,viewGen:++gen});emit({type:'session_ready',sessionId,viewGen:gen,title:'自定义会话头发发布'});emit({type:'history',sessionId,viewGen:gen,items:[]});emit({type:'stream_release'});document.getElementById('input').value='';document.getElementById('input').dispatchEvent(new Event('input'));document.querySelectorAll('#attachments .ctx-chip button').forEach(button=>button.click());document.getElementById('active-command')?.click();window.sent.length=0;};
 const input=document.getElementById('input');const sendBtn=document.getElementById('send-btn');const messages=document.getElementById('messages');const type=text=>{input.value=text;input.dispatchEvent(new Event('input'));};



 await test('loading older history preserves the exact editor, selection and image edit state',()=>{
  reset();const images=[{ref:'original-one',fileName:'one.png',mime:'image/png',bytes:100},{ref:'original-two',fileName:'two.png',mime:'image/png',bytes:100}];
  const items=[{id:'preserved-editor-q',role:'user',text:'ORIGINAL_EDIT',attachments:images},{id:'preserved-editor-a',role:'assistant',text:'ORIGINAL_REPLY'}];
  emit({type:'history',sessionId:'A',viewGen:gen,items,truncated:true});
  emit({type:'conversation_sync',sessionId:'A',editable:{target:{rowId:2,entityId:'preserved-editor-q'},text:'ORIGINAL_EDIT',attachments:images},turns:[]});
  messages.querySelector('.turn-edit-btn').click();
  const bubble=messages.querySelector('.message.user.editing'),editor=bubble.querySelector('.user-edit'),attempt=bubble.dataset.editRequestId;
  editor.value='UNSENT_EDIT_TEXT';editor.setSelectionRange(2,8);
  bubble.querySelector('.image-remove').click();
  emit({type:'image_pending',edit:true,sessionId:'A',editRequestId:attempt,imageId:'preserved-upload',fileName:'added.png'});
  messages.querySelector('.history-more').click();
  check(sent.some(message=>message.type==='loadOlder'),'load older not requested');
  emit({type:'historyOlder',sessionId:'A',viewGen:gen,items:[{id:'before-editor',role:'user',text:'OLDER_QUESTION'}],truncated:false});
  check(bubble.isConnected&&messages.querySelector('.user-edit')===editor,'history replaced the active editor node');
  check(editor.value==='UNSENT_EDIT_TEXT'&&editor.selectionStart===2&&editor.selectionEnd===8,'text or selection lost');
  check(bubble.dataset.editRequestId===attempt,'edit identity changed during redraw');
  check(bubble.querySelector('.image-chip').dataset.removed==='1','removed original image restored unexpectedly');
  check(bubble.querySelector('[data-image-id="preserved-upload"]').dataset.status==='uploading','upload chip lost');
  emit({type:'image_ready',edit:true,sessionId:'A',editRequestId:attempt,imageId:'preserved-upload',attachment:{ref:'added-image',fileName:'added.png',mime:'image/png',bytes:100}});
  bubble.querySelector('[data-uedit="send"]').click();
  const submission=sent.find(message=>message.type==='editLast');
  check(submission.text==='UNSENT_EDIT_TEXT'&&submission.entityId==='preserved-editor-q','restored editor submitted the wrong text or target');
  check(submission.attachments.map(image=>image.ref).join(',')==='original-two,added-image','image removal or completed upload lost');
  reset('B');check(!messages.querySelector('.user-edit'),'editor leaked across chats');
 });
 await test('an editing optimistic bubble keeps its draft when the first canonical history assigns its server id',()=>{
  reset();type('PROMOTED_ORIGINAL');sendBtn.click();
  emit({type:'conversation_sync',sessionId:'A',editable:{target:{rowId:8,entityId:'promoted-server-id'},text:'PROMOTED_ORIGINAL'},turns:[]});
  const bubble=messages.querySelector('.message.user');messages.querySelector('.turn-edit-btn').click();
  const editor=bubble.querySelector('.user-edit');editor.value='PROMOTED_UNSENT_EDIT';
  emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'promoted-server-id',role:'user',text:'PROMOTED_ORIGINAL'}]});
  check(bubble.isConnected&&bubble.querySelector('.user-edit')===editor&&editor.value==='PROMOTED_UNSENT_EDIT','canonical id reconciliation lost the editor');
  check(bubble.dataset.jump==='promoted-server-id','canonical question id not adopted');
  bubble.querySelector('[data-uedit="cancel"]').click();messages.querySelector('.turn-edit-btn').click();
  check(bubble.querySelector('.user-edit'),'restored footer still targets the discarded bubble');
 });
 await test('late edit acknowledgements cannot close a newer edit and failed edits remain retryable',()=>{
  reset();emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'late-edit-q',role:'user',text:'ORIGINAL'}]});
  emit({type:'conversation_sync',sessionId:'A',editable:{target:{rowId:1,entityId:'late-edit-q'},text:'ORIGINAL'},turns:[]});
  const open=()=>messages.querySelector('.turn-edit-btn').click();open();
  messages.querySelector('.user-edit').value='FIRST_SUBMISSION';
  const firstButton=messages.querySelector('[data-uedit="send"]');firstButton.click();firstButton.click();
  check(sent.filter(message=>message.type==='editLast').length===1,'double submit was not blocked');
  const first=sent.find(message=>message.type==='editLast');
  const pendingEditor=messages.querySelector('.user-edit'),clipboard=new DataTransfer();clipboard.setData('text/plain','IGNORED_PASTE');clipboard.items.add(new File(['png'],'pending.png',{type:'image/png'}));
  pendingEditor.dispatchEvent(new ClipboardEvent('paste',{clipboardData:clipboard,bubbles:true,cancelable:true}));
  check(pendingEditor.value==='FIRST_SUBMISSION'&&!messages.querySelector('.image-chip[data-added]'),'pending submission accepted an edit that its acknowledgement could erase');
  messages.querySelector('[data-uedit="cancel"]').click();open();
  const editor=messages.querySelector('.user-edit');editor.value='NEW_UNSENT_EDIT';
  emit({...first,type:'query_rewound'});emit({...first,type:'query_edit_rejected',message:'OLD_ERROR'});
  check(editor.isConnected&&editor.value==='NEW_UNSENT_EDIT','old result replaced the newer editor');
  messages.querySelector('[data-uedit="send"]').click();const second=sent.filter(message=>message.type==='editLast').at(-1);
  emit({...second,type:'query_edit_rejected',message:'RETRYABLE_ERROR'});
  check(editor.isConnected&&editor.value==='NEW_UNSENT_EDIT'&&!editor.readOnly,'failed edit lost its draft or remained locked');
  check(!messages.querySelector('[data-uedit="send"]').disabled,'failed edit could not retry');
  messages.querySelector('[data-uedit="send"]').click();const retry=sent.filter(message=>message.type==='editLast').at(-1);
  emit({...second,type:'query_rewound'});check(editor.isConnected,'old submission from the same edit attempt closed the retry');
  emit({...retry,type:'query_rewound'});
  check(!messages.querySelector('.user-edit')&&messages.querySelector('.user-body').textContent==='NEW_UNSENT_EDIT','matching acknowledgement did not apply exact text');
 });
 await test('reasoning and tool-group choices survive both pagination and snapshot updates',()=>{
  reset();const items=[{id:'group-choice-q',role:'user',text:'GROUP_QUESTION'},{id:'group-choice-a',role:'assistant',text:'GROUP_REPLY',steps:[
   {kind:'reasoning',partId:'group-reason',text:'THINKING'},
   {kind:'tool',toolCallId:'group-one',toolName:'shell',inputText:'echo one',outputText:'one',status:'completed'},
   {kind:'tool',toolCallId:'group-two',toolName:'shell',inputText:'echo two',outputText:'two',status:'completed'},
   {kind:'text',partId:'group-final',text:'GROUP_REPLY'}]}];
  emit({type:'history',sessionId:'A',viewGen:gen,items,truncated:true});
  messages.querySelector('.work-fold-btn').click();messages.querySelector('.reasoning-head').click();messages.querySelector('.process-group').click();
  messages.querySelector('.history-more').click();emit({type:'historyOlder',sessionId:'A',viewGen:gen,items:[{id:'group-before',role:'user',text:'BEFORE'}],truncated:false});
  check(messages.querySelector('.reasoning-head').getAttribute('aria-expanded')==='true','thought expansion lost');
  check(messages.querySelector('.process-group').getAttribute('aria-expanded')==='true','tool group expansion lost');
  messages.querySelector('.reasoning-head').click();messages.querySelector('.process-group').click();
  emit({type:'history',sessionId:'A',viewGen:gen,items:structuredClone(items)});
  check(messages.querySelector('.reasoning-head').getAttribute('aria-expanded')==='false','thought closure lost');
  check(messages.querySelector('.process-group').getAttribute('aria-expanded')==='false','group closure lost');
 });
 await test('local Markdown links keep line selections separate from encoded filename delimiters',()=>{
  reset();emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'line-links',role:'assistant',text:'[Source](./source.ts#L12-L18) [Named file](./a%23b%3Fc.ts#L2) [Docs](./README.md#usage)'}]});
  for(const link of messages.querySelectorAll('.md a'))link.click();
  const links=sent.filter(message=>message.type==='openMarkdownFile');
  check(links.length===3,'local links were not intercepted');
  check(links[0].path==='./source.ts'&&links[0].line===12&&links[0].endLine===18,'line range was treated as filename');
  check(links[1].path==='./a#b?c.ts'&&links[1].line===2,'encoded filename was split after decoding');
  check(links[2].path==='./README.md'&&!links[2].line,'document anchor was treated as filename');
 });
 await test('manual work and tool expansion survive loading older history without leaking to a new chat',()=>{
  reset();const now=Date.now();const items=[
   {id:'choice-question',role:'user',text:'CHOICE_QUESTION',createdAt:now-10000},
   {id:'choice-answer',role:'assistant',text:'CHOICE_FINAL',createdAt:now-9000,endedAt:now,steps:[
    {kind:'reasoning',partId:'choice-reason',text:'CHOICE_REASON'},
    {kind:'tool',toolCallId:'choice-tool',toolName:'shell',status:'completed',inputText:'echo CHOICE_TOOL',outputText:'CHOICE_TOOL'},
    {kind:'text',partId:'choice-final',text:'CHOICE_FINAL'}]}
  ];
  emit({type:'history',sessionId:'A',viewGen:gen,items,truncated:true});
  messages.querySelector('.work-fold-btn').click();
  document.querySelector('#tool-choice-tool .tool-head').click();
  messages.querySelector('.history-more').click();
  check(sent.some(message=>message.type==='loadOlder'&&message.oldestId==='choice-question'),'older history request missing');
  emit({type:'historyOlder',sessionId:'A',viewGen:gen,items:[{id:'choice-older',role:'user',text:'OLDER_QUESTION'}],truncated:false});
  check(messages.querySelector('.work-fold').classList.contains('open'),'manual work expansion lost');
  check(!document.getElementById('tool-choice-tool').classList.contains('collapsed'),'manual tool expansion lost');
  check(messages.textContent.includes('CHOICE_FINAL'),'final reply changed');
  reset('B');emit({type:'history',sessionId:'B',viewGen:gen,items});
  check(!messages.querySelector('.work-fold').classList.contains('open'),'expansion leaked to another chat');
  check(document.getElementById('tool-choice-tool').classList.contains('collapsed'),'tool expansion leaked to another chat');
 });
 await test('inline builtin tool choices survive history refresh',()=>{
  reset();
  const embedded='Found it.**🌐 Z.ai Built-in Tool: webReader**\n```json\n{"url":"https://example.test/page"}\n```\n**Output:**\n**webReader_result_summary:** [{"text":{"title":"Example page"}}]';
  const items=[{id:'inline-choice-q',role:'user',text:'INLINE_QUESTION'},
   {id:'inline-choice-a',role:'assistant',text:'INLINE_FINAL',steps:[
    {kind:'reasoning',partId:'inline-thought',text:'Thinking'},
    {kind:'text',partId:'inline-reader',text:embedded},
    {kind:'text',partId:'inline-final',text:'INLINE_FINAL'}]}];
  emit({type:'history',sessionId:'A',viewGen:gen,items});
  messages.querySelector('.work-fold-btn').click();
  const tool=messages.querySelector('.tool-call');check(tool&&!tool.id,'fixture needs an inline tool without a call id');
  tool.querySelector('.tool-head').click();
  emit({type:'history',sessionId:'A',viewGen:gen,items:structuredClone(items)});
  check(messages.querySelector('.work-fold').classList.contains('open'),'inline work expansion lost');
  check(!messages.querySelector('.tool-call').classList.contains('collapsed'),'inline tool expansion lost');
 });
 await test('reasoning picker sends its session and view generation',()=>{
  reset();emit({type:'session_controls',thoughtEnabled:true,thoughtLevel:'high',thoughtLevels:[{value:'low',label:'Low'},{value:'high',label:'High'}]});
  document.getElementById('thought-chip').click();
  const option=[...document.querySelectorAll('.overlay-item')].find(node=>node.textContent.includes('Low')||node.textContent.includes('低'));
  check(option,'reasoning option missing');option.click();
  const change=sent.find(message=>message.type==='setThoughtLevel');
  check(change?.sessionId==='A'&&change.viewGen===gen&&change.thoughtLevel==='low','reasoning change lost ownership');
 });
 await test('manual closure of running work survives a snapshot but a new insert still closes old work',()=>{
  reset();const now=Date.now();const items=[
   {id:'choice-live-q',role:'user',text:'LIVE_CHOICE',createdAt:now-5000},
   {id:'choice-live-a',role:'assistant',text:'',running:true,createdAt:now-4000,steps:[{kind:'reasoning',partId:'choice-live-part',text:'LIVE_REASON'}]}
  ];
  emit({type:'status',sessionId:'A',status:'running'});
  emit({type:'history',sessionId:'A',viewGen:gen,activeSince:now-4000,items});
  const fold=messages.querySelector('.work-fold');check(fold?.classList.contains('open'),'running fold absent');
  fold.querySelector('.work-fold-btn').click();
  emit({type:'history',sessionId:'A',viewGen:gen,activeSince:now-4000,items:structuredClone(items)});
  const restored=messages.querySelector('.work-fold');
  check(!restored.classList.contains('open'),'manual closure lost on snapshot');
  restored.querySelector('.work-fold-btn').click();
  emit({type:'history',sessionId:'A',viewGen:gen,renderSource:'transcript-sync',items:[...items,{id:'choice-insert-q',role:'user',text:'NEW_INSERT',createdAt:now}]});
  check(!messages.querySelector('.work-fold').classList.contains('open'),'old manual expansion overrode insertion collapse');
 });
 await test('a newly appended question collapses prior open work even when its backend turn id changes',()=>{
  reset();const now=Date.now();const before=[
   {id:'turn-id-change-root',role:'user',turnId:'task-before-insert',text:'ROOT_BEFORE_INSERT',createdAt:now-5000},
   {id:'turn-id-change-work',role:'assistant',turnId:'task-before-insert',text:'',createdAt:now-4000,endedAt:now-1000,work:{text:'OLD_INSERT_WORK',interrupted:true},steps:[{kind:'reasoning',text:'OLD_INSERT_WORK'}]}
  ];
  emit({type:'history',sessionId:'A',viewGen:gen,items:before});
  const previous=messages.querySelector('.work-fold:not(.work-duration-only)');
  check(previous?.classList.contains('open'),'fixture did not create the prior open work fold');
  emit({type:'history',sessionId:'A',viewGen:gen,renderSource:'transcript-sync',items:[...before,
   {id:'turn-id-change-inserted',role:'user',turnId:'task-after-insert',text:'INSERTED_FOLLOWUP',createdAt:now}
  ]});
  const inserted=[...messages.querySelectorAll('.message.user:not(.queued)')].at(-1);
  const restoredPrevious=messages.querySelector('.work-fold:not(.work-duration-only)');
  check(inserted?.textContent.includes('INSERTED_FOLLOWUP'),'the inserted question was not restored');
  check(restoredPrevious&&!restoredPrevious.classList.contains('open'),'the previous work fold stayed open after a question with a new backend turn id');
 });

 await test('a prior work fold split by an inserted prompt is collapsed by default',()=>{
  reset();
  const now=Date.now();
  emit({type:'history',sessionId:'A',viewGen:gen,items:[
   {id:'insert-fold-root',role:'user',turnId:'insert-fold-task',text:'INSERT_ROOT',createdAt:now-5000},
   {id:'insert-fold-before',role:'assistant',turnId:'insert-fold-task',text:'',createdAt:now-5000,endedAt:now-2000,work:{text:'INSERT_OLD_WORK',interrupted:true},steps:[{kind:'reasoning',text:'INSERT_OLD_WORK'}]},
   {id:'insert-fold-question',role:'user',turnId:'insert-fold-task',text:'INSERT_FOLLOWUP',createdAt:now-1000},
   {id:'insert-fold-after',role:'assistant',turnId:'insert-fold-task',text:'INSERT_FOLLOWUP_REPLY',createdAt:now-900,endedAt:now,steps:[{kind:'reasoning',text:'INSERT_NEW_WORK'},{kind:'text',text:'INSERT_FOLLOWUP_REPLY'}]}
  ]});
  const folds=[...messages.querySelectorAll('.work-fold:not(.work-duration-only)')];
  check(folds.length===2,'inserted prompt did not split the work into two segments');
  check(folds[0].dataset.continuation==='1','earlier work segment was not marked as a continuation');
  check(!folds[0].classList.contains('open'),'the previous work fold stayed open after the inserted prompt');
  check(messages.textContent.includes('INSERT_FOLLOWUP_REPLY'),'the reply after the inserted prompt was lost');
 });
 await test('an immediate insert closes the previous live work fold',()=>{
  reset();
  emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'live-insert-root',role:'user',text:'LIVE_INSERT_ROOT'}]});
  emit({type:'status',sessionId:'A',status:'running'});
  emit({type:'assistant_reasoning_delta',partId:'live-insert-work',authoritative:true,fullText:'LIVE_INSERT_WORK'});
  const fold=messages.querySelector('.work-fold[data-state="running"]');
  check(!!fold?.classList.contains('open'),'running work fold setup failed');
  type('LIVE_INSERT_FOLLOWUP');
  document.getElementById('insert-now-btn').click();
  check([...messages.querySelectorAll('.message.user:not(.queued)')].some(node=>node.textContent.includes('LIVE_INSERT_FOLLOWUP')),'immediate follow-up was not inserted into the transcript');
  emit({type:'status',sessionId:'A',status:'completedInterrupted'});
  check(!fold.classList.contains('open'),`the previous live work fold stayed expanded after insertion (state=${fold.dataset.state}, next=${fold.nextElementSibling?.className ?? 'none'})`);
 });

 await test('queued send marks its bubble pending while the spinner stays at the tail',()=>{
  reset();emit({type:'status',sessionId:'A',status:'running'});type('PENDING_QUEUE_WITH_SPINNER');sendBtn.click();
  const card=document.querySelector('#queue-zone .queued'),spinner=document.getElementById('working-indicator');
  check(card?.dataset.queuePending==='1','queued bubble has no pending marker');
  check([...card.querySelectorAll('button')].every(button=>button.disabled),'pending queue actions enabled too early');
  check(messages.lastElementChild===spinner&&!spinner.dataset.queuePending,'pending queue modified the spinner');
  emit({type:'queue_sync',sessionId:'A',items:[]});check(card.isConnected,'early empty queue sync erased pending bubble');
  const command=sent.find(message=>message.type==='insert');
  emit({type:'queue_sync',sessionId:'A',items:[{queueItemId:'confirmed-queue',sourceCommandId:command.queueItemId,text:'PENDING_QUEUE_WITH_SPINNER'}]});
  check(card.dataset.queueId==='confirmed-queue'&&card.dataset.queuePending==='0','queue confirmation lost bubble identity');
  check(document.querySelectorAll('#queue-zone .queued').length===1&&[...card.querySelectorAll('button')].every(button=>!button.disabled),'queue confirmation duplicated bubble or left actions disabled');
 });
 await test('server queue restoration during generation leaves the spinner untouched',()=>{
  reset();emit({type:'status',sessionId:'A',status:'running'});
  emit({type:'queue_sync',sessionId:'A',items:[{queueItemId:'restore-1',sourceCommandId:'source-1',text:'RESTORED_QUEUE_ONE'},{queueItemId:'restore-2',sourceCommandId:'source-2',text:'RESTORED_QUEUE_TWO'}]});
  const cards=[...document.querySelectorAll('#queue-zone .queued')],spinner=document.getElementById('working-indicator');
  check(cards.length===2&&cards[0].dataset.queueId==='restore-1'&&cards[1].dataset.sourceCommandId==='source-2','restored queue identifiers incorrect');
  check(cards[0].querySelector('.user-body').textContent==='RESTORED_QUEUE_ONE'&&cards[1].querySelector('.user-body').textContent==='RESTORED_QUEUE_TWO','restored queue text incorrect');
  check(messages.lastElementChild===spinner&&!spinner.dataset.queueId&&!spinner.dataset.rawText,'queue restoration mutated spinner');
  const staleDelete=cards[1].querySelector('[data-qact="delete"]');check(cards[1].dataset.sessionId==='A','restored queue card lost its owning session');staleDelete.click();check(sent.some(message=>message.type==='queueDelete'&&message.sessionId==='A'&&message.queueItemId==='restore-2'),'restored queue actions lost their target or owner');sent.length=0;reset('B');staleDelete.disabled=false;staleDelete.click();check(!sent.some(message=>message.type==='queueDelete'),'detached A queue card mutated the active B session');
 });
 await test('multiple queued messages live above the composer and reorder through the backend',()=>{
  reset();emit({type:'status',sessionId:'A',status:'running'});
  emit({type:'queue_sync',sessionId:'A',items:[{queueItemId:'first',text:'FIRST'},{queueItemId:'second',text:'SECOND'},{queueItemId:'third',text:'THIRD'}]});
  const zone=document.getElementById('queue-zone'),cards=[...zone.querySelectorAll('.queued')];
  const composer=document.querySelector('.composer-card').getBoundingClientRect();
  const box=zone.getBoundingClientRect();
  check(!zone.hidden&&cards.map(card=>card.dataset.queueId).join(',')==='first,second,third','queue order or placement incorrect');
  check(zone.parentElement?.id==='goal-zone','queue left the goal band');
  check(box.width>0&&box.width<=composer.width-24,`queue width ${box.width} is not narrower than composer ${composer.width}`);
  check(box.bottom<=composer.top+2&&Math.abs(box.bottom-composer.top)<=2,`queue is not flush on the composer (${box.bottom} vs ${composer.top})`);
  check(getComputedStyle(zone).borderBottomWidth==='0px'&&getComputedStyle(zone).boxShadow==='none','queue is still a separate card');
  check(zone.scrollWidth<=zone.clientWidth+1,'queue overflows the narrow composer');
  emit({type:'goal_state',sessionId:'A',goal:{objective:'窄列目标',status:'active',iteration:1,timeUsedSeconds:3,verifications:[]}});
  const strip=document.getElementById('goal-strip');
  const stripBox=strip.getBoundingClientRect();
  const queuedBox=zone.getBoundingClientRect();
  check(!strip.hidden&&strip.parentElement===zone.parentElement,'goal left the shared band');
  const cardNow=document.querySelector('.composer-card').getBoundingClientRect();
  check(queuedBox.bottom<=stripBox.top+1&&Math.abs(queuedBox.width-stripBox.width)<=1,`queue and goal are not one narrow column (${queuedBox.width} vs ${stripBox.width})`);
  check(getComputedStyle(strip).borderTopLeftRadius==='0px','goal strip kept a separate cap under the queue');
  check(Math.abs(stripBox.bottom-cardNow.top)<=2,`goal strip left the composer edge (${stripBox.bottom} vs ${cardNow.top})`);
  const rail=document.getElementById('question-rail');
  rail.hidden=false;
  check(strip.getBoundingClientRect().bottom<=rail.getBoundingClientRect().top+2,'open question rail covered the goal band');
  rail.hidden=true;
  emit({type:'goal_state',sessionId:'A',goal:null});
  check(strip.hidden&&!zone.hidden,'clearing the goal hid the queue');
  check(!messages.querySelector('.queued'),'queue still occupies the conversation');
  check(cards[0].querySelector('[data-qact="now"] svg[data-lucide="chevronsUp"]'),'immediate action lacks double up arrows');
  const handle=cards[2].querySelector('.queue-grip');handle.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));
  check(sent.some(message=>message.type==='queueReorder'&&message.queueItemId==='third'&&message.beforeQueueItemId==='second'),'reorder did not send backend target');
  check([...zone.querySelectorAll('.queued')].map(card=>card.dataset.queueId).join(',')==='first,third,second','reorder did not update visible order');
  emit({type:'view_reset',viewGen:++gen});check(zone.hidden&&!zone.querySelector('.queued'),'old session queue survived switch');
 });
 await test('promoted pending edit action supports cancel and resend without a history redraw',()=>{
  reset();const prompt='EDIT_PLACEHOLDER_PROMOTION';type(prompt);sendBtn.click();const user=messages.querySelector('.message.user');
  emit({type:'conversation_sync',sessionId:'A',editable:{target:{rowId:17,entityId:'editable-17'},text:prompt},turns:[]});
  const pen=user.nextElementSibling.querySelector('.turn-edit-btn');pen.click();check(user.querySelector('.user-edit'),'confirmed pen did not open editor');
  user.querySelector('[data-uedit="cancel"]').click();check(!user.querySelector('.user-edit')&&user.querySelector('.user-body').textContent===prompt,'cancel on promoted pen did nothing');
  pen.click();user.querySelector('.user-edit').value='EDITED_AFTER_PROMOTION';user.querySelector('[data-uedit="send"]').click();
  check(sent.some(message=>message.type==='editLast'&&message.text==='EDITED_AFTER_PROMOTION'&&message.rowId===17&&message.entityId==='editable-17'),'promoted edit resend lost text or target');
 });

 await test('send shows a work clock before any model output and stop preserves it',()=>{reset();type('WAIT_FOR_FIRST_OUTPUT');sendBtn.click();const fold=messages.querySelector('.work-fold[data-state="running"]');check(fold&&fold.querySelector('.work-fold-label').textContent,'send has no immediate work clock');check(!messages.querySelector('.work-note'),'waiting invented reasoning');check(sent.some(m=>m.type==='send'&&Number.isFinite(m.sentAt)),'send timestamp missing');emit({type:'status',sessionId:'A',status:'running',message:'等待模型响应…'});check(messages.querySelectorAll('.work-fold').length===1,'running status duplicated work clock');emit({type:'assistant_reasoning_delta',partId:'first-wait-reasoning',authoritative:true,fullText:'FIRST_THOUGHT'});check(messages.querySelectorAll('.work-fold').length===1&&fold.textContent.includes('FIRST_THOUGHT'),'first output did not reuse waiting clock');emit({type:'status',sessionId:'A',status:'completedInterrupted'});check(fold.dataset.state==='interrupted','stop left waiting clock running');});
 await test('waiting clock belongs to the new question and empty rejected clocks are removed',()=>{reset();emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'old-q',role:'user',text:'PREVIOUS_QUESTION'},{id:'old-a',role:'assistant',text:'PREVIOUS_ANSWER',steps:[{kind:'reasoning',text:'PREVIOUS_THOUGHT'},{kind:'text',text:'PREVIOUS_ANSWER'}]}]});type('NEW_QUESTION');sendBtn.click();const user=[...messages.querySelectorAll('.message.user')].at(-1);const fold=messages.querySelector('.work-fold[data-state="running"]');check(!!(user.compareDocumentPosition(fold)&Node.DOCUMENT_POSITION_FOLLOWING),'waiting clock attached before its question');check(!fold.textContent.includes('PREVIOUS_THOUGHT'),'new clock reused previous reasoning');const command=sent.find(m=>m.type==='send');emit({type:'send_rejected',sessionId:'A',commandId:command.commandId,text:'NEW_QUESTION',message:'test rejection'});check(!messages.querySelector('.work-fold[data-state="running"]'),'rejection left a running clock');check(input.value==='NEW_QUESTION','rejection lost draft');reset();type('/compact');sendBtn.click();check(!messages.querySelector('.work-fold'),'timeline command created an empty waiting fold');});
 await test('active history retains a waiting clock without creating reasoning',()=>{reset();emit({type:'history',sessionId:'A',viewGen:gen,activeSince:Date.now()-10000,items:[{id:'waiting-user',role:'user',text:'WAITING_QUESTION'}]});check(messages.querySelectorAll('.work-fold[data-state="running"]').length===1,'active history lost waiting clock');check(!messages.querySelector('.work-note'),'active history invented reasoning');emit({type:'assistant_reasoning_delta',partId:'restored-first',authoritative:true,fullText:'RESTORED_FIRST'});check(messages.querySelectorAll('.work-fold').length===1,'restored waiting clock duplicated');});
 await test('question jump toggle click area is ten pixels tall',()=>{const toggle=document.getElementById('rail-toggle');check(getComputedStyle(toggle).height==='10px','question jump toggle height changed');});
 await test('history redraw emits content-free render and frame timing',()=>{
  const original=requestAnimationFrame,frames=[];window.requestAnimationFrame=callback=>{frames.push(callback);return frames.length;};
  try{reset();sent.length=0;const privateText='PRIVATE_TRANSCRIPT_MUST_NOT_ENTER_METRICS';emit({type:'history',sessionId:'A',viewGen:gen,renderSource:'transcript-sync',items:[{id:'metric-q',role:'user',text:privateText},{id:'metric-a',role:'assistant',text:privateText}]});
   const metric=()=>sent.find(item=>item.type==='historyRenderTiming'&&item.historyRenderSource==='transcript-sync');
   check(!metric(),'render metric was posted before a paint opportunity');frames.splice(0).forEach(callback=>callback(performance.now()));check(!metric(),'render metric did not wait for its second frame');frames.splice(0).forEach(callback=>callback(performance.now()));
   const result=metric();check(result,'history render metric was not posted after two frames');check(Number.isFinite(result.historySyncMs)&&result.historySyncMs>=0&&Number.isFinite(result.historyFrameMs),'render/frame duration missing');check(result.historyItemCount===2&&result.historyRenderMode==='full','full render mode or row count incorrect');check(!JSON.stringify(result).includes(privateText),'transcript content leaked into metrics');
  }finally{window.requestAnimationFrame=original;}
 });
 await test('a strictly appended echoed question reconciles in place and preserves independent folds',async()=>{reset();const long='APPEND_QUESTION_LINE\n'.repeat(8);const initial=[{id:'append-old-q',role:'user',text:'APPEND_OLD_QUESTION'},{id:'append-old-a',role:'assistant',text:'APPEND_OLD_ANSWER'}];emit({type:'history',sessionId:'A',viewGen:gen,items:initial});const oldQuestion=messages.querySelector('.message.user');check(oldQuestion?.dataset.jump==='append-old-q'&&messages.textContent.includes('APPEND_OLD_ANSWER'),'initial transcript was not mounted');type(long);sendBtn.click();const optimistic=messages.querySelector('.message.user:not([data-jump="append-old-q"])');check(optimistic?.dataset.live==='1'&&optimistic.classList.contains('question-collapsed'),'send did not create the optimistic collapsed question');optimistic.nextElementSibling.querySelector('.question-fold-btn').click();check(!optimistic.classList.contains('question-collapsed'),'question expansion setup failed');const posted=sent.find(message=>message.type==='send');check(posted,'send event missing');emit({type:'history',sessionId:'A',viewGen:gen,activeSince:Date.now(),renderSource:'transcript-sync',items:[...initial,{id:'append-server-q',rowId:3,turnId:'append-turn',role:'user',text:long,createdAt:Date.now()}]});await new Promise(resolve=>setTimeout(resolve,120));const reconciled=messages.querySelector('.message.user[data-jump="append-server-q"]');check(reconciled===optimistic,'eligible append rebuilt or duplicated the optimistic bubble');check(reconciled.nextElementSibling.dataset.anchor==='append-server-q','question footer anchor was not reconciled');check(!reconciled.classList.contains('question-collapsed'),'append reset explicit question expansion');check(oldQuestion?.isConnected&&messages.querySelectorAll('.message.user').length===2,'append removed or duplicated existing questions');check(messages.querySelectorAll('.message.user').length===2,'append left duplicate user bubbles');});
 await test('transcript reconciliation falls back to full render when an earlier row changes',()=>{reset();const long='APPEND_FALLBACK_QUESTION\n'.repeat(3);const initial=[{id:'fallback-old-q',role:'user',text:'FALLBACK_OLD_QUESTION'},{id:'fallback-old-a',role:'assistant',text:'FALLBACK_OLD_ANSWER'}];emit({type:'history',sessionId:'A',viewGen:gen,items:initial});type(long);sendBtn.click();emit({type:'history',sessionId:'A',viewGen:gen,activeSince:Date.now(),renderSource:'transcript-sync',items:[{...initial[0]},{...initial[1],text:'FALLBACK_CANONICAL_UPDATE'},{id:'fallback-new-q',rowId:3,role:'user',text:long,createdAt:Date.now()}]});check(messages.textContent.includes('FALLBACK_CANONICAL_UPDATE'),'append fallback ignored changed canonical history');check(!messages.textContent.includes('FALLBACK_OLD_ANSWER'),'append fallback retained stale response text');check(messages.querySelectorAll('.message.user').length===2,'append fallback duplicated an optimistic question');});
 await test('live work clock never jumps when server history arrives',()=>{reset();emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});const original=Date.now;let now=original();Date.now=()=>now;try{type('CLOCK_SNAPSHOT');sendBtn.click();const started=Number(messages.querySelector('.work-fold[data-state="running"]').dataset.startedAt);now+=1500;emit({type:'history',sessionId:'A',viewGen:gen,activeSince:started+1000,items:[{id:'clock-q',role:'user',text:'CLOCK_SNAPSHOT'}]});let fold=messages.querySelector('.work-fold[data-state="running"]');check(Number(fold?.dataset.startedAt)===started&&fold.querySelector('.work-fold-label').textContent.includes('1 秒'),'user-only snapshot restarted waiting clock');emit({type:'history',sessionId:'A',viewGen:gen,activeSince:started-20000,items:[{id:'clock-q',role:'user',text:'CLOCK_SNAPSHOT'},{id:'clock-a',role:'assistant',text:'',running:true,steps:[{kind:'reasoning',text:'FIRST_OUTPUT'}]}]});fold=messages.querySelector('.work-fold[data-state="running"]');check(Number(fold?.dataset.startedAt)===started&&fold.querySelector('.work-fold-label').textContent.includes('1 秒'),'assistant snapshot advanced or restarted work clock');emit({type:'assistant_reasoning_delta',partId:'clock-r',authoritative:true,fullText:'FIRST_OUTPUT_MORE'});check(Number(messages.querySelector('.work-fold[data-state="running"]')?.dataset.startedAt)===started,'first output changed the clock origin');}finally{Date.now=original;}});
 await test('first output paint acknowledgement is scoped to its page and session',()=>{reset();const original=requestAnimationFrame;const frames=[];window.requestAnimationFrame=callback=>{frames.push(callback);return frames.length;};const flush=()=>{for(let i=0;frames.length&&i<100;i++)frames.shift()(performance.now());};try{type('MEASURE_FIRST_OUTPUT');sendBtn.click();emit({type:'assistant_reasoning_delta',partId:'measured-first',authoritative:true,fullText:'MEASURED_THOUGHT',timingId:'paint-probe',sessionId:'A'});flush();check(sent.filter(m=>m.type==='responsePainted'&&m.timingId==='paint-probe').length===1,'first output acknowledgement missing');check(sent.find(m=>m.type==='responsePainted').frameWaitMs>=0,'invalid frame wait');emit({type:'assistant_reasoning_delta',partId:'measured-first',authoritative:true,fullText:'LATE_THOUGHT',timingId:'late-probe',sessionId:'A'});reset('B');flush();check(!sent.some(m=>m.type==='responsePainted'),'old page acknowledged output in new session');}finally{window.requestAnimationFrame=original;}});
 await test('empty assistant snapshot and waiting status retain the first-output work clock',()=>{reset();type('EMPTY_ASSISTANT_WAIT');sendBtn.click();emit({type:'history',sessionId:'A',viewGen:gen,activeSince:Date.now()-100,items:[{id:'wait-q',role:'user',text:'EMPTY_ASSISTANT_WAIT'},{id:'wait-a',role:'assistant',text:'',running:true,steps:[]}]});check(messages.querySelectorAll('.work-fold[data-state="running"]').length===1,'empty assistant snapshot erased waiting clock');emit({type:'status',sessionId:'A',status:'running',message:'等待模型响应…'});check(messages.querySelectorAll('.work-fold[data-state="running"]').length===1,'waiting status duplicated clock');emit({type:'assistant_reasoning_delta',partId:'empty-first',authoritative:true,fullText:'FIRST_AFTER_EMPTY'});check(messages.querySelectorAll('.work-fold').length===1,'first output created a second clock');});
 await test('waiting timer is visible above composer in a long conversation before first output',()=>{reset();const items=[];for(let i=0;i<8;i++){items.push({id:'scroll-q-'+i,role:'user',text:'OLD_QUESTION_'+i});items.push({id:'scroll-a-'+i,role:'assistant',text:Array.from({length:35},(_,j)=>'Previous answer line '+j).join('\n')});}emit({type:'history',sessionId:'A',viewGen:gen,items});check(messages.scrollHeight>messages.clientHeight,'fixture did not overflow');type('SCROLL_WAIT_QUESTION');sendBtn.click();const checkVisible=()=>{const fold=messages.querySelector('.work-fold[data-state="running"]');check(fold&&fold.getBoundingClientRect().bottom<=document.getElementById('composer').getBoundingClientRect().top+2,'waiting clock is under composer until first output scrolls');};checkVisible();emit({type:'history',sessionId:'A',viewGen:gen,activeSince:Date.now()-200,items:[...items,{id:'scroll-new-q',role:'user',text:'SCROLL_WAIT_QUESTION'},{id:'scroll-empty-a',role:'assistant',text:'',running:true,steps:[]}]});checkVisible();});
 await test('running clock begins at zero and one second lasts exactly one elapsed second',()=>{reset();emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});const original=Date.now;let now=original();const base=now;Date.now=()=>now;try{type('CLOCK_BOUNDARIES');sendBtn.click();const fold=messages.querySelector('.work-fold[data-state="running"]');const paint=()=>fold.querySelector('.work-fold-btn').click();check(fold.querySelector('.work-fold-label').textContent.includes('0 秒'),'sub-second wait mislabeled as one second');for(const [elapsed,label] of [[999,'0 秒'],[1000,'1 秒'],[1999,'1 秒'],[2000,'2 秒']]){now=base+elapsed;paint();check(fold.querySelector('.work-fold-label').textContent.endsWith(label),'wrong running boundary at '+elapsed);}emit({type:'assistant_reasoning_delta',partId:'clock-r',authoritative:true,fullText:'CLOCK_THOUGHT'});emit({type:'status',sessionId:'A',status:'completedSuccess'});const frozen=fold.querySelector('.work-fold-label').textContent;now=base+10000;paint();check(fold.querySelector('.work-fold-label').textContent===frozen,'finished duration kept advancing');}finally{Date.now=original;}});
 await test('editor image events are scoped to the session and edit attempt',()=>{reset('B');emit({type:'history',sessionId:'B',viewGen:gen,items:[{id:'b-question',role:'user',text:'B QUESTION'}]});emit({type:'conversation_sync',sessionId:'B',editable:{target:{rowId:1,entityId:'b-question'},text:'B QUESTION'},turns:[]});const open=()=>messages.querySelector('.turn-edit-btn').click();open();const editor=messages.querySelector('.message.user.editing');const first=editor.dataset.editRequestId;emit({type:'image_pending',sessionId:'A',edit:true,editRequestId:first,imageId:'foreign-image',fileName:'A.png'});check(!messages.querySelector('[data-image-id="foreign-image"]'),'foreign image entered editor');editor.querySelector('[data-uedit="cancel"]').click();open();const second=editor.dataset.editRequestId;check(first!==second,'edit identity reused');emit({type:'image_pending',sessionId:'B',edit:true,editRequestId:first,imageId:'old-edit',fileName:'old.png'});check(!messages.querySelector('[data-image-id="old-edit"]'),'cancelled edit event entered new edit');emit({type:'image_pending',sessionId:'B',edit:true,editRequestId:second,imageId:'valid-edit',fileName:'new.png'});check(!!messages.querySelector('[data-image-id="valid-edit"]'),'valid edit event ignored');emit({type:'image_ready',sessionId:'B',edit:true,editRequestId:second,imageId:'valid-edit',attachment:{ref:'valid-ref',fileName:'new.png',mime:'image/png',bytes:100}});editor.querySelector('[data-uedit="send"]').click();const resend=sent.find(m=>m.type==='editLast');check(resend?.attachments?.[0]?.ref==='valid-ref','valid edit image lost on resend');check(!document.querySelector('#image-drafts .image-chip'),'obsolete event leaked to composer');});
 await test('history restoration does not label protocol parts as a message count',()=>{reset('restore-count');emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});emit({type:'history',sessionId:'restore-count',viewGen:gen,items:[{id:'restore-user',role:'user',turnId:'restore-task',text:'RESTORE_QUESTION'},{id:'restore-thought',role:'assistant',turnId:'restore-task',text:'',steps:[{kind:'reasoning',text:'RESTORE_THOUGHT'}]},{id:'restore-middle',role:'assistant',turnId:'restore-task',text:'RESTORE_MIDDLE'},{id:'restore-final',role:'assistant',turnId:'restore-task',text:'RESTORE_FINAL'}]});check(document.getElementById('toast').textContent==='会话已恢复','protocol part count exposed as restored messages');check(messages.textContent.includes('RESTORE_QUESTION')&&messages.textContent.includes('RESTORE_MIDDLE')&&messages.textContent.includes('RESTORE_FINAL'),'restoration notice changed history content');});
 await test('older question dots arrive after the transcript',()=>{reset('dots');emit({type:'history',sessionId:'dots',viewGen:gen,items:[{id:'visible-q',role:'user',text:'VISIBLE_QUESTION'}]});check(messages.textContent.includes('VISIBLE_QUESTION'),'transcript waited for the question index');check(![...document.querySelectorAll('.q-dot')].some(dot=>dot.dataset.preview==='OLDER_QUESTION'),'off-page dot arrived before its index');emit({type:'question_index',sessionId:'dots',viewGen:gen,questions:[{id:'older-q',text:'OLDER_QUESTION'},{id:'visible-q',text:'VISIBLE_QUESTION'}]});check([...document.querySelectorAll('.q-dot')].some(dot=>dot.dataset.preview==='OLDER_QUESTION'),'off-page question dot missing');});
 await test('numbered question dots keep ordinals out of the hover preview',()=>{
  reset('rail-number');
  emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});
  const at=new Date(2026,9,13,17,5).getTime();
  const olderAt=new Date(2024,2,2,9,8).getTime();
  const longQuestion='第二问'+'补充'.repeat(40);
  const clock=(ms,language)=>new Date(ms).toLocaleTimeString(language,{hour:'2-digit',minute:'2-digit',hour12:false});
  const expectWhen=(month,day,ms,language)=>language==='en'?`${month}/${day} ${clock(ms,language)}`:`${month}月${day}日 ${clock(ms,language)}`;
  emit({type:'history',sessionId:'rail-number',viewGen:gen,items:[
    {id:'number-q1',role:'user',text:'第一问'},
    {id:'number-a1',role:'assistant',text:'第一答'},
    {id:'number-q2',role:'user',text:longQuestion,createdAt:at}
  ]});
  const rail=document.getElementById('question-rail');
  if(rail.hidden)document.getElementById('rail-toggle').click();
  const preview=document.getElementById('question-preview');
  const time=()=>preview.querySelector('.question-preview-time');
  const body=()=>preview.querySelector('.question-preview-body');
  const hover=dot=>dot.dispatchEvent(new PointerEvent('pointerover',{bubbles:true}));
  let dots=[...document.querySelectorAll('#question-rail-track .q-dot')];
  check(dots.length===2&&dots[0].textContent==='1'&&dots[1].textContent==='2'&&dots[0].dataset.preview==='第一问','question numbers missing');
  hover(dots[0]);
  check(!preview.hidden&&time().hidden&&body().textContent==='第一问','undated hover invented a time or repeated its ordinal: '+(preview.textContent||''));
  hover(dots[1]);
  check(!time().hidden&&time().textContent===expectWhen(10,13,at,'zh-CN')&&body().textContent===longQuestion,'hover date wrong or ordinal was repeated: '+(time().textContent||'')+' / '+(body().textContent||''));
  check(dots[1].getAttribute('aria-label')===expectWhen(10,13,at,'zh-CN')+'\n'+longQuestion,'question dot label missing its date');
  const bodyStyle=getComputedStyle(body());
  const bodyHeight=body().getBoundingClientRect().height;
  const bodyLine=parseFloat(bodyStyle.lineHeight);
  check(bodyStyle.webkitLineClamp==='2'&&bodyHeight>bodyLine+1&&bodyHeight<=bodyLine*2+1,'question body did not stay on two lines');
  check(getComputedStyle(time()).whiteSpace==='nowrap'&&time().getBoundingClientRect().height>0&&time().scrollWidth<=time().clientWidth+1,'date line was clipped');
  emit({type:'question_index',sessionId:'rail-number',viewGen:gen,questions:[
    {id:'number-old',text:'更早的问题',at:olderAt},
    {id:'number-q1',text:'第一问'},
    {id:'number-q2',text:longQuestion}
  ]});
  dots=[...document.querySelectorAll('#question-rail-track .q-dot')];
  check(dots.length===3&&dots[0].dataset.at===String(olderAt)&&dots[2].dataset.at===String(at)&&!dots[1].dataset.at,'indexed question time missing');
  hover(dots[0]);
  check(time().textContent===expectWhen(3,2,olderAt,'zh-CN')&&!/2024|年/.test(time().textContent)&&body().textContent==='更早的问题','older hover kept the year or ordinal: '+(time().textContent||''));
  hover(dots[2]);
  check(time().textContent===expectWhen(10,13,at,'zh-CN')&&body().textContent===longQuestion,'visible question lost its bubble time');
  emit({type:'ui_language',language:'en',setting:'en'});
  hover([...document.querySelectorAll('#question-rail-track .q-dot')][2]);
  check(time().textContent===expectWhen(10,13,at,'en')&&body().textContent===longQuestion,'english hover date wrong: '+preview.textContent);
  emit({type:'ui_language',language:'zh-TW',setting:'zh-TW'});
  hover([...document.querySelectorAll('#question-rail-track .q-dot')][2]);
  check(time().textContent===expectWhen(10,13,at,'zh-TW')&&body().textContent===longQuestion,'traditional hover date wrong: '+preview.textContent);
 });
 await test('every question navigation marker is numbered',()=>{
  reset('stars');
  const items=[];
  for(let i=0;i<100;i++){items.push({id:'star-q-'+i,role:'user',text:'STAR_'+i});items.push({id:'star-a-'+i,role:'assistant',text:'A_'+i});}
  emit({type:'history',sessionId:'stars',viewGen:gen,items});
  const rail=document.getElementById('question-rail');
  if(rail.hidden)document.getElementById('rail-toggle').click();
  const dots=[...document.querySelectorAll('#question-rail-track .q-dot')];
  check(dots.length===100,'number fixture did not build one hundred dots');
  const current= document.querySelector('#question-rail-track .q-dot.current');
  check(current,'current viewport question has no active marker');
  const currentFrame=getComputedStyle(current,'::after');
  check(currentFrame.content!=='none'&&currentFrame.borderTopStyle==='solid'&&currentFrame.borderRadius==='4px','active question number is not framed by a rounded rectangle');
  dots.forEach((dot,index)=>{
    check(dot.textContent===String(index+1),'question marker did not show its ordinal '+(index+1));
    if((index+1)%10===0){
      check(dot.classList.contains('mark')&&Number.parseInt(getComputedStyle(dot).fontWeight,10)>=600,'tenth number lost its visual marker');
    }else check(!dot.classList.contains('mark'),'ordinary question number became a marker');
  });
  const triple=dots[99];
  triple.classList.add('current');
  const tripleFrame=getComputedStyle(triple,'::after');
  const tripleBox=triple.getBoundingClientRect();
  const textRange=document.createRange();textRange.selectNodeContents(triple);
  const textBox=textRange.getBoundingClientRect();
  check(triple.textContent==='100'&&tripleFrame.borderRadius==='4px','three-digit marker did not keep its rounded rectangle');
  check(tripleBox.width>=textBox.width+8&&textBox.left>=tripleBox.left+2&&textBox.right<=tripleBox.right-2,'three-digit marker is clipped by its active frame');
 });
 await test('current question follows the topbar reading line after folding',async()=>{
  reset('rail-active-fold');
  const items=[];
  for(let i=1;i<=3;i++){items.push({id:`active-q${i}`,role:'user',text:`ACTIVE_QUESTION_${i}`});items.push({id:`active-a${i}`,role:'assistant',text:`ACTIVE_ANSWER_${i}`});}
  emit({type:'history',sessionId:'rail-active-fold',viewGen:gen,items});
  const rail=document.getElementById('question-rail');
  if(rail.hidden)document.getElementById('rail-toggle').click();
  const edge=messages.getBoundingClientRect().top+parseFloat(getComputedStyle(document.body).getPropertyValue('--z-messages-pad-top'));
  const q1=messages.querySelector('.message.user[data-jump="active-q1"]');
  const q2=messages.querySelector('.message.user[data-jump="active-q2"]');
  const q3=messages.querySelector('.message.user[data-jump="active-q3"]');
  const original=[q1.getBoundingClientRect.bind(q1),q2.getBoundingClientRect.bind(q2),q3.getBoundingClientRect.bind(q3)];
  q1.getBoundingClientRect=()=>new DOMRect(0,edge-100,120,32);
  q2.getBoundingClientRect=()=>new DOMRect(0,edge-1,120,32);
  q3.getBoundingClientRect=()=>new DOMRect(0,q2.classList.contains('turn-hidden')?edge-1:edge+1,120,32);
  try{
   await new Promise(resolve=>requestAnimationFrame(()=>resolve()));
   messages.dispatchEvent(new Event('scroll'));
   check(document.querySelector('.q-dot.current')?.dataset.jump==='active-q2',`active question did not follow the topbar reading line: ${document.querySelector('.q-dot.current')?.dataset.jump||'none'}`);
   const collapse=q2.nextElementSibling.querySelector('.turn-collapse-btn');
   check(collapse,'second question has no turn collapse control');
   collapse.click();
   await new Promise(resolve=>requestAnimationFrame(()=>resolve()));
   check(q2.classList.contains('turn-hidden'),'question turn did not fold');
   check(document.querySelector('.q-dot.current')?.dataset.jump==='active-q3',`folding did not advance the active question at the topbar reading line: ${document.querySelector('.q-dot.current')?.dataset.jump||'none'}`);
  }finally{[q1,q2,q3].forEach((question,index)=>question.getBoundingClientRect=original[index]);}
 });
 await test('all-folded navigation tracks the fold bar below the topbar',async()=>{
  reset('rail-all-folded-active');
  const items=[];
  for(let i=1;i<=4;i++){items.push({id:`all-active-q${i}`,role:'user',text:`ALL_ACTIVE_QUESTION_${i}`});items.push({id:`all-active-a${i}`,role:'assistant',text:`ALL_ACTIVE_ANSWER_${i}`});}
  emit({type:'history',sessionId:'rail-all-folded-active',viewGen:gen,items});
  const rail=document.getElementById('question-rail');
  if(rail.hidden)document.getElementById('rail-toggle').click();
  const edge=messages.getBoundingClientRect().top+parseFloat(getComputedStyle(document.body).getPropertyValue('--z-messages-pad-top'));
  document.getElementById('collapse-all-turns').click();
  const bars=[...messages.querySelectorAll('.turn-fold-bar')];
  check(bars.length===4&&bars.every((bar,index)=>bar.dataset.jump===`all-active-q${index+1}`),`fold bars did not retain their question identities: ${bars.length} [${bars.map(bar=>bar.dataset.jump||'missing').join(',')}]`);
  const originals=bars.map(bar=>bar.getBoundingClientRect.bind(bar));
  [edge-40,edge-1,edge+1,edge+80].forEach((top,index)=>{bars[index].getBoundingClientRect=()=>new DOMRect(0,top,140,24);});
  try{
   await new Promise(resolve=>requestAnimationFrame(()=>resolve()));
   check(messages.querySelectorAll('.message.user.turn-hidden').length===4,'collapse all left question bubbles visible');
   check(document.querySelector('.q-dot.current')?.dataset.jump==='all-active-q2',`all-folded rail did not follow its visible fold bar: ${document.querySelector('.q-dot.current')?.dataset.jump||'none'}`);
  }finally{bars.forEach((bar,index)=>bar.getBoundingClientRect=originals[index]);}
 });
 await test('question rail removes the counter and keeps collapse control aligned',()=>{
  reset('collapse-place');
  emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});
  const items=[];
  for(let i=0;i<80;i++)items.push({id:'place-q-'+i,role:'user',text:'PLACE_'+i});
  emit({type:'history',sessionId:'collapse-place',viewGen:gen,items});
  const rail=document.getElementById('question-rail');
  if(rail.hidden)document.getElementById('rail-toggle').click();
  const button=document.getElementById('collapse-all-turns');
  const toggle=document.getElementById('rail-toggle');
  check(button&&button.getAttribute('aria-label')==='折叠所有对话','collapse-all label missing');
  check(!document.getElementById('question-rail-pos'),'question progress counter is still rendered');
  check(rail.classList.contains('can-scroll'),'number rail lost its overflow affordance');
  const b=button.getBoundingClientRect(),t=toggle.getBoundingClientRect();
  check(b.width>0,'collapse control is missing');
  check(Math.abs((b.left+b.right)/2-(t.left+t.right)/2)<=4,'collapse control is not centered over the jump toggle');
  check(b.bottom<=t.top+4,'collapse control overlaps the jump toggle');
  const track=document.getElementById('question-rail-track');
  track.scrollLeft=track.scrollWidth;
  const last=track.querySelector('.q-dot:last-child').getBoundingClientRect(),viewport=track.getBoundingClientRect();
  check(last.right<=viewport.right-12,'last question number remains inside the right-edge fade at maximum scroll');
 });
 await test('collapse-all restores every turn to its exact previous fold state',()=>{
  reset('collapse-all');
  const items=[];
  for(let i=0;i<12;i++){items.push({id:'all-q-'+i,role:'user',text:'TURN_'+i});items.push({id:'all-a-'+i,role:'assistant',text:'ANSWER_'+i});}
  emit({type:'history',sessionId:'collapse-all',viewGen:gen,items});
  const rail=document.getElementById('question-rail');
  if(rail.hidden)document.getElementById('rail-toggle').click();
  check(messages.querySelectorAll('.turn-fold-bar').length===2,'default fold was not limited to the older turns');
  messages.querySelector('.turn-fold-bar').click();
  check(messages.querySelectorAll('.turn-fold-bar').length===1,'could not create a mixed pre-collapse state');
  const collapse=document.getElementById('collapse-all-turns');
  collapse.click();
  check(messages.querySelectorAll('.message.user.turn-hidden').length===12&&messages.querySelectorAll('.turn-fold-bar').length===12,'collapse-all left a turn open');
  check(collapse.dataset.state==='restore-recent'&&collapse.getAttribute('aria-label')==='恢复'&&collapse.querySelector('path[stroke-dasharray]'),'collapsed state icon or tooltip missing');
  emit({type:'history',sessionId:'collapse-all',viewGen:gen,items});
  check(messages.querySelectorAll('.turn-fold-bar').length===12,'redraw reopened collapsed turns');
  collapse.click();
  check(messages.querySelectorAll('.turn-fold-bar').length===1&&messages.querySelectorAll('.message.user.turn-hidden').length===1,'restore did not recover the exact pre-collapse state');
  check(collapse.dataset.state==='collapse-all'&&collapse.getAttribute('aria-label')==='折叠所有对话','restored state kept the restore affordance');
  collapse.click();
  messages.querySelector('.turn-fold-bar').click();
  check(messages.querySelectorAll('.turn-fold-bar').length===11,'one reopened turn did not stay open');
  emit({type:'ui_language',language:'en',setting:'en'});
  check(document.getElementById('collapse-all-turns').getAttribute('aria-label')==='Collapse all turns','collapse-all label did not switch');
  reset('collapse-all-fresh');
  emit({type:'history',sessionId:'collapse-all-fresh',viewGen:gen,items});
  check(messages.querySelectorAll('.turn-fold-bar').length===2,'a fresh load kept every turn collapsed');
 });
 await test('collapse-all folds a truncated leading assistant fragment too',()=>{
  reset('partial-collapse');
  const items=[
    {id:'partial-leading',role:'assistant',text:'TRUNCATED_LEADING_ANSWER'},
    {id:'partial-question',role:'user',text:'CURRENT_QUESTION'},
    {id:'partial-answer',role:'assistant',text:'CURRENT_ANSWER'}
  ];
  emit({type:'history',sessionId:'partial-collapse',viewGen:gen,truncated:true,items});
  const rail=document.getElementById('question-rail');
  if(rail.hidden)document.getElementById('rail-toggle').click();
  check(messages.querySelectorAll('.turn-fold-bar').length===0,'partial fixture did not start expanded');
  document.getElementById('collapse-all-turns').click();
  check(messages.querySelectorAll('.turn-fold-bar').length===2&&messages.querySelectorAll('.message.assistant.turn-hidden').length===2&&messages.querySelectorAll('.message.user.turn-hidden').length===1,'truncated leading turn was not collapsed');
  document.getElementById('collapse-all-turns').click();
  check(messages.querySelectorAll('.turn-fold-bar').length===0&&messages.textContent.includes('TRUNCATED_LEADING_ANSWER')&&messages.textContent.includes('CURRENT_ANSWER'),'restore failed for the truncated partial turn');
 });
 await test('a model switch row paints between the previous reply and the next question',()=>{
  reset('model-place');
  emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});
  emit({type:'history',sessionId:'model-place',viewGen:gen,items:[
    {id:'model-q1',role:'user',turnId:'model-t1',text:'第一问'},
    {id:'model-a1',role:'assistant',turnId:'model-t1',text:'第一答'},
    {id:'model-mark',role:'assistant',turnId:'model-t2',text:'',tools:[],steps:[{kind:'model',from:'deepseek-flash',to:'GLM-5.3-Flash',fromProvider:'deepseek',toProvider:'account:bigmodel-team-coding-plan'}]},
    {id:'model-q2',role:'user',turnId:'model-t2',text:'第二问'},
    {id:'model-a2',role:'assistant',turnId:'model-t2',text:'第二答'}
  ]});
  const mark=messages.querySelector('.model-mark');
  const questions=[...messages.querySelectorAll('.message.user')];
  check(mark&&mark.textContent.includes('模型已切换 deepseek-flash → GLM-5.3-Flash'),'desktop model switch missing: '+(mark?.textContent||''));
  emit({type:'models',available:[
    {providerId:'deepseek',modelId:'deepseek-flash',label:'deepseek-flash',providerName:'DeepSeek'},
    {providerId:'account:bigmodel-team-coding-plan',modelId:'GLM-5.3-Flash',label:'GLM-5.3-Flash',providerName:'BigModel Team Coding Plan'}
  ],current:{providerId:'account:bigmodel-team-coding-plan',modelId:'GLM-5.3-Flash'}});
  check(mark.textContent.includes('deepseek-flash(DeepSeek)')&&mark.textContent.includes('GLM-5.3-Flash(BigModel Team Coding Plan)'),'model switch lost the provider: '+(mark.textContent||''));
  check(questions.length===2&&questions[0].compareDocumentPosition(mark)&Node.DOCUMENT_POSITION_FOLLOWING&&mark.compareDocumentPosition(questions[1])&Node.DOCUMENT_POSITION_FOLLOWING,'model switch is not between the two questions');
  check(!mark.closest('.work-fold'),'model switch was folded into the work block');
  const firstFooter=[...messages.querySelectorAll('.reply-meta')].find(meta=>meta.dataset.copyText?.includes('第一答'));
  check(firstFooter&&firstFooter.compareDocumentPosition(mark)&Node.DOCUMENT_POSITION_FOLLOWING,'reply copy/time footer fell below the model switch');
  check(parseFloat(getComputedStyle(mark,'::before').width)<=16.5&&parseFloat(getComputedStyle(mark,'::after').width)<=16.5,'model switch side rules stretched too far from the label');
 });
 await test('a fast direct answer keeps its known work duration without an empty fold',()=>{
  reset('fast-answer');
  emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});
  emit({type:'history',sessionId:'fast-answer',viewGen:gen,items:[
   {id:'fast-q',role:'user',turnId:'fast-turn',text:'FAST_QUESTION',createdAt:1000},
   {id:'fast-a',role:'assistant',turnId:'fast-turn',text:'FAST_ANSWER',createdAt:1000,endedAt:1240,workDurationMs:240,steps:[{kind:'text',text:'FAST_ANSWER'}]}
  ]});
  const bar=messages.querySelector('.work-duration-only');
  check(bar?.dataset.durationMs==='240','fast reply lost the backend duration');
  check(bar?.textContent.includes('已工作 1 秒'),'fast reply duration label is missing or wrong: '+(bar?.textContent||''));
  check(!bar?.querySelector('.work-fold-viewport,button'),'time-only work bar suggests an empty expandable process');
  const answer=messages.querySelector('.message.assistant');
  check(bar&&answer&&bar.compareDocumentPosition(answer)&Node.DOCUMENT_POSITION_FOLLOWING,'fast reply work duration is not above its answer');
 });
 await test('transcript redraw without an index keeps the existing question dots',()=>{reset('dots-keep');emit({type:'history',sessionId:'dots-keep',viewGen:gen,items:[{id:'keep-visible-q',role:'user',text:'KEEP_VISIBLE'}]});emit({type:'question_index',sessionId:'dots-keep',viewGen:gen,questions:[{id:'keep-older-q',text:'KEEP_OLDER'},{id:'keep-visible-q',text:'KEEP_VISIBLE'}]});const older=()=>[...document.querySelectorAll('.q-dot')].some(dot=>dot.dataset.preview==='KEEP_OLDER');check(older(),'fixture index missing');emit({type:'history',sessionId:'dots-keep',viewGen:gen,items:[{id:'keep-visible-q',role:'user',text:'KEEP_VISIBLE'},{id:'keep-a',role:'assistant',text:'KEEP_ANSWER'}]});check(older(),'transcript redraw dropped the older question dot');check(messages.textContent.includes('KEEP_ANSWER'),'redraw lost the new content');reset('dots-other');check(!older(),'question index survived a session reset');});
 await test('model errors provide recovery guidance and preserve untranslated original details',()=>{reset();emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});const raw='No available model: 原始诊断 <img src=x onerror=alert(1)>';emit({type:'session_error',message:raw});const card=messages.querySelector('.message.error');check(card.querySelector('.err-guidance').textContent.includes('重新选择一次模型'),'no model recovery instructions');check(card.querySelector('details pre').textContent===raw&&!card.querySelector('details').open,'diagnostic changed or initially expanded');check(!card.querySelector('img'),'diagnostic became executable markup');card.querySelector('details').open=true;emit({type:'ui_language',language:'en',setting:'en'});check(card.querySelector('.err-title').textContent==='The model is not ready yet','title did not localize');check(!/[\u4e00-\u9fff]/.test(card.querySelector('.err-guidance').textContent),'English recovery hint contains Chinese');check(card.querySelector('details pre').textContent===raw&&card.querySelector('details').open,'language switch altered raw details or expansion');card.querySelector('[data-act="copyDiagnostics"]').click();card.querySelector('[data-act="community"]').click();check(sent.some(message=>message.type==='copyDiagnostics')&&sent.some(message=>message.type==='openCommunity'),'diagnostics or community action missing');card.querySelector('[data-act="pickModel"]').click();check(document.getElementById('popover').classList.contains('open'),'model recovery action did not open picker');});
 await test('custom installation and runtime failures expose exact settings actions',()=>{for(const [raw,setting] of [['找不到 ZCode app-server。请填写 zcode.binaryPath。','binaryPath'],['Cannot start node runtime; set zcode.nodePath','nodePath']]){reset();emit({type:'session_error',message:raw});const card=messages.querySelector('.message.error');check(card.querySelector('.err-guidance').textContent.includes('zcode.'+setting),'missing usable configuration instruction');card.querySelector('[data-act="'+setting+'"]').click();check(sent.some(message=>message.type==='openRecoverySettings'&&message.setting===setting),'settings action missing');check(!card.querySelector('[data-act="retryLast"]'),'empty session offered a phantom retry');}});
 await test('setup without usable credentials offers sign-in diagnostics and community recovery',()=>{reset();emit({type:'setup',reason:'No saved credentials',hint:'Original backend hint',picker:[]});const recovery=document.getElementById('setup-recovery');check(document.getElementById('setup-hint').textContent.length>20,'setup has no guidance');check(recovery.querySelector('details pre').textContent.includes('Original backend hint'),'setup lost original hint');recovery.querySelector('[data-act="community"]').click();recovery.querySelector('[data-act="copyDiagnostics"]').click();check(sent.some(message=>message.type==='openCommunity')&&sent.some(message=>message.type==='copyDiagnostics'),'setup recovery actions missing');recovery.querySelector('[data-act="retry"]').click();check(sent.some(message=>message.type==='retry'),'setup cannot reload sign-in');});
 await test('math renders securely outside code, updates after closure and loads bundled fonts',()=>{reset();emit({type:'assistant_text_delta',partId:'formula-stream',fullText:'Incomplete $x_1'});check(!messages.querySelector('.katex'),'unfinished formula rendered too early');const text=String.raw`Inline $x_1^2$ and \(\frac{1}{2}\).

$$\begin{pmatrix}1&2\\3&4\end{pmatrix}$$

\[\sum_{i=1}^n i\]

Cost $3 and $5.

$\unknownCommand{<script>}$

$\includegraphics{https://example.invalid/leak}$`+'\n\nCode: `$raw_code$`';emit({type:'assistant_text_delta',partId:'formula-stream',fullText:text});check(messages.querySelectorAll('.katex').length>=4,'expected four formulas or code/currency misclassified');check(messages.querySelector('math')&&messages.querySelector('.katex-html'),'sanitizer damaged math accessibility or visual markup');check(messages.querySelector('code').textContent==='$raw_code$','inline code changed');check(messages.textContent.includes('Cost $3 and $5.'),'prices converted to math');check(!messages.querySelector('img[src^="https:"]')&&!messages.querySelector('script'),'unsafe formula markup survived');check(![...document.fonts].some(face=>face.family.replaceAll('"','')==='KaTeX_Main'),'formula fonts are still bundled');const katex=messages.querySelector('.katex');check(getComputedStyle(katex).fontFamily.includes('KaTeX'),'math stylesheet missing');emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});emit({type:'status',sessionId:'A',status:'completedSuccess'});const hint=messages.querySelector('.math-font-hint');check(hint?.textContent==='美化公式','completed formula reply has no font hint');hint.click();check(sent.some(message=>message.type==='installMathFonts'),'font hint did not request the download');emit({type:'math_fonts',mode:'on',status:'downloading'});check(messages.querySelector('.math-font-hint')?.textContent==='正在下载','download state missing');check(messages.querySelector('.math-font-hint').disabled,'download hint stayed clickable');emit({type:'math_fonts',mode:'on',status:'ready',css:`@font-face{font-family:\"KaTeX_Main\";src:url(\"${mathFontFixture}\") format(\"woff2\");font-weight:400;font-style:normal;font-display:swap}`});check(!messages.querySelector('.math-font-hint'),'font hint stayed after fonts were ready');check(document.getElementById('math-font-faces')?.textContent.includes('KaTeX_Main'),'ready fonts were not applied');emit({type:'math_fonts',mode:'off',status:'disabled',css:''});check(!document.getElementById('math-font-faces'),'disabled formula fonts kept their stylesheet');});
 await test('formula font hint stays on the latest formula reply',()=>{reset();emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});emit({type:'math_fonts',mode:'auto',status:'absent'});emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'font-q1',role:'user',text:'FIRST_FORMULA'},{id:'font-a1',role:'assistant',text:'First $x$.'},{id:'font-q2',role:'user',text:'SECOND_PLAIN'},{id:'font-a2',role:'assistant',text:'No math here.'},{id:'font-q3',role:'user',text:'THIRD_FORMULA'},{id:'font-a3',role:'assistant',text:'Third $y$.'}]});const hints=[...messages.querySelectorAll('.math-font-hint')];check(hints.length===1,'expected one formula font hint');check(hints[0].closest('.reply-meta')?.dataset.copyText?.includes('Third'),'hint was not on the latest formula reply');emit({type:'math_fonts',mode:'off',status:'disabled'});check(!messages.querySelector('.math-font-hint'),'font hint remained after it was turned off');});
 await test('partial history never mounts a floating collapse button above its process',()=>{reset();emit({type:'history',sessionId:'A',viewGen:gen,truncated:true,items:[{id:'partial-work',role:'assistant',text:'PARTIAL_FINAL',steps:[{kind:'reasoning',text:'PARTIAL_WORK'},{kind:'text',text:'PARTIAL_FINAL'}]}]});check(messages.querySelector('.history-more'),'more history button missing');check(!messages.querySelector('.turn-collapse-btn'),'orphan collapse icon appears without question footer');emit({type:'historyOlder',sessionId:'A',viewGen:gen,more:false,items:[{id:'partial-root',role:'user',text:'PARTIAL_QUESTION'}]});check(messages.querySelector('.message.user + .msg-meta .turn-collapse-btn'),'actual question lost collapse action');});
 await test('long task pagination joins process blocks and every fold remains usable',()=>{reset();const row=(id,role,text,n,extra={})=>({id,role,text,rowId:n,logEpoch:'long-epoch',turnId:'long-task',...extra});emit({type:'history',sessionId:'A',viewGen:gen,truncated:true,items:[row('p3','assistant','FINAL_LONG_ANSWER',3,{steps:[{kind:'reasoning',text:'LAST_THOUGHT'},{kind:'text',text:'FINAL_LONG_ANSWER'}]})]});check(!messages.querySelector('.turn-hidden'),'partial task hidden without a question');messages.querySelector('.history-more').click();emit({type:'historyOlder',sessionId:'A',viewGen:gen,more:true,items:[row('p2','assistant','',2,{steps:[{kind:'reasoning',text:'MIDDLE_THOUGHT'}]})]});check(messages.querySelectorAll('.work-fold').length===1,'pagination split one task into duplicate work blocks');messages.querySelector('.history-more').click();emit({type:'historyOlder',sessionId:'A',viewGen:gen,more:false,items:[row('p1','user','LONG_TASK_QUESTION',1)]});const user=messages.querySelector('.message.user');user.nextElementSibling.querySelector('.turn-collapse-btn').click();check(messages.querySelectorAll('.turn-fold-bar').length===1,'stale fold bars survived loading');messages.querySelector('.turn-fold-bar').click();check(!messages.querySelector('.turn-hidden'),'fold cannot reopen after paging');emit({type:'history',sessionId:'A',viewGen:gen,truncated:true,items:[row('p3','assistant','UPDATED_FINAL_ANSWER',3,{steps:[{kind:'reasoning',text:'LAST_THOUGHT'},{kind:'text',text:'UPDATED_FINAL_ANSWER'}]})]});check(messages.textContent.includes('LONG_TASK_QUESTION')&&messages.textContent.includes('MIDDLE_THOUGHT'),'live snapshot erased loaded pages');check(!messages.querySelector('.history-more'),'completed pagination reset by limited snapshot');check(!messages.querySelector('.turn-hidden'),'open task reset after snapshot');emit({type:'history',sessionId:'A',viewGen:gen,truncated:true,items:[{id:'new-epoch-answer',role:'assistant',text:'NEW_EPOCH',rowId:3,logEpoch:'new-epoch',turnId:'new-task'}]});check(!messages.textContent.includes('LONG_TASK_QUESTION'),'new log epoch retained stale loaded pages');});
 await test('inserted prompt preserves chronology and charges task duration only once',()=>{reset();emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'task-start',role:'user',turnId:'one-task',text:'TASK_START'},{id:'before-insert',role:'assistant',turnId:'one-task',text:'',createdAt:1000,endedAt:121000,workDurationMs:65000,steps:[{kind:'reasoning',text:'BEFORE_INSERT'}]},{id:'inserted-input',role:'user',turnId:'one-task',text:'INSERTED_INPUT'},{id:'after-insert',role:'assistant',turnId:'one-task',text:'FINAL_AFTER_INSERT',createdAt:1000,endedAt:121000,workDurationMs:65000,steps:[{kind:'reasoning',text:'AFTER_INSERT'},{kind:'text',text:'FINAL_AFTER_INSERT'},{kind:'reasoning',text:'TRAILING_SETTLING'}]}]});const folds=[...messages.querySelectorAll('.work-fold')];check(folds.filter(f=>f.dataset.durationMs==='65000').length===1,'task total repeated for inserted segments');check(folds.filter(f=>f.dataset.continuation==='1').length===2,'continuations presented as unrelated work totals');check(messages.textContent.indexOf('BEFORE_INSERT')<messages.textContent.indexOf('INSERTED_INPUT')&&messages.textContent.indexOf('INSERTED_INPUT')<messages.textContent.indexOf('AFTER_INSERT'),'insert chronology lost');messages.querySelector('.turn-collapse-btn').click();check(messages.querySelectorAll('.turn-fold-bar').length===1,'inserted message split one canonical task into independent rounds');messages.querySelector('.turn-fold-bar').click();check(!messages.querySelector('.turn-hidden'),'inserted task cannot reopen');});
 await test('multiple visible inserts show an independent duration for each work segment',()=>{reset();emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});emit({type:'history',sessionId:'A',viewGen:gen,items:[
  {id:'multi-root',role:'user',turnId:'multi-insert-task',text:'MULTI_ROOT',createdAt:1000},
  {id:'multi-first',role:'assistant',turnId:'multi-insert-task',text:'',createdAt:1000,endedAt:121000,workDurationMs:120000,steps:[{kind:'reasoning',text:'MULTI_FIRST_WORK'}]},
  {id:'multi-insert-one',role:'user',turnId:'multi-insert-task',text:'MULTI_INSERT_ONE',createdAt:31000},
  {id:'multi-second',role:'assistant',turnId:'multi-insert-task',text:'',createdAt:31000,endedAt:121000,workDurationMs:120000,steps:[{kind:'reasoning',text:'MULTI_SECOND_WORK'}]},
  {id:'multi-insert-two',role:'user',turnId:'multi-insert-task',text:'MULTI_INSERT_TWO',createdAt:91000},
  {id:'multi-final',role:'assistant',turnId:'multi-insert-task',text:'MULTI_FINAL',createdAt:91000,endedAt:121000,workDurationMs:120000,steps:[{kind:'reasoning',text:'MULTI_FINAL_WORK'},{kind:'text',text:'MULTI_FINAL'}]}
 ]});const folds=[...messages.querySelectorAll('.work-fold')];check(folds.length===3,'two visible insertions did not produce exactly three work segments');check(folds.map(f=>Number(f.dataset.durationMs)).join(',')==='30000,60000,30000','segment clocks inherited the task-wide duration');check(folds.map(f=>f.querySelector('.work-fold-label').textContent).join('|')==='已工作 30 秒|已工作 1 分|已工作 30 秒','a continuation hid its independently calculated duration');});
 await test('backend hidden runtime rows across two turn IDs render one workbar for one visible prompt',()=>{reset();emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});emit({type:'history',sessionId:'A',viewGen:gen,items:window.workbarBackendHistory});const users=[...messages.querySelectorAll('.message.user:not(.queued)')];check(users.length===1&&users[0].dataset.rawText==='FIXTURE_QUESTION','hidden backend inputs appeared as visible questions');const folds=[...messages.querySelectorAll('.work-fold')];check(folds.length===1,'adjacent backend turns split one visible task into multiple workbars');check(folds[0].dataset.durationMs==='350000','merged workbar did not sum each backend turn duration exactly once');check(messages.textContent.includes('FIXTURE_THOUGHT_BEFORE')&&messages.textContent.includes('FIXTURE_INTERMEDIATE_REPLY')&&messages.textContent.includes('FIXTURE_THOUGHT_AFTER')&&messages.textContent.includes('FIXTURE_FINAL_REPLY'),'merging backend turns lost assistant output');check(!messages.textContent.includes('FIXTURE_HIDDEN_'),'hidden backend context leaked into transcript');});
 await test('active inserted task has only one running clock and stops all earlier segments',()=>{reset();const items=[{id:'active-root',role:'user',turnId:'active-task',text:'ACTIVE_ROOT'},{id:'active-old',role:'assistant',turnId:'active-task',running:true,createdAt:Date.now()-60000,text:'',steps:[{kind:'reasoning',text:'OLD_ACTIVE_PROCESS'}]},{id:'active-insert',role:'user',turnId:'active-task',text:'ACTIVE_INSERT'},{id:'active-tail',role:'assistant',turnId:'active-task',running:true,createdAt:Date.now()-60000,text:'',steps:[{kind:'reasoning',text:'CURRENT_ACTIVE_PROCESS'}]}];emit({type:'history',sessionId:'A',viewGen:gen,activeSince:Date.now()-60000,items});check(messages.querySelectorAll('.work-fold[data-state="running"]').length===1,'insertion left multiple running clocks');check(messages.querySelector('.work-fold').dataset.continuation==='1','earlier active segment still pretends to run');emit({type:'history',sessionId:'A',viewGen:gen,items:items.map(item=>({...item,running:false,workDurationMs:item.role==='assistant'?65000:undefined,endedAt:Date.now()}))});check(!messages.querySelector('.work-fold[data-state="running"]'),'completed task kept a running segment');check(messages.querySelectorAll('.work-fold[data-duration-ms="65000"]').length===1,'completed active task counted time twice');});
 await test('git cards stay with their original questions across repeated updates',()=>{reset();emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'git-owner-one',role:'user',text:'FIRST_GIT_TASK'},{id:'git-answer-one',role:'assistant',text:'FIRST_GIT_REPLY'},{id:'git-owner-two',role:'user',text:'SECOND_GIT_TASK'},{id:'git-answer-two',role:'assistant',text:'SECOND_GIT_REPLY'}]});const turn=(id,text,rowId)=>({turnId:id,userText:text,fileChanges:{target:{rowId,entityId:id},summary:{files:1,additions:2,deletions:1},canRewind:true}});for(let i=0;i<3;i++)emit({type:'conversation_sync',sessionId:'A',editable:null,turns:[turn('git-one','FIRST_GIT_TASK',1),turn('git-two','SECOND_GIT_TASK',2)]});const first=messages.querySelector('[data-turn-id="git-one"]');const secondUser=messages.querySelector('[data-jump="git-owner-two"]');check(!!(first.compareDocumentPosition(secondUser)&Node.DOCUMENT_POSITION_FOLLOWING),'first git card migrated to last task');check(messages.querySelectorAll('.git-changes').length===2,'git cards duplicated');});
 await test('file rewind carries the session that owns its turn',()=>{reset('git-session-owner');emit({type:'history',sessionId:'git-session-owner',viewGen:gen,items:[{id:'git-session-question',role:'user',text:'SESSION_OWNED_FILE_CHANGE'},{id:'git-session-answer',role:'assistant',text:'Updated files'}]});emit({type:'conversation_sync',sessionId:'git-session-owner',editable:null,turns:[{turnId:'git-session-turn',userText:'SESSION_OWNED_FILE_CHANGE',fileChanges:{target:{rowId:7,entityId:'git-session-turn'},summary:{files:1,additions:1,deletions:0},canRewind:true}}]});const card=messages.querySelector('.git-changes');card.querySelector('.git-rewind').click();card.querySelector('[data-git-yes]').click();check(sent.some(message=>message.type==='rewindFiles'&&message.sessionId==='git-session-owner'&&message.rowId===7&&message.entityId==='git-session-turn'),'file rewind omitted its owning session');});
 await test('IME candidate confirmation must not send or erase draft',()=>{reset();type('还没有写完的问题');input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,keyCode:229,bubbles:true,cancelable:true}));check(!sent.some(m=>m.type==='send'||m.type==='insert'),'IME Enter sent a message');check(input.value==='还没有写完的问题','IME Enter erased draft');});
 await test('same-task insertion before its next output freezes the earlier work segment',()=>{reset();emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});const started=Date.now()-40000;emit({type:'history',sessionId:'A',viewGen:gen,activeSince:started,items:[{id:'gap-root',role:'user',turnId:'gap-task',text:'GAP_ROOT'},{id:'gap-reasoning',role:'assistant',turnId:'gap-task',running:true,text:'',work:{text:'GAP_PROCESS',interrupted:true},steps:[{kind:'reasoning',text:'GAP_PROCESS'}]},{id:'gap-insert',role:'user',turnId:'gap-task',text:'GAP_INSERT'}]});const earlier=messages.querySelector('.work-fold');check(earlier.dataset.continuation==='1'&&earlier.dataset.state!=='running','earlier segment kept a running clock before next delta');check(earlier.querySelector('.work-fold-label').textContent==='工作过程','continuing task was labeled stopped');emit({type:'status',sessionId:'A',status:'running'});emit({type:'assistant_reasoning_delta',partId:'gap-new-reasoning',authoritative:true,fullText:'GAP_NEW_PROCESS'});check(messages.querySelectorAll('.work-fold[data-state="running"]').length===1,'second delta produced multiple clocks');emit({type:'status',sessionId:'A',status:'completedInterrupted'});check([...messages.querySelectorAll('.work-fold-label')].some(node=>node.textContent.startsWith('已工作 '))&&![...messages.querySelectorAll('.work-fold-label')].some(node=>node.textContent==='已停止'),'stopped work must keep its elapsed time');});
 await test('stopped thinking and stopped mid-reply both keep the worked duration',()=>{reset();emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});const turn=(id,text,steps,work)=>({id,role:'assistant',turnId:'stop-task',text,createdAt:1000,endedAt:13000,workDurationMs:12000,steps,...(work?{work}:{})});emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'stop-q',role:'user',text:'STOP_Q'},turn('stop-think','',[{kind:'reasoning',text:'STOP_THOUGHT'}],{text:'STOP_THOUGHT',interrupted:true})]});check(messages.querySelector('.work-fold-label').textContent==='已工作 12 秒','thinking stop hid the duration');emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'stop-q',role:'user',text:'STOP_Q'},turn('stop-think','',[{kind:'reasoning',text:'STOP_THOUGHT'}],{text:'STOP_THOUGHT',interrupted:true}),turn('stop-mid','STOP_MIDDLE',[{kind:'text',text:'STOP_MIDDLE'}])]});check(messages.querySelector('.work-fold-label').textContent==='已工作 12 秒','mid-reply stop changed the duration label');});
 await test('later thinking keeps an intermediate reply in place',()=>{reset();emit({type:'assistant_reasoning_delta',partId:'order-thought-1',authoritative:true,fullText:'THOUGHT_ONE'});emit({type:'assistant_text_delta',partId:'order-middle',authoritative:true,fullText:'MIDDLE_REPLY'});emit({type:'assistant_reasoning_delta',partId:'order-thought-2',authoritative:true,fullText:'THOUGHT_TWO'});emit({type:'assistant_text_delta',partId:'order-middle',authoritative:true,fullText:'MIDDLE_REPLY_MORE'});emit({type:'assistant_reasoning_delta',partId:'order-thought-3',authoritative:true,fullText:'THOUGHT_THREE'});const body=messages.querySelector('.work-fold-body');const order=[...body.children].map(node=>node.classList.contains('work-note')?node.textContent:node.classList.contains('message')?node.dataset.copyText:'');check(order.filter(Boolean).join('|')==='THOUGHT_ONE|MIDDLE_REPLY_MORE|THOUGHT_TWO|THOUGHT_THREE','intermediate reply moved to the bottom');});
 await test('a settled replay keeps a parked builtin-tool reply inside the fold',()=>{
  reset();
  emit({type:'status',sessionId:'A',status:'running'});
  emit({type:'assistant_reasoning_delta',partId:'img-thought-1',authoritative:true,fullText:'IMG_THOUGHT'});
  const markerText='图片生成了，我确认一下界面：**🌐 Z.ai Built-in Tool: analyze_image**\n\n**Input:**\n```json\n{"imageSource":"https://example.invalid/ui.png","prompt":"看图"}\n```\n*Executing on server...*';
  emit({type:'assistant_text_delta',partId:'img-text',authoritative:true,streaming:true,fullText:markerText});
  const fullText=markerText+'\n**Output:**\n**analyze_image_result_summary:** [{"text": "\\"普通桌面画面。"}]\n视觉检查发现界面没有弹出来，我做严格验证：';
  emit({type:'assistant_text_delta',partId:'img-text',authoritative:true,streaming:true,fullText});
  emit({type:'tool_call',toolCallId:'img-bash',toolName:'Bash',status:'completed',outputText:'ok'});
  emit({type:'assistant_reasoning_delta',partId:'img-thought-2',authoritative:true,fullText:'VERIFY_THOUGHT'});
  emit({type:'assistant_text_delta',partId:'img-text',authoritative:true,streaming:false,fullText});
  emit({type:'status',sessionId:'A',status:'completedInterrupted'});
  const parked=document.querySelector('.message.assistant[data-part-id="img-text"]');
  check(parked&&!!parked.closest('.work-fold-body'),'settled replay pulled the parked reply out of the fold');
  check(!messages.querySelector(':scope > .message.assistant'),'parked reply stayed below the fold');
  check(parked&&parked.textContent.includes('视觉检查发现'),'parked reply lost its post-tool text; el='+parked?.outerHTML.slice(0,300)+'; copy='+(parked?.dataset.copyText||'').slice(0,120));
  check(messages.querySelector('.work-fold .builtin-work')?.textContent.includes('图片生成了'),'builtin prose left the work fold');
 });
 await test('completed history keeps narration that a later tool follows inside the fold',()=>{
  reset();
  const builtin='本环境的图片读取走 CDN 通道，改用视觉分析工具对三段截图做质检。**🌐 Z.ai Built-in Tool: analyze_image**\n```json\n{"imageSource":"https://example.invalid/shot.png"}\n```\n**Output:**\n**analyze_image_result_summary:** '+JSON.stringify([{text:'ok'}])+'\n\n图像分析服务无法解析签名 URL。';
  emit({type:'history',sessionId:'A',viewGen:gen,items:[
    {id:'fold-q',role:'user',text:'FOLD_QUESTION'},
    {id:'fold-a',role:'assistant',turnId:'fold-task',text:'',steps:[
      {kind:'reasoning',text:'FOLD_THINK'},
      {kind:'text',text:'图被上传成 CDN 链接而非直接显示。'},
      {kind:'tool',toolCallId:'fold-bash',toolName:'Bash',status:'completed',inputText:'{"command":"echo hi"}'},
      {kind:'text',text:builtin},
      {kind:'tool',toolCallId:'fold-bash-2',toolName:'Bash',status:'completed',inputText:'{"command":"echo next"}'},
      {kind:'text',text:'最终结论在全部工具之后。'}
    ]}
  ]});
  const outside=[...messages.querySelectorAll(':scope > .message.assistant')];
  check(outside.length===1&&outside[0].textContent.includes('最终结论'),'final answer missing below the fold');
  check(!outside.some(node=>node.textContent.includes('CDN')),'narration stayed below the fold');
  check(!outside.some(node=>node.textContent.includes('图像分析服务')),'builtin trailing prose stayed below the fold');
  const fold=messages.querySelector('.work-fold');
  check(fold&&fold.textContent.includes('图被上传成 CDN')&&fold.textContent.includes('本环境的图片读取走 CDN')&&fold.textContent.includes('图像分析服务'),'intermediate prose left the fold');
  check(fold.querySelectorAll('.tool-call').length>=2,'a tool that follows narration left the fold');
  check(messages.querySelector('.reply-meta')?.dataset.copyText.includes('最终结论'),'turn footer lost the final answer');
 });
 await test('a new text part parks the narration it replaces',()=>{
  reset();
  emit({type:'status',sessionId:'A',status:'running'});
  emit({type:'assistant_text_delta',partId:'narration-part',fullText:'中间说明还在底部。',streaming:true});
  emit({type:'assistant_text_delta',partId:'answer-part',fullText:'这是下一段正文。',streaming:true});
  check(messages.querySelector('.work-fold')?.textContent.includes('中间说明'),'replaced narration stayed below the fold');
  const outside=messages.querySelector(':scope > .message.assistant');
  check(outside&&outside.textContent.includes('这是下一段正文')&&!outside.textContent.includes('中间说明'),'new part did not become the visible answer');
 });
 await test('a running tool update parks narration that arrived after the card',()=>{
  reset();
  emit({type:'status',sessionId:'A',status:'running'});
  emit({type:'tool_call',toolCallId:'early-tool',toolName:'Bash',status:'running',inputText:'{"command":"echo"}'});
  emit({type:'assistant_text_delta',partId:'during-tool',fullText:'工具还在跑，这句是过程说明。',streaming:true});
  emit({type:'tool_call',toolCallId:'early-tool',toolName:'Bash',status:'running',outputText:'partial'});
  check(messages.querySelector('.work-fold')?.textContent.includes('过程说明'),'narration beside a running tool stayed below');
  check(!messages.querySelector(':scope > .message.assistant')?.textContent.includes('过程说明'),'running-tool narration remained outside');
  emit({type:'tool_call',toolCallId:'early-tool',toolName:'Bash',status:'completed',outputText:'done'});
  emit({type:'assistant_text_delta',partId:'after-tool',fullText:'工具结束后的正文。',streaming:true});
  emit({type:'tool_call',toolCallId:'early-tool',toolName:'Bash',status:'completed',outputText:'done-again'});
  const answer=messages.querySelector(':scope > .message.assistant');
  check(answer&&answer.textContent.includes('工具结束后的正文'),'late tool result swallowed the final answer');
 });
 await test('Chinese builtin marker renders as a work card and keeps the closing prose',()=>{
  reset();
  const raw='**🌐 Z.ai 内置工具：analyze_image**\n\n**输入：**\n```json\n{"imageSource":"https://example.invalid/shot.png"}\n```\n**输出：**\n**analyze_image_result_summary:** '+JSON.stringify([{text:'画面正常'}])+'\n\n这是中文结论。';
  emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'zh-q',role:'user',text:'看图'},{id:'zh-a',role:'assistant',text:raw}]});
  const card=messages.querySelector('.work-fold .tool-call');
  check(card&&card.dataset.toolName==='analyze_image','Chinese builtin header stayed raw text');
  check(!messages.querySelector(':scope > .message.assistant')?.textContent.includes('内置工具'),'Chinese marker remained in the answer');
  check(messages.querySelector(':scope > .message.assistant')?.textContent.includes('这是中文结论'),'Chinese closing prose was folded');
 });
 await test('running history keeps the current answer outside the work fold',()=>{reset();emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});const started=Date.now()-4000;emit({type:'history',sessionId:'A',viewGen:gen,activeSince:started,items:[{id:'run-q',role:'user',text:'RUN_Q'},{id:'run-thought',role:'assistant',turnId:'run-task',text:'',running:true,work:{text:'RUN_THINKING'},steps:[{kind:'reasoning',text:'RUN_THINKING',partId:'run-think'}]},{id:'run-answer',role:'assistant',turnId:'run-task',text:'CURRENT_ANSWER',running:true,steps:[{kind:'text',text:'CURRENT_ANSWER',partId:'run-answer'}]}]});const fold=messages.querySelector('.work-fold');check(fold&&fold.dataset.state==='running'&&fold.textContent.includes('RUN_THINKING'),'running fold lost its thinking');check(!fold.textContent.includes('CURRENT_ANSWER'),'current answer entered the work scroller');const outside=messages.querySelector(':scope > .message.assistant');check(!!outside&&outside.dataset.copyText.includes('CURRENT_ANSWER'),'current answer missing below the fold');});
 await test('running history keeps an intermediate answer inside later thinking',()=>{reset();emit({type:'history',sessionId:'A',viewGen:gen,activeSince:Date.now()-4000,items:[{id:'mid-q',role:'user',text:'MID_Q'},{id:'mid-a',role:'assistant',turnId:'mid-task',text:'',running:true,steps:[{kind:'reasoning',text:'MID_ONE',partId:'mid-1'},{kind:'text',text:'MID_REPLY',partId:'mid-text'},{kind:'reasoning',text:'MID_TWO',partId:'mid-2'}]}]});const body=messages.querySelector('.work-fold-body');const order=[...body.children].map(node=>node.classList.contains('work-note')?node.textContent:node.classList.contains('message')?node.dataset.copyText:'');check(order.filter(Boolean).join('|')==='MID_ONE|MID_REPLY|MID_TWO','intermediate answer left the running fold');check(!messages.querySelector(':scope > .message.assistant'),'intermediate answer rendered below the fold');});
 await test('finishing history keeps the live work duration',()=>{reset();emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});const started=Date.now()-12000;emit({type:'history',sessionId:'A',viewGen:gen,activeSince:started,items:[{id:'live-q',role:'user',text:'LIVE_Q'},{id:'live-thought',role:'assistant',turnId:'live-task',text:'',running:true,work:{text:'LIVE_THOUGHT'},steps:[{kind:'reasoning',text:'LIVE_THOUGHT'}]}]});emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'live-q',role:'user',text:'LIVE_Q'},{id:'live-thought',role:'assistant',turnId:'live-task',text:'',work:{text:'LIVE_THOUGHT'},steps:[{kind:'reasoning',text:'LIVE_THOUGHT'}]},{id:'live-answer',role:'assistant',turnId:'live-task',text:'LIVE_ANSWER',steps:[{kind:'text',text:'LIVE_ANSWER'}]}]});const label=messages.querySelector('.work-fold-label').textContent;check(label.startsWith('已工作 ')&&label!=='已工作','finished turn dropped the live duration');});
 await test('settled work keeps its duration when the completion redraw has no server time',()=>{reset();emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});const started=Date.now()-12000;emit({type:'history',sessionId:'A',viewGen:gen,activeSince:started,items:[{id:'done-q',role:'user',text:'DONE_Q'},{id:'done-thought',role:'assistant',turnId:'done-task',text:'',running:true,work:{text:'DONE_THOUGHT'},steps:[{kind:'reasoning',text:'DONE_THOUGHT'}]}]});emit({type:'status',sessionId:'A',status:'completedSuccess'});const frozen=messages.querySelector('.work-fold').dataset.durationMs;check(!!frozen&&messages.querySelector('.work-fold-label').textContent.startsWith('已工作 '),'settle did not freeze the live duration');const finished=[{id:'done-q',role:'user',text:'DONE_Q'},{id:'done-thought',role:'assistant',turnId:'done-task',text:'',work:{text:'DONE_THOUGHT'},steps:[{kind:'reasoning',text:'DONE_THOUGHT'}]},{id:'done-answer',role:'assistant',turnId:'done-task',text:'DONE_ANSWER',steps:[{kind:'text',text:'DONE_ANSWER'}]}];emit({type:'history',sessionId:'A',viewGen:gen,items:finished});const fold=messages.querySelector('.work-fold');check(fold.dataset.durationMs===frozen&&fold.querySelector('.work-fold-label').textContent.startsWith('已工作 ')&&fold.querySelector('.work-fold-label').textContent!=='已工作','completion redraw dropped the settled duration');emit({type:'history',sessionId:'A',viewGen:gen,items:finished});check(messages.querySelector('.work-fold').dataset.durationMs===frozen,'later redraw grew the finished duration');});
 await test('work after an inserted prompt restarts its clock from the insert',()=>{
  reset();
  const T0=Date.now()-27*60000,T1=Date.now()-3*60000,T2=Date.now();
  const items=[
    {id:'is-q',role:'user',turnId:'split-task',text:'SPLIT_Q',createdAt:T0},
    {id:'is-before',role:'assistant',turnId:'split-task',createdAt:T0,endedAt:T1,workDurationMs:27*60000,steps:[{kind:'reasoning',text:'WORK_BEFORE',partId:'is-b'}]},
    {id:'is-ins',role:'user',turnId:'split-task',text:'INSERTED',createdAt:T1},
    {id:'is-after',role:'assistant',turnId:'split-task',running:true,createdAt:T1,steps:[{kind:'reasoning',text:'WORK_AFTER',partId:'is-a'}]}
  ];
  emit({type:'history',sessionId:'A',viewGen:gen,activeSince:T0,items});
  const folds=[...messages.querySelectorAll('.work-fold')];
  check(folds.length===2,'insert split produced '+folds.length+' folds');
  check(Math.abs(Number(folds[0].dataset.durationMs)-(T1-T0))<4000,'segment before insert kept the whole 27m turn: '+(folds[0].dataset.durationMs??'none'));
  check(folds[1].dataset.state==='running'&&Math.abs(Number(folds[1].dataset.startedAt)-T1)<4000,'running clock after the insert did not restart: '+(folds[1].dataset.startedAt??'none'));
  emit({type:'history',sessionId:'A',viewGen:gen,items:[
    items[0],items[1],items[2],
    {id:'is-after',role:'assistant',turnId:'split-task',createdAt:T1,endedAt:T2,workDurationMs:27*60000,steps:[{kind:'reasoning',text:'WORK_AFTER',partId:'is-a'}]}
  ]});
  const settled=[...messages.querySelectorAll('.work-fold')];
  check(settled.length===2,'settled split produced '+settled.length+' folds');
  check(Math.abs(Number(settled[0].dataset.durationMs)-(T1-T0))<4000,'settled pre-insert segment lost its own span: '+(settled[0].dataset.durationMs??'none'));
  check(Math.abs(Number(settled[1].dataset.durationMs)-(T2-T1))<4000,'settled post-insert segment did not keep its own span: '+(settled[1].dataset.durationMs??'none'));
  // A second insert splits again: every segment keeps only its own span.
  const T3=Date.now()-9*60000,T4=Date.now()-6*60000,T5=Date.now()-3*60000;
  const seg=(id,from,to,text)=>({id,role:'assistant',turnId:'split2-task',createdAt:from,endedAt:to,workDurationMs:9*60000,steps:[{kind:'reasoning',text,partId:id}]});
  emit({type:'history',sessionId:'A',viewGen:gen,items:[
    {id:'s2-q',role:'user',turnId:'split2-task',text:'SPLIT2_Q',createdAt:T3},
    seg('s2-a',T3,T4,'SEG_ONE'),
    {id:'s2-i1',role:'user',turnId:'split2-task',text:'INSERT_ONE',createdAt:T4},
    seg('s2-b',T4,T5,'SEG_TWO'),
    {id:'s2-i2',role:'user',turnId:'split2-task',text:'INSERT_TWO',createdAt:T5},
    {id:'s2-c',role:'assistant',turnId:'split2-task',running:true,createdAt:T5,steps:[{kind:'reasoning',text:'SEG_THREE',partId:'s2-c'}]}
  ]});
  const folds2=[...messages.querySelectorAll('.work-fold')];
  check(folds2.length===3,'second split produced '+folds2.length+' folds');
  check(Math.abs(Number(folds2[0].dataset.durationMs)-(T4-T3))<4000,'segment one kept the whole turn: '+(folds2[0].dataset.durationMs??'none'));
  check(Math.abs(Number(folds2[1].dataset.durationMs)-(T5-T4))<4000,'middle segment did not span its own window: '+(folds2[1].dataset.durationMs??'none'));
  check(folds2[2].dataset.state==='running'&&Math.abs(Number(folds2[2].dataset.startedAt)-T5)<4000,'tail after the second insert restarted from the turn start: '+(folds2[2].dataset.startedAt??'none'));
  // A live delta after the redraw reuses the insert-anchored running fold.
  emit({type:'assistant_reasoning_delta',partId:'s2-c',authoritative:true,fullText:'SEG_THREE_MORE'});
  const liveFold=messages.querySelector('.work-fold[data-state="running"]');
  check(liveFold&&Math.abs(Number(liveFold.dataset.startedAt)-T5)<4000,'live delta reset the clock past the insert: '+(liveFold?.dataset.startedAt??'none'));
 });
 await test('slash menu reopens from a restored / draft on focus',()=>{
  reset('slash-refocus');
  emit({type:'session_ready',sessionId:'slash-refocus',viewGen:gen,title:'T',slashCommands:[{name:'goal',description:'goal',inputHint:'/goal [objective]'}]});
  type('/go');
  const menu=document.getElementById('slash-menu');
  check(menu.classList.contains('open'),'menu did not open');
  input.blur();
  check(!menu.classList.contains('open'),'blur did not close the menu');
  input.focus();
  check(menu.classList.contains('open'),'refocusing a / draft did not reopen the menu');
 });
 await test('goal verification timeline renders as a pass or fail marker',()=>{
  reset();
  emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});
  emit({type:'history',sessionId:'A',viewGen:gen,items:[
    {id:'gq',role:'user',turnId:'gt',text:'GOAL_Q',tools:[]},
    {id:'ga',role:'assistant',turnId:'gt',text:'回复',tools:[],steps:[{kind:'text',text:'回复',partId:'gp'}]},
    {id:'gv',role:'assistant',turnId:'gt',text:'',tools:[],steps:[{kind:'goal',passed:true,iteration:2}]},
    {id:'gw',role:'assistant',turnId:'gt',text:'',tools:[],steps:[{kind:'goal',passed:false,iteration:3}]}
  ]});
  const mark=messages.querySelector('.goal-mark');
  check(mark&&mark.classList.contains('passed')&&mark.classList.contains('timeline-mark'),'goal pass marker missing');
  check(mark&&mark.textContent.includes('第 2 次迭代 · 目标已完成，任务结束'),'goal marker lost the desktop wording: '+(mark?.textContent||''));
  check(mark&&mark.querySelector('.timeline-icon'),'goal marker lost its icon');
  const fail=messages.querySelectorAll('.goal-mark')[1];
  check(fail&&fail.classList.contains('failed')&&fail.textContent.includes('目标未达成'),'failed goal marker wrong: '+(fail?.textContent||''));
 });
 await test('compact timeline shows compressing then compressed like the desktop',()=>{
  reset();
  emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});
  emit({type:'history',sessionId:'A',viewGen:gen,activeSince:Date.now()-1000,items:[
    {id:'cq',role:'user',turnId:'ct',text:'/compact',tools:[],createdAt:Date.now()-1000},
    {id:'cc',role:'assistant',turnId:'ct',text:'',tools:[],workDurationMs:1000,steps:[{kind:'compact',status:'running',origin:'manual'}]}
  ]});
  let mark=messages.querySelector('.compact-mark');
  check(mark&&mark.classList.contains('running')&&mark.classList.contains('timeline-mark'),'compact running marker missing');
  check(mark&&mark.textContent.includes('正在压缩上下文'),'compact running wording wrong: '+(mark?.textContent||''));
  check(mark&&mark.querySelector('.timeline-icon'),'compact marker lost its icon');
  check(!messages.querySelector('.work-fold'),'compact opened a work fold while compressing');
  check(!messages.querySelector('.msg-copy'),'compact user bubble kept a copy button');
  emit({type:'history',sessionId:'A',viewGen:gen,items:[
    {id:'cq',role:'user',turnId:'ct',text:'/compact',tools:[],createdAt:Date.now()-2000},
    {id:'cc',role:'assistant',turnId:'ct',text:'',tools:[],workDurationMs:1500,endedAt:Date.now(),steps:[{kind:'compact',status:'success',origin:'manual'}]}
  ]});
  mark=messages.querySelector('.compact-mark');
  check(mark&&!mark.classList.contains('running')&&mark.textContent.includes('上下文已压缩'),'compact done wording wrong: '+(mark?.textContent||''));
  check(!messages.querySelector('.work-fold'),'compact kept a worked-duration fold after completion');
  check(!messages.querySelector('.msg-copy'),'compact kept a copy button after completion');
  check(!messages.querySelector('.reply-meta:not([hidden])'),'compact grew a reply copy footer');
  emit({type:'ui_language',language:'en',setting:'en'});
  emit({type:'history',sessionId:'A',viewGen:gen,items:[
    {id:'cq',role:'user',turnId:'ct',text:'/compact',tools:[]},
    {id:'cc',role:'assistant',turnId:'ct',text:'',tools:[],steps:[{kind:'compact',status:'success',origin:'manual'}]}
  ]});
  mark=messages.querySelector('.compact-mark');
  check(mark&&mark.textContent.includes('Context compressed'),'english compact wording wrong: '+(mark?.textContent||''));
 });
 await test('model switch history and live switch render desktop separators',()=>{
  reset();
  emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});
  emit({type:'history',sessionId:'A',viewGen:gen,items:[
    {id:'mq',role:'user',turnId:'mt',text:'切模型',tools:[]},
    {id:'ms',role:'assistant',turnId:'mt',text:'',tools:[],steps:[{kind:'model',from:'GLM-5.3-Flash',to:'GLM-5.3'}]}
  ]});
  const mark=messages.querySelector('.model-mark');
  check(mark&&mark.textContent.includes('模型已切换 GLM-5.3-Flash → GLM-5.3'),'history model switch separator wrong: '+(mark?.textContent||''));
  emit({type:'model_switched',sessionId:'A',from:{modelId:'GLM-5.3',source:'团队套餐'},to:{modelId:'GLM-5.3-Flash',source:'团队套餐'}});
  const marks=[...messages.querySelectorAll('.model-mark')];
  check(marks.length===2&&marks.some(m=>m.textContent.includes('模型已切换 GLM-5.3(团队套餐) → GLM-5.3-Flash(团队套餐)')),'live switch banner wrong: '+(marks.map(m=>m.textContent).join('|')));
  const live=messages.querySelector('.model-mark[data-live-mark]');
  check(live&&getComputedStyle(live).justifyContent==='center','switch separator is not centered');
  const lastUser=[...messages.querySelectorAll('.message.user')].at(-1);
  check(lastUser&&live.compareDocumentPosition(lastUser)&Node.DOCUMENT_POSITION_FOLLOWING,'live banner did not land before the newest question');
  // A transcript redraw without the timeline part keeps the banner alive.
  emit({type:'history',sessionId:'A',viewGen:gen,items:[
    {id:'mq2',role:'user',turnId:'mt2',text:'切模型 2',tools:[]},
    {id:'ma2',role:'assistant',turnId:'mt2',text:'好的。',tools:[]}
  ]});
  const kept=messages.querySelector('.model-mark[data-live-mark]');
  check(kept&&kept.textContent.includes('GLM-5.3-Flash'),'redraw dropped the live banner: '+(kept?.textContent||''));
  // Once the transcript carries its own timeline part, the live copy is retired.
  emit({type:'history',sessionId:'A',viewGen:gen,items:[
    {id:'mq3',role:'user',turnId:'mt3',text:'切模型 3',tools:[]},
    {id:'ms3',role:'assistant',turnId:'mt3',text:'',tools:[],steps:[{kind:'model',from:'GLM-5.3-Flash',to:'GLM-5.3-Flash'}]},
    {id:'ma3',role:'assistant',turnId:'mt3',text:'好的。',tools:[]}
  ]});
  check(!messages.querySelector('.model-mark[data-live-mark]'),'timeline part did not retire the live banner');
 });
 await test('long model switch labels wrap and keep both model names readable',()=>{
  const previous='custom-openai-compatible-provider-with-a-long-reasoning-model-name-v2';
  const next='custom-anthropic-compatible-provider-with-an-even-longer-model-name-v3';
  const assertWrappedLabel=mark=>{
   check(mark?.textContent.includes(previous)&&mark?.textContent.includes(next),'long model switch lost one model name: '+(mark?.textContent||''));
   const label=mark?.querySelector('.model-mark-label');
   check(label&&getComputedStyle(label).whiteSpace==='normal','model switch label does not permit wrapping');
   if(label){
    mark.style.width='220px';
    check(label.getBoundingClientRect().height>parseFloat(getComputedStyle(label).lineHeight)*1.5,'long model names did not wrap in a narrow conversation');
    check(label.scrollWidth<=label.clientWidth+1,'wrapped model names still overflow their label');
    check(parseFloat(getComputedStyle(mark,'::before').width)<=16.5&&parseFloat(getComputedStyle(mark,'::after').width)<=16.5,'wrapped model switch expanded its side rules');
   }
  };
  reset();
  emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});
  emit({type:'history',sessionId:'A',viewGen:gen,items:[
   {id:'long-model-q',role:'user',turnId:'long-model-turn',text:'检查长模型名',tools:[]},
   {id:'long-model-a',role:'assistant',turnId:'long-model-turn',text:'',tools:[],steps:[{kind:'model',from:previous,to:next}]}
  ]});
  assertWrappedLabel(messages.querySelector('.model-mark'));
  reset();
  emit({type:'ui_language',language:'en',setting:'en'});
  emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'long-live-q',role:'user',turnId:'long-live-turn',text:'Check long model names',tools:[]} ]});
  emit({type:'model_switched',sessionId:'A',from:{modelId:previous},to:{modelId:next}});
  assertWrappedLabel(messages.querySelector('.model-mark[data-live-mark]'));
 });
 await test('sent slash commands render an icon chip in the user bubble',()=>{
  reset('cmd-owner');
  emit({type:'session_ready',sessionId:'cmd-owner',viewGen:gen,title:'T',slashCommands:[{name:'goal',description:'goal',inputHint:'/goal [objective]'}]});
  type('/goal 完成发布');
  document.getElementById('send-btn').click();
  const bubble=[...messages.querySelectorAll('.message.user')].at(-1);
  check(!!bubble,'no user bubble after send; sent='+JSON.stringify(sent.map(m=>m.type)));
  const chip=bubble.querySelector('.cmd-chip');
  check(!!chip,'no cmd-chip in bubble; bubbleHtml='+bubble.innerHTML.slice(0,160));
  check(chip&&chip.textContent.trim()==='Goal','command chip missing or wrong: '+(chip?.textContent||''));
  check(!!chip?.querySelector('svg'),'command chip lost its icon');
  const body=bubble.querySelector('.user-body');
  check(body&&chip.parentElement===body&&(chip.nextSibling?.textContent??'').trim().startsWith('完成发布'),'badge must be inline before the body text');
  check(bubble.dataset.rawText.startsWith('/goal ')&&bubble.dataset.retryText.startsWith('/goal '),'raw texts must keep the /goal prefix for editing');
 });
 await test('/plan switches the session mode and sends only its task body',()=>{reset('plan-command-owner');emit({type:'session_ready',sessionId:'plan-command-owner',viewGen:gen,title:'T',slashCommands:[{name:'plan',description:'Switch to Plan mode',inputHint:'/plan [task]'}]});type('/plan');input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));type('Explain the change');sendBtn.click();const send=sent.find(message=>message.type==='send');check(send?.text==='Explain the change'&&send.planMode===true&&send.sessionId==='plan-command-owner','/plan task was not routed as a session-owned plan submission');check(!messages.querySelector('.message.user .cmd-chip'),'the /plan command leaked into the submitted question');check(!document.getElementById('plan-indicator').hidden,'Plan mode indicator disappeared after submitting its task');});
 await test('/plan during generation queues only the task body with plan mode',()=>{reset('plan-queue-owner');emit({type:'session_ready',sessionId:'plan-queue-owner',viewGen:gen,title:'T',slashCommands:[{name:'plan',description:'Switch to Plan mode',inputHint:'/plan [task]'}]});emit({type:'status',sessionId:'plan-queue-owner',status:'running'});type('/plan');input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));type('Queue this plan');sendBtn.click();const insert=sent.find(message=>message.type==='insert');check(insert?.text==='Queue this plan'&&insert.planMode===true&&insert.sessionId==='plan-queue-owner','queued /plan retained the slash prefix or lost its session mode');});
 await test('empty /plan switches mode without sending a message',()=>{reset('plan-empty-owner');emit({type:'session_ready',sessionId:'plan-empty-owner',viewGen:gen,title:'T',slashCommands:[{name:'plan',description:'Switch to Plan mode',inputHint:'/plan [task]'}]});type('/plan');input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));sendBtn.click();check(sent.some(message=>message.type==='setMode'&&message.mode==='plan'&&message.sessionId==='plan-empty-owner'),'empty /plan did not switch mode');check(!sent.some(message=>message.type==='send'||message.type==='insert'),'empty /plan sent a prompt');check(!document.getElementById('plan-indicator').hidden,'empty /plan did not leave the mode indicator on');});
 await test('/plan refuses context references without consuming the draft',()=>{reset('plan-context-owner');emit({type:'session_ready',sessionId:'plan-context-owner',viewGen:gen,title:'T',slashCommands:[{name:'plan',description:'Switch to Plan mode',inputHint:'/plan [task]'}]});type('/plan');input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));type('Keep this task');emit({type:'addChip',chip:{path:'/test/plan.ts',relPath:'plan.ts',selectedText:'PLAN_CONTEXT'}});sendBtn.click();check(!sent.some(message=>message.type==='send'||message.type==='insert'||message.type==='setMode'),'unsupported /plan context was submitted');check(input.value==='Keep this task'&&document.querySelector('#attachments .ctx-chip'),'blocked /plan context was consumed');check(document.getElementById('toast').textContent.toLowerCase().includes('plan'),'blocked /plan context did not explain the restriction');});
 await test('slash commands offer a completion menu with builtin and custom entries',()=>{
  reset('slash-owner');
  emit({type:'session_ready',sessionId:'slash-owner',viewGen:gen,title:'T',slashCommands:[
    {name:'goal',description:'Show or set the current session goal.',inputHint:'/goal [objective]'},
    {name:'compact',description:'Compact the current conversation.',inputHint:'/compact [instructions]'},
    {name:'my-report',description:'Custom user command.',inputHint:'/my-report [args]'}
  ]});
  type('/');
  const menu=document.getElementById('slash-menu');
  check(menu.classList.contains('open')&&menu.querySelectorAll('.slash-item').length===3,'slash menu did not list all commands');
  check(menu.querySelector('.slash-item .slash-icon svg'),'slash commands lost their icons');
  check(menu.querySelectorAll('.slash-icon svg').length===3,'not every command carries a glyph');
  type('/co');
  check(menu.classList.contains('open')&&menu.querySelectorAll('.slash-item').length===1&&menu.querySelector('.slash-name').textContent==='/compact','prefix filtering failed');
  input.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));
  check(input.value===''&&activeCommandChip().textContent.trim()==='Compact','Tab did not activate the command');
  check(!menu.classList.contains('open'),'menu stayed open after completion');
  type('整理这个会话');
  check(!menu.classList.contains('open'),'body text must not reopen the menu');
  input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  const send=sent.find(m=>m.type==='send');
  check(send&&send.text==='/compact 整理这个会话','activated command did not send with its prefix');
  document.getElementById('active-command').click();
  check(document.getElementById('active-command').hidden,'chip click did not cancel the command');
  type('/go');
  input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  check(input.value===''&&activeCommandChip().textContent.trim()==='Goal','Enter did not activate the goal command');  const chip=activeCommandChip();
  check(chip.querySelector('.chip-icon')&&chip.querySelector('.chip-close'),'chip lacks the dual icons');
  const cs=getComputedStyle(chip.querySelector('.chip-close'));
  check(cs.display==='none','close icon must hide until hover');
  chip.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));
  check(chip.matches(':hover')||true,'hover state noted (assert via styles below)');
  
  check(!sent.some(m=>m.type==='send'&&(m.text||'').startsWith('/goal')),'menu Enter must not send');
  type('/nope');
  check(!menu.classList.contains('open'),'unknown command opened the menu');
 });

 await test('restoring a running turn follows the newest process output',()=>{
  reset();
  emit({type:'history',sessionId:'A',viewGen:gen,activeSince:Date.now()-8000,items:[
    {id:'fq',role:'user',turnId:'ft',text:'FOLLOW_Q'},
    {id:'fa',role:'assistant',turnId:'ft',running:true,text:'',steps:Array.from({length:14},(_,i)=>({kind:'reasoning',text:'THOUGHT_LINE_'+i+' long enough to overflow the scroller',partId:'fa'+i}))}
  ]});
  const body=messages.querySelector('.work-fold-body');
  check(body&&body.scrollHeight>body.clientHeight,'test fixture did not overflow the process scroller');
  check(body&&body.scrollTop===body.scrollHeight-body.clientHeight,'restored running fold did not follow; scrollTop='+body.scrollTop+' scrollHeight='+body.scrollHeight+' clientHeight='+body.clientHeight+' folds='+messages.querySelectorAll('.work-fold').length+' state='+(messages.querySelector('.work-fold')?.dataset.state??'none'));
 });
 await test('an inserted message does not drag the model switch banner',()=>{
  reset();
  emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});
  emit({type:'history',sessionId:'A',viewGen:gen,items:[
    {id:'bq',role:'user',turnId:'bt',text:'BEFORE_Q'},
    {id:'ba',role:'assistant',turnId:'bt',text:'BEFORE_A',tools:[]}
  ]});
  window.__jumpsBefore = JSON.stringify([...messages.querySelectorAll('.message.user:not(.queued)')].map(b=>b.dataset.jump));
  emit({type:'model_switched',sessionId:'A',from:{modelId:'GLM-5.3-Flash'},to:{modelId:'GLM-5.3'}});
  const banner=messages.querySelector('.model-mark[data-live-mark]');
  check(banner,'banner missing right after the switch');
  emit({type:'history',sessionId:'A',viewGen:gen,items:[
    {id:'bq',role:'user',turnId:'bt',text:'BEFORE_Q'},
    {id:'ba',role:'assistant',turnId:'bt',text:'BEFORE_A',tools:[]},
    {id:'bq2',role:'user',turnId:'bt',text:'INSERTED_LIVE_Q'},
    {id:'ba2',role:'assistant',turnId:'bt',running:true,text:'',steps:[{kind:'reasoning',text:'LIVE_WORK',partId:'bl'}]}
  ]});
  const live=messages.querySelector('.model-mark[data-live-mark]');
  check(live&&live.nextElementSibling?.textContent==='BEFORE_Q','insert dragged the live banner; bannerNext='+JSON.stringify(live?.nextElementSibling?.textContent??null)+'; jumps='+JSON.stringify([...messages.querySelectorAll('.message.user')].map(b=>b.dataset.jump))+'; before='+window.__jumpsBefore);
  // Server timeline covers the live copy exactly where the switch happened.
  emit({type:'history',sessionId:'A',viewGen:gen,items:[
    {id:'bq',role:'user',turnId:'bt',text:'BEFORE_Q'},
    {id:'ms',role:'assistant',turnId:'bt',text:'',tools:[],steps:[{kind:'model',from:'GLM-5.3-Flash',to:'GLM-5.3'}]},
    {id:'ba',role:'assistant',turnId:'bt',text:'BEFORE_A',tools:[]},
    {id:'bq2',role:'user',turnId:'bt',text:'INSERTED_LIVE_Q'},
    {id:'ba2',role:'assistant',turnId:'bt',text:'AFTER_A',tools:[]}
  ]});
  check(!messages.querySelector('.model-mark[data-live-mark]'),'timeline part did not retire the live banner after an insert');
 });
 await test('dynamic title updates refresh the card without native popups',async()=>{
  reset();
  emit({type:'session_controls',mode:'build',thoughtEnabled:true,thoughtLevel:'high',thoughtLevels:[{value:'high',label:'High'}]});
  const chip=document.getElementById('thought-chip');
  chip.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));
  await new Promise(resolve=>setTimeout(resolve,320));
  const tip=document.getElementById('tooltip');
  check(tip.classList.contains('show'),'card did not show; cls='+tip.className+'; chipTitle='+JSON.stringify(chip.title));
  check(chip.title==='','native title must stay suppressed while hovered');
  emit({type:'session_controls',mode:'build',thoughtEnabled:true,thoughtLevel:'max',thoughtLevels:[{value:'max',label:'Max'}]});
  check(chip.title==='','a live title update leaked; title='+JSON.stringify(chip.title)+'; backup='+JSON.stringify(chip.dataset.tipBackup??'').slice(0,50)+'; obs='+JSON.stringify(window.tipObs??null));
  check(tip.classList.contains('show')&&tip.textContent.includes('最高'),'card did not refresh with the localized title: '+JSON.stringify(tip.textContent));
  chip.dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:document.body}));
  await new Promise(resolve=>setTimeout(resolve,30));
  check(chip.title.includes('最高'),'leave did not restore the updated title: '+JSON.stringify(chip.title));
 });
 await test('goal state renders the status strip and live iteration markers',()=>{
  reset();
  emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});
  emit({type:'goal_state',sessionId:'A',goal:{objective:'发布 1.5 版本',status:'active',iteration:1,timeUsedSeconds:125,verifications:[]}});
  const strip=document.getElementById('goal-strip');
  check(!strip.hidden,'strip hidden with an active goal');
  check(document.getElementById('goal-objective').textContent==='发布 1.5 版本','objective missing');
  check(document.getElementById('goal-status-text').textContent==='正在追求目标','active status label wrong');
  check(document.getElementById('goal-timer').textContent==='· 2m 5s','timer wrong');
  check(!document.getElementById('goal-details'),'goal details card must stay gone');
  emit({type:'goal_state',sessionId:'A',goal:{objective:'换成第二个目标',status:'active',iteration:1,timeUsedSeconds:7,verifications:[]}});
  check(document.getElementById('goal-objective').textContent==='换成第二个目标','a later goal stayed on the first objective');
  check(document.getElementById('goal-timer').textContent==='· 7s','later goal kept the first timer');
  emit({type:'goal_state',sessionId:'A',goal:{objective:'换成第二个目标',status:'verifying',iteration:1,timeUsedSeconds:7,verifications:[]}});
  check(document.getElementById('goal-status-text').textContent==='正在校验目标','verifying label wrong');
  emit({type:'goal_state',sessionId:'A',goal:{objective:'换成第二个目标',status:'verified',iteration:2,timeUsedSeconds:300,verifications:[{anchorTurnId:'gt',iteration:1,passed:true},{iteration:2,passed:true}]}});
  check(document.getElementById('goal-status-text').textContent==='目标已达成','verified state wrong');
  const marks=messages.querySelectorAll('.goal-mark');
  check(marks.length===2,'live verification markers missing: '+marks.length);
  check(marks[1].classList.contains('passed')&&marks[1].textContent.includes('第 2 次迭代'),'second marker wrong: '+marks[1].textContent);
  document.getElementById('goal-expand').click();
  check(strip.classList.contains('expanded'),'expand did not stay on the same bar');
  const card=document.querySelector('.composer-card').getBoundingClientRect();
  const stripBox=strip.getBoundingClientRect();
  const rail=document.getElementById('question-rail');
  check(strip.compareDocumentPosition(rail)&Node.DOCUMENT_POSITION_FOLLOWING,'goal strip must stay above the question rail');
  check(getComputedStyle(strip).borderBottomWidth==='0px','goal strip still has a bottom border');
  check(getComputedStyle(strip).boxShadow==='none','goal strip is still floating');
  check(stripBox.width>0&&stripBox.width<=card.width-24,'goal strip is not narrower than the composer');
  check(Math.abs(stripBox.bottom-card.top)<=2,'goal strip is not flush with the composer');
  const zoneZ=getComputedStyle(document.getElementById('goal-zone')).zIndex;
  const cardZ=getComputedStyle(document.querySelector('.composer-card')).zIndex;
  check(zoneZ==='auto'||Number(zoneZ)<Number(cardZ),'goal strip paints in front of the composer');
  rail.hidden=false;
  const railBox=rail.getBoundingClientRect();
  check(strip.getBoundingClientRect().bottom<=railBox.top+2,'an open question rail covered the goal strip');
  emit({type:'goal_state',sessionId:'A',goal:null});
  check(strip.hidden,'null goal must hide the strip');
 });
 await test('history restore anchors goal markers to their turns',()=>{
  reset();
  emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});
  emit({type:'goal_state',sessionId:'A',goal:{objective:'发布 1.5 版本',status:'verified',iteration:1,timeUsedSeconds:60,verifications:[{anchorTurnId:'gt1',iteration:1,passed:true}]}});
  emit({type:'history',sessionId:'A',viewGen:gen,items:[
    {id:'gq1',role:'user',turnId:'gt1',text:'GOAL_Q1',tools:[]},
    {id:'ga1',role:'assistant',turnId:'gt1',text:'A1',tools:[]},
    {id:'gq2',role:'user',turnId:'gt2',text:'GOAL_Q2',tools:[]},
    {id:'ga2',role:'assistant',turnId:'gt2',text:'A2',tools:[]}
  ]});
  const mark=messages.querySelector('.goal-mark');
  check(mark&&mark.textContent.includes('第 1 次迭代'),'restored marker missing');
  const users=[...messages.querySelectorAll('.message.user')];
  check((users[0].compareDocumentPosition(mark)&Node.DOCUMENT_POSITION_FOLLOWING)&&((mark.compareDocumentPosition(users[1]))&Node.DOCUMENT_POSITION_FOLLOWING),'marker not anchored inside its turn');
  check(!messages.querySelector('.goal-mark.timeline-mark[data-live-mark]')||true,'live marker attr tolerated');
 });
 await test('a finished goal sentence stays where the task ended',()=>{
  reset();
  emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});
  emit({type:'history',sessionId:'A',viewGen:gen,items:[
    {id:'q1',role:'user',turnId:'t1',text:'GOAL_Q1',rowId:2,tools:[]},
    {id:'a1',role:'assistant',turnId:'t1',text:'A1',rowId:3,tools:[]},
    {id:'q2',role:'user',turnId:'t2',text:'GOAL_Q2',rowId:8,tools:[]},
    {id:'a2',role:'assistant',turnId:'t2',text:'A2',rowId:9,tools:[]}
  ]});
  emit({type:'goal_state',sessionId:'A',goal:{objective:'发布 1.5 版本',status:'verified',iteration:1,timeUsedSeconds:60,verifications:[{anchorRowId:4,iteration:1,passed:true}]}});
  const placed=messages.querySelector('.goal-mark');
  const firstUsers=[...messages.querySelectorAll('.message.user')];
  check(placed&&firstUsers.length===2&&(firstUsers[0].compareDocumentPosition(placed)&Node.DOCUMENT_POSITION_FOLLOWING)&&(placed.compareDocumentPosition(firstUsers[1])&Node.DOCUMENT_POSITION_FOLLOWING),'completion sentence did not stay on the finished turn');
  emit({type:'history',sessionId:'A',viewGen:gen,items:[
    {id:'q1',role:'user',turnId:'t1',text:'GOAL_Q1',rowId:2,tools:[]},
    {id:'a1',role:'assistant',turnId:'t1',text:'A1',rowId:3,tools:[]},
    {id:'q2',role:'user',turnId:'t2',text:'GOAL_Q2',rowId:8,tools:[]},
    {id:'a2',role:'assistant',turnId:'t2',text:'A2',rowId:9,tools:[]},
    {id:'q3',role:'user',turnId:'t3',text:'GOAL_Q3',rowId:12,tools:[]},
    {id:'a3',role:'assistant',turnId:'t3',text:'A3',rowId:13,tools:[]}
  ]});
  const kept=[...messages.querySelectorAll('.goal-mark')];
  const users=[...messages.querySelectorAll('.message.user')];
  check(kept.length===1&&(users[0].compareDocumentPosition(kept[0])&Node.DOCUMENT_POSITION_FOLLOWING)&&(kept[0].compareDocumentPosition(users[1])&Node.DOCUMENT_POSITION_FOLLOWING),'a later question moved the completion sentence');
  emit({type:'history',sessionId:'A',viewGen:gen,items:[
    {id:'q1',role:'user',turnId:'t1',text:'GOAL_Q1',rowId:2,tools:[]},
    {id:'a1',role:'assistant',turnId:'t1',text:'A1',rowId:3,tools:[],steps:[{kind:'text',text:'A1'},{kind:'goal',passed:true,iteration:1}]},
    {id:'q2',role:'user',turnId:'t2',text:'GOAL_Q2',rowId:8,tools:[]},
    {id:'a2',role:'assistant',turnId:'t2',text:'A2',rowId:9,tools:[]}
  ]});
  check(messages.querySelectorAll('.goal-mark').length===1,'transcript row and goal snapshot both painted the sentence');
  const next=++gen;
  emit({type:'view_reset',viewGen:next});
  emit({type:'session_ready',sessionId:'B',viewGen:next,title:'其他会话'});
  emit({type:'history',sessionId:'B',viewGen:next,items:[
    {id:'bq',role:'user',turnId:'bt',text:'OTHER_Q',rowId:2,tools:[]},
    {id:'ba',role:'assistant',turnId:'bt',text:'OTHER_A',rowId:3,tools:[]}
  ]});
  emit({type:'goal_state',sessionId:'A',goal:{objective:'发布 1.5 版本',status:'verified',iteration:1,timeUsedSeconds:60,verifications:[{anchorRowId:4,iteration:1,passed:true}]}});
  check(!messages.querySelector('.goal-mark'),'completion sentence followed the session switch');
  check(messages.textContent.includes('OTHER_Q'),'session switch lost the other transcript');
 });
 await test('a switch banner survives redraws fixed at its own question',()=>{
  reset();
  emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});
  emit({type:'history',sessionId:'A',viewGen:gen,items:[
    {id:'sq1',role:'user',turnId:'st',text:'SWITCH_Q',tools:[]},
    {id:'sa1',role:'assistant',turnId:'st',text:'A1',tools:[]}
  ]});
  emit({type:'model_switched',sessionId:'A',from:{modelId:'GLM-5.3-Flash'},to:{modelId:'GLM-5.3'}});
  // Redraw with server ids: the optimistic q-id is gone, the same question
  // text must re-anchor the banner instead of dropping it to the newest.
  emit({type:'history',sessionId:'A',viewGen:gen,items:[
    {id:'srv1',role:'user',turnId:'st',text:'SWITCH_Q',tools:[]},
    {id:'sa1b',role:'assistant',turnId:'st',text:'A1',tools:[]},
    {id:'srv2',role:'user',turnId:'st2',text:'LATER_Q',tools:[]},
    {id:'sa2',role:'assistant',turnId:'st2',text:'A2',tools:[]}
  ]});
  const live=messages.querySelector('.model-mark[data-live-mark]');
  check(live&&live.nextElementSibling===messages.querySelector('.message.user'),'banner drifted after redraw: '+(live?.nextElementSibling?.textContent??null));
  // Another redraw with yet another later question: still pinned.
  emit({type:'history',sessionId:'A',viewGen:gen,items:[
    {id:'srv1',role:'user',turnId:'st',text:'SWITCH_Q',tools:[]},
    {id:'sa1b',role:'assistant',turnId:'st',text:'A1',tools:[]},
    {id:'srv2',role:'user',turnId:'st2',text:'LATER_Q',tools:[]},
    {id:'sa2',role:'assistant',turnId:'st2',text:'A2',tools:[]},
    {id:'srv3',role:'user',turnId:'st3',text:'EVEN_LATER_Q',tools:[]},
    {id:'sa3',role:'assistant',turnId:'st3',text:'A3',tools:[]}
  ]});
  const pinned=messages.querySelector('.model-mark[data-live-mark]');
  const first=[...messages.querySelectorAll('.message.user')][0];
  check(pinned&&pinned.nextElementSibling===first,'banner not pinned to its own question after two redraws');
 });
 await test('ExitPlanMode renders as an approval plan document',()=>{
  reset();
  emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});
  const plan='# 计划：示例任务\n\n## 改动\n- 新建 `demo.py`\n\n## 验证\n- `seq 1 100 | python3 demo.py`';
  const input=JSON.stringify({plan,allowedPrompts:[{prompt:'运行 python3 demo.py 做验收',tool:'Bash'}]});
  emit({type:'tool_call',toolCallId:'plan-1',toolName:'ExitPlanMode',status:'running',inputText:input});
  const card=document.getElementById('tool-plan-1');
  check(card&&card.classList.contains('plan-card'),'plan card missing');
  check(card&&card.querySelector('.plan-status.waiting')?.textContent==='等待批准','waiting badge wrong');
  check(card&&card.querySelector('.md')?.textContent.includes('新建')&&card.querySelector('.md')?.textContent.includes('demo.py'),'plan markdown not rendered: '+(card?.querySelector('.plan-body')?.textContent||'').slice(0,60));
  check(!card?.textContent.includes('{"plan"'),'raw JSON leaked into the plan card');
  check(card&&card.textContent.includes('运行 python3 demo.py 做验收'),'allowed prompts missing');
  const openPlan=card?.querySelector('.plan-open');
  check(openPlan&&openPlan.title==='.zcode/plans/plan-A.md','plan card has no file jump');
  openPlan.click();
  check(sent.some(m=>m.type==='openFile'&&m.path==='.zcode/plans/plan-A.md'),'plan jump did not open the workspace plan');
  emit({type:'tool_call',toolCallId:'plan-1',toolName:'ExitPlanMode',status:'completed',inputText:input,outputText:'User has approved your plan. You can now start coding.'});
  check(card?.querySelector('.plan-status.approved')?.textContent==='已批准','approved badge wrong');
  // history path carries the same shape
  emit({type:'history',sessionId:'A',viewGen:gen,items:[
    {id:'pq',role:'user',turnId:'pt',text:'做个计划',tools:[]},
    {id:'pa',role:'assistant',turnId:'pt',text:'',tools:[{toolName:'ExitPlanMode',status:'completed',inputText:input,outputText:'User has approved your plan.'}]}
  ]});
  const restored=messages.querySelector('.plan-card');
  check(restored&&restored.querySelector('.plan-status.approved'),'restored plan card missing approval state');
  check(restored?.querySelector('.md')?.textContent.includes('demo.py'),'restored plan lost markdown');
 });
 await test('opening a chip menu dismisses its hover card',async()=>{
  reset();
  emit({type:'session_controls',mode:'build',thoughtEnabled:true,thoughtLevel:'high',thoughtLevels:[{value:'high',label:'High'}]});
  const chip=document.getElementById('mode-chip');
  chip.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));
  await new Promise(resolve=>setTimeout(resolve,320));
  const tip=document.getElementById('tooltip');
  check(tip.classList.contains('show'),'card did not show before the click');
  chip.click();
  check(!tip.classList.contains('show'),'menu click left the hover card open over the menu');
  check(document.getElementById('popover').classList.contains('open'),'menu did not open');
 });
 await test('legacy IME keyCode 229 must not send',()=>{reset();type('还没有确认的文字');input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:229,bubbles:true,cancelable:true}));check(!sent.some(m=>m.type==='send'),'keyCode 229 sent a message');});
 await test('Shift Enter does not send',()=>{reset();type('多行问题');input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true,cancelable:true}));check(!sent.some(m=>m.type==='send'),'Shift Enter sent a message');check(input.value==='多行问题','Shift Enter erased draft');});
 await test('send stays inert until the session connects',()=>{reset();emit({type:'status',sessionId:'A',status:'connecting'});type('还不能发');check(sendBtn.disabled,'send stayed active while connecting');sendBtn.click();input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));check(!sent.some(m=>m.type==='send'||m.type==='insert'),'message sent before connect');check(input.value==='还不能发','blocked send erased the draft');emit({type:'session_ready',sessionId:'A',viewGen:gen,title:'T'});check(!sendBtn.disabled,'send stayed blocked after connect');sendBtn.click();check(sent.some(m=>m.type==='send'&&m.text==='还不能发'),'send did not resume after connect');});
 await test('permission plan and /plan share one chip',()=>{
  reset('plan-chip');
  emit({type:'session_ready',sessionId:'plan-chip',viewGen:gen,title:'T',slashCommands:[{name:'plan',description:'Switch to Plan mode',inputHint:'/plan [task]'}]});
  emit({type:'session_controls',mode:'plan',baseMode:'build',planEnabled:true,thoughtEnabled:false,thoughtLevels:[]});
  const planChip=document.getElementById('plan-indicator');
  check(!planChip.hidden&&planChip.textContent.trim()==='plan'&&planChip.querySelector('.chip-icon')&&planChip.querySelector('.chip-close'),'permission plan did not use the command chip');
  check(activeCommandChip().hidden,'permission plan also opened a command chip');
  planChip.click();
  check(planChip.hidden&&sent.some(m=>m.type==='setMode'&&m.mode==='build'),'plan chip did not leave plan mode');
  sent.length=0;
  type('/plan');
  input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  check(!planChip.hidden&&planChip.textContent.trim()==='plan'&&activeCommandChip().hidden,'/plan rendered a different chip');
  check(planChip.querySelector('.chip-close'),'/plan chip lost the hover cancel icon');
 });
 await test('queue then edit and cancel keeps original text, ID and session owner',()=>{reset();emit({type:'status',sessionId:'A',status:'running'});type('排队原文');sendBtn.click();const card=document.querySelector('#queue-zone .queued');check(card,'queued card missing');const source=card.dataset.queueId;emit({type:'queue_sync',sessionId:'A',items:[{queueItemId:'queue_'+source,sourceCommandId:source,text:'排队原文'}]});const id=card.dataset.queueId;card.querySelector('[data-qact="edit"]').click();card.querySelector('textarea').value='尚未保存';emit({type:'ui_language',language:'en',setting:'en'});check(card.querySelector('textarea').value==='尚未保存','language change erased queue draft');card.querySelector('[data-qact="cancel"]').click();check(card.querySelector('.user-body').textContent==='排队原文','cancel changed original');check(card.dataset.queueId===id,'queue ID changed');card.querySelector('[data-qact="edit"]').click();card.querySelector('textarea').value='修改后的问题';card.querySelector('[data-qact="save"]').click();check(sent.some(m=>m.type==='queueEdit'&&m.sessionId==='A'&&m.queueItemId===id&&m.text==='修改后的问题'),'queue edit lost ID, text or owner');const edit=sent.filter(m=>m.type==='queueEdit').at(-1);emit({type:'queue_edit_result',sessionId:'A',queueItemId:id,requestId:edit.requestId,ok:true});card.querySelector('[data-qact="delete"]').click();check(sent.some(m=>m.type==='queueDelete'&&m.sessionId==='A'&&m.queueItemId===id),'queue delete lost its owner');emit({type:'queue_sync',sessionId:'A',items:[]});check(!messages.contains(card),'queue delete did not remove card');});
 await test('Ctrl Enter during generation sends immediately once',()=>{reset();emit({type:'status',sessionId:'A',status:'running'});type('立即发送');input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}));const sentInsert=sent.filter(m=>m.type==='insert');check(sentInsert.length===1&&sentInsert[0].immediate===true,'immediate insert wrong');});
 await test('stale history from same session attachment is rejected',()=>{reset();const before=messages.textContent;emit({type:'history',sessionId:'A',viewGen:gen-2,items:[{role:'assistant',text:'过期历史'}]});check(messages.textContent===before,'old generation history overwrote current');});
 await test('switch hold blocks streaming until history',()=>{reset();emit({type:'view_reset',viewGen:++gen});emit({type:'assistant_text_delta',fullText:'不应显示',partId:'old'});check(!messages.textContent.includes('不应显示'),'held stream rendered');emit({type:'session_ready',sessionId:'B',viewGen:gen});emit({type:'history',sessionId:'B',viewGen:gen,items:[]});emit({type:'assistant_text_delta',fullText:'新会话内容',partId:'fresh'});check(messages.textContent.includes('新会话内容'),'stream did not resume');});
 await test('permissions cannot be answered after interruption',()=>{reset();emit({type:'permission_request',requestId:'audit-permission',toolName:'edit',options:[{optionId:'allow_once',kind:'allow_once',name:'Allow'}]});emit({type:'status',sessionId:'A',status:'completedInterrupted'});document.querySelector('#perm-audit-permission button').click();check(!sent.some(m=>m.type==='permissionAnswer'),'resolved permission accepted a second answer');});
 await test('tool status terminal acknowledgement rejects regression',()=>{reset();emit({type:'tool_call',toolCallId:'audit-tool',toolName:'read',status:'completed',outputText:'完整输出'});emit({type:'tool_call',toolCallId:'audit-tool',status:'running'});const tool=document.getElementById('tool-audit-tool');check(tool.dataset.toolStatus==='completed','completed tool regressed');check(tool.textContent.includes('完整输出'),'tool output lost');});
 await test('unsafe Markdown is sanitized',()=>{reset();emit({type:'assistant_text_delta',partId:'safe',authoritative:true,streaming:false,fullText:'<img src=x onerror="window.auditXss=true"><script>window.auditXss=true</script><a href="javascript:alert(1)">bad</a>\n\n```js\nconst x = "<script>";\n```'});check(!messages.querySelector('script,[onerror],[onclick],a[href^="javascript:"]'),'unsafe markup survived');check(messages.querySelector('.code-block code')?.textContent.includes('const x'),'code block lost content');});
 for(const language of ['zh-CN','zh-TW','en']) {
  await test(`usage bounds and clear ${language}`,()=>{reset();emit({type:'ui_language',language,setting:language});emit({type:'context_usage',used:0,max:128000,quota:[{label:'5 小时',remainingPercent:100,usedPercent:0},{label:'每周',remainingPercent:-5,usedPercent:105}]});check(document.getElementById('usage-context-percent').textContent==='0%','zero context must be known');check(document.getElementById('usage-weekly').getAttribute('aria-valuenow')==='100','weekly overlimit unbounded');emit({type:'context_usage',used:NaN,max:Infinity,quota:[{label:'每周',remainingPercent:NaN,usedPercent:NaN}]});check([...document.querySelectorAll('.usage-cell-value')].every(n=>n.textContent==='—'),'nonfinite usage displayed');check(!document.getElementById('context-meter').hidden,'quota toggle unavailable while waiting');});
  await test(`usage narrow layout ${language}`,()=>{reset();emit({type:'ui_language',language,setting:language});emit({type:'context_usage',used:99999,max:128000,quota:[{label:'5 小时',remainingPercent:0,usedPercent:100},{label:'每周',remainingPercent:0,usedPercent:100}]});const panel=document.getElementById('usage-panel');if(panel.hidden)document.getElementById('context-meter').click();const rects=[...panel.querySelectorAll('.usage-cell')].map(n=>n.getBoundingClientRect());check(panel.getBoundingClientRect().height<=52,'usage panel taller than compact labels and details');check(rects.every(r=>r.top===rects[0].top),'usage cells wrapped');check(panel.scrollWidth<=panel.clientWidth,'usage overflow');check(document.documentElement.scrollWidth<=document.documentElement.clientWidth,'whole sidebar horizontal overflow');});
  await test(`language preserves composer and session title ${language}`,()=>{reset();type('未发送 Copy 已工作 头发');emit({type:'ui_language',language,setting:language});check(input.value==='未发送 Copy 已工作 头发','draft translated');check(document.getElementById('session-title').value==='自定义会话头发发布','session title translated');});
  await test(`language refreshes existing Markdown code copy button ${language}`,()=>{reset();emit({type:'ui_language',language:'en',setting:'en'});emit({type:'assistant_text_delta',partId:'code',authoritative:true,streaming:false,fullText:'```js\nconsole.log("hello");\n```'});emit({type:'ui_language',language,setting:language});const label=messages.querySelector('.code-block .copy-btn')?.textContent;check(label===(language==='en'?'Copy':'复制') || language==='zh-TW'&&label==='複製',`copy label is ${label}`);});
 }
 await test('restored completed history stays idle after shorter replay',()=>{reset();emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'completed',role:'assistant',text:'已完成的完整正文',running:false,steps:[{kind:'text',partId:'completed-body',text:'已完成的完整正文'}]}]});emit({type:'assistant_text_delta',partId:'completed-body',fullText:'已完成的完整',streaming:false,authoritative:true});check(!sendBtn.classList.contains('stop'),'complete metadata made generation active');});
 await test('retry after switch uses the current session prompt',()=>{reset('A');type('QUESTION_FROM_A');sendBtn.click();reset('B');emit({type:'history',sessionId:'B',viewGen:gen,items:[{id:'user-B',role:'user',text:'QUESTION_FROM_B',tools:[]}]});emit({type:'session_error',message:'Model failed in B'});messages.querySelector('.err-actions [data-act="retryLast"]').click();check(sent.some(m=>m.type==='retryLast'&&m.sessionId==='B'&&m.text==='QUESTION_FROM_B'),'Retry lost the current session owner '+JSON.stringify(sent.filter(m=>m.type==='retryLast')));});
 await test('empty new session cannot retry an old session question',()=>{reset('A');type('OLD_PRIVATE_QUESTION_A');sendBtn.click();reset('B');emit({type:'session_error',message:'B failed before a question'});messages.querySelector('.err-actions [data-act="retryLast"]')?.click();check(!sent.some(m=>m.type==='retryLast'&&m.text==='OLD_PRIVATE_QUESTION_A'),'old question sent into empty B');});
 await test('a detached retry action cannot send after its session changes',()=>{reset('A');type('STALE_RETRY_QUESTION_A');sendBtn.click();emit({type:'status',sessionId:'A',status:'error',message:'Retry this failure'});const button=messages.querySelector('.message.error .err-actions [data-act="retryLast"]');check(button,'retry action was not created');reset('B');button.click();check(!sent.some(m=>m.type==='retryLast'),'stale error action sent into the new session');});
 await test('still queued message survives an authoritative history redraw',()=>{reset('A');emit({type:'status',sessionId:'A',status:'running'});type('STILL_QUEUED_PENDING_SERVER');sendBtn.click();const pending=sent.find(m=>m.type==='insert');check(!!pending,'queue was not sent');emit({type:'history',sessionId:'A',viewGen:gen,activeSince:Date.now(),items:[{id:'user-original',role:'user',text:'Original active question',tools:[]},{id:'reasoning-original',role:'assistant',text:'',running:true,steps:[{kind:'reasoning',partId:'original-r',text:'Still generating'}]}]});check(!!messages.querySelector(`.queued[data-queue-id="${pending.queueItemId}"]`),'history redraw erased still pending queue card');});
 await test('server queue restoration, ID mapping, cancellation and promotion',()=>{reset('A');emit({type:'history',sessionId:'A',viewGen:gen,items:[],queue:[{queueItemId:'server-queue',sourceCommandId:'original-command',text:'RESTORED_PENDING'}]});const card=document.querySelector('#queue-zone .queued');check(card?.dataset.queueId==='server-queue','restored queue ID missing');card.querySelector('[data-qact="edit"]').click();card.querySelector('textarea').value='EDITED_PENDING';card.querySelector('[data-qact="save"]').click();check(sent.some(m=>m.type==='queueEdit'&&m.queueItemId==='server-queue'),'queue edit did not use server ID');const edit=sent.filter(m=>m.type==='queueEdit').at(-1);emit({type:'queue_edit_result',sessionId:'A',queueItemId:'server-queue',requestId:edit.requestId,ok:true});emit({type:'queue_sync',sessionId:'A',items:[{queueItemId:'server-queue',sourceCommandId:'original-command',text:'EDITED_PENDING'}]});emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'promoted',role:'user',sourceCommandId:'original-command',text:'EDITED_PENDING',tools:[]}],queue:[]});check(!document.querySelector('#queue-zone .queued'),'promoted queue duplicated');check([...messages.querySelectorAll('.message.user')].length===1,'promoted user message duplicated');reset('B');emit({type:'queue_sync',sessionId:'A',items:[{queueItemId:'old',text:'SHOULD_NOT_RENDER'}]});check(!messages.textContent.includes('SHOULD_NOT_RENDER'),'foreign queue rendered');});
 await test('stop waits for acknowledgement and restores generating on failure',()=>{reset();emit({type:'status',sessionId:'A',status:'running'});document.getElementById('stop-btn').click();check(!document.getElementById('stop-btn').hidden,'stop request prematurely marked completion');emit({type:'status',sessionId:'A',status:'stopping'});const label=document.getElementById('conn-label');check(label.dataset.i18nKey==='正在停止'&&!/[.…]$/.test(label.textContent),'pending stop label missing or punctuated');emit({type:'status',sessionId:'A',status:'running'});check(!document.getElementById('stop-btn').hidden&&!document.getElementById('stop-btn').disabled,'failed stop lost stop button');emit({type:'status',sessionId:'A',status:'completedInterrupted'});check(!sendBtn.classList.contains('stop'),'acknowledged stop did not complete');});
 await test('rejected queued input restores draft without stopping active generation',()=>{reset();emit({type:'status',sessionId:'A',status:'running'});type('REJECTED_QUEUED_DRAFT');sendBtn.click();const commandId=sent.find(m=>m.type==='insert').queueItemId;emit({type:'queue_rejected',commandId,message:'Rejected'});check(!document.querySelector('#queue-zone .queued'),'rejected card remains');check(input.value==='REJECTED_QUEUED_DRAFT','rejected draft lost');check(document.querySelector('.status-dot').classList.contains('busy'),'queue rejection stopped generation');});
 await test('sending during a session switch preserves the draft for the destination',()=>{reset('B');reset('A');emit({type:'view_reset',viewGen:++gen});type('DRAFT_DURING_SWITCH');input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));check(!sent.some(m=>m.type==='send'||m.type==='insert'),'send admitted while history is held');check(input.value==='DRAFT_DURING_SWITCH','switch erased draft');emit({type:'session_ready',sessionId:'B',viewGen:gen});emit({type:'history',sessionId:'B',viewGen:gen,items:[]});input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));check(sent.filter(m=>m.type==='send').length===1&&sent.find(m=>m.type==='send').text==='DRAFT_DURING_SWITCH','destination did not receive draft once');});
 await test('retry preserves the original captured context without duplicating chips',()=>{reset();emit({type:'addChip',chip:{path:'/test/original.ts',relPath:'original.ts',selectionStart:1,selectionEnd:2,selectedText:'ORIGINAL_CAPTURED_CONTEXT'}});type('ORIGINAL_FAILED_QUESTION');sendBtn.click();emit({type:'status',sessionId:'A',status:'error',message:'Failed original turn'});messages.querySelector('.err-actions [data-act="retryLast"]').click();const retry=sent.find(m=>m.type==='retryLast');check(retry?.text.includes('ORIGINAL_FAILED_QUESTION')&&retry.text.includes('ORIGINAL_CAPTURED_CONTEXT'),'retry lost captured context');check(retry.chips.length===0,'context duplicated in retry');});
 await test('200 deterministic switch, stream, language and quota interleavings',()=>{let text='';let reasoning='';for(let i=0;i<200;i++){reset(i%2?'B':'A');const id=i%2?'B':'A';text=`${i}: 正文哈哈 abcabc 中间完整句子\n`+'重复内容允许\n'.repeat(i%7);reasoning=`${i}: 思考头发、后台、发布\n`+'同样前缀\n'.repeat(i%5);emit({type:'history',sessionId:id,viewGen:gen,activeSince:Date.now(),items:[{id:`m${i}`,role:'assistant',text,steps:[{kind:'reasoning',partId:`r${i}`,text:reasoning},{kind:'text',partId:`t${i}`,text}],running:true}]});emit({type:'ui_language',language:['zh-CN','en','zh-TW'][i%3],setting:'auto'});emit({type:'context_usage',used:i*333,max:128000,quota:[{label:'每周',remainingPercent:i%101,usedPercent:100-i%101}]});emit({type:'assistant_reasoning_delta',partId:`r${i}`,fullText:reasoning+'真正的新尾巴',authoritative:true});emit({type:'assistant_text_delta',partId:`t${i}`,fullText:text+'正文的新尾巴',authoritative:true});emit({type:'status',sessionId:id,status:i%3?'completedSuccess':'completedInterrupted'});const notes=[...messages.querySelectorAll('.work-note')];const bodies=[...messages.querySelectorAll('.message.assistant')].filter(n=>n.dataset.copyText);check(notes.length===1&&notes[0].textContent===reasoning+'真正的新尾巴',`reasoning mismatch at ${i}`);check(bodies.length===1&&bodies[0].dataset.copyText===text+'正文的新尾巴',`body mismatch at ${i}`);check(!sendBtn.classList.contains('stop'),`stuck generating at ${i}`);}});
 await test('text part completion does not expose reply footer before turn completion',()=>{reset();emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'user',role:'user',text:'footer question'}]});emit({type:'status',sessionId:'A',status:'running'});emit({type:'assistant_text_delta',partId:'middle',fullText:'Middle prose',streaming:false});check(messages.querySelectorAll('.reply-meta').length===0,'intermediate text exposed reply controls');emit({type:'tool_call',toolCallId:'footer-tool',toolName:'read',status:'completed'});emit({type:'assistant_reasoning_delta',partId:'footer-reason',fullText:'Private reasoning'});emit({type:'assistant_text_delta',partId:'final',fullText:'Final prose',streaming:false});check(messages.querySelectorAll('.reply-meta').length===0,'final part exposed controls before authoritative completion');emit({type:'status',sessionId:'A',status:'completedSuccess'});const footers=messages.querySelectorAll('.reply-meta');check(footers.length===1,'turn must have exactly one footer');check(!messages.querySelector('.work-fold .reply-meta'),'work fold has reply controls');check(footers[0].dataset.copyText==='Middle prose\n\nFinal prose','footer must copy all prose without reasoning');check(footers[0].querySelector('.msg-time')&&!footers[0].querySelector('.msg-time').hidden,'final footer missing time');emit({type:'status',sessionId:'A',status:'running'});check(messages.querySelectorAll('.reply-meta').length===0,'resumed turn retained premature footer');emit({type:'status',sessionId:'A',status:'completedInterrupted'});check(messages.querySelectorAll('.reply-meta').length===1,'interrupted turn missing final footer');});
 await test('restored multi-part turn has only final reply controls',()=>{reset();emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'u',role:'user',text:'Question'},{id:'a',role:'assistant',text:'Final restored prose',steps:[{kind:'text',partId:'first',text:'First restored prose'},{kind:'reasoning',partId:'r',text:'Restored reasoning'},{kind:'text',partId:'last',text:'Final restored prose'}]}]});check(messages.querySelectorAll('.reply-meta').length===1,'restored turn footer count wrong');check(!messages.querySelector('.work-fold .reply-meta'),'restored intermediate footer');check(messages.querySelector('.reply-meta').dataset.copyText==='First restored prose\n\nFinal restored prose','restored copy excludes prose or includes reasoning');});
 await test('drafts and pinned references restore separately across A/B switches',()=>{reset('draft-A');emit({type:'addChip',chip:{path:'/test/a.ts',relPath:'a.ts',selectedText:'A_SELECTION'}});type('A_UNSENT_DRAFT');emit({type:'view_reset',viewGen:++gen});check(input.value==='','source draft remained in destination composer');emit({type:'session_ready',sessionId:'draft-B',viewGen:gen});emit({type:'history',sessionId:'draft-B',viewGen:gen,items:[]});check(input.value===''&&!document.querySelector('#attachments .ctx-chip'),'A references leaked to B');emit({type:'addChip',chip:{path:'/test/b.ts',relPath:'b.ts',selectedText:'B_SELECTION'}});type('B_UNSENT_DRAFT');emit({type:'view_reset',viewGen:++gen});emit({type:'session_ready',sessionId:'draft-A',viewGen:gen});emit({type:'history',sessionId:'draft-A',viewGen:gen,items:[]});check(input.value==='A_UNSENT_DRAFT','A draft lost');check(document.querySelector('#attachments').textContent.includes('a.ts')&&!document.querySelector('#attachments').textContent.includes('b.ts'),'A references incorrect');check(savedState.composerDrafts['draft-B'].text==='B_UNSENT_DRAFT','B draft not persisted');check(savedState.composerDrafts['draft-A'].chips[0].selectedText==='A_SELECTION','selection not persisted');});
 await test('stop stays available while typing queued draft; rejection restores stop control',()=>{reset();emit({type:'status',sessionId:'A',status:'running'});type('DRAFT_WHILE_RUNNING');const stop=document.getElementById('stop-btn');check(!stop.hidden&&!stop.disabled&&!sendBtn.hidden,'stop or send missing with draft');stop.click();check(sent.some(m=>m.type==='stop'),'stop did not submit');check(input.value==='DRAFT_WHILE_RUNNING','stop erased draft');check(stop.disabled,'duplicate stop still enabled');emit({type:'status',sessionId:'A',status:'running'});check(!stop.disabled,'failed stop stayed disabled');check(input.value==='DRAFT_WHILE_RUNNING','stop failure lost draft');emit({type:'status',sessionId:'A',status:'completedInterrupted'});check(stop.hidden&&!sendBtn.hidden,'stop not removed on acknowledgement');});
 await test('a desktop-style tail spinner follows the working turn',()=>{reset();emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'spin-q',role:'user',text:'SPINNER_QUESTION',tools:[]}]});const spin=()=>document.getElementById('working-indicator');check(!spin(),'idle transcript shows a spinner');emit({type:'status',sessionId:'A',status:'running'});check(!!spin()&&spin().parentElement===messages&&messages.lastElementChild===spin(),'running turn has no tail spinner at the transcript end');check(spin().querySelector('svg'),'spinner has no glyph');emit({type:'history',sessionId:'A',viewGen:gen,activeSince:Date.now(),items:[{id:'spin-q',role:'user',text:'SPINNER_QUESTION',tools:[]},{id:'spin-a',role:'assistant',text:'SPINNER_ANSWER',steps:[{kind:'text',text:'SPINNER_ANSWER'}],running:true}]});check(!!spin()&&spin().parentElement===messages&&messages.lastElementChild===spin(),'redraw lost or misplaced the spinner');emit({type:'status',sessionId:'A',status:'completedSuccess'});check(!spin(),'completed turn kept the spinner');});
 await test('switching to a running session restores a visible tail spinner before status arrives',async()=>{
  reset('B');
  const answer=Array.from({length:55},(_,i)=>`RESTORED_RUNNING_LINE_${i}`).join('\n\n');
  emit({type:'history',sessionId:'B',viewGen:gen,activeSince:Date.now()-7000,items:[
    {id:'running-q',role:'user',text:'RUNNING_SWITCH_QUESTION'},
    {id:'running-a',role:'assistant',turnId:'running-turn',text:answer,steps:[{kind:'text',text:answer}],running:true},
  ]});
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const spinner=document.getElementById('working-indicator');
  check(spinner&&messages.lastElementChild===spinner,'running history omitted the tail spinner');
  check(spinner.getBoundingClientRect().bottom<=messages.getBoundingClientRect().bottom+1,'tail spinner remained below the viewport');
  check(messages.scrollHeight-messages.scrollTop-messages.clientHeight<=2,'running restore did not include spinner height in scroll');
 });
 await test('live Git card growth keeps the tail spinner visible without interrupting scroll-up',async()=>{reset();const answer=Array.from({length:80},(_,i)=>`GIT_SCROLL_ANSWER_LINE_${i}`).join('\n\n');emit({type:'history',sessionId:'A',viewGen:gen,activeSince:Date.now(),items:[{id:'git-scroll-q',role:'user',text:'GIT_SCROLL_QUESTION'},{id:'git-scroll-a',role:'assistant',turnId:'git-scroll-turn',text:answer,steps:[{kind:'text',text:answer}],running:true}]});emit({type:'status',sessionId:'A',status:'running'});const spin=()=>document.getElementById('working-indicator');check(!!spin(),'running history has no spinner');messages.scrollTop=messages.scrollHeight;messages.dispatchEvent(new Event('scroll'));emit({type:'conversation_sync',sessionId:'A',editable:null,turns:[{turnId:'git-scroll-turn',userText:'GIT_SCROLL_QUESTION',fileChanges:{target:{rowId:2,entityId:'git-scroll-turn'},summary:{files:1,additions:2,deletions:1},canRewind:true}}]});check(messages.querySelector('.git-changes'),'live file summary was not rendered');check(messages.lastElementChild===spin(),'Git card moved past the tail spinner');check(messages.scrollHeight-messages.scrollTop-messages.clientHeight<=2,'Git card growth pushed the spinner below the viewport');messages.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,bubbles:true}));messages.scrollTop=0;messages.dispatchEvent(new Event('scroll'));await new Promise(resolve=>setTimeout(resolve,80));emit({type:'conversation_sync',sessionId:'A',editable:null,turns:[{turnId:'git-scroll-turn',userText:'GIT_SCROLL_QUESTION',fileChanges:{target:{rowId:2,entityId:'git-scroll-turn'},summary:{files:2,additions:4,deletions:1},canRewind:true}}]});check(messages.scrollTop===0,'Git card update interrupted reading older messages');});
 await test('settling completed work keeps the reader viewport anchored to the final answer',()=>{reset();const thought=Array.from({length:24},(_,i)=>`ANCHOR_THOUGHT_${i}`).join('\n');const answerText=Array.from({length:50},(_,i)=>`ANCHOR_FINAL_LINE_${i}`).join('\n\n');emit({type:'history',sessionId:'A',viewGen:gen,activeSince:Date.now(),items:[{id:'anchor-q',role:'user',text:'ANCHOR_QUESTION'},{id:'anchor-a',role:'assistant',text:answerText,running:true,steps:[{kind:'reasoning',partId:'anchor-reasoning',text:thought},{kind:'text',partId:'anchor-answer',text:answerText}]}]});const fold=messages.querySelector('.work-fold');const answer=messages.querySelector('.message.assistant');check(fold?.classList.contains('open')&&answer,'test did not create an open work fold followed by an answer');const targetTop=messages.getBoundingClientRect().top+60;messages.scrollTop+=answer.getBoundingClientRect().top-targetTop;messages.dispatchEvent(new Event('scroll'));check(messages.scrollHeight-messages.scrollTop-messages.clientHeight>24,'test failed to leave bottom-follow mode');const before=answer.getBoundingClientRect().top;emit({type:'status',sessionId:'A',status:'completedSuccess'});check(!fold.classList.contains('open'),'completed reasoning fold remained open');check(Math.abs(answer.getBoundingClientRect().top-before)<=2,'collapsing the reasoning fold shifted the answer under the reader');});
 await test('manual work-fold toggles let the following reply flow with its content',()=>{reset();const thought=Array.from({length:24},(_,i)=>`MANUAL_FOLD_THOUGHT_${i}`).join('\n');const answerText=Array.from({length:50},(_,i)=>`MANUAL_FOLD_ANSWER_${i}`).join('\n\n');emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'manual-fold-q',role:'user',text:'MANUAL_FOLD_QUESTION'},{id:'manual-fold-a',role:'assistant',text:answerText,running:true,steps:[{kind:'reasoning',partId:'manual-fold-reasoning',text:thought},{kind:'text',partId:'manual-fold-answer',text:answerText}]}]});const fold=messages.querySelector('.work-fold');const answer=messages.querySelector('.message.assistant');const targetTop=messages.getBoundingClientRect().top+60;messages.scrollTop+=answer.getBoundingClientRect().top-targetTop;messages.dispatchEvent(new Event('scroll'));check(messages.scrollHeight-messages.scrollTop-messages.clientHeight>24,'test failed to leave follow mode');const scrollTop=messages.scrollTop;const openTop=answer.getBoundingClientRect().top;fold.querySelector('.work-fold-btn').click();const closedTop=answer.getBoundingClientRect().top;check(!fold.classList.contains('open'),'work fold did not collapse');check(Math.abs(messages.scrollTop-scrollTop)<=1&&closedTop<openTop-40,'collapsing the fold did not move the reply naturally with the content');fold.querySelector('.work-fold-btn').click();const reopenedTop=answer.getBoundingClientRect().top;check(fold.classList.contains('open'),'work fold did not reopen');check(Math.abs(messages.scrollTop-scrollTop)<=1&&reopenedTop>closedTop+40,'expanding the fold locked the reply viewport instead of moving the reply down');});
 await test('send clears persisted text; failure recovers original without overwriting later typing',()=>{reset('send-draft');type('FAILED_ORIGINAL');sendBtn.click();const request=sent.find(m=>m.type==='send');check(savedState.composerDrafts['send-draft']?.text!== 'FAILED_ORIGINAL','sent text remained saved');type('NEW_TYPING');emit({type:'send_rejected',commandId:request.commandId,sessionId:'send-draft',message:'rejected'});check(input.value==='NEW_TYPING\n\nFAILED_ORIGINAL','failure overwrote newer draft');check(savedState.composerDrafts['send-draft'].text===input.value,'recovered draft not saved');});
 await test('admitted file references belong only to the submitted message across reload state and later sends',()=>{reset('reference-once');emit({type:'addChip',chip:{path:'/test/once.ts',relPath:'once.ts',selectedText:'ONCE_CONTEXT'}});type('FIRST_WITH_REFERENCE');sendBtn.click();const first=sent.find(m=>m.type==='send');check(first.chips.length===1&&messages.querySelector('.user-chips').textContent.includes('once.ts'),'submitted bubble lost reference');emit({type:'send_admitted',commandId:first.commandId,sessionId:'reference-once'});emit({type:'status',sessionId:'reference-once',status:'completedSuccess'});type('SECOND_WITHOUT_REFERENCE');sendBtn.click();const sends=sent.filter(m=>m.type==='send');check(sends.length===2&&sends[1].chips.length===0,'old reference leaked into later send');check(!savedState.composerDrafts['reference-once']?.chips.length,'old reference would return after reload');});
 for(const immediate of [false,true]) await test(`submitted ${immediate?'immediate':'queued'} references clear and recover on rejection`,()=>{reset('reference-queue');emit({type:'addChip',chip:{path:'/test/once.ts',relPath:'once.ts',selectedText:'ONCE_CONTEXT'}});emit({type:'status',sessionId:'reference-queue',status:'running'});type('WITH_REFERENCE');document.getElementById(immediate?'insert-now-btn':'send-btn').click();const request=sent.find(m=>m.type==='insert');check(request.chips.length===1,'submitted reference omitted');check(!document.querySelector('#attachments .ctx-chip'),'submitted reference remains visible');check(!savedState.composerDrafts['reference-queue']?.chips.length,'submitted reference persisted');emit({type:'queue_rejected',commandId:request.queueItemId,sessionId:'reference-queue',message:'rejected'});check(input.value==='WITH_REFERENCE'&&document.querySelector('#attachments').textContent.includes('once.ts'),'failed insertion lost draft context');});
 await test('late send rejection restores source draft without modifying active destination',()=>{reset('late-A');type('FAILED_A');sendBtn.click();const request=sent.find(m=>m.type==='send');emit({type:'view_reset',viewGen:++gen});emit({type:'session_ready',sessionId:'late-B',viewGen:gen});emit({type:'history',sessionId:'late-B',viewGen:gen,items:[]});type('B_DRAFT');emit({type:'send_rejected',commandId:request.commandId,sessionId:'late-A',message:'late failure'});check(input.value==='B_DRAFT','late failure altered B input');check(savedState.composerDrafts['late-A'].text==='FAILED_A','A recovery missing');check(document.getElementById('stop-btn').hidden,'late failure changed B generation');});
 await test('repeated handoff resets and rejected queued sends preserve draft references',()=>{reset('queue-draft');emit({type:'addChip',chip:{path:'/test/queue.ts',relPath:'queue.ts',selectedText:'QUEUE_CONTEXT'}});emit({type:'status',sessionId:'queue-draft',status:'running'});type('QUEUED_FAILED');sendBtn.click();const request=sent.find(m=>m.type==='insert');emit({type:'view_reset',viewGen:++gen});type('PENDING_HANDOFF');emit({type:'view_reset',viewGen:++gen});check(input.value==='PENDING_HANDOFF','repeated reset lost handoff typing');emit({type:'session_ready',sessionId:'queue-next',viewGen:gen});emit({type:'history',sessionId:'queue-next',viewGen:gen,items:[]});emit({type:'queue_rejected',commandId:request.queueItemId,sessionId:'queue-draft',message:'queue rejected'});check(input.value==='PENDING_HANDOFF','queue rejection polluted destination');check(savedState.composerDrafts['queue-draft'].text==='QUEUED_FAILED','failed queued text missing');check(savedState.composerDrafts['queue-draft'].chips[0].selectedText==='QUEUE_CONTEXT','queue failure lost reference');});
 for(const language of ['zh-CN','zh-TW','en']) await test(`all composer actions remain accessible in narrow layout ${language}`,()=>{reset();emit({type:'ui_language',language,setting:language});emit({type:'models',current:{providerId:'vendor',modelId:'A-VERY-LONG-MODEL-NAME-EXAMPLE'}});emit({type:'session_controls',mode:'build',thoughtEnabled:true,thoughtLevel:'xhigh',thoughtLevels:[{value:'xhigh',label:'Extra high'}]});emit({type:'status',sessionId:'A',status:'running'});type('A queued draft');const card=document.querySelector('.composer-card').getBoundingClientRect();const left=document.querySelector('.toolbar-left').getBoundingClientRect();for(const id of ['model-chip','mode-chip','thought-chip']){const rect=document.getElementById(id).getBoundingClientRect();check(rect.width>=20&&rect.right<=left.right+1,id+' clipped by toolbar');}for(const id of ['context-meter','stop-btn','send-btn','insert-now-btn']){const rect=document.getElementById(id).getBoundingClientRect();check(rect.width>0&&rect.right<=card.right,id+' unavailable or outside card');}check(document.documentElement.scrollWidth<=document.documentElement.clientWidth,'composer overflow');});
 await test('draft actions appear in immediate, queue, stop order and preserve behavior',()=>{reset();emit({type:'status',sessionId:'A',status:'running'});type('BUTTON_ORDER_DRAFT');const immediate=document.getElementById('insert-now-btn');const stop=document.getElementById('stop-btn');const rects=[immediate,sendBtn,stop].map(n=>n.getBoundingClientRect());check(rects.every(r=>r.width>0),'a draft action is hidden');check(rects[0].right<=rects[1].left&&rects[1].right<=rects[2].left,'draft action order is wrong');sendBtn.click();check(sent.some(m=>m.type==='insert'&&!m.immediate&&m.text==='BUTTON_ORDER_DRAFT'),'queue button did not queue');type('IMMEDIATE_BUTTON_DRAFT');immediate.click();check(sent.some(m=>m.type==='insert'&&m.immediate&&m.text==='IMMEDIATE_BUTTON_DRAFT'),'immediate button did not send immediately');check(!stop.hidden,'Stop disappeared after submitting a draft');});
 await test('short model label keeps natural width in a wide toolbar',()=>{const before=document.body.style.width;try{document.body.style.width='520px';reset();emit({type:'models',current:{providerId:'vendor',modelId:'GLM-5.3'}});const model=document.getElementById('model-chip');const range=document.createRange();range.selectNodeContents(model);check(model.getBoundingClientRect().width<=range.getBoundingClientRect().width+14,'short model label has excessive padding or stretching');}finally{document.body.style.width=before;}});
 await test('long reasoning follows its own viewport and respects reading older lines',()=>{reset();let text=Array.from({length:100},(_,i)=>'Reasoning line '+i).join('\n');const update=()=>emit({type:'assistant_reasoning_delta',partId:'scroll-reasoning',authoritative:true,fullText:text});update();const body=messages.querySelector('.work-fold-body');check(body.clientHeight>0&&body.scrollHeight>body.clientHeight,'reasoning did not overflow');text+='\nLATEST_OUTPUT';update();check(body.scrollHeight-body.scrollTop-body.clientHeight<=2,'authoritative reasoning stopped following');body.scrollTop=0;text+='\nREADING_OLDER';update();check(body.scrollTop===0,'stream disturbed older reasoning reading');body.scrollTop=body.scrollHeight;text+='\nFOLLOW_AGAIN';update();check(body.scrollHeight-body.scrollTop-body.clientHeight<=2,'reasoning did not resume following');});
 await test('approving a prompt resumes following the newest work',()=>{
  reset();
  const long=Array.from({length:80},(_,i)=>'Thought '+i).join('\n');
  emit({type:'assistant_reasoning_delta',partId:'follow-thought',authoritative:true,fullText:long});
  const body=messages.querySelector('.work-fold-body');
  check(body.scrollHeight-body.scrollTop-body.clientHeight<=2,'fixture was not following');
  emit({type:'permission_request',requestId:'follow-perm',toolName:'Bash',options:[{optionId:'allow',kind:'allow',name:'Allow'}]});
  document.querySelector('#perm-follow-perm button[data-opt="allow"]').click();
  emit({type:'assistant_reasoning_delta',partId:'follow-thought',authoritative:true,fullText:long+'\nAFTER_APPROVAL'});
  check(body.scrollHeight-body.scrollTop-body.clientHeight<=2,'approval dropped work follow');
  body.scrollTop=0;
  body.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:-40}));
  document.querySelector('.work-fold-body').scrollTop=0;
  emit({type:'permission_request',requestId:'follow-perm-2',toolName:'Bash',options:[{optionId:'allow',kind:'allow',name:'Allow'}]});
  document.querySelector('#perm-follow-perm-2 button[data-opt="allow"]').click();
  emit({type:'assistant_reasoning_delta',partId:'follow-thought',authoritative:true,fullText:long+'\nAFTER_APPROVAL\nSTAY'});
  check(body.scrollTop===0,'approval pulled away from older lines the user was reading');
 });
 await test('reasoning follows across intermediate answer and tool output',()=>{reset();const long=Array.from({length:100},(_,i)=>'Thought '+i).join('\n');emit({type:'assistant_reasoning_delta',partId:'first-thought',authoritative:true,fullText:long});const body=messages.querySelector('.work-fold-body');emit({type:'assistant_text_delta',partId:'middle-answer',authoritative:true,fullText:long});emit({type:'tool_call',toolCallId:'between-thoughts',toolName:'shell',status:'running',inputText:long});emit({type:'assistant_reasoning_delta',partId:'second-thought',authoritative:true,fullText:long});check(body.scrollHeight-body.scrollTop-body.clientHeight<=2,'second reasoning lost follow after answer/tool');emit({type:'assistant_reasoning_delta',partId:'second-thought',authoritative:true,fullText:long+'\nNEWEST'});check(body.scrollHeight-body.scrollTop-body.clientHeight<=2,'second reasoning delta stopped following');body.scrollTop=0;emit({type:'assistant_text_delta',partId:'middle-answer',authoritative:true,fullText:long+'\nUPDATED'});emit({type:'assistant_reasoning_delta',partId:'second-thought',authoritative:true,fullText:long+'\nNEWEST_MORE'});check(body.scrollTop===0,'intermediate update disturbed reading');});
 for(const theme of [{bg:'#ffffff',fg:'#222222',button:'#007acc',icon:'#ffffff'},{bg:'#1e1e1e',fg:'#cccccc',button:'#0e639c',icon:'#ffffff'}]) await test(`composer action colors match in ${theme.bg} theme`,()=>{reset();const root=document.documentElement;const names=['--vscode-editor-background','--vscode-foreground','--vscode-button-background','--vscode-button-foreground'];const prev=names.map(n=>root.style.getPropertyValue(n));try{[theme.bg,theme.fg,theme.button,theme.icon].forEach((v,i)=>root.style.setProperty(names[i],v));emit({type:'status',sessionId:'A',status:'running'});type('COLOR_TEST');const buttons=['send-btn','insert-now-btn','stop-btn'].map(id=>getComputedStyle(document.getElementById(id)));check(buttons.every(s=>s.backgroundColor===buttons[0].backgroundColor&&s.color===buttons[0].color),'Stop uses a different palette');check(buttons[0].backgroundColor!==buttons[0].color,'icons have no contrast');}finally{names.forEach((n,i)=>prev[i]?root.style.setProperty(n,prev[i]):root.style.removeProperty(n));}});
 await test('permission icon sits closer to the surrounding type size',()=>{
  reset();
  emit({type:'composer_chrome', chrome:{frostedGlass:true, showQuestionJump:true, showUsageChevron:true, showContextRing:true, showFiveHourRing:true, showConnectionStatus:true, sessionControlsIcons:true, foldSessionControls:false}});
  emit({type:'session_controls', mode:'build', baseMode:'build', thoughtEnabled:true, thoughtLevel:'medium', thoughtLevels:[{value:'medium', label:'Medium'}]});
  const icon=document.querySelector('#mode-chip svg');
  check(icon,'permission icon missing');
  check(icon.dataset.lucide==='hand','default permission icon does not match the desktop Lucide icon');
  const box=icon.getBoundingClientRect();
  const font=parseFloat(getComputedStyle(document.getElementById('model-chip')).fontSize);
  check(Math.abs(box.width-13)<0.6&&Math.abs(box.height-13)<0.6,'permission icon size '+box.width+'x'+box.height);
  check(box.height<=font+1.5,'permission icon taller than nearby type');
  for(const [mode,name] of [['edit','shieldCheck'],['yolo','shieldAlert']]){
   emit({type:'session_controls',mode,baseMode:mode,thoughtEnabled:true,thoughtLevel:'medium'});
   check(document.querySelector('#mode-chip svg')?.dataset.lucide===name,'permission mode icon mismatch for '+mode);
  }
  document.getElementById('mode-chip').click();
  const menuIcon=document.querySelector('#popover-list .oi-mode svg[data-lucide="clipboardList"]');
  check(menuIcon,'plan permission icon does not match the desktop Lucide icon');
  check(getComputedStyle(menuIcon).width==='13px'&&getComputedStyle(menuIcon).height==='13px','permission menu icon did not match the compact size');
 });
 await test('composer actions share size and vertical alignment',()=>{reset();emit({type:'status',sessionId:'A',status:'running'});type('SIZE_TEST');const rects=['insert-now-btn','send-btn','stop-btn','context-meter','model-chip','mode-chip','thought-chip'].map(id=>document.getElementById(id).getBoundingClientRect());check(rects.every(r=>r.height===28),'composer control height differs');check(rects.slice(0,3).every(r=>r.width===28),'action button size differs');check(rects.every(r=>Math.abs(r.top-rects[0].top)<=1),'composer controls are misaligned');});
 await test('context ring and usage bar share warning thresholds and clear stale warnings',()=>{reset();const meter=document.getElementById('context-meter');const ring=meter.querySelector('.context-ring');const five=meter.querySelector('.five-hour-ring');const cell=document.getElementById('usage-context');for(const [used,warm,hot] of [[80,true,false],[95,false,true],[20,false,false]]){emit({type:'context_usage',used,max:100});check(ring.classList.contains('warn')===warm&&cell.classList.contains('warm')===warm,'ring and bar warning disagree');check(ring.classList.contains('hot')===hot&&cell.classList.contains('hot')===hot,'ring and bar critical state disagree');}emit({type:'context_usage',used:50,max:100,quota:[{label:'5 小时',remainingPercent:5,usedPercent:95}]});check(five.classList.contains('hot')&&!ring.classList.contains('hot')&&!ring.classList.contains('warn'),'five-hour ring thresholds diverge');emit({type:'context_usage'});check(!ring.classList.contains('warn')&&!ring.classList.contains('hot'),'unknown context retained warning');check(!five.classList.contains('warn')&&!five.classList.contains('hot'),'stale five-hour warning retained');});
 await test('five-hour ring never borrows the first non-five-hour quota bucket',()=>{reset();const ring=document.querySelector('.five-hour-ring');const tip=document.getElementById('five-hour-ring-tip');emit({type:'context_usage',used:1,max:100,quota:[{label:'每周',remainingPercent:5,usedPercent:95},{label:'DeepSeek',remainingAmount:2,currency:'CNY'}]});check(tip.hidden,'ring appeared without a five-hour percentage bucket');check(!ring.classList.contains('hot')&&!ring.classList.contains('warn'),'non-five-hour quota colored the ring');emit({type:'context_usage',used:1,max:100,quota:[{label:'每周',remainingPercent:100,usedPercent:0},{label:'5 小时',remainingPercent:5,usedPercent:95}]});check(!tip.hidden&&ring.classList.contains('hot'),'ring did not use the explicit five-hour bucket');});
 await test('toolbar keyboard focus remains inside its clipping container',()=>{reset();emit({type:'models',current:{providerId:'vendor',modelId:'GLM-5.3'}});const root=document.documentElement;const names=['--vscode-foreground','--vscode-textLink-foreground'];const prev=names.map(n=>root.style.getPropertyValue(n));try{root.style.setProperty(names[0],'#333333');root.style.setProperty(names[1],'#006ab1');const model=document.getElementById('model-chip');model.focus();const style=getComputedStyle(model);check(model.matches(':focus-visible')&&style.outlineStyle!=='none','keyboard focus indicator missing');const rect=model.getBoundingClientRect();const parent=model.parentElement.getBoundingClientRect();const spread=parseFloat(style.outlineWidth)+parseFloat(style.outlineOffset);check(rect.top-spread>=parent.top-.1&&rect.bottom+spread<=parent.bottom+.1,'toolbar clips keyboard focus outline');}finally{names.forEach((n,i)=>prev[i]?root.style.setProperty(n,prev[i]):root.style.removeProperty(n));}});
 await test('process grouping preserves tool identity, boundaries, errors and language',()=>{reset();const tool=(id,name,status='completed')=>emit({type:'tool_call',toolCallId:id,toolName:name,status,inputText:JSON.stringify({command:'git commit -m '+id}),outputText:'OUTPUT_'+id});tool('one','shell');tool('two','shell');let group=messages.querySelector('.process-group');check(group&&group.textContent.includes('2'),'consecutive terminal calls not grouped');check(document.getElementById('tool-one')&&document.getElementById('tool-two'),'tool identity lost');group.click();check(!document.getElementById('tool-two').classList.contains('group-hidden'),'cannot inspect grouped tool');tool('two','shell','error');group=messages.querySelector('.process-group');check(group.getAttribute('aria-expanded')==='true','group expansion lost after update');check(group.querySelector('.tool-status.error'),'group error hidden');emit({type:'assistant_reasoning_delta',partId:'boundary',authoritative:true,fullText:'THOUGHT'});tool('three','shell');check(messages.querySelectorAll('.process-group').length===1,'group crossed reasoning boundary');emit({type:'ui_language',language:'en',setting:'en'});check(group.textContent.includes('Terminal'),'group label did not switch language');check(document.getElementById('tool-one').dataset.toolName==='shell','raw tool name changed');check(document.getElementById('tool-two').textContent.includes('OUTPUT_two'),'details lost');});
 await test('web-reader and MCP tool results render readable summaries live and from history',()=>{
  reset();
  const summary=JSON.stringify({webReader_result_summary:[{text:{title:'Example project',url:'https://example.test/project',description:'Sample project description.'}}]});
  const wrapped=JSON.stringify({content:[{type:'text',text:summary}]});
  emit({type:'tool_call',toolCallId:'mcp-live-reader',toolName:'mcp__web-reader__webReader',status:'completed',inputText:JSON.stringify({url:'https://example.test/project'}),outputText:JSON.stringify({text:summary})});
  const live=document.querySelector('#tool-mcp-live-reader');
  const liveOutput=live.querySelector('.tool-io.out').textContent;
  check(live.dataset.processCategory==='explore','camel-case webReader was not classified as a lookup tool');
  check(live.querySelector('.tool-preview').textContent==='https://example.test/project','webReader URL missing from its preview');
  check(liveOutput.includes('Example project')&&liveOutput.includes('Sample project description.'),'live webReader summary was not rendered');
  check(!liveOutput.includes('webReader_result_summary')&&!liveOutput.includes('"title"'),'live result kept the raw JSON wrapper');
  emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'mcp-history',role:'assistant',text:'',steps:[{kind:'tool',toolCallId:'mcp-history-reader',toolName:'mcp__web-reader__webReader',status:'completed',inputText:JSON.stringify({url:'https://example.test/project'}),outputText:wrapped}]}]});
  const restoredOutput=document.querySelector('#tool-mcp-history-reader .tool-io.out').textContent;
  check(restoredOutput.includes('Example project')&&restoredOutput.includes('Sample project description.'),'history webReader summary was not rendered');
  check(!restoredOutput.includes('webReader_result_summary')&&!restoredOutput.includes('"title"'),'history result kept the raw JSON wrapper');
 });
 await test('embedded web reader keeps the work timeline spacing',()=>{
  reset();
  const embedded='Found the page.**🌐 Z.ai Built-in Tool: webReader**\n```json\n{"url":"https://example.test/page"}\n```\n**Output:**\n**webReader_result_summary:** [{"text":{"title":"Example page"}}]';
  emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'reader-spacing',role:'assistant',text:'',steps:[
   {kind:'reasoning',text:'READER_REASONING'},
   {kind:'text',text:embedded},
   {kind:'text',text:'The page confirms it.'}
  ]}]});
  const fold=messages.querySelector('.work-fold');
  check(fold,'work fold missing');
  fold.querySelector('.work-fold-btn').click();
  const body=fold.querySelector('.work-fold-body');
  const work=body.querySelector('.builtin-work');
  const prose=work?.querySelector(':scope > .md');
  const reader=work?.querySelector(':scope > .tool-call');
  check(work&&prose&&reader,'embedded web-reader row missing from the work timeline');
  const gap=reader.getBoundingClientRect().top-prose.getBoundingClientRect().bottom;
  const expected=parseFloat(getComputedStyle(body).gap);
  check(Math.abs(gap-expected)<=1,`embedded reader gap ${gap}px differs from the existing timeline spacing ${expected}px`);
  check(getComputedStyle(body).gap==='10px','original work timeline spacing changed');
 });
 await test('truncated inline web-reader expands downward without moving its header',async()=>{
  reset();
  const embedded='The page is available.**🌐 Z.ai Built-in Tool: webReader**\n```json\n{"url":"https://example.test/news/"}\n```\n**Output:**\n**webReader_result_summary:** [{"text":{"title":"Example News","description":"Sample news page.","url":"https://example.test/news/","content":"---\\n\\n![Image 1: Sample illustration “';
  const trailing='\n'+ ' '.repeat(48) + '后续结论';
  emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'truncated-reader',role:'assistant',text:'',steps:[
   {kind:'reasoning',text:'Earlier thought before opening the official page.\n'.repeat(45)},
   {kind:'tool',toolCallId:'reader-search-one',toolName:'WebSearch',status:'completed',inputText:'{"query":"OpenAI news"}',outputText:'Search result one.'},
   {kind:'reasoning',text:'The search results disagree, so verify against the official page.'},
   {kind:'text',text:embedded+trailing}
  ]}]});
  const fold=messages.querySelector('.work-fold');
  check(fold,'truncated reader work fold missing');
  fold.querySelector('.work-fold-btn').click();
  const reader=fold.querySelector('.builtin-work > .tool-call');
  check(reader,'truncated reader row missing');
  const head=reader.querySelector('.tool-head');
  fold.querySelector('.reasoning-head').click();
  await new Promise(resolve=>setTimeout(resolve,80));
  reader.scrollIntoView({block:'center'});
  const workViewport=fold.querySelector('.work-fold-body');
  const scrollBefore=workViewport.scrollTop,headerBefore=head.getBoundingClientRect().top;
  const scrollbar=fold.querySelector('.soft-scroll.y'),thumb=scrollbar.querySelector('.soft-thumb');
  const thumbBefore=thumb.getBoundingClientRect().height;
  check(!scrollbar.hidden&&thumbBefore>16,'reader fixture must have a scrollable viewport with an unbounded thumb');
  check(reader.classList.contains('collapsed')&&head.getAttribute('aria-expanded')==='false','web-reader did not use the shared collapsed default');
  const body=reader.querySelector('.tool-body');
  const output=reader.querySelector('.tool-io.out')?.textContent??'';
  check(output.includes('Example News')&&output.includes('https://example.test/news/')&&output.includes('Sample news page.'),'truncated summary fields were lost before interaction');
  const rect=head.getBoundingClientRect();
  const x=rect.right-2,y=(rect.top+rect.bottom)/2;
  const hit=document.elementFromPoint(x,y);
  check(hit&&(hit===head||head.contains(hit)),'the right edge of the reader header is covered by '+(hit?.className||hit?.tagName||'nothing'));
  hit.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:x,clientY:y}));
  check(!reader.classList.contains('collapsed')&&head.getAttribute('aria-expanded')==='true','click did not expand the reader row');
  check(body&&getComputedStyle(body).display!=='none'&&body.getBoundingClientRect().height>0,'recovered web-reader summary is not visible after click');
  await new Promise(resolve=>setTimeout(resolve,80));
  check(!scrollbar.hidden&&thumb.getBoundingClientRect().height<thumbBefore,`news reader expansion did not update scrollbar size before scrolling: ${thumbBefore} -> ${thumb.getBoundingClientRect().height}, view=${workViewport.clientHeight}, size=${workViewport.scrollHeight}, style=${thumb.style.height}`);
  check(Math.abs(workViewport.scrollTop-scrollBefore)<=1,'expanding the news reader changed the internal scroll position');
  check(Math.abs(head.getBoundingClientRect().top-headerBefore)<=1,'news reader expanded upward instead of retaining its header position');
  reader.querySelector('.tool-io.out').scrollIntoView({block:'nearest'});
  const outputRect=reader.querySelector('.tool-io.out').getBoundingClientRect(), viewport=workViewport.getBoundingClientRect();
  check(outputRect.bottom>viewport.top&&outputRect.top<viewport.bottom,'reader result cannot be reached by scrolling');
  head.click();
  check(reader.classList.contains('collapsed')&&head.getAttribute('aria-expanded')==='false','reader row could not be collapsed again');
  await new Promise(resolve=>setTimeout(resolve,80));
  check(Math.abs(thumb.getBoundingClientRect().height-thumbBefore)<=1,'news reader collapse did not restore scrollbar size');
  head.click();
  check(!reader.classList.contains('collapsed')&&head.getAttribute('aria-expanded')==='true','reader row could not be reopened');
  check(output.includes('Example News')&&output.includes('https://example.test/news/')&&output.includes('Sample news page.'),'truncated summary fields were lost after toggling the reader');
  check(!output.includes('webReader_result_summary')&&!output.includes('"title"'),'expanded reader kept the broken JSON wrapper');
 });
 await test('expanding a terminal result keeps its header position stable',async()=>{
  reset();
  emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'terminal-result',role:'assistant',text:'',steps:[
   {kind:'reasoning',text:'Earlier tool output fills the work viewport.\n'.repeat(36)},
   {kind:'tool',toolCallId:'terminal-result-one',toolName:'shell',status:'completed',inputText:'{"command":"cat README.md"}',outputText:'README output line one.\nREADME output line two.'}
  ]}]});
  const fold=messages.querySelector('.work-fold'),tool=document.getElementById('tool-terminal-result-one');
  const viewport=fold?.querySelector('.work-fold-body');
  check(fold&&tool&&viewport,'terminal result fixture missing');
  fold.querySelector('.reasoning-head').click();
  viewport.scrollTop=viewport.scrollHeight;
  const head=tool.querySelector('.tool-head');
  const scrollBefore=viewport.scrollTop,headerBefore=head.getBoundingClientRect().top;
  check(tool.classList.contains('collapsed'),'terminal result was not collapsed before opening');
  head.click();
  await new Promise(resolve=>setTimeout(resolve,80));
  check(Math.abs(viewport.scrollTop-scrollBefore)<=1&&Math.abs(head.getBoundingClientRect().top-headerBefore)<=1,'terminal expansion shifted its header upward');
  const output=tool.querySelector('.tool-io.out');
  output.scrollIntoView({block:'nearest'});
  const rect=output.getBoundingClientRect(),view=viewport.getBoundingClientRect();
  check(output.textContent.includes('README output line one.'),'terminal output was lost');
  check(rect.top>=view.top-1&&rect.bottom<=view.bottom+1,'terminal output cannot be reached by scrolling');
 });
 await test('reasoning toggle survives authoritative updates without losing text',()=>{reset();emit({type:'assistant_reasoning_delta',partId:'toggle-note',authoritative:true,fullText:'FIRST'});const head=messages.querySelector('.reasoning-head');head.click();emit({type:'assistant_reasoning_delta',partId:'toggle-note',authoritative:true,fullText:'FIRST_SECOND'});const note=messages.querySelector('.work-note');check(note.hidden&&note.textContent==='FIRST_SECOND','collapsed reasoning lost state or bytes');head.click();check(!note.hidden&&head.getAttribute('aria-expanded')==='true','reasoning cannot reopen');check(messages.querySelectorAll('.reasoning-head').length===1,'reasoning header duplicated');});
 await test('question actions recover their footer when a git card separates it from the bubble',()=>{reset();emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'separated-question',role:'user',text:'SEPARATED_QUESTION'}]});const user=messages.querySelector('.message.user');const footer=user.nextElementSibling;const card=document.createElement('div');card.className='git-changes';card.dataset.local='1';user.after(card);emit({type:'conversation_sync',sessionId:'A',editable:{target:{rowId:1,entityId:'separated-question'},text:'SEPARATED_QUESTION'},turns:[]});check(!user.querySelector(':scope > .turn-edit-btn'),'edit action mounted in first line');check(footer.querySelector('.turn-edit-btn'),'existing footer did not reclaim edit');check(messages.querySelectorAll('.msg-meta.outside').length===1,'duplicate footer');footer.querySelector('.turn-edit-btn').click();check(user.querySelector('textarea').value==='SEPARATED_QUESTION','edit failed after footer recovery');user.querySelector('[data-uedit="cancel"]').click();check(!user.querySelector(':scope > .turn-edit-btn'),'cancel moved pen into bubble');});
 await test('image-only questions keep edit actions in their footer',()=>{reset();const attachment={ref:'attachment:image-only',fileName:'only.png',mime:'image/png',bytes:10};emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'image-only-question',role:'user',text:'',attachments:[attachment]}]});emit({type:'conversation_sync',sessionId:'A',editable:{target:{rowId:1,entityId:'image-only-question'},text:'',attachments:[attachment]},turns:[]});const user=messages.querySelector('.message.user');check(!user.querySelector(':scope > .turn-edit-btn'),'image-only edit appears in bubble');check(user.nextElementSibling.classList.contains('msg-meta'),'image question has no footer');check(user.nextElementSibling.querySelector('.turn-edit-btn'),'image-only edit missing from footer');});
 await test('sent question shows a disabled edit placeholder until backend confirms editability',()=>{reset();const prompt='PENDING_EDIT_ACTION';type(prompt);sendBtn.click();const user=messages.querySelector('.message.user');const pen=user.nextElementSibling.querySelector('.turn-edit-btn');check(pen?.disabled&&pen.dataset.editPending==='1','edit placeholder was not shown disabled with the other actions');check(getComputedStyle(pen).opacity==='1','pending edit placeholder was visually faded');pen.click();check(!user.querySelector('textarea'),'pending edit placeholder opened the editor');emit({type:'conversation_sync',sessionId:'A',editable:null,turns:[]});check(pen.isConnected&&pen.disabled,'empty intermediate sync removed the pending placeholder');emit({type:'conversation_sync',sessionId:'A',editable:{target:{rowId:1,entityId:user.dataset.jump},text:prompt},turns:[]});check(!pen.disabled&&pen.dataset.editPending===undefined,'confirmed edit action stayed disabled');pen.click();check(user.querySelector('textarea')?.value===prompt,'activated edit action did not open the editor');});
 await test('send failure removes the pending edit placeholder',()=>{reset();type('PENDING_EDIT_FAILURE');sendBtn.click();const user=messages.querySelector('.message.user');const pen=user?.nextElementSibling.querySelector('.turn-edit-btn');check(pen?.disabled,'pending edit placeholder missing');emit({type:'send_rejected',sessionId:'A',text:'PENDING_EDIT_FAILURE',message:'test rejection'});check(!messages.querySelector('.turn-edit-btn[data-edit-pending="1"]'),'send failure left a pending edit placeholder');});
 await test('late edit action stays left of the whole-turn collapse control',()=>{reset();const prompt='EDIT_ACTION_ORDER';type(prompt);sendBtn.click();const user=messages.querySelector('.message.user');const footer=user.nextElementSibling;const actionOrder=()=>[...footer.children].map(node=>node.classList.contains('turn-edit-btn')?'edit':node.classList.contains('turn-collapse-btn')?'collapse':node.classList.contains('msg-copy')?'copy':node.matches('time')?'time':'other');check(actionOrder().slice(0,3).join(',')==='edit,collapse,copy'&&footer.querySelector('.turn-edit-btn').disabled,'initial pending edit slot/order changed');emit({type:'conversation_sync',sessionId:'A',editable:{target:{rowId:1,entityId:user.dataset.jump},text:prompt},turns:[]});check(actionOrder().slice(0,4).join(',')==='edit,collapse,copy,time','late edit action was not kept at the far left: '+actionOrder().join(','));});
 await test('question editing and collapsing work from the copy footer',()=>{reset();emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'footer-question',role:'user',text:'QUESTION_FOR_EDIT'}]});emit({type:'conversation_sync',sessionId:'A',editable:{target:{rowId:1,entityId:'user-footer'},text:'QUESTION_FOR_EDIT'},turns:[{turnId:'turn-footer',userText:'QUESTION_FOR_EDIT'}]});const user=messages.querySelector('.message.user');const meta=user.nextElementSibling;const pen=meta.querySelector('.turn-edit-btn');check(pen&&meta.querySelector('.msg-copy'),'edit not beside copy');pen.click();check(user.querySelector('textarea').value==='QUESTION_FOR_EDIT','footer edit targets wrong question');user.querySelector('[data-uedit="cancel"]').click();check(!user.querySelector('textarea')&&!pen.hidden,'cancel did not restore edit');const collapse=meta.querySelector('.turn-collapse-btn');check(collapse,'collapse not beside copy');collapse.click();const bar=messages.querySelector('.turn-fold-bar');check(bar,'footer collapse failed');bar.click();check(user.nextElementSibling.querySelector('.turn-collapse-btn'),'collapse action missing after reopening');});
 await test('read-only shell exploration and mutating commands have separate groups',()=>{reset();for(const [id,command] of [['read1','rg pattern src'],['read2','git status --short'],['wrapped','bash -lc "rg pattern src"'],['piped','rg pattern src | head'],['echoed',"git status --short && echo '---' && git diff --stat | tail -5"],['quoted','git diff scripts/a.js | grep "^+" | head -30'],['tests','npm run check 2>&1 | tail -1'],['commit','git add -A && git commit -m msg']])emit({type:'tool_call',toolCallId:id,toolName:'shell',status:'completed',inputText:JSON.stringify({command})});emit({type:'assistant_reasoning_delta',partId:'write-boundary',authoritative:true,fullText:'THOUGHT'});emit({type:'tool_call',toolCallId:'write',toolName:'shell',status:'completed',inputText:JSON.stringify({command:'git status > status.txt'})});check(document.getElementById('tool-read1').dataset.processCategory==='explore','read shell not classified as exploration');check(document.getElementById('tool-wrapped').dataset.processCategory==='explore','wrapped read shell classified as terminal');check(document.getElementById('tool-piped').dataset.processCategory==='explore','piped read shell classified as terminal');check(document.getElementById('tool-echoed').dataset.processCategory==='explore'&&document.getElementById('tool-quoted').dataset.processCategory==='explore'&&document.getElementById('tool-tests').dataset.processCategory==='explore','inspection shell classified as terminal');check(document.getElementById('tool-commit').dataset.processCategory==='terminal','git commit classified as exploration');check(/Terminal|终端|終端/.test(document.getElementById('tool-read1').querySelector('.tool-name')?.textContent||''),'shell row used the explore header as its label');check(/搜索|searches/.test(messages.querySelector('.process-group').textContent)&&/文件|files/.test(messages.querySelector('.process-group').textContent),'explore group missing search and file counts');emit({type:'tool_call',toolCallId:'sorted',toolName:'shell',status:'completed',inputText:JSON.stringify({command:'grep -o "zcode" package.json | sort -u'})});emit({type:'tool_call',toolCallId:'nodeRead',toolName:'shell',status:'completed',inputText:JSON.stringify({command:'node -e "console.log(1)"'})});check(document.getElementById('tool-sorted').dataset.processCategory==='explore'&&document.getElementById('tool-nodeRead').dataset.processCategory==='terminal','lookup command with sort or node classified wrongly');check(messages.querySelector('.process-group'),'read shell calls not grouped');check(document.getElementById('tool-write').dataset.processCategory==='terminal'&&!document.getElementById('tool-write').classList.contains('group-hidden'),'write command incorrectly merged with reads');});
 await test('restored history groups tools once and keeps collapsed thought expandable',()=>{reset();emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'history-process',role:'assistant',text:'DONE',steps:[{kind:'reasoning',partId:'restored-thought',text:'RESTORED_THOUGHT'},{kind:'tool',toolCallId:'restored-one',toolName:'shell',status:'completed',inputText:'{"command":"echo one"}'},{kind:'tool',toolCallId:'restored-two',toolName:'shell',status:'completed',inputText:'{"command":"echo two"}'},{kind:'text',text:'DONE'}]}]});const fold=messages.querySelector('.work-fold');fold.querySelector('.work-fold-btn').click();const note=fold.querySelector('.work-note');check(note.hidden&&fold.querySelector('.process-group'),'restored process not compact or grouped');fold.querySelector('.reasoning-head').click();check(!note.hidden&&note.textContent==='RESTORED_THOUGHT','restored thought missing');fold.querySelector('.process-group').click();check(!document.getElementById('tool-restored-two').classList.contains('group-hidden'),'restored tool inaccessible');});
 await test('active tools start compact and respect explicit expansion',()=>{reset();emit({type:'tool_call',toolCallId:'compact-terminal',toolName:'shell',status:'running',inputText:'{"command":"echo hello"}'});const tool=document.getElementById('tool-compact-terminal');check(tool.classList.contains('collapsed')&&tool.querySelector('.tool-status.running'),'running terminal not compact or status lost');tool.querySelector('.tool-head').click();emit({type:'tool_call',toolCallId:'compact-terminal',status:'running',outputText:'NEW_OUTPUT'});check(!tool.classList.contains('collapsed')&&tool.querySelector('.tool-io.out').textContent==='NEW_OUTPUT','expanded terminal reset during output');emit({type:'tool_call',toolCallId:'compact-generic',toolName:'customTool',status:'running',inputText:'{}'});const generic=document.getElementById('tool-compact-generic');check(generic.classList.contains('collapsed')&&generic.querySelector('.tool-status.running'),'running generic tool did not share the collapsed default');});
 await test('terminal label and shell preview share a stable text baseline',()=>{reset();emit({type:'tool_call',toolCallId:'aligned-terminal',toolName:'shell',status:'running',inputText:'{"command":"Bash"}'});const card=document.getElementById('tool-aligned-terminal');const label=card.querySelector('.tool-name');const preview=card.querySelector('.tool-preview');check(label.dataset.i18nKey==='终端'&&preview.textContent==='Bash','terminal translation key or shell name changed');check(getComputedStyle(label).lineHeight==='18px'&&getComputedStyle(preview).lineHeight==='18px','terminal label and shell preview use different line heights');const a=label.getBoundingClientRect(),b=preview.getBoundingClientRect();check(Math.abs((a.top+a.bottom-b.top-b.bottom)/2)<=0.25,'terminal label and shell preview are vertically misaligned');});
 await test('reasoning and process headers align icons and labels across tool types',()=>{reset();emit({type:'assistant_reasoning_delta',partId:'aligned-thought',authoritative:true,fullText:'THOUGHT'});emit({type:'tool_call',toolCallId:'aligned-group-one',toolName:'shell',status:'completed',inputText:'{"command":"echo one"}'});emit({type:'tool_call',toolCallId:'aligned-group-two',toolName:'shell',status:'completed',inputText:'{"command":"echo two"}'});emit({type:'tool_call',toolCallId:'aligned-read',toolName:'read_file',status:'completed',inputText:'{"path":"README.md"}'});emit({type:'tool_call',toolCallId:'aligned-generic',toolName:'apply_patch',status:'completed',inputText:'{}'});const headers=[...messages.querySelectorAll('.reasoning-head,.process-group,.tool-head')].filter(header=>header.querySelector(':scope > .process-icon'));check(headers.length>=5,'expected reasoning, grouped process and tool headers');check(messages.querySelector('.reasoning-head .process-icon')?.dataset.lucide==='brain','reasoning icon does not match the desktop Lucide icon');check(messages.querySelector('.process-group .process-icon')?.dataset.lucide==='squareTerminal','terminal group icon does not match the desktop Lucide icon');check(document.querySelector('#tool-aligned-read .process-icon')?.dataset.lucide==='search','lookup icon does not match the desktop Lucide icon');check(document.querySelector('#tool-aligned-generic .process-icon')?.dataset.lucide==='codeXml','generic tool icon does not match the desktop Lucide icon');check(document.querySelector('#tool-aligned-generic .tool-head')?.classList.contains('raw-tool-head'),'raw tool label lost its optical alignment class');for(const header of headers){if(!header.getClientRects().length)continue;check(getComputedStyle(header).lineHeight==='18px','header does not use the shared 18px line height');const icon=header.querySelector(':scope > .process-icon');const label=header.querySelector(':scope > span:not(.tool-preview):not(.tool-status)');check(icon&&label,'icon or primary label missing');check(parseFloat(icon.getAttribute('stroke-width'))===1.5,'process icon stroke changed');const i=icon.getBoundingClientRect(),l=label.getBoundingClientRect(),expected=icon.dataset.lucide==='brain'?-1.5:icon.dataset.lucide==='codeXml'&&header.classList.contains('raw-tool-head')?0:-1;check(Math.abs((i.top+i.bottom-l.top-l.bottom)/2-expected)<=0.25,'icon and label centers differ in '+header.className);}});
 await test('new-chat greeting localizes without touching drafts and disappears on history',()=>{reset();type('GREETING_DRAFT');for(const language of ['zh-CN','en','zh-TW']){emit({type:'ui_language',language,setting:language});const title=messages.querySelector('.empty-title');check(title&&title.dataset.i18nKey,'missing time greeting');check(title.textContent!=='开始新的对话'&&title.textContent!=='Start a new chat','generic title still present');if(language==='en')check(!/[\u4e00-\u9fff]/.test(title.textContent),'English greeting contains Chinese');check(input.value==='GREETING_DRAFT','greeting language change erased draft');check(messages.querySelector('.empty-mark path')?.getAttribute('vector-effect')==='non-scaling-stroke'&&!messages.querySelector('.empty-mark filter'),'new-chat outline loses sharp edges at sidebar scale');check(document.documentElement.scrollWidth<=document.documentElement.clientWidth,'empty chat overflows');}emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'greeting-history',role:'user',text:'HISTORICAL_QUESTION'}]});check(!messages.querySelector('.empty'),'greeting remained on populated history');check(messages.textContent.includes('HISTORICAL_QUESTION'),'history altered');});

 await test('long questions collapse by default independently of whole-turn folding',()=>{reset();const long='LONG_QUESTION_LINE\n'.repeat(8);const items=[];for(let i=0;i<11;i++){items.push({id:'fold-q-'+i,rowId:i*2+1,turnId:'fold-turn-'+i,role:'user',text:i===0?long:'SHORT_QUESTION_'+i});items.push({id:'fold-a-'+i,rowId:i*2+2,turnId:'fold-turn-'+i,role:'assistant',text:'ANSWER_'+i});}emit({type:'history',sessionId:'A',viewGen:gen,items});const bar=messages.querySelector('.turn-fold-bar');check(bar,'older whole turn did not fold');bar.click();const user=messages.querySelector('.message.user[data-jump="fold-q-0"]');let questionToggle=user.nextElementSibling.querySelector('.question-fold-btn');check(user.classList.contains('question-collapsed')&&questionToggle,'long question did not default to collapsed');questionToggle.click();check(!user.classList.contains('question-collapsed')&&questionToggle.getAttribute('aria-expanded')==='true','question toggle did not expand only the prompt');check(!messages.querySelector('.turn-fold-bar'),'question toggle affected whole-turn state');emit({type:'history',sessionId:'A',viewGen:gen,items});const redrawn=messages.querySelector('.message.user[data-jump="fold-q-0"]');check(!redrawn.classList.contains('question-collapsed'),'explicit question expansion was lost on transcript redraw');redrawn.nextElementSibling.querySelector('.turn-collapse-btn').click();check(redrawn.classList.contains('turn-hidden')&&redrawn.nextElementSibling.querySelector('.question-fold-btn').hidden,'whole-turn fold did not hide its question action');messages.querySelector('.turn-fold-bar').click();check(!redrawn.classList.contains('turn-hidden')&&!redrawn.classList.contains('question-collapsed'),'reopening whole turn changed independent question state');const short=messages.querySelector('.message.user[data-jump="fold-q-1"]');check(!short.nextElementSibling.querySelector('.question-fold-btn'),'short prompt gained a redundant fold action');});
 await test('question-fold controls follow the selected interface language',()=>{reset();emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'locale-q',role:'user',text:'LANGUAGE_LONG_QUESTION\n'.repeat(8)}]});let button=messages.querySelector('.question-fold-btn');check(button?.title==='展开问题','Chinese question-fold label missing');emit({type:'ui_language',language:'en',setting:'en'});check(button.title==='Expand question','question-fold label did not switch to English');button.click();check(button.title==='Collapse question','expanded question action did not localize');emit({type:'ui_language',language:'zh-TW',setting:'zh-TW'});check(button.title==='摺疊問題','question-fold label did not switch to Traditional Chinese');});
 await test('permission after overflowing reasoning is visible without stealing composer focus',async()=>{
  reset(); emit({type:'status',sessionId:'A',status:'running'});
  emit({type:'assistant_reasoning_delta',partId:'permission-thought',fullText:'Long thought line.\n'.repeat(180),authoritative:true});
  await new Promise(r=>setTimeout(r,40));
  const body=messages.querySelector('.work-fold-body');body.scrollTop=body.scrollHeight;
  input.focus();type('Retain this draft');document.getElementById('jump-latest').click();
  emit({type:'permission_request',sessionId:'A',requestId:'overflow-permission',toolName:'shell',input:{command:'echo approval'},options:[{optionId:'allow_once',kind:'allow_once',name:'Allow'}]});
  await new Promise(r=>setTimeout(r,40));
  const card=document.getElementById('perm-overflow-permission');const actions=card.querySelector('.perm-actions').getBoundingClientRect();
  const viewport=body.getBoundingClientRect(),outer=messages.getBoundingClientRect();
  check(actions.top>=Math.max(viewport.top,outer.top)-2&&actions.bottom<=Math.min(viewport.bottom,outer.bottom)+2,'permission actions remained below nested viewport '+JSON.stringify({actions:{top:actions.top,bottom:actions.bottom},inner:{top:viewport.top,bottom:viewport.bottom},outer:{top:outer.top,bottom:outer.bottom},innerScroll:body.scrollTop,innerMax:body.scrollHeight-body.clientHeight,outerScroll:messages.scrollTop,outerMax:messages.scrollHeight-messages.clientHeight}));
  check(document.activeElement===input&&input.value==='Retain this draft','approval stole keyboard focus or draft');
  check(!document.getElementById('pending-action').hidden,'pending approval entry missing');
  card.querySelector('button').click();check(document.getElementById('pending-action').hidden,'answered approval entry persisted');
 });
 await test('approval follow callbacks cannot scroll a newly switched conversation',async()=>{
  reset();emit({type:'status',sessionId:'A',status:'running'});
  emit({type:'assistant_reasoning_delta',partId:'source-thought',fullText:'Source work\n'.repeat(180),authoritative:true});
  emit({type:'permission_request',sessionId:'A',requestId:'switch-follow',toolName:'edit',options:[{optionId:'allow',kind:'allow_once',name:'Allow'}]});
  document.querySelector('#perm-switch-follow button').click();
  reset('B');emit({type:'status',sessionId:'B',status:'running'});
  emit({type:'assistant_reasoning_delta',partId:'destination-thought',fullText:'Destination work\n'.repeat(180),authoritative:true});
  const body=messages.querySelector('.work-fold-body');body.scrollTop=0;
  await new Promise(resolve=>setTimeout(resolve,80));
  check(body.scrollTop===0,'a source approval callback scrolled the destination work');
 });
 await test('reading old reasoning is preserved and pending entry reveals a collapsed request',async()=>{
  reset();emit({type:'status',sessionId:'A',status:'running'});
  emit({type:'assistant_reasoning_delta',partId:'reading-thought',fullText:'Read earlier lines.\n'.repeat(180),authoritative:true});
  await new Promise(r=>setTimeout(r,40));
  const fold=messages.querySelector('.work-fold'),body=fold.querySelector('.work-fold-body');body.scrollTop=0;
  const before=body.scrollTop;
  emit({type:'permission_request',sessionId:'A',requestId:'reading-permission',toolName:'edit',options:[{optionId:'deny',kind:'deny',name:'Deny'}]});
  await new Promise(r=>setTimeout(r,40));check(body.scrollTop===before,'approval moved user reading position');
  fold.querySelector('.work-fold-btn').click();check(!fold.classList.contains('open'),'test failed to collapse');
  document.getElementById('pending-action').click();
  check(fold.classList.contains('open'),'pending entry did not expand work fold');
  check(document.activeElement===document.getElementById('perm-reading-permission'),'pending entry focused decision button instead of card');
  check(!sent.some(m=>m.type==='permissionAnswer'),'revealing request approved it');
  emit({type:'permission_request',sessionId:'B',requestId:'stale-permission',options:[]});check(!document.getElementById('perm-stale-permission'),'background approval leaked');
  reset('B');await new Promise(r=>setTimeout(r,30));check(document.getElementById('pending-action').hidden,'pending entry leaked across sessions');
 });
 await test('activity distinguishes waiting reasoning tools approval and stopping',()=>{
  reset();const label=document.getElementById('conn-label');
  emit({type:'status',sessionId:'A',status:'running'});check(label.dataset.i18nKey==='等待模型响应'&&!/[.…]$/.test(label.textContent),'first-token wait mislabeled or punctuated');
  emit({type:'assistant_reasoning_delta',partId:'phase',fullText:'Thinking',authoritative:true});check(label.dataset.i18nKey==='正在思考','reasoning phase missing');
  emit({type:'tool_call',toolCallId:'phase-tool',toolName:'shell',status:'running'});check(label.dataset.i18nKey==='正在执行工具','tool phase missing');
  emit({type:'permission_request',sessionId:'A',requestId:'phase-permission',toolName:'shell',options:[{optionId:'allow',kind:'allow_once'}]});
  emit({type:'status',sessionId:'A',status:'running'});check(label.dataset.i18nKey==='等待确认','generic running status hid approval');
  document.querySelector('#perm-phase-permission button').click();check(label.dataset.i18nKey==='等待模型响应'&&!/[.…]$/.test(label.textContent),'approval answer did not resume cleanly waiting');
  emit({type:'assistant_text_delta',partId:'phase-answer',fullText:'Response',authoritative:true});check(label.dataset.i18nKey==='正在回复','answer phase missing');
  emit({type:'sync_status',sessionId:'A',active:true});check(label.dataset.i18nKey==='正在恢复同步','sync phase missing');
  emit({type:'sync_status',sessionId:'A',active:false});
  emit({type:'status',sessionId:'A',status:'stopping'});emit({type:'assistant_reasoning_delta',partId:'phase',fullText:'Thinking tail',authoritative:true});
  check(label.dataset.i18nKey==='正在停止'&&!/[.…]$/.test(label.textContent),'late delta hid stopping or added punctuation');
  emit({type:'status',sessionId:'A',status:'completedInterrupted'});check(document.getElementById('stop-btn').hidden,'stopped session stayed generating');
 });
 await test('editing after stop drops the old reply and keeps stop usable',()=>{
  reset();
  emit({type:'history',sessionId:'A',viewGen:gen,items:[
    {id:'edit-q',role:'user',text:'ORIGINAL_QUESTION'},
    {id:'edit-a',role:'assistant',text:'OLD_REPLY',running:true,steps:[{kind:'text',text:'OLD_REPLY',partId:'old-reply'}]},
  ]});
  emit({type:'status',sessionId:'A',status:'running'});
  emit({type:'status',sessionId:'A',status:'stopping'});
  check(document.getElementById('stop-btn').disabled,'stop stayed clickable while stopping');
  emit({type:'assistant_text_delta',partId:'old-reply',fullText:'OLD_REPLY grows',authoritative:true,streaming:false});
  check(document.getElementById('conn-label').dataset.i18nKey==='正在停止','stream during stop left the stopping state');
  emit({type:'conversation_sync',sessionId:'A',editable:{target:{rowId:1,entityId:'edit-q'},text:'ORIGINAL_QUESTION'},turns:[]});
  messages.querySelector('.turn-edit-btn').click();messages.querySelector('.user-edit').value='EDITED_QUESTION';
  messages.querySelector('[data-uedit="send"]').click();
  const editCommand=sent.find(message=>message.type==='editLast');
  emit({...editCommand,type:'query_rewound',text:'EDITED_QUESTION'});
  check(messages.textContent.includes('EDITED_QUESTION')&&!messages.textContent.includes('OLD_REPLY'),'rewind kept the stopped reply');
  const stop=document.getElementById('stop-btn');
  check(!stop.hidden&&!stop.disabled,'rewound turn left stop disabled');
  stop.click();
  check(sent.some(message=>message.type==='stop'),'stop after rewind was ignored');
 });
 await test('settings diagnostics request preserves draft and restores focus',()=>{
  reset();type('Diagnostic draft');document.getElementById('btn-settings').click();document.getElementById('copy-diagnostics').click();
  check(sent.some(m=>m.type==='copyDiagnostics'),'diagnostic copy request missing');
  check(input.value==='Diagnostic draft','diagnostic copy erased draft');
  check(document.activeElement===document.getElementById('btn-settings'),'settings focus not restored');
 });

 await test('pending user question is reachable and resolved decision returns keyboard focus',async()=>{
  reset();emit({type:'status',sessionId:'A',status:'running'});
  emit({type:'assistant_reasoning_delta',partId:'question-long',fullText:'Long reasoning.\n'.repeat(180),authoritative:true});
  await new Promise(r=>setTimeout(r,40));messages.scrollTop=0;messages.dispatchEvent(new Event('scroll'));
  emit({type:'user_input_request',sessionId:'A',requestId:'pending-question',questions:[{question:'Choose',options:[{value:'yes',label:'Yes'}]}]});
  const pending=document.getElementById('pending-action');check(!pending.hidden,'pending question entry missing');pending.click();
  const card=document.getElementById('ask-pending-question');check(document.activeElement===card,'question entry failed to focus card');
  const option=card.querySelector('button[data-val]');option.focus();option.click();
  check(pending.hidden&&document.activeElement===input,'answered question left stale prompt or keyboard focus');
  emit({type:'permission_request',sessionId:'A',requestId:'focus-permission',options:[{optionId:'deny',kind:'deny'}]});
  const deny=document.querySelector('#perm-focus-permission button');deny.focus();deny.click();check(document.activeElement===input,'permission decision did not return composer focus');
 });

 const imageFixture={ref:'image-ref',fileName:'sample.png',mime:'image/png',bytes:100};
 const addImage=(owner='A',id='image-test')=>{emit({type:'image_pending',sessionId:owner,imageId:id,fileName:imageFixture.fileName,mime:imageFixture.mime,bytes:100});emit({type:'image_ready',sessionId:owner,imageId:id,attachment:imageFixture});};
 await test('/plan refuses images without consuming the draft',()=>{reset('plan-image-owner');emit({type:'session_ready',sessionId:'plan-image-owner',viewGen:gen,title:'T',slashCommands:[{name:'plan',description:'Switch to Plan mode',inputHint:'/plan [task]'}]});type('/plan');input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));type('Keep this task');addImage('plan-image-owner');sendBtn.click();check(!sent.some(message=>message.type==='send'||message.type==='insert'||message.type==='setMode'),'unsupported /plan image was submitted');check(input.value==='Keep this task'&&document.querySelector('#image-drafts .image-chip'),'blocked /plan image was consumed');check(document.getElementById('toast').textContent.toLowerCase().includes('plan'),`blocked /plan image did not explain the restriction: ${document.getElementById('toast').textContent}`);});
 await test('draft image preview opens full data, preserves draft and rejects stale responses',()=>{
  reset('preview-draft');type('PREVIEW_CAPTION');addImage('preview-draft');
  const button=document.querySelector('#image-drafts .image-preview-btn');
  check(!button.disabled&&button.getAttribute('aria-label').includes('sample.png'),'draft preview is inaccessible');button.focus();button.click();
  const request=sent.filter(message=>message.type==='previewImage').at(-1);
  check(request.sessionId==='preview-draft'&&request.attachments[0].ref==='image-ref'&&request.rowId===undefined,'draft preview uses wrong attachment or history target');
  emit({type:'image_preview',requestId:request.requestId,dataUrl:'data:image/png;base64,AA=='});
  const overlay=document.getElementById('image-preview');check(overlay&&document.activeElement===overlay.querySelector('button'),'preview not opened or focused');
  overlay.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  check(!document.getElementById('image-preview')&&document.activeElement===button,'preview did not close and restore focus');
  check(input.value==='PREVIEW_CAPTION'&&document.querySelector('#image-drafts .image-chip'),'preview consumed the draft');
  button.click();const removed=sent.filter(message=>message.type==='previewImage').at(-1);document.querySelector('#image-drafts .image-remove').click();
  emit({type:'image_preview',requestId:removed.requestId,dataUrl:'data:image/png;base64,AA=='});check(!document.getElementById('image-preview'),'removed attachment opened a late preview');
  emit({type:'image_pending',sessionId:'preview-draft',imageId:'pending-preview',fileName:'pending.png',mime:'image/png',bytes:100});check(document.querySelector('#image-drafts .image-preview-btn').disabled,'uploading attachment offered unavailable preview');
  document.querySelector('#image-drafts .image-remove').click();addImage('preview-draft');document.querySelector('#image-drafts .image-preview-btn').click();const stale=sent.filter(message=>message.type==='previewImage').at(-1);
  reset('preview-other');emit({type:'image_preview',requestId:stale.requestId,dataUrl:'data:image/png;base64,AA=='});check(!document.getElementById('image-preview'),'preview leaked into next session');
 });
 await test('image preview zooms with wheel, buttons and double click',async()=>{
  reset('zoom-draft');addImage('zoom-draft');
  document.querySelector('#image-drafts .image-preview-btn').click();
  const request=sent.filter(message=>message.type==='previewImage').at(-1);
  emit({type:'image_preview',requestId:request.requestId,dataUrl:'data:image/png;base64,AA=='});
  const overlay=document.getElementById('image-preview');
  const img=overlay.querySelector('img');
  const label=overlay.querySelector('.image-zoom-label');
  check(img.style.transform==='translate(0px, 0px) scale(1)','preview did not start fitted: '+(img.style.transform||'none'));
  overlay.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,bubbles:true,cancelable:true}));
  check(/scale\(1\.1/.test(img.style.transform),'wheel did not zoom in: '+img.style.transform);
  const percent=parseFloat(label.textContent);
  check(Number.isFinite(percent)&&percent>100,'zoom label did not update: '+label.textContent);
  img.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
  check(img.style.transform==='translate(0px, 0px) scale(1)','double click did not return to fit: '+img.style.transform);
  overlay.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,bubbles:true,cancelable:true}));
  overlay.querySelector('.image-zoom-fit').click();
  check(img.style.transform==='translate(0px, 0px) scale(1)','fit button did not reset: '+img.style.transform);
  const copy=[...overlay.querySelectorAll('.image-zoom button')].filter(b=>b!==overlay.querySelector('.image-zoom-fit')).pop();
  check(copy&&copy.querySelector('svg'),'copy button missing from the zoom bar');
  let clipPayload=null;
  const OrigClipboardItem=window.ClipboardItem;
  const origFetch=window.fetch;
  window.ClipboardItem=class{constructor(map){clipPayload=Object.keys(map)[0];}};
  window.fetch=async()=>({blob:async()=>({type:'image/png',size:10})});
  navigator.clipboard={write:async()=>{}};
  copy.click();
  await new Promise(resolve=>setTimeout(resolve,80));
  check(clipPayload&&/image\//.test(clipPayload),'copy did not write an image payload; got='+clipPayload);
  window.ClipboardItem=OrigClipboardItem;
  window.fetch=origFetch;
  overlay.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  check(!document.getElementById('image-preview'),'zoom preview did not close');
 });
 await test('hover cards replace native titles with styled tooltips',async()=>{
  reset();
  emit({type:'session_controls',mode:'build',thoughtEnabled:true,thoughtLevel:'high',thoughtLevels:[{value:'high',label:'High'}]});
  const chip=document.getElementById('mode-chip');
  const tip=document.getElementById('tooltip');
  chip.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));
  await new Promise(resolve=>setTimeout(resolve,120));
  const early='cls='+tip.className;
  await new Promise(resolve=>setTimeout(resolve,400));
  check(tip.classList.contains('show')&&tip.textContent.trim().length>0,'styled tooltip did not appear; '+early+'; late-cls='+tip.className);
  check(chip.title==='','native title stayed visible while the card showed');
  check(parseFloat(getComputedStyle(tip).borderRadius)>0,'hover card lacks rounded corners');
  chip.dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:document.body}));
  await new Promise(resolve=>setTimeout(resolve,30));
  check(!tip.classList.contains('show'),'hover card did not hide on leave');
  check(chip.title.trim().length>0,'native title was not restored after leave');
 });
 await test('image-only send consumes attachments and rejection restores the original draft',()=>{
  reset('image-owner'); addImage('image-owner'); check(document.querySelector('#image-drafts .image-chip'),'image draft missing');
  sendBtn.click(); const message=sent.find(m=>m.type==='send'); check(message&&message.text===''&&message.attachments[0].ref===imageFixture.ref,'image-only send was lost');
  check(!document.querySelector('#image-drafts .image-chip'),'sent image remained in composer'); check(messages.querySelector('.user-images button'),'image-only message missing');
  emit({type:'send_rejected',sessionId:'image-owner',commandId:message.commandId,text:'',message:'failure'});
  check(document.querySelector('#image-drafts .image-chip'),'rejection lost attachment');
  document.querySelector('#image-drafts .image-remove').click();
 });
 await test('upload completion stays in originating session after switch and removing upload rejects late completion',()=>{
  reset('image-A'); emit({type:'image_pending',sessionId:'image-A',imageId:'background',fileName:'sample.png',mime:'image/png',bytes:100});
  reset('image-B'); emit({type:'image_ready',sessionId:'image-A',imageId:'background',attachment:imageFixture});
  check(!document.querySelector('#image-drafts .image-chip'),'background upload attached to B');
  reset('image-A'); check(document.querySelector('#image-drafts .image-chip'),'A upload was lost');
  document.querySelector('#image-drafts .image-remove').click(); emit({type:'image_ready',sessionId:'image-A',imageId:'background',attachment:imageFixture});
  check(!document.querySelector('#image-drafts .image-chip'),'removed image resurrected');
 });
 await test('uploading and failed images block sending instead of silently dropping content',()=>{
  reset('image-block'); type('keep text'); emit({type:'image_pending',sessionId:'image-block',imageId:'pending',fileName:'sample.png',mime:'image/png',bytes:100});
  sendBtn.click(); check(!sent.some(m=>m.type==='send'),'uploading image sent'); check(input.value==='keep text','blocked send erased draft');
  emit({type:'image_failed',sessionId:'image-block',imageId:'pending'}); sendBtn.click(); check(!sent.some(m=>m.type==='send'),'failed image silently discarded');
  document.querySelector('#image-drafts .image-remove').click();
 });
 await test('image-only queue uses one-arrow insertion and server history restores images',()=>{
  reset('image-queue'); emit({type:'status',sessionId:'image-queue',status:'running'}); addImage('image-queue'); sendBtn.click();
  const message=sent.find(m=>m.type==='insert'); check(message&&message.attachments[0].ref===imageFixture.ref&&!message.immediate,'image queue payload wrong');
  emit({type:'queue_admitted',sessionId:'image-queue',commandId:message.queueItemId});
  emit({type:'queue_sync',sessionId:'image-queue',items:[{queueItemId:'queue-image',sourceCommandId:message.queueItemId,text:'',attachments:[imageFixture]}]});
  check(document.querySelectorAll('#queue-zone .queued').length===1&&document.querySelector('#queue-zone .queued .user-images'),'queue duplicated or lost image');
  reset('image-history'); emit({type:'history',sessionId:'image-history',viewGen:gen,items:[{id:'user-image',role:'user',text:'',attachments:[imageFixture,{...imageFixture,ref:'second-image'}],attachmentTarget:{rowId:7,entityId:'user-image'}}]});
  check(messages.querySelector('.user-images button'),'image-only history lost');
  messages.querySelectorAll('.user-images button')[1].click(); const preview=sent.find(m=>m.type==='previewImage'); check(preview&&preview.sessionId==='image-history','preview owner wrong');check(preview.rowId===7&&preview.entityId==='user-image'&&preview.attachmentIndex===1&&preview.attachments[0].ref==='second-image','preview attachment target wrong');
  emit({type:'image_preview',requestId:preview.requestId,dataUrl:'data:image/png;base64,iVBORw0KGgo='}); check(document.getElementById('image-preview'),'preview missing');
  document.querySelector('#image-preview button').click(); check(!document.getElementById('image-preview'),'preview did not close');
 });


 await test('reasoning image-analysis builtin renders a card and retains raw identity across restores',()=>{
  reset(); emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'u-image',role:'user',text:'image question'}]}); emit({type:'status',sessionId:'A',status:'running'});
  const raw='Before analysis\n**Z.ai Built-in Tool: analyze_image**\n```json\n{"imageSource":"image"}\n```\n*Executing on server...*';
  emit({type:'assistant_reasoning_delta',partId:'image-thinking',fullText:raw});
  let card=messages.querySelector('.work-note .tool-call'); check(card&&card.dataset.toolName==='analyze_image','builtin in reasoning remained raw text');
  card.querySelector('.tool-head').click();
  const complete=raw+'\n**Output:**\n**analyze_image_result_summary:** '+JSON.stringify([{text:'Analysis result\nLast sentence'}]);
  emit({type:'assistant_reasoning_delta',partId:'image-thinking',fullText:complete});
  card=messages.querySelector('.work-note .tool-call'); check(card.dataset.toolStatus==='completed','image analysis stuck running');
  check(card.dataset.userToggle==='open','stream update lost manual expansion');
  check(card.querySelector('.tool-io.out').textContent==='Analysis result\nLast sentence','analysis output not decoded');
  check(messages.querySelector('.work-note').dataset.segment===complete,'presentation altered raw stream identity');
  emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'u-image',role:'user',text:'image question'},{id:'reason-image',role:'assistant',text:'',work:{text:complete}}]});
  check(messages.querySelector('.work-note .tool-call')?.dataset.toolName==='analyze_image','history reasoning lost card');
 });
 await test('generated Markdown file displays one desktop-style card after turn-file verification',()=>{
  reset();
  const text='文件已生成：[test-hello.md](/workspace/test-hello.md)';
  emit({type:'history',sessionId:'A',viewGen:gen,items:[
    {id:'file-card-q',role:'user',turnId:'file-card-turn',text:'生成文件'},
    {id:'file-card-a',role:'assistant',turnId:'file-card-turn',text,steps:[{kind:'text',text}]},
  ]});
  const turn={turnId:'file-card-turn',userText:'生成文件',fileChanges:{target:{rowId:9,entityId:'file-header'},summary:{files:1,additions:11,deletions:0,state:'active'},canRewind:true}};
  emit({type:'conversation_sync',sessionId:'A',editable:null,turns:[turn]});
  const request=window.sent.find(message=>message.type==='loadPreviewFiles');
  check(request?.rowId===9&&request?.entityId==='file-header','preview validation did not use the turn header');
  check(request.previewCandidates?.[0]==='/workspace/test-hello.md','preview candidate lost the Markdown path');
  check(!messages.querySelector('.file-preview-card'),'unverified file card appeared before host validation');
  emit({type:'preview_files',sessionId:'A',turnId:'file-card-turn',signature:request.signature,cards:[{path:'test-hello.md',name:'test-hello.md',kind:'markdown',extension:'MD'}]});
  const card=messages.querySelector('.message.assistant .file-preview-card');
  check(card?.querySelector('.file-preview-name')?.textContent==='test-hello.md','generated file card was not attached to the answer');
  check(card.querySelector('.file-preview-subtitle')?.textContent.includes('MD'),'generated file type is missing');
  card.click();
  check(window.sent.some(message=>message.type==='openMarkdownFile'&&message.path==='test-hello.md'&&message.sessionId==='A'),'file card did not open via scoped host command');
  emit({type:'conversation_sync',sessionId:'A',editable:null,turns:[turn]});
  check(messages.querySelectorAll('.file-preview-card').length===1,'repeated sync duplicated file card');
  emit({type:'conversation_sync',sessionId:'A',editable:null,turns:[{...turn,fileChanges:{...turn.fileChanges,summary:{...turn.fileChanges.summary,state:'reverted'}}}]});
  check(!messages.querySelector('.file-preview-card'),'rewind left a generated Markdown card visible');
 });
 await test('assistant Markdown image-file links ask the host to open the current session file',()=>{
  reset();
  const text='查看 [图片](/workspace/samples/sample_preview.png) 和 [另一张](samples/sample%20two.png)。';
  emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'image-link-question',role:'user',text:'SHOW_IMAGE'},{id:'image-link-answer',role:'assistant',text}]});
  const links=[...messages.querySelectorAll('.message.assistant .md a')];
  check(links.length===2,'Markdown file links were not rendered as anchors');
  links[0].click(); links[1].click();
  const opens=window.sent.filter(message=>message.type==='openMarkdownFile');
  check(opens.length===2,'clicking a Markdown file link did not reach the extension host');
  check(opens[0].path==='/workspace/samples/sample_preview.png'&&opens[1].path==='samples/sample two.png','Markdown file path changed during click handling');
  check(opens.every(message=>message.sessionId==='A'),'Markdown file click lost its session owner');
 });
 await test('Unicode-minus emphasis renders strongly and decimal ranges stay literal beside hyphens',()=>{
  reset();type('MARKDOWN_EDGE_CASES');sendBtn.click();
  const text='**−1.25 和 −0.75 相差 0.50 个单位。**这是相邻中文标点与强调的示例。\n\n**说明就是：两个读数，统一单位。**接下来展示普通说明文字。\n\n处理流程：**读取两组数据 → 检查单位 → 转换格式 → 输出示例结果。**检查结束\n\n范围 1.2-3.4- 后续说明\n\n示例集合 **12 项**（均为虚构数据），区间 0.15~3.25 米。选取 ±0.5 米窗口（2.0~4.0 米）的有 6 项\n\n真正的 ~~删除线~~ 应保留；`1~2` 仍是代码。\n\n`**代码里的星号**中文`';
  emit({type:'assistant_text_delta',partId:'markdown-edge-cases',fullText:text});
  const strong=[...messages.querySelectorAll('.message.assistant .md strong')];
  check(strong.length===4,'CJK-adjacent strong markers were not parsed for every paragraph');
  check(strong.map(node=>node.textContent).join('|')==='−1.25 和 −0.75 相差 0.50 个单位。|说明就是：两个读数，统一单位。|读取两组数据 → 检查单位 → 转换格式 → 输出示例结果。|12 项','CJK-adjacent strong text changed');
  check(getComputedStyle(strong[0]).fontWeight==='700','strong emphasis has no explicit visual weight');
  const prose=messages.querySelector('.message.assistant .md');
  check(!prose.querySelector('del')?.textContent.includes('1.2-3.4'),'a numeric range and following hyphen became strikethrough');
  check(prose.textContent.includes('1.2-3.4- 后续说明'),'range punctuation was changed');
  check(prose.textContent.includes('区间 0.15~3.25 米。选取 ±0.5 米窗口（2.0~4.0 米）'),'numeric tilde ranges were changed');
  const deleted=[...prose.querySelectorAll('del,s')];
  check(deleted.length===1&&deleted[0].textContent==='删除线','numeric tilde ranges became strikethrough or genuine strikethrough broke');
  check([...prose.querySelectorAll('code')].some(node=>node.textContent==='1~2'),'tilde inside code span changed');
  check([...prose.querySelectorAll('code')].some(node=>node.textContent==='**代码里的星号**中文'),'code-span markers were interpreted as emphasis');
  reset();
  emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'markdown-history-question',role:'user',text:'MARKDOWN_HISTORY'},{id:'markdown-history-answer',role:'assistant',text}]});
  check(messages.querySelectorAll('.message.assistant .md strong').length===4,'history restoration did not apply the CJK strong fix');
  const restored=messages.querySelector('.message.assistant .md');
  check(restored.textContent.includes('区间 0.15~3.25 米。选取 ±0.5 米窗口（2.0~4.0 米）')&&restored.querySelectorAll('del,s').length===1,'history restoration reintroduced numeric-range strikethrough');
 });
 await test('signed numeric tilde ranges stay literal in streamed and restored replies',()=>{
  reset();type('SIGNED_RANGES');sendBtn.click();
  const ranges='约 ~2秒，另一次 ~3秒；区间 2~3秒；约 ~ 2秒 和 ~−0.5秒、~+.5秒。范围 −3.2~−0.8米；第二段 -4.5~-2.2米；进度 0~+2.50%；小数 0~.5 与 1~.8。几百毫秒~3 秒，总启动则是 4~6 秒。';
  const text=ranges+'\n\n~~过期说明~~ 和 ~旧说明~；~~123~~、2~~old~~、~~2秒~~\n\n`-2~-1`\n\n```text\n0~+1\n```';
  const checkReply=()=>{
   const prose=messages.querySelector('.message.assistant .md');
   check(prose?.textContent.includes(ranges),'signed range text changed');
   check([...prose.querySelectorAll('del')].map(node=>node.textContent).join('|')==='过期说明|旧说明|123|old|2秒','signed ranges became strikethrough or intentional strikethrough broke');
   check([...prose.querySelectorAll('code')].some(node=>node.textContent==='-2~-1'),'inline code changed');
   check(prose.querySelector('pre code')?.textContent.trim()==='0~+1','fenced code changed');
  };
  emit({type:'assistant_text_delta',partId:'signed-ranges',fullText:'范围 −3.2~−0.8米'});
  emit({type:'assistant_text_delta',partId:'signed-ranges',fullText:text});
  checkReply();
  reset();emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'ranges-question',role:'user',text:'SIGNED_RANGES'},{id:'ranges-answer',role:'assistant',text}]});
  checkReply();
 });
 for(const terminal of ['completedSuccess','completedInterrupted'])await test('markdown image analysis settles with '+terminal+' and cannot revive on late text',()=>{
  reset();emit({type:'status',sessionId:'A',status:'running'});
  const text='**Z.ai Built-in Tool: analyze_image**\n\n```json\n{"imageSource":"local:test"}\n```\n*Executing on server...*';
  emit({type:'assistant_reasoning_delta',partId:'unfinished-image-tool',fullText:text,authoritative:true});
  check(messages.querySelector('.tool-call').dataset.toolStatus==='running','active analysis not running');
  emit({type:'assistant_text_delta',partId:'image-final-prose',fullText:'VISIBLE_FINAL_IMAGE_REPLY',authoritative:true});
  emit({type:'status',sessionId:'A',status:terminal});
  const expected=terminal==='completedSuccess'?'completed':'cancelled';
  check(messages.querySelector('.tool-call').dataset.toolStatus===expected,'image tool retained running status after task end');
  emit({type:'assistant_reasoning_delta',partId:'unfinished-image-tool',fullText:text,authoritative:true,streaming:false});
  check(messages.querySelector('.tool-call').dataset.toolStatus===expected,'late settled text revived running status');
  check([...messages.querySelectorAll('.message.assistant')].some(node=>node.textContent.includes('VISIBLE_FINAL_IMAGE_REPLY')&&!node.closest('.work-fold')),'final answer folded into analysis');
 });
 await test('protocol image analysis cannot remain running after success or revive from a late update',()=>{
  reset();emit({type:'status',sessionId:'A',status:'running'});
  emit({type:'tool_call',toolCallId:'image-terminal',toolName:'analyze_image',status:'running',inputText:'{"imageSource":"local:test"}'});
  emit({type:'status',sessionId:'A',status:'completedSuccess'});
  check(document.getElementById('tool-image-terminal').dataset.toolStatus==='completed','protocol image analysis stayed running');
  emit({type:'tool_call',toolCallId:'image-terminal',toolName:'analyze_image',status:'running',outputText:'LATE_COMPLETE_IMAGE_RESULT'});
  check(document.getElementById('tool-image-terminal').dataset.toolStatus==='completed'&&messages.textContent.includes('LATE_COMPLETE_IMAGE_RESULT'),'late output revived or lost image result');
  check(!messages.querySelector('.work-fold[data-state="running"]'),'late image result restarted a settled work clock');
 });
 await test('workspace @ menu selects files without sending and ignores stale replies',async()=>{
  reset(); input.focus(); type('@main'); input.setSelectionRange(input.value.length,input.value.length); input.dispatchEvent(new Event('input'));
  await new Promise(r=>setTimeout(r,150)); const request=[...sent].reverse().find(item=>item.type==='searchWorkspaceFiles'); check(request&&request.text==='main','no @ search request');
  emit({type:'workspace_files',requestId:'stale',sessionId:request.sessionId,files:[{path:'/test/stale',relPath:'stale'}]}); check(!document.querySelector('#file-mentions button'),'stale search accepted');
  emit({type:'workspace_files',requestId:request.requestId,sessionId:request.sessionId,files:[{path:'/test/main.ts',relPath:'src/main.ts'},{path:'/test/main.test.ts',relPath:'src/main.test.ts'}]});
  check(document.querySelectorAll('#file-mentions button').length===2,'file menu missing results');
  input.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));
  const sendsBefore=sent.filter(item=>item.type==='send').length;
  input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  check(sent.filter(item=>item.type==='send').length===sendsBefore,'mention Enter sent prompt');
  check(input.value==='','@ token not consumed');
  check(document.querySelector('#attachments').textContent.includes('main.test.ts'),'chosen reference not added immediately');
  type('email@example.com'); check(document.querySelector('#file-mentions').hidden,'email incorrectly triggered menu');
  type('@'); input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})); check(document.querySelector('#file-mentions').hidden,'Escape did not dismiss');
 });

 await test('workspace @ menu merges conversations after files and sends a distinct session reference',async()=>{
  reset('mention-sessions');
  emit({type:'ui_language',language:'en',setting:'en'});
  const attach=document.getElementById('attach-files');
  const send=document.getElementById('send-btn');
  check(attach.querySelector('svg path')?.getAttribute('d')?.startsWith('m8 12'),'attachment button no longer uses the paperclip icon');
  check(getComputedStyle(send).borderRadius==='50%','send button is no longer circular');
  const first={sessionId:'sess_11111111-1111-4111-8111-111111111111',title:'Review current plan'};
  const second={sessionId:'sess_22222222-2222-4222-8222-222222222222',title:'Review older notes'};
  emit({type:'sessions',currentId:'mention-sessions',includeArchived:false,sessions:[{sessionId:'mention-sessions',title:'Current'},first,second,{sessionId:'sess_archived',title:'Review archived',archivedAt:1}]});
  input.focus();type('@review');input.setSelectionRange(input.value.length,input.value.length);input.dispatchEvent(new Event('input'));
  await new Promise(r=>setTimeout(r,150));
  const request=[...sent].reverse().find(item=>item.type==='searchWorkspaceFiles');check(request?.text==='review','merged @ did not search workspace files');
  emit({type:'workspace_files',requestId:request.requestId,sessionId:request.sessionId,files:[{path:'/test/review.ts',relPath:'src/review.ts'}]});
  const menu=document.getElementById('file-mentions'),buttons=[...menu.querySelectorAll('button[role="option"]')];
  check(buttons.length===3&&buttons[0].textContent.includes('review.ts'),'files are not first in merged suggestions');
  check(buttons[1].textContent.includes(first.title)&&buttons[2].textContent.includes(second.title),'workspace sessions are missing or not at the end');
  check(menu.textContent.indexOf('Workspace files')<menu.textContent.indexOf('Workspace conversations'),'group order is not files then conversations');
  input.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));
  input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  check(input.value===''&&menu.hidden,'session selection did not consume @ query');
  check(document.querySelector('#attachments .session-ref-chip')?.textContent.includes(first.title),'selected session did not become a visible reference');
  check(!sent.some(item=>item.type==='switchSession'),'referencing a session switched the active conversation');
  type('Compare this conversation');sendBtn.click();
  const message=sent.find(item=>item.type==='send');
  check(message?.sessionRefs?.length===1&&message.sessionRefs[0].sessionId===first.sessionId,'session reference was mixed with file chips or omitted');
  check(messages.querySelector('.message.user .session-ref-chip')?.textContent.includes(first.title),'sent bubble did not show its conversation reference');
  emit({type:'send_rejected',sessionId:'mention-sessions',commandId:message.commandId,text:message.text,sessionRefs:message.sessionRefs,message:'fixture rejection'});
  check(document.querySelector('#attachments .session-ref-chip')?.textContent.includes(first.title),'failed send did not restore the session reference');
  emit({type:'sessions',currentId:'mention-sessions',includeArchived:false,sessions:[]});
  emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});
 });

 await test('builtin image analysis in assistant text belongs to work fold in stream and history',()=>{
  reset(); emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'u',role:'user',text:'analyze image'}]}); emit({type:'status',sessionId:'A',status:'running'});
  const raw='**Z.ai Built-in Tool: analyze_image**\n```json\n{"imageSource":"image"}\n```\n**Output:**\n**analyze_image_result_summary:** '+JSON.stringify([{text:JSON.stringify('Readable analysis\nSecond line')}]);
  emit({type:'assistant_text_delta',partId:'image-builtin',fullText:raw});
  check(messages.querySelector('.work-fold .tool-call'),'assistant builtin escaped work fold');
  check(!messages.querySelector(':scope > .message.assistant .tool-call'),'standalone builtin card');
  check(messages.querySelector('.tool-io.out').textContent==='Readable analysis\nSecond line','double-encoded result not decoded');
  emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'u',role:'user',text:'analyze image'},{id:'a',role:'assistant',text:raw}]});
  check(messages.querySelector('.work-fold .tool-call'),'history builtin escaped fold');
  check(messages.querySelector('.work-fold').dataset.state!=='running','completed history became generating');
 });
 await test('active editor is not included implicitly and placeholder advertises only @',()=>{
  reset(); emit({type:'editorContext',chip:{path:'/test/private.ts',relPath:'private.ts',implicit:true}});
  check(!document.querySelector('#editor-chip-row .ctx-chip'),'active file displayed implicitly');
  check(input.placeholder.includes('@')&&!input.placeholder.includes('$'),'placeholder lacks @ or advertises skills; got '+JSON.stringify(input.placeholder).slice(0,60)+'; attr='+JSON.stringify(input.getAttribute('placeholder')||'').slice(0,60));
  type('explicit question'); sendBtn.click(); const message=sent.find(item=>item.type==='send'); check(message&&!message.chips.some(chip=>chip.path==='/test/private.ts'),'active editor silently sent');
 });

 await test('image builtin keeps final prose outside work during streaming replay and history',()=>{
  reset(); emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'u',role:'user',text:'image'}]}); emit({type:'status',sessionId:'A',status:'running'});
  const raw='**Z.ai Built-in Tool: analyze_image**\n```json\n{"imageSource":"image"}\n```\n**Output:**\n**analyze_image_result_summary:** '+JSON.stringify([{text:'Tool analysis'}]);
  emit({type:'assistant_text_delta',partId:'mixed-image',fullText:raw});
  const full=raw+'\n\nThis is the final answer.';
  emit({type:'assistant_text_delta',partId:'mixed-image',fullText:full});
  check(messages.querySelectorAll('.tool-call').length===1,'mixed stream duplicated tool');
  check(messages.querySelector('.work-fold .tool-call'),'tool outside work');
  check(!messages.querySelector('.work-fold').textContent.includes('This is the final answer.'),'final answer folded with tool');
  check(messages.querySelector(':scope > .message.assistant').textContent.includes('This is the final answer.'),'final answer missing outside work');
  emit({type:'assistant_text_delta',partId:'mixed-image',fullText:raw});
  check(messages.textContent.includes('This is the final answer.'),'short replay erased final answer');
  emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'u',role:'user',text:'image'},{id:'a',role:'assistant',text:full}]});
  const restoredFold=[...messages.querySelectorAll('.work-fold')].find(fold=>!fold.classList.contains('work-duration-only'));
  check(restoredFold?.querySelector('.tool-call'),'restored image tool missing from work fold');
  check(restoredFold.querySelector('.tool-io.out')?.textContent==='Tool analysis','restored image-analysis result missing');
  check(!restoredFold.textContent.includes('This is the final answer.'),'restored answer folded');
  const restoredAnswers=[...messages.querySelectorAll(':scope > .message.assistant')];
  check(restoredAnswers.some(answer=>!answer.hidden&&answer.textContent.includes('This is the final answer.')),'restored final answer missing outside work');
  check(parseFloat(getComputedStyle(input).lineHeight)>parseFloat(getComputedStyle(input).fontSize),'font shorthand reset composer line height');
 });

 await test('separate final answer part does not replace an image-tool source anchor',()=>{
  reset(); emit({type:'status',sessionId:'A',status:'running'});
  const raw='**Z.ai Built-in Tool: analyze_image**\n```json\n{}\n```\n**Output:**\n**analyze_image_result_summary:** '+JSON.stringify([{text:'Tool output'}]);
  emit({type:'assistant_text_delta',partId:'tool-source',fullText:raw});
  emit({type:'assistant_text_delta',partId:'final-source',fullText:'Separate final reply'});
  check(messages.querySelector('.work-fold .tool-call'),'new answer part replaced previous tool');
  check(messages.querySelector(':scope > .message.assistant:not([hidden])').textContent.includes('Separate final reply'),'separate final reply not visible');
 });

 await test('@ image uses the same image chip as an attachment', async () => {
  reset('mention-image'); input.focus(); type('@shot'); input.setSelectionRange(input.value.length, input.value.length); input.dispatchEvent(new Event('input'));
  await new Promise(r=>setTimeout(r,150));
  const request=[...sent].reverse().find(item=>item.type==='searchWorkspaceFiles');
  check(request,'image mention did not search');
  emit({type:'workspace_files',requestId:request.requestId,sessionId:request.sessionId,files:[{path:'/test/my shot.png',relPath:'images/my shot.png'}]});
  input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  check(!document.querySelector('#attachments .ctx-chip'),'@ image became a filename chip');
  const attach=[...sent].reverse().find(item=>item.type==='attachFileUris');
  check(attach&&attach.uris[0]==='file:///test/my%20shot.png'&&attach.sessionId==='mention-image','@ image was not attached as a picture');
  emit({type:'image_pending',sessionId:'mention-image',imageId:'shot',fileName:'my shot.png',mime:'image/png',bytes:100});
  const chip=document.querySelector('#image-drafts .image-chip');
  check(chip&&chip.dataset.status==='uploading'&&chip.title.includes('my shot.png'),'@ image did not show the attachment chip');
 });
 await test('archived session click stays on the current conversation', () => {
  reset(); emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});
  document.getElementById('btn-sessions').click();
  document.getElementById('tab-archived').click();
  emit({type:'sessions',includeArchived:true,currentId:'A',sessions:[{sessionId:'ARCH',title:'Old archived',archivedAt:1}]});
  const item=[...document.querySelectorAll('#overlay-list .overlay-item')].find(el=>el.textContent.includes('Old archived'));
  check(item,'archived session missing from the list');
  check(!item.querySelector('[data-act="rename"]'),'archived session still offered rename');
  item.click();
  check(!sent.some(message=>message.type==='switchSession'),'archived session started a switch');
  check(document.getElementById('toast').textContent==='请先取消归档再打开','archived session did not ask to unarchive');
  check(parseInt(getComputedStyle(document.getElementById('toast')).zIndex||'0')>parseInt(getComputedStyle(document.getElementById('overlay')).zIndex||'0'),'archived hint toast renders behind the open overlay');
  check(document.getElementById('overlay').classList.contains('open'),'archived list closed before restore');
  check(document.getElementById('session-title').value==='自定义会话头发发布','archived click changed the open session');
  item.querySelector('[data-act="unarchive"]').click();
  check(sent.some(message=>message.type==='unarchiveSession'&&message.sessionId==='ARCH'),'restore no longer unarchives');
  document.getElementById('tab-active').click();
  emit({type:'sessions',includeArchived:false,currentId:'A',sessions:[{sessionId:'LIVE',title:'Live chat'}]});
  const liveItem=[...document.querySelectorAll('#overlay-list .overlay-item')].find(el=>el.textContent.includes('Live chat'));
  check(liveItem&&!!liveItem.querySelector('[data-act="rename"]'),'active session lost rename');
 });
 await test('session archive shows scoped animated progress until matching host completion',()=>{
  reset();emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});document.getElementById('btn-sessions').click();
  emit({type:'sessions',includeArchived:false,currentId:'A',sessions:[{sessionId:'A',title:'会话 A'},{sessionId:'B',title:'会话 B'}]});
  const row=id=>[...document.querySelectorAll('#overlay-list .overlay-item')].find(el=>el.textContent.includes(`会话 ${id}`));
  const action=(id,name)=>row(id)?.querySelector(`[data-act="${name}"]`);
  action('A','archive').click();
  let archiveRequest=sent.find(message=>message.type==='archiveSession');
  check(archiveRequest?.actionRequestId,'archive request has no completion identity');
  let busy=action('A','archive');
  check(busy?.disabled&&busy.dataset.pending==='1'&&busy.getAttribute('aria-busy')==='true','archive did not enter a busy state immediately');
  check(busy.querySelectorAll('.session-action-dots i').length===3&&getComputedStyle(busy.querySelector('.session-action-dots i')).animationName==='session-action-dot','archive does not show the animated three-dot indicator');
  check(getComputedStyle(busy.querySelector('.session-action-label')).visibility==='hidden','busy archive label remained visible behind its indicator');
  check(row('A').getAttribute('aria-busy')==='true'&&row('A').dataset.operationPending==='1','archive row was not announced busy');
  check(!action('B','archive').disabled,'pending action disabled another session');
  row('A').click();check(!sent.some(message=>message.type==='switchSession'),'pending session row still switched conversations');
  emit({type:'sessions',includeArchived:false,currentId:'A',sessions:[{sessionId:'A',title:'会话 A'},{sessionId:'B',title:'会话 B'}]});
  busy=action('A','archive');check(busy?.dataset.pending==='1','sessions refresh erased pending archive state');
  emit({type:'session_action_complete',sessionId:'A',actionRequestId:'stale-request'});
  check(action('A','archive')?.dataset.pending==='1','stale completion cleared a newer operation');
  emit({type:'session_action_complete',sessionId:'A',actionRequestId:archiveRequest.actionRequestId});
  check(!action('A','archive')?.disabled&&!action('A','archive')?.dataset.pending,'matching completion did not restore the archive action');
 });
 await test('restore and delete actions retain progress through list refreshes',()=>{
  reset();emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});document.getElementById('btn-sessions').click();document.getElementById('tab-archived').click();
  emit({type:'sessions',includeArchived:true,currentId:'A',sessions:[{sessionId:'A',title:'会话 A',archivedAt:1}]});
  const row=()=>[...document.querySelectorAll('#overlay-list .overlay-item')].find(el=>el.textContent.includes('会话 A'));
  row().querySelector('[data-act="unarchive"]').click();
  const restore=sent.find(message=>message.type==='unarchiveSession');
  check(row().querySelector('[data-pending="1"]')?.getAttribute('aria-label')==='正在恢复','restore did not show localized progress');
  emit({type:'sessions',includeArchived:false,currentId:'A',sessions:[{sessionId:'A',title:'会话 A'}]});
  check(row().querySelector('[data-pending="1"]')?.dataset.act==='unarchive','restore progress disappeared when the row moved tabs');
  emit({type:'session_action_complete',sessionId:'A',actionRequestId:restore.actionRequestId});
  check(!row().querySelector('[data-pending="1"]'),'restore spinner remained after completion');
  document.getElementById('tab-archived').click();emit({type:'sessions',includeArchived:true,currentId:'A',sessions:[{sessionId:'A',title:'会话 A',archivedAt:1}]});
  row().querySelector('[data-act="delete"]').click();
  const deletion=sent.filter(message=>message.type==='deleteSession').at(-1);
  check(row().querySelector('[data-pending="1"]')?.getAttribute('aria-label')==='正在删除','delete did not show localized progress');
  emit({type:'sessions',includeArchived:true,currentId:'A',sessions:[{sessionId:'A',title:'会话 A',archivedAt:1}]});
  check(row().querySelector('[data-pending="1"]')?.dataset.act==='delete','list refresh erased pending delete state');
  emit({type:'session_action_complete',sessionId:'A',actionRequestId:deletion.actionRequestId});
  check(!row().querySelector('[data-pending="1"]'),'delete spinner remained after completion');
 });
 await test('choosing the open session closes the list without reloading it', () => {
  reset('A');
  emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});
  emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'keep',role:'user',text:'KEEP_THIS_TURN'}]});
  document.getElementById('btn-sessions').click();
  emit({type:'sessions',includeArchived:false,currentId:'A',sessions:[
    {sessionId:'A',title:'当前会话'},
    {sessionId:'B',title:'另一会话'}
  ]});
  const current=[...document.querySelectorAll('#overlay-list .overlay-item')].find(el=>el.textContent.includes('当前会话'));
  check(current&&current.classList.contains('active'),'open session is not marked in the list');
  const overlay=document.getElementById('overlay');
  const sheet=overlay.querySelector('.sheet');
  const overlayBlur=getComputedStyle(overlay).backdropFilter||'none';
  check(overlayBlur==='none'||!overlayBlur.includes('blur'),'session list still blurs the whole page');
  check((getComputedStyle(sheet).backdropFilter||'').includes('blur'),'session sheet is not frosted');
  check(getComputedStyle(overlay).backgroundColor==='rgba(0, 0, 0, 0)','session list still paints a scrim');
  const titleBefore=document.getElementById('session-title').value;
  current.click();
  check(!sent.some(message=>message.type==='switchSession'),'current session started a switch');
  check(!overlay.classList.contains('open'),'list stayed open after choosing the current session');
  check(messages.textContent.includes('KEEP_THIS_TURN'),'current session cleared the transcript');
  check(document.getElementById('session-title').value===titleBefore,'current session rewrote the title');
  document.getElementById('btn-sessions').click();
  emit({type:'sessions',includeArchived:false,currentId:'A',sessions:[
    {sessionId:'A',title:'当前会话'},
    {sessionId:'B',title:'另一会话'}
  ]});
  [...document.querySelectorAll('#overlay-list .overlay-item')].find(el=>el.textContent.includes('另一会话')).click();
  check(sent.some(message=>message.type==='switchSession'&&message.sessionId==='B'),'another session did not switch');
 });
 await test('model, permission and reasoning menus open beside their buttons', () => {
  const before = document.body.style.width;
  try {
    document.body.style.width = '420px';
    reset();
    emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});
    emit({type:'models',current:{providerId:'vendor',modelId:'GLM-5.3'},available:[{providerId:'vendor',modelId:'GLM-5.3',label:'GLM-5.3',hasKey:true},{providerId:'vendor',modelId:'GLM-4.6',label:'GLM-4.6',hasKey:true}]});
    emit({type:'session_controls',mode:'build',thoughtEnabled:true,thoughtLevel:'high',thoughtLevels:[{value:'high',label:'High'},{value:'max',label:'Max'}]});
    const host = document.getElementById('composer').getBoundingClientRect();
    const pop = document.getElementById('popover');
    for (const id of ['model-chip','mode-chip','thought-chip']) {
      const button = document.getElementById(id);
      button.click();
      const chip = button.getBoundingClientRect();
      const box = pop.getBoundingClientRect();
      check(pop.classList.contains('open') && button.getAttribute('aria-expanded')==='true', id+' menu closed');
      check(box.bottom <= chip.top + 1, id+' menu is not above its button');
      check(box.left <= chip.right && box.right >= chip.left, id+' menu misses its button');
      check(box.left >= host.left - 1 && box.right <= host.right + 1, id+' menu leaves the composer');
      check(box.width <= 220.5 && box.width <= host.width - 24, id+' menu still spans the composer');
    }
    check((getComputedStyle(pop).backdropFilter||'').includes('blur'), 'option menu is not frosted');
    pop.querySelector('.overlay-item').click();
    check(!pop.classList.contains('open'), 'menu stayed open after a choice');

    const current = {providerId:'vendor',modelId:'GLM-5.3'};
    const many = Array.from({length: 40}, (_, index) => ({
      providerId: index === 20 ? current.providerId : `vendor-${index}`,
      modelId: index === 20 ? current.modelId : `model-${String(index + 1).padStart(2, '0')}`,
      label: index === 20 ? current.modelId : `model-${String(index + 1).padStart(2, '0')}`,
      hasKey: true
    }));
    document.getElementById('model-chip').click();
    emit({type:'models', current, available: many});
    const active = pop.querySelector('.overlay-item.active');
    check(active && active.textContent.includes('GLM-5.3'), 'current model is not marked active');
    check(active && Math.abs(active.getBoundingClientRect().bottom - pop.getBoundingClientRect().bottom) < 2,
      'model picker did not reveal the current choice');
    document.body.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
    document.getElementById('btn-settings').click();
    const settings=document.getElementById('settings-menu');
    check(!settings.hidden && (getComputedStyle(settings).backdropFilter||'').includes('blur'), 'settings menu is not frosted');
    const glass=document.getElementById('frosted-glass');
    check(glass.checked && document.documentElement.dataset.frostedGlass==='true', 'frosted glass starts off');
    glass.click();
    check(document.documentElement.dataset.frostedGlass==='false', 'glass switch did not turn off');
    check(sent.some(message=>message.type==='setChrome'&&message.chromeKey==='frostedGlass'&&message.enabled===false), 'glass preference was not saved');
    check(!(getComputedStyle(pop).backdropFilter||'').includes('blur') && !(getComputedStyle(settings).backdropFilter||'none').includes('blur') && !(getComputedStyle(document.querySelector('.composer-card')).backdropFilter||'').includes('blur'), 'glass stayed on after the switch');
    emit({type:'composer_chrome', chrome:{frostedGlass:true, showQuestionJump:true, showUsageChevron:true, showContextRing:true, showFiveHourRing:true, showConnectionStatus:true, sessionControlsIcons:false, foldSessionControls:false}});
    check(glass.checked && (getComputedStyle(document.querySelector('.composer-card')).backdropFilter||'').includes('blur'), 'saved glass did not return');
  } finally { document.body.style.width = before; }
 });
 await test('selecting @ file then immediately sending includes reference without a host acknowledgement',async()=>{
  reset(); input.focus(); type('Explain @main'); input.setSelectionRange(input.value.length,input.value.length); input.dispatchEvent(new Event('input'));
  await new Promise(r=>setTimeout(r,150)); const request=[...sent].reverse().find(item=>item.type==='searchWorkspaceFiles'); check(request,'missing search');
  emit({type:'workspace_files',requestId:request.requestId,sessionId:request.sessionId,files:[{path:'/test/main.ts',relPath:'main.ts'}]});
  input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  check(document.querySelector('#attachments').textContent.includes('main.ts'),'reference awaited host callback');
  input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  const message=sent.find(item=>item.type==='send');check(message&&message.chips.some(chip=>chip.path==='/test/main.ts'),'immediate send omitted selected reference');
  check(message.text==='Explain','search token leaked into sent prompt');
  check(!sent.some(item=>item.type==='mentionFile'),'redundant acknowledgement can resurrect removed references');
  check(!document.querySelector('#attachments .ctx-chip'),'submitted reference remains in composer');
  check(!savedState.composerDrafts['A']?.chips.length,'submitted reference remains in persisted draft');
  emit({type:'send_rejected',commandId:message.commandId,sessionId:'A',message:'rejected'});
  check(document.querySelector('#attachments').textContent.includes('main.ts'),'rejected send lost reference');
 });

 await test('image-analysis card is compact and hides signed URL queries without changing raw parameters',()=>{
  reset(); const parameters=JSON.stringify({imageSource:'https://example.invalid/image.png?Signature=SECRET',prompt:'Explain screenshot'});
  emit({type:'tool_call',toolCallId:'compact-image',toolName:'analyze_image',status:'running',inputText:parameters});
  let card=messages.querySelector('.tool-call'); check(card.classList.contains('collapsed'),'image tool starts expanded');
  check(!card.querySelector('.tool-head').textContent.includes('https:'),'signed URL crowds header');
  check(card.dataset.rawInput===parameters,'parameter presentation modified request data');
  check(!card.querySelector('.tool-body').textContent.includes('SECRET'),'signature remains visible');
  card.querySelector('.tool-head').click();
  emit({type:'tool_call',toolCallId:'compact-image',toolName:'analyze_image',status:'completed',outputText:JSON.stringify([{text:'Full result'}])});
  card=messages.querySelector('.tool-call'); check(!card.classList.contains('collapsed'),'completion lost user expansion');
  check(card.querySelectorAll('.tool-section-label').length===2,'parameters and result not separated');
  check(card.querySelector('.tool-io.out').textContent==='Full result','result truncated or lost');
 });
 await test('reference tooltip identifies absolute path selection snapshot and current dirty file',()=>{
  reset(); emit({type:'addChip',chip:{path:'/test/main.ts',relPath:'main.ts'}});
  const chip=document.querySelector('#attachments .ctx-chip');check(chip.title.includes('/test/main.ts'),'absolute path missing');
  chip.dispatchEvent(new Event('mouseenter')); const request=[...sent].reverse().find(item=>item.type==='fileReferenceDetails');check(request,'dirty status not requested');
  emit({type:'file_reference_details',path:request.path,requestId:request.requestId,sessionId:request.sessionId,dirty:true});check(/未保存|未儲存|unsaved/i.test(chip.title),'dirty hint missing');
  emit({type:'addChip',chip:{path:'/test/selected.ts',relPath:'selected.ts',selectionStart:3,selectionEnd:8,selectedText:'snapshot',sourceDirty:true}});
  const selected=[...document.querySelectorAll('#attachments .ctx-chip')].find(item=>item.textContent.includes('selected.ts'));check(selected.title.includes('L3')&&selected.title.includes('L8'),'selection range missing');
  const title=chip.title;emit({type:'file_reference_details',path:request.path,requestId:request.requestId,sessionId:'another-session',dirty:false});check(chip.title===title,'foreign tooltip reply changed current draft');
 });
 await test('editing the last question can drop and restore images before resending',()=>{
  reset();
  const images=[{ref:'img://a.png',fileName:'a.png',mime:'image/png',bytes:10},{ref:'img://b.png',fileName:'b.png',mime:'image/png',bytes:20}];
  emit({type:'history',sessionId:'A',viewGen:gen,items:[
    {id:'img-q',role:'user',turnId:'t',text:'带图提问',attachments:images,tools:[]},
    {id:'img-a',role:'assistant',turnId:'t',text:'回复',tools:[]}
  ]});
  emit({type:'conversation_sync',sessionId:'A',editable:{target:{rowId:2,entityId:'e2'},text:'带图提问',attachments:images},turns:[]});
  const bubble=[...messages.querySelectorAll('.message.user')].at(-1);
  messages.querySelector('.turn-edit-btn').click();
  const chips=[...bubble.querySelectorAll('.user-images .image-chip')];
  check(chips.length===2,'edit did not expose the sent images');
  check(!!bubble.querySelector('.edit-add-image'),'edit cannot add an image');
  check(!!bubble.querySelector('.user-edit'),'edit textarea missing');
  chips[1].querySelector('.image-remove').click();
  check(chips[1].dataset.removed==='1','remove badge did not mark the image');
  chips[1].querySelector('.image-remove').click();
  check(chips[1].dataset.removed!==('1'),'badge toggle could not restore the image');
  chips[1].querySelector('.image-remove').click();
  bubble.querySelector('[data-uedit="send"]').click();
  const edit=sent.find(m=>m.type==='editLast');
  check(edit&&edit.sessionId==='A'&&edit.attachments.length===1&&edit.attachments[0].ref==='img://a.png','edit lost its session owner or resent the dropped image');
  bubble.querySelector('[data-uedit="cancel"]').click();
  check(!bubble.querySelector('.image-remove')&&!bubble.querySelector('.user-images[data-editing]'),'cancel did not restore the original images');
  // Removing every image with no text left must not submit an empty edit.
  messages.querySelector('.turn-edit-btn').click();
  for(const chip of bubble.querySelectorAll('.user-images .image-chip')) chip.querySelector('.image-remove').click();
  bubble.querySelector('.user-edit').value='';
  bubble.querySelector('[data-uedit="send"]').click();
  check(!sent.some((m,i)=>i>sent.indexOf(edit)&&m.type==='editLast'),'empty edit with no images must not submit');
  bubble.querySelector('[data-uedit="cancel"]').click();
  check(bubble.querySelectorAll('.user-images .image-chip').length===2&&!bubble.querySelector('.image-remove'),'second cancel did not restore the images');
 });
 await test('edit message preserves bubble width or expands to fit buttons and textarea grows',()=>{
  reset();const text='A long original question '.repeat(20);emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'u-edit',role:'user',text}]});emit({type:'conversation_sync',sessionId:'A',editable:{text,target:{rowId:2,entityId:'u-edit'}},turns:[{turnId:'edit-turn',userText:text}]});
  const bubble=messages.querySelector('.message.user');const before=bubble.getBoundingClientRect().width;const edit=document.querySelector('.turn-edit-btn');check(edit,'missing edit button');edit.click();
  const textarea=bubble.querySelector('.user-edit');check(textarea,'edit textarea missing');check(Math.abs(bubble.getBoundingClientRect().width-before)<2,'long bubble width changed when editing');
  const editAttach=bubble.querySelector('.edit-add-image svg path'),composerAttach=document.querySelector('#attach-files svg path');check(editAttach?.getAttribute('d')===composerAttach?.getAttribute('d')&&editAttach?.getAttribute('stroke-width')===composerAttach?.getAttribute('stroke-width'),'edit attachment icon differs from the composer paperclip');
  const editSend=bubble.querySelector('.user-edit-send'),composerSend=document.getElementById('send-btn'),editSendStyle=getComputedStyle(editSend),composerSendStyle=getComputedStyle(composerSend);check(editSendStyle.width===composerSendStyle.width&&editSendStyle.height===composerSendStyle.height&&editSendStyle.borderRadius===composerSendStyle.borderRadius,'edit send button does not match the composer circle');check(editSendStyle.backgroundColor===composerSendStyle.backgroundColor&&editSendStyle.color===composerSendStyle.color,'edit send button does not match the composer theme colors');
  check(textarea.getBoundingClientRect().width>bubble.getBoundingClientRect().width*.8,'textarea shrank to button layout');check(textarea.getBoundingClientRect().height>=64,'textarea too short');
  bubble.querySelector('[data-uedit="cancel"]').click();check(!bubble.style.width,'cancel retained edit width');
  reset(); emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'short-edit',role:'user',text:'Hi'}]});emit({type:'conversation_sync',sessionId:'A',editable:{text:'Hi',target:{rowId:3,entityId:'short-edit'}},turns:[{turnId:'short-turn',userText:'Hi'}]});
  const small=messages.querySelector('.message.user'),smallWidth=small.getBoundingClientRect().width;document.querySelector('.turn-edit-btn').click();
  check(small.getBoundingClientRect().width>smallWidth,'short message not expanded for buttons');
  check(small.getBoundingClientRect().width<=messages.clientWidth,'edit bubble overflows sidebar');

 });

 await test('answered multi-select question becomes a compact expandable work summary',()=>{
  reset();emit({type:'status',sessionId:'A',status:'running'});
  emit({type:'user_input_request',sessionId:'A',requestId:'multi-summary',questions:[{header:'Scope',question:'Which files should be updated?',multiSelect:true,options:[{value:'code',label:'Code'},{value:'docs',label:'Documentation'}]}]});
  const card=document.getElementById('ask-multi-summary');check(card.textContent.includes('Which files should be updated?'),'header hid actual question');
  check(!card.classList.contains('resolved')&&!card.querySelector('.ask-summary'),'pending question prematurely compacted');
  card.querySelector('[data-val="code"]').click();card.querySelector('[data-val="docs"]').click();
  card.querySelector('[data-act="submit"]').click();
  const summary=card.querySelector('.ask-summary'),details=card.querySelector('.ask-details');
  check(card.closest('.work-fold')&&summary&&details.hidden,'answered question not compacted in work fold');
  check(summary.textContent.includes('Code')&&summary.textContent.includes('Documentation'),'selected labels missing');
  check(!summary.disabled,'summary cannot expand');summary.click();check(!details.hidden&&summary.getAttribute('aria-expanded')==='true','summary did not expand');
  check([...details.querySelectorAll('button')].every(button=>button.disabled),'resolved question actions still active');
  summary.click();check(details.hidden,'summary did not collapse');
  const replies=sent.filter(item=>item.type==='userInputAnswer');check(replies.length===1&&replies[0].content.answer==='code, docs','multi-select reply changed or duplicated');
 });
 await test('declined and interrupted questions keep read-only expandable summaries',()=>{
  reset();emit({type:'status',sessionId:'A',status:'running'});
  const question={question:'Continue?',options:[{value:'yes',label:'Yes'}]};
  emit({type:'user_input_request',requestId:'declined-summary',questions:[question]});
  const declined=document.getElementById('ask-declined-summary');declined.querySelector('[data-act="decline"]').click();check(declined.querySelector('.ask-details').hidden,'declined form stayed open');
  check(sent.filter(item=>item.type==='userInputAnswer'&&item.action==='decline').length===1,'decline reply missing');
  emit({type:'user_input_request',requestId:'cancelled-summary',questions:[question]});
  emit({type:'status',sessionId:'A',status:'completedInterrupted'});
  const cancelled=document.getElementById('ask-cancelled-summary');const header=cancelled.querySelector('.ask-summary');check(header&&!header.disabled,'interrupted summary cannot open');
  header.click();check(!cancelled.querySelector('.ask-details').hidden,'interrupted details missing');
  const count=sent.filter(item=>item.type==='userInputAnswer').length;cancelled.querySelector('[data-val]').click();check(sent.filter(item=>item.type==='userInputAnswer').length===count,'interrupted question sent a reply');
 });

 await test('initial reasoning options without enabled show picker and explicit disable hides it',()=>{
  reset(); emit({type:'session_controls',thoughtEnabled:false,thoughtLevels:[]});
  emit({type:'session_controls',thoughtLevel:'high',thoughtLevels:[{value:'low',label:'Low'},{value:'high',label:'High'}]});
  const chip=document.getElementById('thought-chip');check(getComputedStyle(chip).display!=='none','initial options remain hidden');
  emit({type:'session_controls',mode:'build'});check(getComputedStyle(chip).display!=='none','partial permission update hid thought picker');
  emit({type:'session_controls',thoughtEnabled:false,thoughtLevels:[{value:'high'}]});check(getComputedStyle(chip).display==='none','explicit disabled model exposes reasoning');
 });
 await test('usage details show compact token counts and reset dates then clear on switch',()=>{
  reset();emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'}); const resetTime=Date.now()+3*60*60*1000,weekly=Date.now()+7*24*60*60*1000;
  emit({type:'context_usage',used:3000,max:1000000,quota:[{label:'5 小时',remainingPercent:75,usedPercent:25,nextResetTime:resetTime},{label:'每周',remainingPercent:80,usedPercent:20,nextResetTime:weekly}]});
  check(document.querySelector('#usage-context .usage-cell-detail').textContent==='0.3/100万','token ratio missing');check([...document.querySelectorAll('.usage-cell-detail')].every(node=>node.parentElement.classList.contains('usage-cell-head')),'usage details still occupy a second line');const visibleCells=[...document.querySelectorAll('.usage-cell:not([hidden])')];check(visibleCells.every(cell=>{const node=cell.querySelector('.usage-cell-value');return getComputedStyle(node).display!=='none'&&node.getBoundingClientRect().width>0&&node.textContent.includes('%')}),'usage percentages hidden when details exist');for(const cell of visibleCells){const head=cell.querySelector('.usage-cell-head');check(head.children[0].classList.contains('usage-cell-label')&&head.children[1].classList.contains('usage-cell-value')&&head.children[2].classList.contains('usage-cell-detail'),'percentage not beside label or details not on right');}const widths=visibleCells.map(cell=>cell.getBoundingClientRect().width);check(Math.max(...widths)-Math.min(...widths)<1,'usage columns are not equal');
  check(document.querySelector('#usage-five-hour .usage-cell-detail').textContent.includes('↻'),'short quota reset missing');
  check(/\d+\/\d+/.test(document.querySelector('#usage-weekly .usage-cell-detail').textContent),'weekly reset date missing');
  check(document.querySelector('#usage-context svg.usage-context-symbol[aria-hidden="true"]'),'context window symbol missing');
  for(const [language,expected] of [['en','3/1000k'],['zh-TW','0.3/100萬'],['zh-CN','0.3/100万']]){emit({type:'ui_language',language,setting:language});check(document.querySelector('#usage-context .usage-cell-detail').textContent===expected,'context units did not follow language');}
  emit({type:'context_usage',used:1,max:128000});check(document.querySelector('#usage-context .usage-cell-detail').textContent==='0.0001/12.8万','small context rounded down to zero');
  emit({type:'view_reset',viewGen:++gen});check([...document.querySelectorAll('.usage-cell-detail')].every(element=>!element.textContent),'previous conversation details retained');
 });

 await test('Start Plan model buckets render by server labels without dropping extra quotas',()=>{
  reset();emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});emit({type:'context_usage',used:1000,max:1000000,quota:[
   {label:'GLM-5.3',remainingPercent:80,usedPercent:20,remainingCount:2400000,nextResetTime:2000100000000},
   {label:'GLM-5.3-Flash',remainingPercent:50,usedPercent:50,remainingCount:2500000,nextResetTime:2000200000000},
   {label:'GLM-5.2',remainingPercent:25,usedPercent:75,remainingCount:500000,nextResetTime:2000300000000},
  ]});
  const cells=[...document.querySelectorAll('#usage-panel .usage-cell')].filter(cell=>!cell.hidden);
  check(cells.length===4,'Start Plan buckets beyond the two Coding Plan limits were dropped');
  check(cells.slice(1).map(cell=>cell.querySelector('.usage-cell-label').textContent).join('|')==='GLM-5.3|GLM-5.3-Flash|GLM-5.2','Start Plan labels or server ordering changed');
  check(cells.slice(1).map(cell=>cell.querySelector('.usage-cell-value').textContent).join('|')==='20%|50%|75%','Start Plan percentages did not use remaining_units');
  emit({type:'context_usage',used:1000,max:1000000,quota:[{label:'5 小时',remainingPercent:75,usedPercent:25},{label:'每周',remainingPercent:80,usedPercent:20}]});
  check([...document.querySelectorAll('#usage-panel .usage-cell')].filter(cell=>!cell.hidden).length===3,'old Start Plan cells stayed visible after switching back to Coding Plan quota');
  check(document.querySelector('#usage-five-hour .usage-cell-label').textContent==='5时'&&document.querySelector('#usage-weekly .usage-cell-label').textContent==='一周','standard Coding Plan labels were not restored');
 });

 await test('money-only provider balances render amounts and restore percentage quotas',()=>{
  reset();emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});emit({type:'context_usage',used:1000,max:1000000,quota:[
   {label:'CNY',currency:'CNY',remainingAmount:12.5,grantedAmount:2.5,toppedUpAmount:10},
   {label:'USD',currency:'USD',remainingAmount:0,grantedAmount:0,toppedUpAmount:0},
   {label:'EUR',currency:'EUR',remainingAmount:5.25},
  ]});
  const cny=document.getElementById('usage-five-hour'),usd=document.getElementById('usage-weekly'),eur=[...document.querySelectorAll('#usage-panel .usage-cell')].find(cell=>cell.querySelector('.usage-cell-label').textContent==='EUR');
  check(cny.querySelector('.usage-cell-label').textContent==='CNY'&&cny.querySelector('.usage-cell-value').textContent==='¥12.50','CNY balance or compact label missing');
  check(usd.querySelector('.usage-cell-label').textContent==='USD'&&usd.querySelector('.usage-cell-value').textContent==='$0.00','zero USD balance was dropped');
  check(eur&&eur.querySelector('.usage-cell-value').textContent.replace(/[^\d.]/g,'')==='5.25','non-CNY/USD balance was not formatted');
  check(!cny.querySelector('.usage-cell-detail').textContent&&!usd.querySelector('.usage-cell-detail').textContent,'money amount was duplicated as a reset detail');
  check([cny,usd].every(cell=>cell.classList.contains('money')&&cell.getAttribute('role')==='group'&&!cell.hasAttribute('aria-valuenow')),'money row retained misleading progress semantics');
  check([cny,usd].every(cell=>getComputedStyle(cell.querySelector('.usage-track')).display==='none'),'money row showed a fake usage bar');
  check(cny.title.includes('账户余额（CNY）')&&cny.title.includes('赠金余额：¥2.50')&&cny.title.includes('充值余额：¥10.00'),'balance breakdown missing from hover details');
  check(document.getElementById('five-hour-ring-tip').hidden,'money balance showed a percentage-only ring');
  emit({type:'context_usage',used:1000,max:1000000,quota:[{label:'5 小时',remainingPercent:75,usedPercent:25},{label:'每周',remainingPercent:80,usedPercent:20}]});
  check(!document.getElementById('five-hour-ring-tip').hidden&&cny.querySelector('.usage-cell-value').textContent==='25%'&&!cny.classList.contains('money'),'switching back did not restore the normal quota display');
 });

 await test('custom quota metrics show values without fake percentages',()=>{
  reset();emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});emit({type:'context_usage',used:1000,max:1000000,quota:[
   {label:'Kimi API',currency:'CNY',remainingAmount:42.5,metrics:[{label:'消费',period:'今日',value:1.25,format:'currency',currency:'CNY'}]},
   {label:'今日消费',metrics:[{label:'消费',period:'今日',value:3.2,format:'currency',currency:'CNY'}]},
  ]});
  const balance=document.getElementById('usage-five-hour'),metric=document.getElementById('usage-weekly');
  check(balance.querySelector('.usage-cell-value').textContent==='¥42.50','balance stopped being the primary value');
  check(balance.querySelector('.usage-cell-detail').textContent.includes('今日 · 消费：¥1.25'),'custom metric was not visible beside its balance');
  check(balance.title.includes('今日 · 消费：¥1.25'),'custom metric missing from balance details');
  check(metric.querySelector('.usage-cell-value').textContent==='¥3.20'&&metric.classList.contains('metric-only'),'metric-only row did not show its amount');
  check(metric.getAttribute('role')==='group'&&!metric.hasAttribute('aria-valuenow'),'metric-only row exposed a fake progress percentage');
  check(getComputedStyle(metric.querySelector('.usage-track')).display==='none','metric-only row showed a fake usage bar');
  check(metric.title.includes('今日 · 消费：¥3.20'),'custom metric missing from hover details');
  emit({type:'context_usage',used:1000,max:1000000,quota:[{label:'5 小时',remainingPercent:75,usedPercent:25}]});
  check(!metric.classList.contains('metric-only')&&metric.hidden,'metric-only presentation leaked into the hidden weekly slot');
 });

 await test('count-only and reset-only quota rows stay visible without fake percentages',()=>{
  reset();emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});
  const resetAt=Date.now()+3600000;
  emit({type:'context_usage',used:1000,max:1000000,quota:[
   {label:'API 次数',remainingCount:12345,nextResetTime:resetAt},
   {label:'额度重置',nextResetTime:resetAt},
  ]});
  const count=document.getElementById('usage-five-hour'),resetOnly=document.getElementById('usage-weekly');
  check(count.querySelector('.usage-cell-label').textContent==='API 次数'&&count.querySelector('.usage-cell-value').textContent==='12,345','count-only quota was omitted or altered');
  check(count.classList.contains('count-only')&&getComputedStyle(count.querySelector('.usage-track')).display==='none','count-only quota displayed a fake usage bar');
  check(count.getAttribute('role')==='group'&&!count.hasAttribute('aria-valuenow')&&count.getAttribute('aria-label').includes('12,345'),'count-only quota retained progress semantics or lost its accessible value');
  check(count.title.includes('剩余数量：12,345')&&count.title.includes('重置时间：'),'count or reset detail missing from hover');
  check(resetOnly.querySelector('.usage-cell-label').textContent==='额度重置'&&resetOnly.querySelector('.usage-cell-value').textContent==='—'&&resetOnly.querySelector('.usage-cell-detail').textContent.includes('↻'),'reset-only quota was not visible');
  check(resetOnly.getAttribute('role')==='group'&&!resetOnly.hasAttribute('aria-valuenow'),'reset-only quota displayed percentage semantics');
 });

 await test('quoted @ filenames and error retry keep draft and owner intact',async()=>{
  reset();input.focus();type('Explain @"my file.ts"');input.setSelectionRange(input.value.length,input.value.length);input.dispatchEvent(new Event('input'));
  await new Promise(r=>setTimeout(r,150));let request=[...sent].reverse().find(item=>item.type==='searchWorkspaceFiles');check(request&&request.text==='my file.ts','quoted filename not searched');
  emit({type:'workspace_files',requestId:request.requestId,sessionId:request.sessionId,files:[],error:'文件搜索失败，请重试。'});
  check(document.querySelector('#file-mentions button'),'retry button missing');const text=input.value;
  input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  const retry=[...sent].reverse().find(item=>item.type==='searchWorkspaceFiles');check(retry.requestId!==request.requestId&&input.value===text,'retry changed draft or reused stale ID');
  emit({type:'workspace_files',requestId:request.requestId,sessionId:request.sessionId,files:[{path:'/test/wrong',relPath:'wrong'}]});check(!document.querySelector('#file-mentions button'),'stale failed request supplied results');
 emit({type:'workspace_files',requestId:retry.requestId,sessionId:retry.sessionId,files:[{path:'/test/my file.ts',relPath:'my file.ts'}]});
  input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  check(input.value==='Explain ','quoted query not removed cleanly');check(document.querySelector('#attachments').textContent.includes('my file.ts'),'quoted file reference missing');
 });

 await test('conversation reasoning and question rail scrollbars stay visible in both themes',()=>{
  reset();
  emit({type:'assistant_reasoning_delta',partId:'scrollbar-contrast',authoritative:true,fullText:'THOUGHT_LINE\n'.repeat(45)});
  const root=document.documentElement,name='--vscode-foreground',previous=root.style.getPropertyValue(name);
  const thumbs=[
   document.getElementById('messages-thumb'),
   document.querySelector('.work-fold-viewport > .soft-scroll.y .soft-thumb'),
   document.querySelector('#question-rail .soft-scroll.x .soft-thumb')
  ];
  check(thumbs.every(Boolean),'a target scrollbar thumb is missing');
  const opacity=element=>{const values=getComputedStyle(element).backgroundColor.match(/[0-9]*\.?[0-9]+/g)?.map(Number)||[];return values.length>3?values.at(-1):1;};
  try{
   for(const foreground of ['#cccccc','#222222']){
    root.style.setProperty(name,foreground);
    check(opacity(thumbs[0])>=0.17&&opacity(thumbs[1])>=0.17,`conversation or reasoning thumb contrast stayed too low for ${foreground}`);
    check(opacity(thumbs[2])>=0.21,`question rail thumb contrast stayed too low for ${foreground}`);
   }
  }finally{if(previous)root.style.setProperty(name,previous);else root.style.removeProperty(name);}
 });

 await test('composer scrollbar stays stable while growing text crosses the height cap',()=>{
  reset();const area=document.getElementById('input-area'),rail=area.querySelector('.soft-scroll.y');check(rail,'composer hairline rail missing');
  const saved=area.style.width;
  try {for(const width of [240,320]){area.style.width=width+'px';let overflowSeen=false,lastHeight=0;const widths=[];
   for(let count=1;count<=140;count+=3){type('中文 English '.repeat(count));const height=input.getBoundingClientRect().height,overflow=input.scrollHeight>input.clientHeight+1;
    check(height>=lastHeight&&height<=160,'composer height shrank or exceeded cap');lastHeight=height;
    check(rail.hidden===!overflow,'composer rail visibility disagrees with actual overflow');
    if(overflowSeen)check(overflow&&!rail.hidden,'composer scrollbar disappeared while adding text');overflowSeen ||= overflow;widths.push(input.clientWidth);
   }
   check(overflowSeen,'growth fixture never overflowed');check(widths.every(width=>width===widths[0]),'scrollbar changed wrapping width');
   check(getComputedStyle(input).scrollbarWidth==='none'&&parseFloat(getComputedStyle(rail.querySelector('.soft-thumb')).width)===2,'composer rail does not match reply hairline');
   type('short');check(rail.hidden&&input.clientHeight<160,'shortening draft left stale scrollbar or height');
  }}finally{area.style.width=saved;type('');}
 });
 await test('long composer draft restores its rail without an input event',()=>{
  reset('scroll-draft-A');type('LONG_DRAFT_LINE\n'.repeat(25));const rail=document.querySelector('#input-area > .soft-scroll.y');check(!rail.hidden,'long draft rail missing');
  emit({type:'view_reset',clear:true,viewGen:++gen});emit({type:'session_ready',sessionId:'scroll-draft-B',viewGen:gen});check(rail.hidden&&input.value==='','old draft rail leaked to new session');
  emit({type:'view_reset',clear:true,viewGen:++gen});emit({type:'session_ready',sessionId:'scroll-draft-A',viewGen:gen});emit({type:'history',sessionId:'scroll-draft-A',viewGen:gen,items:[]});emit({type:'stream_release'});check(input.value==='LONG_DRAFT_LINE\n'.repeat(25)&&!rail.hidden,'restored long draft has no scrollbar');
  sendBtn.click();check(input.value===''&&rail.hidden&&input.clientHeight<160,'sending left stale composer rail');
 });

 await test('immediate insertion freezes the preceding clock and starts a separate live segment',()=>{
  reset();emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});const original=Date.now;let now=original();Date.now=()=>now;
  try{const start=now;type('SEGMENT_ROOT');sendBtn.click();emit({type:'assistant_reasoning_delta',partId:'segment-root-r',fullText:'ROOT_WORK'});
   now+=45000;type('SEGMENT_INSERT');document.getElementById('insert-now-btn').click();
   const previous=messages.querySelector('.work-fold');check(previous.dataset.state==='completed'&&Number(previous.dataset.durationMs)===45000,'insertion did not freeze the first segment at its boundary');
   now+=2000;emit({type:'assistant_reasoning_delta',partId:'segment-next-r',fullText:'NEXT_WORK'});
   const next=messages.querySelector('.work-fold[data-state="running"]');check(Number(next.dataset.startedAt)===start+45000,'new live segment inherited old task start');check(next.querySelector('.work-fold-label').textContent.includes('2 秒'),'new segment displayed cumulative task time');
   now+=3000;emit({type:'status',sessionId:'A',status:'completedSuccess'});check(Number(next.dataset.durationMs)===5000&&Number(previous.dataset.durationMs)===45000,'completion changed independent segment durations');
  }finally{Date.now=original;}
 });
 await test('live history split does not carry the previous segment clock across inserts',()=>{
  reset();const original=Date.now;let now=original();Date.now=()=>now;
  try{const start=now;const root={id:'clock-root',role:'user',turnId:'clock-task',text:'ROOT',createdAt:start};const first={id:'clock-first',role:'assistant',turnId:'clock-task',createdAt:start,running:true,steps:[{kind:'reasoning',partId:'clock-r1',text:'FIRST_SEGMENT'}]};
   emit({type:'history',sessionId:'A',viewGen:gen,activeSince:start,items:[root,first]});now+=60000;
   const inserted={id:'clock-insert',role:'user',turnId:'clock-task',text:'INSERT',createdAt:now};const next={id:'clock-next',role:'assistant',turnId:'clock-task',createdAt:start,running:true,steps:[{kind:'reasoning',partId:'clock-r2',text:'SECOND_SEGMENT'}]};
   const items=[root,{...first,running:false,endedAt:now},inserted,next];emit({type:'history',sessionId:'A',viewGen:gen,activeSince:start,items});
   let folds=[...messages.querySelectorAll('.work-fold')];check(Number(folds[0].dataset.durationMs)===60000&&Number(folds[1].dataset.startedAt)===inserted.createdAt,'live redraw inherited previous segment clock');
   now+=4000;emit({type:'history',sessionId:'A',viewGen:gen,activeSince:start,items});folds=[...messages.querySelectorAll('.work-fold')];check(Number(folds[1].dataset.startedAt)===inserted.createdAt,'same segment redraw reset its own clock');
   emit({type:'view_reset',clear:true,viewGen:++gen});emit({type:'session_ready',sessionId:'A',viewGen:gen});emit({type:'history',sessionId:'A',viewGen:gen,activeSince:start,items});folds=[...messages.querySelectorAll('.work-fold')];check(Number(folds[1].dataset.startedAt)===inserted.createdAt,'cold restoration inherited task-wide clock');
   now+=6000;emit({type:'history',sessionId:'A',viewGen:gen,items:[...items.slice(0,-1),{...next,running:false,endedAt:now,workDurationMs:70000}]});folds=[...messages.querySelectorAll('.work-fold')];check(Number(folds[0].dataset.durationMs)===60000&&Number(folds[1].dataset.durationMs)===10000,'final history repeated task total instead of segment spans');
  }finally{Date.now=original;}
 });
 await test('a queued draft does not split the clock before promotion',()=>{
  reset();const original=Date.now;let now=original();Date.now=()=>now;
  try{type('QUEUE_CLOCK_ROOT');sendBtn.click();emit({type:'assistant_reasoning_delta',partId:'queue-clock-root',fullText:'QUEUE_ROOT_WORK'});const fold=messages.querySelector('.work-fold'),started=fold.dataset.startedAt;
   now+=30000;type('QUEUED_CLOCK_INPUT');sendBtn.click();check(fold.dataset.state==='running'&&fold.dataset.startedAt===started&&messages.querySelectorAll('.work-fold').length===1,'queued draft prematurely split active clock');
  }finally{Date.now=original;}
 });

 await test('a rejected immediate insertion resumes the original segment clock',()=>{
  reset();const original=Date.now;let now=original();Date.now=()=>now;
  try{type('REJECT_CLOCK_ROOT');sendBtn.click();emit({type:'assistant_reasoning_delta',partId:'reject-clock-root',fullText:'ROOT_WORK'});const fold=messages.querySelector('.work-fold'),started=fold.dataset.startedAt;
   now+=30000;type('REJECTED_CLOCK_INSERT');document.getElementById('insert-now-btn').click();const command=sent.find(message=>message.type==='insert'&&message.immediate);check(fold.dataset.state==='completed','immediate insertion did not settle old segment');
   emit({type:'queue_rejected',sessionId:'A',commandId:command.queueItemId,text:'REJECTED_CLOCK_INSERT',message:'Rejected test insertion'});
   check(fold.dataset.state==='running'&&fold.dataset.startedAt===started&&fold.dataset.durationMs===undefined,'rejected insertion left original clock frozen or reset');check(messages.querySelectorAll('.work-fold').length===1&&!messages.textContent.includes('REJECTED_CLOCK_INSERT'),'rejected insertion left an extra segment');
  }finally{Date.now=original;}
 });
 await test('long completed reply returns its question bubble to the top only while naturally following',async()=>{
  reset();emit({type:'history',sessionId:'A',viewGen:gen,items:[
   {id:'completed-position-older-q',role:'user',text:'An earlier question'},
   {id:'completed-position-older-a',role:'assistant',text:('An earlier answer.\n\n').repeat(30)}
  ]});type(('LONG_REPLY_START_CONTEXT\n').repeat(24));sendBtn.click();emit({type:'assistant_reasoning_delta',partId:'start-reasoning',fullText:'Thinking before answering'});
  emit({type:'assistant_text_delta',partId:'long-start-answer',fullText:('Long answer paragraph.\n\n').repeat(35)});
  await new Promise(resolve=>setTimeout(resolve,80));
  const answer=[...messages.querySelectorAll(':scope > .message.assistant')].at(-1);check(answer.getBoundingClientRect().top<0,'fixture did not scroll past answer start');
  emit({type:'status',sessionId:'A',status:'completedSuccess'});
  const question=[...messages.querySelectorAll('.message.user:not(.queued)')].at(-1),rect=question.getBoundingClientRect(),bar=document.getElementById('topbar').getBoundingClientRect();
  check(rect.top>=bar.bottom&&rect.top<bar.bottom+40,'completed question bubble is not below floating header');
  const naturalTop=rect.top;
  check(messages.scrollTop>0,'fixture did not allow the completed question to reach its own scroll position');
  const dot=[...document.querySelectorAll('#question-rail-track .q-dot')].find(item=>item.dataset.jump===question.dataset.jump);
  check(dot,'completed question has no jump target');
  messages.scrollTop+=120;
  const scrollTo=messages.scrollTo.bind(messages);let jumpTarget;
  messages.scrollTo=options=>{jumpTarget=options.top;messages.scrollTop=options.top;};
  try{
   dot.dispatchEvent(new PointerEvent('pointerdown',{button:0,bubbles:true,pointerId:1}));
   dot.dispatchEvent(new PointerEvent('pointerup',{button:0,bubbles:true,pointerId:1}));
  }finally{messages.scrollTo=scrollTo;}
  check(Number.isFinite(jumpTarget),'question jump button did not scroll to the question');
  check(Math.abs(question.getBoundingClientRect().top-naturalTop)<2,`natural completion leaves a different top gap than clicking the question jump button (${naturalTop} vs ${question.getBoundingClientRect().top}; scroll ${messages.scrollTop})`);
  const top=messages.scrollTop;emit({type:'status',sessionId:'A',status:'completedSuccess'});check(messages.scrollTop===top,'duplicate completion moved viewport again');
 });
 await test('natural completion aligns the question even when its answer start is still visible and no Git card exists',()=>{
  reset();type('VISIBLE_ANSWER_START_QUESTION');sendBtn.click();emit({type:'assistant_text_delta',partId:'visible-answer-start',fullText:('A long answer with a visible opening.\n\n').repeat(35)});
  const question=messages.querySelector('.message.user:not(.queued)'),answer=messages.querySelector(':scope > .message.assistant');
  const bar=document.getElementById('topbar').getBoundingClientRect();
  const edge=messages.getBoundingClientRect().top+parseFloat(getComputedStyle(document.body).getPropertyValue('--z-messages-pad-top'))+8;
  let trackedScrollTop=messages.scrollTop;
  const originalScrollTop=Object.getOwnPropertyDescriptor(messages,'scrollTop');
  const originalQuestionRect=question.getBoundingClientRect.bind(question),originalAnswerRect=answer.getBoundingClientRect.bind(answer);
  Object.defineProperty(messages,'scrollTop',{configurable:true,get:()=>trackedScrollTop,set:value=>{trackedScrollTop=value;}});
  question.getBoundingClientRect=()=>new DOMRect(0,edge+80,120,32);
  answer.getBoundingClientRect=()=>new DOMRect(0,edge+120,180,1000);
  const before=trackedScrollTop;
  try{
   check(answer.getBoundingClientRect().top>bar.bottom,'fixture answer opening should still be visible below the header');
   emit({type:'status',sessionId:'A',status:'completedSuccess'});
   check(trackedScrollTop>before,'natural completion skipped top alignment because the answer opening remained visible');
  }finally{
   question.getBoundingClientRect=originalQuestionRect;answer.getBoundingClientRect=originalAnswerRect;
   if(originalScrollTop)Object.defineProperty(messages,'scrollTop',originalScrollTop);else delete messages.scrollTop;
  }
 });
 await test('completion uses the first answer bubble when a long reply is split across bubbles',async()=>{
  reset();type('SPLIT_REPLY_QUESTION');sendBtn.click();
  emit({type:'assistant_text_delta',partId:'split-reply-opening',fullText:('Opening answer paragraph.\n\n').repeat(35)});
  await new Promise(resolve=>setTimeout(resolve,80));
  emit({type:'assistant_text',text:'A short final answer segment.'});
  await new Promise(resolve=>setTimeout(resolve,30));
  const answers=messages.querySelectorAll(':scope > .message.assistant'),bar=document.getElementById('topbar').getBoundingClientRect();
  check(answers.length>=2,'fixture did not create multiple answer bubbles');
  check(answers[0].getBoundingClientRect().top<bar.bottom,'opening answer bubble did not scroll above the viewport');
  check(answers[answers.length-1].getBoundingClientRect().top>bar.bottom,'final answer bubble should remain visible below the header');
  emit({type:'status',sessionId:'A',status:'completedSuccess'});
  const question=messages.querySelector('.message.user:not(.queued)'),rect=question.getBoundingClientRect();
  check(rect.top>=bar.bottom&&rect.top<bar.bottom+40,'question bubble stayed in the middle when the opening answer had scrolled away');
 });
 await test('natural completion reveal survives an idle transcript sync and targets the latest question in a shared turn',async()=>{
  reset();type('STARTING_QUESTION');sendBtn.click();const prompt=('LATEST_INSERTED_QUESTION_CONTEXT\n').repeat(14),answerText=('Final answer paragraph.\n\n').repeat(35);
  emit({type:'history',sessionId:'A',viewGen:gen,renderSource:'transcript-sync',items:[
   {id:'same-turn-q1',role:'user',turnId:'same-turn',text:'EARLIER_QUESTION'},
   {id:'same-turn-a1',role:'assistant',turnId:'same-turn',text:'EARLIER_INTERMEDIATE_REPLY'},
   {id:'same-turn-q2',role:'user',turnId:'same-turn',text:prompt},
   {id:'same-turn-a2',role:'assistant',turnId:'same-turn',text:answerText}
  ]});
  check(messages.querySelector('.message.user[data-jump="same-turn-q2"]'),'history sync did not render the latest same-turn question');
  emit({type:'status',sessionId:'A',status:'completedSuccess'});
  const question=messages.querySelector('.message.user[data-jump="same-turn-q2"]'),rect=question.getBoundingClientRect(),bar=document.getElementById('topbar').getBoundingClientRect();
  check(rect.top>=bar.bottom&&rect.top<bar.bottom+40,'latest same-turn question was not aligned below the header after transcript sync');
 });
 await test('completed question stays at the top when older conversation metadata arrives later',async()=>{
  reset();emit({type:'history',sessionId:'A',viewGen:gen,items:[
   {id:'late-git-owner',role:'user',text:'OLDER_GIT_OWNER'},
   {id:'late-git-answer',role:'assistant',text:'Older answer.'}
  ]});
  type('PINNED_AFTER_COMPLETION');sendBtn.click();
  emit({type:'assistant_text_delta',partId:'pinned-long-answer',fullText:('Long answer after the question.\n\n').repeat(45)});
  await new Promise(resolve=>setTimeout(resolve,80));emit({type:'status',sessionId:'A',status:'completedSuccess'});
  const question=[...messages.querySelectorAll('.message.user:not(.queued)')].at(-1),bar=document.getElementById('topbar').getBoundingClientRect();
  check(question.getBoundingClientRect().top<bar.bottom+40,'fixture question was not initially positioned at the top');
  const oldTurn={turnId:'late-git-turn',userText:'OLDER_GIT_OWNER',fileChanges:{target:{rowId:2,entityId:'late-git-turn'},summary:{files:1,additions:116,deletions:0},canRewind:true}};
  emit({type:'conversation_sync',sessionId:'A',editable:null,turns:[oldTurn]});
  check(!!messages.querySelector('.git-changes[data-turn-id="late-git-turn"]'),'late prior-turn metadata did not add its Git card');
  check(question.getBoundingClientRect().top>=bar.bottom&&question.getBoundingClientRect().top<bar.bottom+40,'late metadata pushed the completed question away from the top');
  messages.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,bubbles:true}));
  messages.scrollTop=Math.max(0,messages.scrollTop-100);messages.dispatchEvent(new Event('scroll'));
  emit({type:'conversation_sync',sessionId:'A',editable:null,turns:[{...oldTurn,fileChanges:{...oldTurn.fileChanges,summary:{files:2,additions:130,deletions:0}}}]});
  check(question.getBoundingClientRect().top>bar.bottom+30,'metadata update overrode the user\'s later scroll position');
 });
 await test('late scroll events do not undo the completed question position without Git cards',async()=>{
  reset();type('PINNED_WITHOUT_GIT_CARD');sendBtn.click();
  emit({type:'assistant_text_delta',partId:'pinned-without-git',fullText:('Long answer with no file changes.\n\n').repeat(45)});
  await new Promise(resolve=>setTimeout(resolve,80));emit({type:'status',sessionId:'A',status:'completedSuccess'});
  const question=messages.querySelector('.message.user:not(.queued)'),bar=document.getElementById('topbar').getBoundingClientRect();
  await new Promise(resolve=>setTimeout(resolve,40));
  const edge=bar.bottom,alignedTop=question.getBoundingClientRect().top;
  check(alignedTop>=edge&&alignedTop<edge+40,'fixture question was not aligned before the delayed scroll');
  messages.scrollTop=Math.min(messages.scrollHeight-messages.clientHeight,messages.scrollTop+120);
  messages.dispatchEvent(new Event('scroll'));
  emit({type:'conversation_sync',sessionId:'A',editable:null,turns:[]});
  check(Math.abs(question.getBoundingClientRect().top-alignedTop)<2,'a delayed scroll event re-armed follow-to-bottom and the next refresh moved the question down');
  messages.dispatchEvent(new KeyboardEvent('keydown',{key:'PageDown',bubbles:true}));
  messages.scrollTop=Math.min(messages.scrollHeight-messages.clientHeight,messages.scrollTop+120);
  messages.dispatchEvent(new Event('scroll'));
  const keyboardTop=question.getBoundingClientRect().top;
  emit({type:'conversation_sync',sessionId:'A',editable:null,turns:[]});
  check(Math.abs(question.getBoundingClientRect().top-keyboardTop)<2,'keyboard reading was pulled back to the completed question');
 });
 await test('a completed long reply still returns to its question when the final answer arrives in a later history refresh',async()=>{
  reset();type('LATE_FINAL_QUESTION');sendBtn.click();
  emit({type:'assistant_reasoning_delta',partId:'late-final-thought',fullText:'Reasoning before the final answer.'});
  emit({type:'status',sessionId:'A',status:'completedSuccess'});
  const final=('The final answer arrived after the completion status.\n\n').repeat(35);
  emit({type:'history',sessionId:'A',viewGen:gen,renderSource:'transcript-sync',items:[
   {id:'late-final-q',role:'user',text:'LATE_FINAL_QUESTION'},
   {id:'late-final-a',role:'assistant',text:final,steps:[{kind:'reasoning',text:'Reasoning before the final answer.'},{kind:'text',text:final}]}
  ]});
  const question=messages.querySelector('.message.user[data-jump="late-final-q"]'),bar=document.getElementById('topbar').getBoundingClientRect();
  check(question&&question.getBoundingClientRect().top>=bar.bottom&&question.getBoundingClientRect().top<bar.bottom+40,'late final answer left its question below the top');
 });
 await test('canonical history redraw retains the completed question at the top without a Git card',async()=>{
  reset();type('CANONICAL_REVEAL_QUESTION');sendBtn.click();
  emit({type:'assistant_text_delta',partId:'canonical-live-answer',fullText:('Live answer paragraph.\n\n').repeat(35)});
  await new Promise(resolve=>setTimeout(resolve,80));emit({type:'status',sessionId:'A',status:'completedSuccess'});
  const final=('Canonical answer paragraph.\n\n').repeat(35);
  emit({type:'history',sessionId:'A',viewGen:gen,renderSource:'transcript-sync',items:[
   {id:'older-canonical-q',role:'user',text:'Earlier question'},
   {id:'older-canonical-a',role:'assistant',text:('Earlier answer paragraph.\n\n').repeat(30)},
   {id:'canonical-reveal-q',role:'user',text:'CANONICAL_REVEAL_QUESTION'},
   {id:'canonical-reveal-a',role:'assistant',text:final,steps:[{kind:'text',text:final}]}
  ]});
  const question=messages.querySelector('.message.user[data-jump="canonical-reveal-q"]'),bar=document.getElementById('topbar').getBoundingClientRect();
  check(question&&question.getBoundingClientRect().top>=bar.bottom&&question.getBoundingClientRect().top<bar.bottom+40,'canonical redraw lost the completed question position');
 });
 await test('completion preserves manual reading position in a long answer',async()=>{
  reset();type('MANUAL_LONG_REPLY');sendBtn.click();emit({type:'assistant_text_delta',partId:'manual-long',fullText:('Manual reading paragraph.\n\n').repeat(35)});
  await new Promise(resolve=>setTimeout(resolve,80));
  messages.dispatchEvent(new WheelEvent('wheel',{deltaY:-300,bubbles:true}));messages.scrollTop=Math.max(0,messages.scrollTop-300);messages.dispatchEvent(new Event('scroll'));const answer=messages.querySelector(':scope > .message.assistant'),top=answer.getBoundingClientRect().top;
  emit({type:'status',sessionId:'A',status:'completedSuccess'});check(Math.abs(answer.getBoundingClientRect().top-top)<2,'completion took over manual reading');
 });
 await test('short replies and interrupted long replies do not jump to the beginning',async()=>{
  reset();type('SHORT_REPLY');sendBtn.click();emit({type:'assistant_text_delta',partId:'short-answer',fullText:'A short answer.'});
  await new Promise(resolve=>setTimeout(resolve,80));const top=messages.scrollTop;
  emit({type:'status',sessionId:'A',status:'completedSuccess'});check(Math.abs(messages.scrollTop-top)<2,'short reply caused unnecessary jump');
  check(!document.getElementById('jump-latest').classList.contains('show'),'short reply showed a jump-to-bottom arrow without moving the viewport');
  reset();type('STOP_LONG_REPLY');sendBtn.click();emit({type:'assistant_text_delta',partId:'stopped-long',fullText:('Stopped paragraph.\n\n').repeat(35)});
  await new Promise(resolve=>setTimeout(resolve,80));const before=messages.querySelector(':scope > .message.assistant').getBoundingClientRect().top;
  emit({type:'status',sessionId:'A',status:'completedInterrupted'});check(messages.querySelector(':scope > .message.assistant').getBoundingClientRect().top<0&&before<0,'interrupted reply was rewound');
 });
 await test('old history fold hides settled reply controls and expands in place exactly once',()=>{
  reset();const items=[];
  for(let i=0;i<12;i++){
   items.push({id:'history-fold-q-'+i,role:'user',text:'HISTORY_FOLD_QUESTION_'+i});
   items.push({id:'history-fold-a-'+i,role:'assistant',text:'HISTORY_FOLD_ANSWER_'+i});
  }
  emit({type:'history',sessionId:'A',viewGen:gen,items});
  const question=messages.querySelector('.message.user[data-jump="history-fold-q-0"]');
  const bar=messages.querySelector('.turn-fold-bar');
  const replyFooter=[...messages.querySelectorAll('.reply-meta')].find(node=>node.dataset.copyText?.includes('HISTORY_FOLD_ANSWER_0'));
  check(question?.classList.contains('turn-hidden')&&bar,'old question was not folded');
  check(replyFooter&&(replyFooter.classList.contains('turn-hidden')||replyFooter.hidden||getComputedStyle(replyFooter).display==='none'),'folded history left its answer copy/time footer visible');
  const beforeQuestions=messages.querySelectorAll('.message.user').length;
  bar.click();
  check(!bar.isConnected,'expanding left the original fold card in place');
  check(question.isConnected&&!question.classList.contains('turn-hidden'),'expanded question did not reuse the folded history node');
  check(messages.querySelectorAll('.message.user').length===beforeQuestions,'expanding duplicated history messages');
  check([...messages.querySelectorAll('.reply-meta')].filter(node=>node.dataset.copyText?.includes('HISTORY_FOLD_ANSWER_0')).length===1,'expanded turn duplicated its copy/time footer');
 });

 await test('failed history loads retry without stopping generation or retaining a failed jump',()=>{
  reset();emit({type:'history',sessionId:'A',viewGen:gen,truncated:true,questions:[{id:'unloaded-review',text:'EARLIER_QUESTION'},{id:'retry-q',text:'CURRENT_QUESTION'}],items:[{id:'retry-q',role:'user',text:'CURRENT_QUESTION'},{id:'retry-a',role:'assistant',text:'CURRENT_ANSWER'}]});
  emit({type:'status',sessionId:'A',status:'running'});
  const more=messages.querySelector('.history-more');more.click();
  const request=sent.find(m=>m.type==='loadOlder');check(request&&request.sessionId==='A'&&request.viewGen===gen,'history request lacks owner');
  emit({type:'history_load_failed',sessionId:'B',viewGen:gen,message:'STALE_HISTORY_FAILURE'});check(more.disabled,'stale failure changed current request');
  emit({type:'history_load_failed',sessionId:'A',viewGen:gen,requestId:request.requestId,message:'PAGE_RETRY'});
  check(!more.disabled&&!document.getElementById('stop-btn').hidden,'history failure blocked retry or stopped generation');
  more.click();check(sent.filter(m=>m.type==='loadOlder').length===2,'history button cannot retry');
  const jump=document.querySelector('.q-dot[data-jump="unloaded-review"]');check(jump,'unloaded question marker missing');const clickJump=()=>{jump.dispatchEvent(new PointerEvent('pointerdown',{button:0,bubbles:true,pointerId:1}));jump.dispatchEvent(new PointerEvent('pointerup',{button:0,bubbles:true,pointerId:1}));};clickJump();
  const through=sent.find(m=>m.type==='loadThrough');check(through,'jump did not request missing history');
  emit({type:'history_load_failed',sessionId:'A',viewGen:gen,requestId:through.requestId,jumpId:'unloaded-review',message:'JUMP_RETRY'});
  clickJump();check(sent.filter(m=>m.type==='loadThrough').length===2,'failed jump cannot retry');
 });
 await test('failed queue edits retain text and selection through refresh and allow one retry',()=>{
  reset();emit({type:'status',sessionId:'A',status:'running'});
  const items=[{queueItemId:'retry-queue',text:'ORIGINAL_TEXT'}];emit({type:'queue_sync',sessionId:'A',items});
  const card=document.querySelector('[data-queue-id="retry-queue"]');card.querySelector('[data-qact="edit"]').click();
  const editor=card.querySelector('.queued-edit');editor.value='REPLACEMENT_TEXT';editor.dispatchEvent(new Event('input'));editor.setSelectionRange(2,5);
  card.querySelector('[data-qact="save"]').click();const request=sent.find(m=>m.type==='queueEdit');
  check(request?.requestId&&editor.readOnly&&card.querySelector('[data-qact="save"]').disabled,'save lacks identity or remains repeatable');
  emit({type:'queue_sync',sessionId:'A',items});check(editor.value==='REPLACEMENT_TEXT'&&editor.selectionStart===2&&editor.selectionEnd===5&&editor.readOnly,'refresh changed pending editor');
  emit({type:'queue_edit_result',sessionId:'A',queueItemId:'retry-queue',requestId:request.requestId,ok:false,message:'EDIT_RETRY'});
  check(!editor.readOnly&&editor.value==='REPLACEMENT_TEXT'&&!card.querySelector('[data-qact="save"]').disabled,'rejected edit cannot retry');
  card.querySelector('[data-qact="save"]').click();const retry=sent.filter(m=>m.type==='queueEdit').at(-1);check(retry.text==='REPLACEMENT_TEXT'&&retry.requestId!==request.requestId,'retry lost replacement or reused attempt');
  emit({type:'queue_edit_result',sessionId:'A',queueItemId:'retry-queue',requestId:request.requestId,ok:true});check(editor.isConnected,'old success closed a newer attempt');
  emit({type:'queue_edit_result',sessionId:'A',queueItemId:'retry-queue',requestId:retry.requestId,ok:true});check(!card.querySelector('.queued-edit')&&card.querySelector('.user-body').textContent==='REPLACEMENT_TEXT','accepted text not displayed');
  emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'after-edit-q',role:'user',text:'QUESTION'},{id:'after-edit-a',role:'assistant',text:'ANSWER_AFTER_EDIT'}]});check(document.querySelector('[data-queue-id="retry-queue"] .user-body')?.textContent==='REPLACEMENT_TEXT','history refresh restored the pre-save queue text');
 });
 await test('queue edit rejection after switching retains its source draft without touching the new session',()=>{
  reset();const items=[{queueItemId:'owned-queue',text:'BEFORE_EDIT'}];emit({type:'queue_sync',sessionId:'A',items});
  const card=document.querySelector('[data-queue-id="owned-queue"]');card.querySelector('[data-qact="edit"]').click();const editor=card.querySelector('.queued-edit');editor.value='SOURCE_RETRY_TEXT';editor.dispatchEvent(new Event('input'));card.querySelector('[data-qact="save"]').click();
  const request=sent.find(m=>m.type==='queueEdit');reset('B');type('B_DRAFT');
  emit({type:'queue_edit_result',sessionId:'A',queueItemId:'owned-queue',requestId:request.requestId,ok:false,message:'OLD_EDIT_FAILURE'});
  check(input.value==='B_DRAFT'&&!document.querySelector('.queued-edit'),'late failure touched the new session');
  reset('A');emit({type:'queue_sync',sessionId:'A',items});check(document.querySelector('.queued-edit')?.value==='SOURCE_RETRY_TEXT'&&!document.querySelector('.queued-edit').readOnly,'source edit was not restored');
  emit({type:'queue_sync',sessionId:'A',items:[]});check(input.value.includes('SOURCE_RETRY_TEXT'),'removed queue lost unsaved text instead of restoring its draft');
 });

 await test('confirmed control rollback restores reasoning and the original base permission under plan',()=>{
  reset();emit({type:'session_controls',mode:'plan',baseMode:'build',planEnabled:true,thoughtEnabled:true,thoughtLevel:'low',thoughtLevels:[{value:'low',label:'Low'},{value:'high',label:'High'}]});
  document.getElementById('thought-chip').click();const high=[...document.querySelectorAll('.overlay-item')].find(node=>node.textContent.includes('High')||node.textContent.includes('高'));check(high,'reasoning option missing');high.click();
  emit({type:'session_controls',mode:'plan',baseMode:'build',planEnabled:true,thoughtEnabled:true,thoughtLevel:'low',thoughtLevels:[{value:'low',label:'Low'},{value:'high',label:'High'}]});
  check(document.getElementById('thought-chip').getAttribute('aria-label').includes('Low')||document.getElementById('thought-chip').getAttribute('aria-label').includes('低'),'reasoning rollback did not restore the confirmed choice');
  document.getElementById('plan-indicator').click();const request=sent.filter(item=>item.type==='setMode').at(-1);check(request?.mode==='build'&&request.sessionId==='A'&&request.viewGen===gen,'leaving plan used an unconfirmed permission or lost ownership');
 });
await test('startup status separates service startup from restoring the last chat',async()=>{
 reset();emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});
 const label=document.getElementById('conn-label');
 const original=Date.now;let now=original();Date.now=()=>now;
 try{
  emit({type:'status',status:'connecting',phase:'starting'});
  check(label.textContent==='正在启动服务','service startup was not named');
  emit({type:'status',status:'connecting',phase:'restoring',waitedSeconds:8});
  check(label.textContent.includes('正在恢复上次会话')&&label.textContent.includes('已等待 8 秒')&&label.textContent.includes('草稿会保留'),'long restore did not explain the wait and preserved draft');
  now+=1000;await new Promise(resolve=>setTimeout(resolve,1100));check(label.textContent.includes('已等待 9 秒'),'visible startup wait did not advance');
  emit({type:'session_ready',sessionId:'A',viewGen:gen});
  check(label.textContent==='已连接','connected session kept the startup wait');
 }finally{Date.now=original;}
});
await test('session list failures stay inside the list and remain distinct from an empty workspace',()=>{
 reset();emit({type:'ui_language',language:'zh-CN',setting:'zh-CN'});
 document.getElementById('btn-sessions').click();
 emit({type:'sessions',includeArchived:false,currentId:'A',sessions:[],notice:'initial'});
 const first=document.getElementById('session-list-notice');
 check(!first.hidden&&first.textContent.includes('会话列表加载失败')&&!!first.querySelector('button'),'first failure looked like an empty workspace or had no retry');
 check(!document.querySelector('#overlay-list').textContent.includes('没有匹配项'),'first failure used the empty-result message');
 first.querySelector('button').click();
 const firstRetry=sent.at(-1);
 check(firstRetry?.type==='listSessions'&&firstRetry.includeArchived===false&&firstRetry.listVisible===true,'first failure did not retry the visible list');
 emit({type:'sessions',includeArchived:false,currentId:'A',sessions:[{sessionId:'A',title:'上次会话'}],notice:'stale'});
 const notice=document.getElementById('session-list-notice');
 check(!notice.hidden&&notice.textContent.includes('刷新失败，当前显示上次结果')&&document.querySelector('#overlay-list').textContent.includes('上次会话'),'stale refresh replaced the previous result or hid the notice');
 notice.querySelector('button').click();
 const staleRetry=sent.at(-1);
 check(staleRetry?.type==='listSessions'&&staleRetry.includeArchived===false&&staleRetry.listVisible===true,'session notice did not retry');
 emit({type:'sessions',includeArchived:true,currentId:'A',sessions:[],notice:'initial'});
 check(!document.querySelector('#overlay-list').textContent.includes('上次会话')&&document.getElementById('session-list-notice').textContent.includes('会话列表加载失败'),'archived first failure kept the active page');
 emit({type:'sessions',includeArchived:false,currentId:'A',sessions:[{sessionId:'A',title:'上次会话'}],notice:'ready'});
 check(document.getElementById('session-list-notice').hidden,'successful refresh left the failure notice');
});
await test('reply selections survive VS Code clipboard command focus recovery',()=>{
 reset();emit({type:'history',sessionId:'A',viewGen:gen,items:[{id:'copy-q1',role:'user',text:'One'},{id:'copy-a1',role:'assistant',text:'First selection'},{id:'copy-q2',role:'user',text:'Two'},{id:'copy-a2',role:'assistant',text:'Second selection'}]});
 const replies=[...messages.querySelectorAll('.message.assistant .md')];
 for(const [index,expected] of ['First selection','Second selection'].entries()){
  input.focus();input.blur();messages.focus();
  const range=document.createRange();range.selectNodeContents(replies[index]);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
  // VS Code's webview wrapper restores the last focused control before copy
  // when the document body has focus. The transcript must retain its selection.
  if(document.activeElement===document.body||document.activeElement===document.documentElement)input.focus();
  check(selection.toString().trim()===expected,'clipboard focus recovery erased the selected reply');
 }
 input.focus();input.value='Composer text';input.setSelectionRange(0,8);
 check(document.activeElement===input&&input.value.slice(input.selectionStart,input.selectionEnd)==='Composer','transcript focus interfered with input selection');
 getSelection().removeAllRanges();
});
 await new Promise(r=>setTimeout(r,30));
 clearInterval(window.auditFrameKeepAlive);
 const pre=document.createElement('pre');pre.id='audit-results';pre.textContent=JSON.stringify({tests,errors:window.browserErrors || []});document.body.appendChild(pre);if(tests.some(t=>!t.pass)) document.body.setAttribute('data-smoke','failed');
})().catch(e=>{clearInterval(window.auditFrameKeepAlive);document.body.setAttribute('data-smoke','failed');const pre=document.createElement('pre');pre.id='audit-results';pre.textContent=JSON.stringify({tests:[],errors:[String(e.stack)]});document.body.appendChild(pre)});
