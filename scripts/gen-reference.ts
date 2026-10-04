/**
 * The automation language's reference, written from its own description
 * (packages/automation/src/kinds): every construct, its words and examples.
 *
 *   npm run gen:reference               write packages/automation/REFERENCE.md
 *   npm run gen:reference -- --check    fail if it is out of date (CI)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { referenceMarkdown } from '@kraftverk/automation';

const FILE = resolve(import.meta.dirname, '..', 'packages', 'automation', 'REFERENCE.md');
const written = referenceMarkdown();
const kept = existsSync(FILE) ? readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n') : null;

if (process.argv.includes('--check')) {
  if (kept !== written) {
    console.error('packages/automation/REFERENCE.md is not what the language says of itself: run `npm run gen:reference`.');
    process.exit(1);
  }
  console.log('The automation language’s reference is current.');
} else if (kept !== written) {
  writeFileSync(FILE, written);
  console.log('Wrote packages/automation/REFERENCE.md.');
} else console.log('packages/automation/REFERENCE.md is current.');
