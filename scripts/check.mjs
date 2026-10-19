import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
for(const directory of ['src','scripts','client','public','test']) {
  for(const file of await readdir(directory))if(/\.(m?js)$/.test(file)) {
    const r=spawnSync(process.execPath,['--check',`${directory}/${file}`],{encoding:'utf8'});
    if(r.status!==0){console.error(r.stderr);process.exit(1);}
  }
}
console.log('Syntax check passed.');
