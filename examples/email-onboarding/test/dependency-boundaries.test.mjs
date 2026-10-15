import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {build,optimizeDeps,resolveConfig} from 'vite';

const root=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(import.meta.url);

test('example lock matches the reviewed Vite 8.0 security patch without overrides',()=>{
  const manifest=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  const lock=JSON.parse(readFileSync(new URL('../package-lock.json',import.meta.url),'utf8'));
  assert.equal(manifest.devDependencies.vite,'8.0.16');
  assert.equal(lock.packages['node_modules/vite'].version,manifest.devDependencies.vite);
  assert.equal(manifest.overrides,undefined,'do not silently force incompatible transitive majors');
});

test('the SDK Zustand root import has a compatible pinned React peer, without React DOM or aliases',async()=>{
  const manifest=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  const lock=JSON.parse(readFileSync(new URL('../package-lock.json',import.meta.url),'utf8'));
  const zustandPath=require.resolve('zustand/package.json');
  const zustand=JSON.parse(readFileSync(zustandPath,'utf8'));
  const peerPath=require.resolve('react/package.json',{paths:[dirname(zustandPath)]});
  const peer=JSON.parse(readFileSync(peerPath,'utf8'));
  assert.equal(manifest.dependencies['@coinbase/cdp-core'],'0.0.127');
  assert.equal(manifest.dependencies.react,'19.3.1');
  assert.equal(lock.packages[''].dependencies.react,manifest.dependencies.react);
  assert.equal(lock.packages['node_modules/react'].version,manifest.dependencies.react);
  assert.equal(peer.version,manifest.dependencies.react);
  assert.equal(zustand.peerDependencies.react,'>=18.0.0');
  assert.equal(zustand.peerDependenciesMeta.react.optional,true);
  assert.match(readFileSync(new URL('../node_modules/zustand/esm/index.mjs',import.meta.url),'utf8'),/export \* from 'zustand\/react'/);
  assert.match(readFileSync(new URL('../node_modules/zustand/esm/react.mjs',import.meta.url),'utf8'),/import React from 'react'/);
  const installed=await import('zustand');
  assert.equal(typeof installed.createStore,'function');
  assert.equal(typeof installed.useStore,'function');
  assert.equal(manifest.dependencies['react-dom'],undefined,'do not add an unused renderer to this vanilla UI');
  assert.equal(lock.packages['node_modules/react-dom'],undefined);
});

test('a fresh real Vite development prebundle resolves the SDK and Zustand React import',async()=>{
  const temp=mkdtempSync(join(tmpdir(),'bidglow-email-peer-'));
  try{
    // Never consume operator .env files or the running owner's cache/server.
    // Unlike a production build this traverses the dev optimizer graph that
    // previously failed on Zustand's optional-but-imported React peer.
    const config=await resolveConfig({root,configFile:false,envDir:false,cacheDir:join(temp,'cache'),logLevel:'silent',
      resolve:{alias:[]},optimizeDeps:{include:['@coinbase/cdp-core','zustand'],noDiscovery:true}},'serve');
    const metadata=await optimizeDeps(config,true,true);
    for(const name of ['@coinbase/cdp-core','zustand']){
      assert.ok(metadata.optimized[name],`real development prebundle missing ${name}`);
      assert.ok(readFileSync(metadata.optimized[name].file,'utf8').length>0);
    }
    assert.deepEqual(config.resolve.alias.filter(alias=>String(alias.find).includes('zustand')),[],
      'never bypass an SDK dependency through a fake alias');
  }finally{rmSync(temp,{recursive:true,force:true});}
});

// Reachability checks, NOT advisory suppression or a claim of a patched SDK.
// A dependency/bundler change must cause a fresh review of these assertions.
test('production browser graph excludes stream-json and the Node Jayson parser',async()=>{
  const result=await build({root,configFile:false,envDir:false,logLevel:'silent',build:{write:false}});
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
