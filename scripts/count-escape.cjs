const fs = require('node:fs');
const src = fs.readFileSync('F:/DI/DataDongBo/src/chamCong.js', 'utf8');
const match = src.match(/ESCAPE '(\\+)'/);
console.log('backslashes', match[1].length);
const like = src.match(/replace\(\/(\[[^\]]+\])\/g,ch=>('([^']+)')/);
console.log('replace', like && like[0]);
