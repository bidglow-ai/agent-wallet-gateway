import {constants,openSync,closeSync,fstatSync,lstatSync,readSync} from 'node:fs';
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
    // Do not block opening a FIFO before its non-regular type can be rejected.
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const stat=fstatSync(fd);
    if(!stat.isFile()||(stat.mode&0o777)!==0o600||stat.nlink!==1||(process.getuid&&stat.uid!==process.getuid())||stat.size<2||stat.size>maxBytes)throw new Error();
    // Bound the actual read as well as the initial stat: a concurrent trusted
    // writer may grow the inode after the size check.
    const buffer=Buffer.alloc(maxBytes+1);let used=0;
    while(used<buffer.length){const count=readSync(fd,buffer,used,buffer.length-used,null);if(!count)break;used+=count;}
    if(used<2||used>maxBytes)throw new Error();
    const value=JSON.parse(buffer.subarray(0,used).toString('utf8'));
    if(!value||Object.getPrototypeOf(value)!==Object.prototype)throw new Error();
    return value;
  }catch{throw new PaymentError('PRIVATE_OPERATOR_FILE_REQUIRED');}
  finally{if(fd!==undefined)closeSync(fd);}
}
