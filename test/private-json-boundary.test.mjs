import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync,linkSync,mkdirSync,mkdtempSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readPrivateJson} from '../src/unattended/private-json.mjs';

function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'private-json-boundary-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const parent=join(directory,'private');mkdirSync(parent,{mode:0o700});
  const file=join(parent,'synthetic.json');writeFileSync(file,'{"syntheticOnly":true}',{mode:0o600});
  return {directory,parent,file};
}
function rejected(path){
  assert.throws(()=>readPrivateJson(path),cause=>cause.code==='PRIVATE_OPERATOR_FILE_REQUIRED'&&
    cause.message==='PRIVATE_OPERATOR_FILE_REQUIRED'&&!JSON.stringify(cause).includes(path));
}

test('owner-only direct parent and opened private file are accepted',t=>{
  const {file}=fixture(t);
  assert.deepEqual(readPrivateJson(file),{syntheticOnly:true});
});
for(const mode of [0o755,0o777])test(`direct parent ${mode.toString(8)} is rejected even with a 0600 file`,t=>{
  const {parent,file}=fixture(t);chmodSync(parent,mode);rejected(file);
});
test('symlink direct parent and lexical aliases cannot bypass the check',t=>{
  const {directory,parent}=fixture(t),alias=join(directory,'alias');symlinkSync(parent,alias);
  rejected(join(alias,'synthetic.json'));
  rejected(alias+'//synthetic.json');rejected(alias+'/./synthetic.json');
});
test('a non-directory direct parent produces only the fixed error',t=>{
  const {directory}=fixture(t),parent=join(directory,'not-a-directory');writeFileSync(parent,'{}',{mode:0o600});
  rejected(join(parent,'synthetic.json'));
});
test('parent validation does not replace file inode and O_NOFOLLOW protections',t=>{
  const {parent,file}=fixture(t),symlink=join(parent,'symlink.json'),hardlink=join(parent,'hardlink.json');
  symlinkSync(file,symlink);rejected(symlink);
  linkSync(file,hardlink);rejected(file);rmSync(hardlink);
  chmodSync(file,0o644);rejected(file);
});
