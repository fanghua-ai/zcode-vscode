import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

// Real time is needed for FileReader and raster decoding. No credentials or live server.
const root = await mkdtemp(path.join(tmpdir(), "zcode-browser-attachments-"));
let chrome, socket;
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
try {
  const modulePath = path.join(root, "html.cjs");
  await build({ entryPoints: ["src/webviewHtml.ts"], outfile: modulePath, bundle: true,
    platform: "node", format: "cjs", alias: { vscode: path.resolve("src/testSupport/vscode.ts") } });
  const { getWebviewHtml } = createRequire(import.meta.url)(modulePath);
  let html = getWebviewHtml({ cspSource: "file:", asWebviewUri: uri => uri }, pathToFileURL(process.cwd()).href, "attachments");
  const start = html.indexOf("<script");
  html = html.slice(0, start) + `<script nonce="attachments">
    window.sent=[];window.savedState={};window.errors=[];
    window.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>savedState,setState:s=>savedState=s});
    window.addEventListener('error',e=>errors.push(e.message));
    window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
  </script>` + html.slice(start);
  const file = path.join(root, "attachments.html");
  await writeFile(file, html);
  chrome = spawn(process.env.CHROME_BIN || "google-chrome", ["--headless", "--no-sandbox", "--disable-gpu",
    "--disable-background-networking", "--no-first-run", "--remote-debugging-port=0",
    `--user-data-dir=${path.join(root, "profile")}`, pathToFileURL(file).href], { stdio: ["ignore", "ignore", "pipe"] });
  const endpoint = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Browser did not start")), 10000);
    chrome.once("error", error => { clearTimeout(timer); reject(error); });
    chrome.stderr.on("data", data => {
      output += data;
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  const port = new URL(endpoint).port;
  let target;
  for (let attempt = 0; attempt < 50 && !target; attempt++) {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = pages.find(page => page.type === "page" && page.url === pathToFileURL(file).href);
    if (!target) await pause(100);
  }
  assert.ok(target, "Attachment page missing");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let next = 0;
  const pending = new Map();
  socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data));
    const slot = pending.get(message.id);
    if (!slot) return;
    clearTimeout(slot.timer); pending.delete(message.id);
    if (message.error) slot.reject(new Error(JSON.stringify(message.error)));
    else slot.resolve(message.result);
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await rpc("Runtime.enable");
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await rpc("Runtime.evaluate", { expression: "document.readyState === 'complete' && window.sent.some(m=>m.type==='ready')", returnByValue: true });
    if (result.result.value) break;
    if (attempt === 99) throw new Error("Webview did not become ready");
    await pause(50);
  }
  const result = await rpc("Runtime.evaluate", { awaitPromise: true, returnByValue: true, expression: `(async()=>{
    let checks=0;const check=(c,m)=>{if(!c)throw new Error(m);checks++;};
    const emit=data=>window.dispatchEvent(new MessageEvent('message',{data}));
    let gen=1;const ready=id=>{emit({type:'view_reset',clear:true,viewGen:++gen});emit({type:'session_ready',sessionId:id,viewGen:gen});emit({type:'history',sessionId:id,viewGen:gen,items:[]});emit({type:'stream_release'});};
    const wait=async predicate=>{const end=Date.now()+3000;while(!predicate()){if(Date.now()>end)throw new Error('Attachment operation timed out');await new Promise(r=>setTimeout(r,20));}};
    const input=document.getElementById('input');const send=document.getElementById('send-btn');
    const png='iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGMM6LnDgA0wYRUdtBIAWtsByEY277MAAAAASUVORK5CYII=';
    const data=atob(png);const bytes=Uint8Array.from(data,c=>c.charCodeAt(0));
    ready('paste-A');
    const transfer=new DataTransfer();transfer.items.add(new File([bytes],'paste.png',{type:'image/png'}));transfer.setData('text/plain','caption');
    const event=new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true});input.dispatchEvent(event);
    check(event.defaultPrevented,'paste did not attach image');ready('paste-B');
    await wait(()=>sent.some(m=>m.type==='uploadImage'));
    const request=sent.find(m=>m.type==='uploadImage');
    check(request.sessionId==='paste-A','paste owner changed');check(request.dataUrl==='data:image/png;base64,'+png,'paste bytes changed');
    const attachment={ref:'pasted-ref',fileName:'paste.png',mime:'image/png',bytes:bytes.length};
    emit({type:'image_ready',sessionId:'paste-A',imageId:request.imageId,attachment});
    check(!document.querySelector('#image-drafts .image-chip'),'A image appeared in B');ready('paste-A');
    check(input.value==='caption','mixed paste lost its caption');
    await wait(()=>document.querySelector('#image-drafts img')?.naturalWidth>0);
    check(savedState.composerDrafts['paste-A'].images[0].thumbnail.length<65536,'thumbnail is unbounded');
    const tile=document.querySelector('#image-drafts .image-chip').getBoundingClientRect();check(tile.width===tile.height&&tile.width===64,'composer image is not a square thumbnail');
    const previewButton=document.querySelector('#image-drafts .image-preview-btn');previewButton.focus();previewButton.click();
    check(!sent.some(message=>message.type==='previewImage'),'unsent draft preview depended on unauthorized backend read');
    await wait(()=>document.querySelector('#image-preview img')?.naturalWidth===8);
    check(document.querySelector('#image-preview img').src==='data:image/png;base64,'+png,'preview used thumbnail instead of original');
    document.querySelector('#image-preview button').click();
    check(!document.getElementById('image-preview')&&document.activeElement===previewButton,'preview close failed to restore focus');
    check(input.value==='caption'&&savedState.composerDrafts['paste-A'].images[0].ref==='pasted-ref','preview changed draft');

    input.value='';input.dispatchEvent(new Event('input'));send.click();
    const sending=sent.find(m=>m.type==='send');check(sending&&sending.attachments[0].ref==='pasted-ref'&&sending.text==='','image-only send failed');
    check(!document.querySelector('#image-drafts .image-chip'),'sent attachment remained');
    await wait(()=>document.querySelector('.user-images img')?.naturalWidth>0);
    const sentTile=document.querySelector('.user-images .image-chip').getBoundingClientRect();check(sentTile.width===80&&sentTile.height===80,'sent image is not a square thumbnail');
    ready('paste-B');emit({type:'send_rejected',sessionId:'paste-A',commandId:sending.commandId,text:'',message:'rejected'});
    check(!document.querySelector('#image-drafts .image-chip'),'late rejection affected B');ready('paste-A');
    check(savedState.composerDrafts['paste-A'].images[0].ref==='pasted-ref','late rejection lost A image');
    document.querySelector('#image-drafts .image-remove').click();
    const corrupted=new DataTransfer();corrupted.items.add(new File([new Uint8Array([137,80,78,71,13,10,26,10])],'broken.png',{type:'image/png'}));
    const uploads=sent.filter(m=>m.type==='uploadImage').length;
    input.dispatchEvent(new ClipboardEvent('paste',{clipboardData:corrupted,bubbles:true,cancelable:true}));
    await wait(()=>savedState.composerDrafts['paste-A'].images?.[0]?.status==='error');
    check(sent.filter(m=>m.type==='uploadImage').length===uploads,'corrupt image reached server');
    document.querySelector('#image-drafts .image-remove').click();
    emit({type:'image_pending',sessionId:'paste-A',imageId:'native',fileName:'native.png',mime:'image/png',bytes:bytes.length});
    emit({type:'image_ready',sessionId:'paste-A',imageId:'native',attachment:{...attachment,fileName:'native.png'},dataUrl:'data:image/png;base64,'+png});
    await wait(()=>savedState.composerDrafts['paste-A'].images?.[0]?.status==='ready');
    check(!!document.querySelector('#image-drafts img'),'native image lacks thumbnail');
    document.querySelector('#image-drafts .image-remove').click();
    const sharp=document.createElement('canvas');sharp.width=640;sharp.height=320;
    const paint=sharp.getContext('2d');paint.fillStyle='#ffffff';paint.fillRect(0,0,640,320);paint.fillStyle='#252525';paint.font='24px sans-serif';paint.fillText('Sharper screenshot text',24,48);
    const sharpData=sharp.toDataURL('image/png');
    emit({type:'image_pending',sessionId:'paste-A',imageId:'sharp',fileName:'sharp.png',mime:'image/png',bytes:100});
    emit({type:'image_ready',sessionId:'paste-A',imageId:'sharp',attachment:{...attachment,ref:'sharp-ref'},dataUrl:sharpData});
    await wait(()=>document.querySelector('#image-drafts img')?.naturalWidth===320);
    check(document.querySelector('#image-drafts img').naturalHeight===160,'sharp thumbnail changed aspect ratio');
    const sharpTile=document.querySelector('#image-drafts .image-chip').getBoundingClientRect();check(sharpTile.width===64&&sharpTile.height===64,'higher resolution enlarged the composer tile');
    check(savedState.composerDrafts['paste-A'].images[0].thumbnail.length<=65536,'sharp thumbnail exceeded draft limit');
    document.querySelector('#image-drafts .image-remove').click();
    const dense=document.createElement('canvas');dense.width=dense.height=1024;
    const pixels=dense.getContext('2d').createImageData(1024,1024);let seed=42;
    for(let index=0;index<pixels.data.length;index+=4){seed=(Math.imul(seed,1664525)+1013904223)>>>0;pixels.data[index]=seed&255;pixels.data[index+1]=(seed>>>8)&255;pixels.data[index+2]=(seed>>>16)&255;pixels.data[index+3]=255;}
    dense.getContext('2d').putImageData(pixels,0,0);
    emit({type:'image_pending',sessionId:'paste-A',imageId:'dense',fileName:'dense.png',mime:'image/png',bytes:100});
    emit({type:'image_ready',sessionId:'paste-A',imageId:'dense',attachment:{...attachment,ref:'dense-ref'},dataUrl:dense.toDataURL('image/png')});
    await wait(()=>savedState.composerDrafts['paste-A'].images[0]?.status==='ready'&&document.querySelector('#image-drafts img')?.naturalWidth>0);
    check(savedState.composerDrafts['paste-A'].images[0].thumbnail.length<=65536,'dense thumbnail exceeded draft limit');
    check(document.querySelector('#image-drafts img').naturalWidth<=320,'dense image was not downscaled');
    document.querySelector('#image-drafts .image-remove').click();
    const drop=new DataTransfer();drop.setData('text/uri-list','file:///project/a%20%231.ts');
    input.dispatchEvent(new DragEvent('drop',{dataTransfer:drop,bubbles:true,cancelable:true}));
    check(sent.some(m=>m.type==='attachFileUris'&&m.sessionId==='paste-A'&&m.uris[0]==='file:///project/a%20%231.ts'),'file drag lost path or owner');
    ready('image-history');
    emit({type:'history',sessionId:'image-history',viewGen:gen,items:[{id:'image-question',role:'user',text:'QUESTION_BELOW_IMAGES',attachments:[{...attachment,ref:'history-ref'},{...attachment,ref:'history-ref-2'}],attachmentTarget:{rowId:7,entityId:'image-question'}}]});
    await wait(()=>sent.some(message=>message.type==='thumbnailImage'&&message.sessionId==='image-history'));
    await wait(()=>sent.filter(message=>message.type==='thumbnailImage'&&message.sessionId==='image-history').length===2);
    for(const request of sent.filter(message=>message.type==='thumbnailImage'&&message.sessionId==='image-history')){
      check(request.rowId===7&&request.entityId==='image-question','history thumbnail lost authorization target');
      emit({type:'image_thumbnail',requestId:request.requestId,dataUrl:'data:image/png;base64,'+png});
    }
    await wait(()=>[...document.querySelectorAll('.user-images img')].length===2&&[...document.querySelectorAll('.user-images img')].every(image=>image.naturalWidth>0));
    const row=document.querySelector('.user-images'),question=document.querySelector('.message.user .user-body');
    check(row.nextElementSibling===question&&question.textContent==='QUESTION_BELOW_IMAGES','question does not follow image row');
    check(row.querySelectorAll('button').length===2,'multiple images not grouped into one row');
    check(errors.length===0,'browser errors: '+errors.join(','));return {checks};
  })()` });
  assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description);
  assert.ok(result.result.value.checks >= 14);
  console.log(`Browser attachment operations passed with real FileReader and decoding: ${result.result.value.checks} checks.`);
} finally {
  socket?.close();
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise(resolve => chrome.once("exit", resolve));
    chrome.kill("SIGTERM");
    await Promise.race([exited, pause(2000)]);
    if (chrome.exitCode === null) { chrome.kill("SIGKILL"); await Promise.race([exited,pause(2000)]); }
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
