import assert from "node:assert/strict";
import test from "node:test";
import * as http from "node:http";
import { readJsonRequest, JsonRequestError } from "./httpJson";

for (const method of ["GET", "POST"] as const) {
  test(`${method} rejects an interrupted JSON response and the next request can complete`, async t => {
    let count = 0;
    let interruptedResponse: http.ServerResponse | undefined;
    let partialResponseObserved = false;
    const server = http.createServer((req, res) => {
      count++;
      req.resume();
      res.writeHead(200, {"Content-Type":"application/json"});
      if (count === 1) { interruptedResponse = res; res.write('{"data":'); }
      else res.end('{"data":"complete"}');
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const address = server.address() as {port:number};
    const read = () => readJsonRequest(receive => {
      const req = http.request(`http://127.0.0.1:${address.port}`, {method}, res => {
        receive(res);
        if (count === 1) res.once("data", () => {
          partialResponseObserved = true;
          interruptedResponse!.destroy();
        });
      });
      req.end(method === "POST" ? '{}' : undefined);
      return req;
    }, 2000);
    await assert.rejects(read, (error: NodeJS.ErrnoException) => error.code === "ECONNRESET");
    assert.equal(partialResponseObserved, true, "the connection must fail after headers and partial body reached the client");
    assert.deepEqual(await read(), {data:"complete"});
    assert.equal(count, 2, "POST must not retry a potentially accepted write automatically");
  });
}

test("whole-request deadline rejects a continuously dripping JSON response", async t => {
  const server = http.createServer((_req,res) => {
    res.writeHead(200);res.write('{"data":"');
    const timer = setInterval(() => res.write('x'), 5);
    res.on("close", () => clearInterval(timer));
  });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  t.after(() => {server.closeAllConnections();server.close();});
  const {port}=server.address() as {port:number};
  await assert.rejects(readJsonRequest(receive => http.get(`http://127.0.0.1:${port}`,receive),50),
    (error:NodeJS.ErrnoException)=>error.code === "ETIMEDOUT");
});

test("HTTP rejection and malformed JSON retain status without exposing response content", async t => {
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === "/rejected" ? 403 : 200);
    res.end(req.url === "/rejected" ? '{"error":{"code":"1210","message":"X-Device-Mid missing: TEST-PRIVATE-KEY"}}' : "TEST-PRIVATE-TOKEN");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { port } = server.address() as { port: number };
  for (const [route, status, code] of [["rejected", 403, "HTTP_STATUS"], ["malformed", 200, "INVALID_JSON"]] as const) {
    let observed: number | undefined;
    await assert.rejects(readJsonRequest(receive => http.get(`http://127.0.0.1:${port}/${route}`, receive), 2000,
      value => { observed = value; }), error => {
      assert.ok(error instanceof JsonRequestError);
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      assert.equal(error.resultCode, route === "rejected" ? "1210" : undefined);
      assert.equal(error.responseReason, route === "rejected" ? "device_id" : undefined);
      assert.doesNotMatch(JSON.stringify(error) + String(error), /TEST-PRIVATE/);
      return true;
    });
    assert.equal(observed, status);
  }
});
