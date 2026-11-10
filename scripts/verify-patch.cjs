const fs = require('node:fs');
const app = fs.readFileSync('F:/DI/DataDongBo/src/app.js', 'utf8');
const src = fs.readFileSync('F:/DI/DataDongBo/src/chamCong.js', 'utf8');
const i = src.indexOf('ESCAPE');
console.log('route', app.includes('/v1/cham-cong/revisions'));
console.log('prefix', src.includes('function prefixLatest'));
console.log('revisions', src.includes('export async function revisions'));
console.log('branch', src.includes('keyPrefix?[await prefixLatest'));
console.log(src.slice(i - 40, i + 30));
