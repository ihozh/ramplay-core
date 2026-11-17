// What the core page needs beside its own files: the documents it links to.
// Copies, never committed.
//   node scripts/assets.mjs
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(HERE, '..', 'public');
const COPIES = [
  ['RAMPLAY_SPEC.md', 'files/RAMPLAY_SPEC.md'],
  ['sdk/ramplay.inc', 'files/ramplay.inc.txt'],
  ['examples/hello/hello.s', 'files/hello.s.txt'],
  ['README.md', 'files/README.md'],
];
let missing = 0;
for (const [from, to] of COPIES) {
  const src = join(ROOT, from), dst = join(OUT, to);
  if (!existsSync(src)) { console.log(`missing: ${from}`); missing++; continue; }
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
}
console.log(`core page: ${COPIES.length - missing} of ${COPIES.length} files copied`);
