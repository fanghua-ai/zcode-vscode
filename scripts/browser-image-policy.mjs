import { build } from "esbuild";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:https";
import assert from "node:assert/strict";

// A real HTTPS image endpoint detects requests. No desktop or account is used.
const root = await mkdtemp(path.join(tmpdir(), "zcode-image-policy-"));
let server;
try {
  const key = path.join(root, "key.pem"), cert = path.join(root, "cert.pem");
  const certificate = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1"], { encoding: "utf8" });
  assert.equal(certificate.status, 0, certificate.stderr);
  let requests = 0;
  const icon = await readFile("media/icon-zcode-vscode.png");
  server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (_request, response) => {
    requests++;
    response.writeHead(200, { "Content-Type": "image/png" }); response.end(icon);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const remote = `https://127.0.0.1:${server.address().port}/image?content=PRIVATE_TEST_MARKER`;
  const modulePath = path.join(root, "html.cjs");
  await build({ entryPoints: ["src/webviewHtml.ts"], outfile: modulePath, bundle: true,
    platform: "node", format: "cjs", alias: { vscode: path.resolve("src/testSupport/vscode.ts") } });
  const { getWebviewHtml } = createRequire(import.meta.url)(modulePath);
  const nonce = "image-policy-test";
  let html = getWebviewHtml({ cspSource: "file:", asWebviewUri: uri => uri }, pathToFileURL(process.cwd()).href, nonce);
  // Keep the real page CSP; isolate the image policy from application startup.
  html = html.replace(/<script[\s\S]*?<\/script>/g, "");
  html = html.replace("</body>", `<script nonce="${nonce}">
    (async()=>{
      const violations=[];
      document.addEventListener('securitypolicyviolation',e=>violations.push({directive:e.effectiveDirective,uri:e.blockedURI}));
      const load=src=>new Promise(resolve=>{const img=new Image();img.onload=()=>resolve(true);img.onerror=()=>resolve(false);img.src=src;document.body.append(img);});
      const blocked=!(await load(${JSON.stringify(remote)}));
      const local=await load(${JSON.stringify(pathToFileURL(path.resolve('media/icon-zcode-vscode.png')).href)});
      const inline=await load('data:image/png;base64,'+${JSON.stringify(icon.toString('base64'))});
      await new Promise(resolve=>setTimeout(resolve,50));
      const denied=violations.some(e=>e.directive==='img-src'&&e.uri===${JSON.stringify(remote)});
      document.body.dataset.imagePolicy=blocked&&denied&&local&&inline?'passed':'failed';
      const pre=document.createElement('pre');pre.id='image-policy-results';pre.textContent=JSON.stringify({blocked,denied,local,inline,violations});document.body.append(pre);
    })().catch(e=>{document.body.dataset.imagePolicy='failed';document.body.append(String(e));});
  </script></body>`);
  const file = path.join(root, "test.html"); await writeFile(file, html);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.env.CHROME_BIN || "google-chrome", ["--headless", "--no-sandbox", "--disable-gpu",
      "--disable-background-networking", "--no-first-run", "--ignore-certificate-errors",
      `--user-data-dir=${path.join(root, 'profile')}`, "--virtual-time-budget=5000", "--dump-dom", pathToFileURL(file).href]);
    let stdout = "", stderr = "";
    const timeout = setTimeout(()=>{child.kill();reject(new Error('Image policy browser timed out'));},30000);
    child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.on('error',error=>{clearTimeout(timeout);reject(error);});
    child.on('close',status=>{clearTimeout(timeout);resolve({status,stdout,stderr});});
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('data-image-policy="passed"'), result.stdout.slice(-5000));
  assert.equal(requests, 0, "Remote image endpoint received a request containing conversation data");
  console.log("Image policy browser passed: HTTPS requests blocked (0 requests), local and data images load.");
} finally {
  if (server) await new Promise(resolve=>server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
