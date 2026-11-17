import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

// Reload the actual built webview with a persistent mock VS Code
// state bridge. No live account, conversation database, or app-server is used.
const root = await mkdtemp(path.join(tmpdir(), "zcode-draft-reload-"));
try {
  const modulePath = path.join(root, "html.cjs");
  await build({ entryPoints: ["src/webviewHtml.ts"], outfile: modulePath, bundle: true,
    platform: "node", format: "cjs", alias: { vscode: path.resolve("src/testSupport/vscode.ts") } });
  const { getWebviewHtml } = createRequire(import.meta.url)(modulePath);
  let html = getWebviewHtml({ cspSource: "file:", asWebviewUri: uri => uri }, pathToFileURL(process.cwd()).href, "reload");
  const start = html.indexOf("<script");
  html = html.slice(0, start) + `<script nonce="reload">
    window.sent=[];
    window.savedState=JSON.parse(sessionStorage.getItem('draft-state')||'{}');
    window.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>savedState,setState:s=>{savedState=s;sessionStorage.setItem('draft-state',JSON.stringify(s));}});
    window.errors=[];
    window.addEventListener('error',e=>errors.push(e.message));
    window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
  </script>` + html.slice(start);
  html = html.replace("</body>", `<script nonce="reload">
    try {
      let count=Number(sessionStorage.getItem('checks')||0);
      const check=(c,m)=>{if(!c)throw new Error(m);count++;sessionStorage.setItem('checks',String(count));};
      const emit=data=>window.dispatchEvent(new MessageEvent('message',{data}));
      const input=document.getElementById('input');
      const type=text=>{input.value=text;input.dispatchEvent(new Event('input'));};
      const ready=(id,gen)=>{emit({type:'session_ready',sessionId:id,viewGen:gen});emit({type:'history',sessionId:id,viewGen:gen,items:[]});};
      const change=(id,gen)=>{emit({type:'view_reset',viewGen:gen});ready(id,gen);};
      const phase=Number(sessionStorage.getItem('phase')||0);
      const reload=next=>{check(errors.length===0,'browser errors before reload');sessionStorage.setItem('phase',String(next));location.reload();};
      if(phase===0){
        ready('reload-A',1);type('A draft with 哈哈');
        emit({type:'image_pending',sessionId:'reload-A',imageId:'reload-image',fileName:'image.png',mime:'image/png',bytes:100});
        emit({type:'image_ready',sessionId:'reload-A',imageId:'reload-image',attachment:{ref:'reload-ref',fileName:'image.png',mime:'image/png',bytes:100}});
        emit({type:'addChip',chip:{path:'/project/a.ts',relPath:'a.ts',selectedText:'A selected context'}});
        change('reload-B',2);check(input.value==='','A text leaked into B');
        type('B retained draft');emit({type:'addChip',chip:{path:'/project/b.ts',relPath:'b.ts',selectedText:'B selected context'}});
        reload(1);
      }else if(phase===1){
        check(input.value==='B retained draft','B draft not restored on startup');ready('reload-B',1);
        check(document.getElementById('attachments').textContent.includes('b.ts'),'B reference lost on reload');
        change('reload-A',2);check(input.value==='A draft with 哈哈','A draft lost across reload and switch');
        check(document.getElementById('attachments').textContent.includes('a.ts'),'A reference lost');
        check(document.querySelector('#image-drafts .image-chip'),'image draft lost on reload');
        document.getElementById('send-btn').click();const request=sent.find(m=>m.type==='send');
        check(request.chips[0].selectedText==='A selected context','sent selection changed');
        check(request.attachments[0].ref==='reload-ref','sent image lost');
        sessionStorage.setItem('request',JSON.stringify(request));check(input.value==='','sent draft not cleared');
        reload(2);
      }else if(phase===2){
        ready('reload-A',1);check(input.value==='','already submitted draft resurrected');
        check(!document.querySelector('#attachments .ctx-chip'),'submitted reference resurrected after reload');
        type('Newer A typing');const request=JSON.parse(sessionStorage.getItem('request'));
        change('reload-B',2);check(input.value==='B retained draft','B draft changed after A send');
        emit({type:'send_rejected',commandId:request.commandId,sessionId:'reload-A',text:request.text,chips:request.chips,attachments:request.attachments,message:'Rejected after reload'});
        check(input.value==='B retained draft','late failure changed active B draft');
        check(savedState.composerDrafts['reload-A'].text==='Newer A typing\\n\\nA draft with 哈哈','failure overwrote newer A typing');
        reload(3);
      }else if(phase===3){
        ready('reload-B',1);check(input.value==='B retained draft','B draft lost after third reload');
        change('reload-A',2);check(input.value==='Newer A typing\\n\\nA draft with 哈哈','recovered draft lost after reload');
        check(savedState.composerDrafts['reload-A'].chips.length===1,'recovery duplicated references');
        check(savedState.composerDrafts['reload-A'].images[0].ref==='reload-ref','late rejection lost image after real reload');
        document.getElementById('send-btn').click();const request=sent.find(m=>m.type==='send');
        check(request.attachments[0].ref==='reload-ref','test send did not include the recovered image');
        type('A text typed after sending');
        change('reload-B',3);
        emit({type:'send_unconfirmed',commandId:request.commandId,sessionId:'reload-A',running:false});
        sessionStorage.setItem('request',JSON.stringify(request));
        check(input.value==='B retained draft'&&document.getElementById('unconfirmed-sends').hidden,'unconfirmed A send appeared in B');
        reload(4);
      }else{
        ready('reload-B',1);
        check(document.getElementById('unconfirmed-sends').hidden,'unconfirmed A send appeared in B on reload');
        change('reload-A',2);
        check(input.value==='A text typed after sending','unconfirmed send was automatically restored into the composer');
        const panel=document.getElementById('unconfirmed-sends');
        check(!panel.hidden,'unconfirmed A send lost on reload');
        panel.open=true;
        const restore=panel.querySelector('button[data-action="restore"]');
        restore.click();restore.click();
        check(input.value==='A text typed after sending\\n\\nNewer A typing\\n\\nA draft with 哈哈','restore lost or duplicated text');
        check(savedState.composerDrafts['reload-A'].chips.length===1,'unconfirmed restore lost selection');
        check(savedState.composerDrafts['reload-A'].images[0].ref==='reload-ref','unconfirmed restore lost image');
        check(panel.hidden&&!sent.some(m=>m.type==='send'||m.type==='retryLast'),'restoring an unconfirmed send sent it again');
        const original=JSON.parse(sessionStorage.getItem('request'));
        emit({type:'send_rejected',commandId:original.commandId,sessionId:'reload-A',text:original.text,attachments:original.attachments});
        check(input.value==='A text typed after sending\\n\\nNewer A typing\\n\\nA draft with 哈哈','late rejection restored the same content twice');
        document.getElementById('send-btn').click();const accepted=sent.find(m=>m.type==='send');
        emit({type:'send_admitted',commandId:accepted.commandId,sessionId:'reload-A'});
        check(Object.keys(savedState.submittedDrafts).length===0,'confirmed send left a recovery copy');
        check(errors.length===0,'browser errors');
        const pre=document.createElement('pre');pre.id='reload-results';pre.textContent=JSON.stringify({pass:true,checks:count});document.body.appendChild(pre);
      }
    }catch(e){const pre=document.createElement('pre');pre.id='reload-results';pre.textContent=JSON.stringify({pass:false,error:String(e.stack)});document.body.appendChild(pre);}
  </script></body>`);
  const file = path.join(root, "reload.html");
  await writeFile(file, html);
  const result = spawnSync(process.env.CHROME_BIN || "google-chrome", ["--headless", "--no-sandbox", "--disable-gpu",
    "--disable-background-networking", "--no-first-run", `--user-data-dir=${path.join(root, "profile")}`,
    "--virtual-time-budget=10000", "--dump-dom", pathToFileURL(file).href],
    { encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  const match = result.stdout.match(/<pre id="reload-results">([\s\S]*?)<\/pre>/);
  assert.ok(match, result.stdout.slice(-3000));
  const report = JSON.parse(match[1].replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"));
  assert.equal(report.pass, true, report.error);
  console.log(`Browser draft reload passed: 4 real page reloads, ${report.checks} checks.`);
} finally {
  await rm(root, { recursive: true, force: true });
}
