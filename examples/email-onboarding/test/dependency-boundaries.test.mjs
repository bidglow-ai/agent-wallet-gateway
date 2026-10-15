import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';

const root=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(import.meta.url);

test('example lock matches the reviewed Vite 8.0 security patch without overrides',()=>{
  const manifest=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  const lock=JSON.parse(readFileSync(new URL('../package-lock.json',import.meta.url),'utf8'));
  assert.equal(manifest.devDependencies.vite,'8.0.16');
  assert.equal(lock.packages['node_modules/vite'].version,manifest.devDependencies.vite);
  assert.equal(manifest.overrides,undefined,'do not silently force incompatible transitive majors');
});

// Reachability checks, NOT advisory suppression or a claim of a patched SDK.
// A dependency/bundler change must cause a fresh review of these assertions.
test('production browser graph excludes stream-json and the Node Jayson parser',async()=>{
  const result=await build({root,logLevel:'silent',build:{write:false}});
  const outputs=Array.isArray(result)?result:[result];
  const ids=outputs.flatMap(output=>output.output.filter(item=>item.type==='chunk')
    .flatMap(chunk=>Object.keys(chunk.modules)));
  assert.ok(ids.some(id=>id.includes('/@coinbase/cdp-core/')),'inspect the real SDK graph');
  assert.ok(ids.some(id=>id.includes('/jayson/lib/client/browser/')),'browser JSON-RPC path remains visible');
  assert.ok(ids.some(id=>id.includes('/uuid/')),'do not claim uuid is absent from the bundle');
  assert.deepEqual(ids.filter(id=>/\/stream-json\/|\/jayson\/lib\/utils\.js/.test(id)),[],
    'streaming parser paths require a new reachability/security review');
});

test('installed Jayson browser path uses native JSON.parse and argument-free UUID v4',()=>{
  for(const name of ['jayson/lib/client/browser/index.js','jayson/lib/generateRequest.js']){
    const source=readFileSync(require.resolve(name),'utf8');
    assert.match(source,/const uuid = require\('uuid'\)\.v4;/);
    assert.match(source,/return uuid\(\);/);
    assert.doesNotMatch(source,/stream-json|uuid\.(?:v3|v5|v6)\(/);
  }
  const BrowserClient=require('jayson/lib/client/browser/index.js');
  const client=new BrowserClient(()=>assert.fail('no network transport is invoked'));
  const request=client.request('synthetic_read_only_method',[]);
  assert.match(request.id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  client._parseResponse(null,'{"result":{"__proto__":{"dependencyProbe":true}}}',(error,response)=>{
    assert.equal(error,null);
    assert.equal(Object.getPrototypeOf(response.result),Object.prototype);
    assert.equal(Object.hasOwn(response.result,'__proto__'),true);
    assert.equal(response.result.dependencyProbe,undefined);
  });
});
