const fs = require('node:fs');
const s = fs.readFileSync('F:/DI/DataDongBo/src/chamCong.js', 'utf8');
const anchors = ['const stateKey', 'const [candidates]', 'export async function readRows', 'export async function status'];
for (const anchor of anchors) {
  const i = s.indexOf(anchor);
  console.log('\n==', anchor, i);
  if (i >= 0) console.log(s.slice(i, i + 500));
}
