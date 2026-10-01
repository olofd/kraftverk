/*
  Checks a kraftverk configuration file against what is installed here
  (docs/CONFIG.md), or prints the JSON Schema an editor checks it with:

    npm run config -- check path/to/kraftverk.yaml
    npm run config -- schema > kraftverk.schema.json

  A problem is printed as "file:line:column: message", as editors and CI
  read them; the exit code is 1 when there is one. Devices and automations
  the file names but does not carry are taken to be the server's: say which
  with --has devices=a,b automations=c.
*/
import { readFileSync } from 'node:fs';

import { checkDocument, configJsonSchema, readConfig, vocabularyOf } from '@kraftverk/config';

import { DeviceTypeRegistry } from '../server/src/devices/types.ts';
import { ProtocolRegistry } from '../server/src/runtime/protocols.ts';

const [command, ...rest] = process.argv.slice(2);
const quiet = console.log;
// The registries say what they found; this says only what it was asked.
console.log = () => {};
const protocols = new ProtocolRegistry();
await protocols.discover();
const types = new DeviceTypeRegistry();
await types.discover();
console.log = quiet;

const option = (name: string): string[] =>
  rest
    .filter((arg) => arg.startsWith(`${name}=`))
    .flatMap((arg) => arg.slice(name.length + 1).split(','))
    .filter(Boolean);
const vocabulary = vocabularyOf(types.all(), (id) => protocols.get(id), {
  devices: option('devices').map((key) => ({ key, type: '', name: key, parts: ['main'] })),
  automations: option('automations').map((key) => ({ key, name: key })),
});

if (command === 'schema') {
  console.log(JSON.stringify(configJsonSchema(vocabulary), null, 2));
} else if (command === 'check' && rest[0]) {
  const file = rest[0];
  const { document, problems } = readConfig(readFileSync(file, 'utf8'), {}, (read) => checkDocument(read, vocabulary));
  for (const problem of problems) console.log(`${file}:${problem.line ?? 1}:${problem.column ?? 1}: ${problem.message}`);
  if (document) {
    const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
    console.log(`${file}: ${count(Object.keys(document.devices).length, 'device')}, ${count(document.links.length, 'link')}, ${count(Object.keys(document.automations).length, 'automation')} — nothing wrong`);
  }
  process.exit(problems.length ? 1 : 0);
} else {
  console.log('Usage: npm run config -- check <file> [devices=a,b] [automations=c] | npm run config -- schema');
  process.exit(2);
}
