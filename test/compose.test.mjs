import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse} from 'yaml';
test('Docker manifests parse, isolate MySQL and keep admin bound to localhost',()=>{
  const load=path=>parse(readFileSync(path,'utf8'),{merge:true});
  const prod=load('docker-compose.yml'),external=load('docker-compose.external.yml'),testCompose=load('docker-compose.test.yml');
  assert.equal(prod.services.mysql.image,'mysql:8.4');assert(!prod.services.mysql.ports);assert(prod.services.api.ports.every(p=>p.startsWith('127.0.0.1:')));assert(prod.services.mysql.command.includes('--innodb-flush-log-at-trx-commit=1'));
  assert(prod.services.api.read_only);assert.deepEqual(prod.services.worker.command,['node','src/worker.js']);assert(!external.services.mysql);assert.deepEqual(external.services.worker.ports,[]);
  assert.equal(testCompose.services['mysql-test'].environment.MYSQL_DATABASE,'datadongbo_test');assert(!testCompose.services['mysql-test'].volumes);
  assert(readFileSync('test/Dockerfile.dockerignore','utf8').includes('.env'));
});
