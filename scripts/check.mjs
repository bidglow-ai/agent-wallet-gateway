import {readdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
for(const directory of ['src','scripts']){
  for(const file of readdirSync(new URL('../'+directory+'/',import.meta.url),{recursive:true})){
    if(file.endsWith('.mjs'))execFileSync(process.execPath,['--check',directory+'/'+file],{stdio:'inherit'});
  }
}
execFileSync(process.execPath,['--test',...readdirSync(new URL('../test/',import.meta.url)).filter(f=>f.endsWith('.test.mjs')).map(f=>'test/'+f)],{stdio:'inherit'});
