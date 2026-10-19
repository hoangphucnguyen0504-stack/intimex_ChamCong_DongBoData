import {readFile,writeFile,access} from 'node:fs/promises';
import {randomBytes,scryptSync} from 'node:crypto';
const passwordHash=password=>{const salt=randomBytes(16).toString('hex');return salt+':'+scryptSync(password,salt,64).toString('hex');};
try {await access('.env');console.log('.env đã tồn tại; giữ nguyên, không ghi đè.');}
catch {
  const initial=randomBytes(18).toString('base64url');
  let source=await readFile('.env.example','utf8');
  const values={ADMIN_PASSWORD_HASH:passwordHash(initial),SESSION_SECRET:randomBytes(32).toString('hex'),API_TOKEN:randomBytes(32).toString('hex'),CONFIG_ENCRYPTION_KEY:randomBytes(32).toString('hex'),MYSQL_PASSWORD:randomBytes(24).toString('hex'),MYSQL_ROOT_PASSWORD:randomBytes(24).toString('hex')};
  for(const [key,value] of Object.entries(values))source=source.replace(new RegExp('^'+key+'=$','m'),key+'='+value);
  await writeFile('.env',source+'\n# Mật khẩu đăng nhập ban đầu; xóa dòng này sau khi cất an toàn.\nADMIN_INITIAL_PASSWORD='+initial+'\n',{flag:'wx',mode:0o600});
  console.log('Đã tạo .env với khóa riêng. Đọc ADMIN_INITIAL_PASSWORD trong .env để đăng nhập tài khoản admin. Không in/chia sẻ file .env.');
}
