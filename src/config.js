import {z} from 'zod';
import {existsSync} from 'node:fs';
import {loadEnvFile} from 'node:process';
if(existsSync('.env')) loadEnvFile('.env');
const schema = z.object({
  PORT:z.coerce.number().int().min(1).max(65535).default(3200),
  PUBLIC_ORIGIN:z.url(), COOKIE_SECURE:z.enum(['true','false']).default('true'),
  ADMIN_USERNAME:z.string().min(1), ADMIN_PASSWORD_HASH:z.string().regex(/^[a-f0-9]{32}:[a-f0-9]{128}$/),
  SESSION_SECRET:z.string().min(48), API_TOKEN:z.string().min(48), CONFIG_ENCRYPTION_KEY:z.string().regex(/^[a-f0-9]{64}$/),
  CHATBOX_READ_TOKEN:z.string().min(48).optional(),
  MYSQL_HOST:z.string().min(1), MYSQL_PORT:z.coerce.number().int().default(3306),MYSQL_DATABASE:z.string().min(1),
  MYSQL_USER:z.string().min(1),MYSQL_PASSWORD:z.string().min(1),MYSQL_SSL:z.enum(['true','false']).default('false'),
  MYSQL_POOL_SIZE:z.coerce.number().int().min(2).max(30).default(6),
  SHEETS_REQUESTS_PER_MINUTE:z.coerce.number().int().min(1).max(40).default(40),
  GOOGLE_SHEET_ID:z.string().optional(),GOOGLE_SERVICE_ACCOUNT_JSON:z.string().optional(),
  BOOTSTRAP_ENTITIES_FILE:z.string().optional(),
  SYNC_INTERVAL_MINUTES:z.coerce.number().int().min(1).max(1440).default(60),
  SYNC_BATCH_SIZE:z.coerce.number().int().min(1).max(200).default(100),
  SYNC_ENABLED:z.enum(['true','false']).default('false')
});
export function loadConfig(env = process.env) {
  const r = schema.safeParse(env);
  if(!r.success) throw Error('ENV_INVALID: '+[...new Set(r.error.issues.map(i=>i.path[0]))].join(', '));
  const c = r.data;
  if(new URL(c.PUBLIC_ORIGIN).origin !== c.PUBLIC_ORIGIN) throw Error('PUBLIC_ORIGIN chỉ gồm protocol và hostname/port');
  if(c.PUBLIC_ORIGIN.startsWith('https:') && c.COOKIE_SECURE !== 'true') throw Error('HTTPS cần COOKIE_SECURE=true');
  return c;
}
