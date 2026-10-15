import {constants,openSync,closeSync,fstatSync,readFileSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {PaymentError} from './intent.mjs';

// Trusted operator inputs only; do not put these documents in a repository.
// The opened inode, not a separate path-stat, is checked before reading secrets.
export function readPrivateJson(path,maxBytes=32768){
  let fd;
  try{
    if(typeof path!=='string'||!isAbsolute(path)||!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new Error();
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    const stat=fstatSync(fd);
    if(!stat.isFile()||(stat.mode&0o777)!==0o600||stat.nlink!==1||(process.getuid&&stat.uid!==process.getuid())||stat.size<2||stat.size>maxBytes)throw new Error();
    const value=JSON.parse(readFileSync(fd,'utf8'));
    if(!value||Object.getPrototypeOf(value)!==Object.prototype)throw new Error();
    return value;
  }catch{throw new PaymentError('PRIVATE_OPERATOR_FILE_REQUIRED');}
  finally{if(fd!==undefined)closeSync(fd);}
}
