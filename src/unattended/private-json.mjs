import {constants,openSync,closeSync,fstatSync,lstatSync,readFileSync} from 'node:fs';
import {dirname,isAbsolute,resolve} from 'node:path';
import {PaymentError} from './intent.mjs';

// Trusted operator inputs only; do not put these documents in a repository.
// Check the direct parent only; this is not ancestor or filesystem-race isolation.
// The opened file inode, not a separate path-stat, is checked before reading secrets.
export function readPrivateJson(path,maxBytes=32768){
  let fd;
  try{
    if(typeof path!=='string'||!isAbsolute(path)||resolve(path)!==path||!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new Error();
    // Canonical lexical paths keep trailing-slash/dot aliases from following a
    // symlink in the direct-parent lstat. No ancestor traversal is claimed.
    const parent=lstatSync(dirname(path));
    if(parent.isSymbolicLink()||!parent.isDirectory()||(parent.mode&0o777)!==0o700||(process.getuid&&parent.uid!==process.getuid()))throw new Error();
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    const stat=fstatSync(fd);
    if(!stat.isFile()||(stat.mode&0o777)!==0o600||stat.nlink!==1||(process.getuid&&stat.uid!==process.getuid())||stat.size<2||stat.size>maxBytes)throw new Error();
    const value=JSON.parse(readFileSync(fd,'utf8'));
    if(!value||Object.getPrototypeOf(value)!==Object.prototype)throw new Error();
    return value;
  }catch{throw new PaymentError('PRIVATE_OPERATOR_FILE_REQUIRED');}
  finally{if(fd!==undefined)closeSync(fd);}
}
