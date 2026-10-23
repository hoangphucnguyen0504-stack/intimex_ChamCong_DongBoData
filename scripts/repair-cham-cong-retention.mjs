import '../src/config.js';

const origin = process.env.PUBLIC_ORIGIN;
let cookie;
async function admin(path, body) {
  const response = await fetch(new URL(path, origin), {
    method: body ? 'POST' : 'GET',
    headers: {Origin: origin, ...(cookie ? {Cookie: cookie} : {}), ...(body ? {'Content-Type': 'application/json'} : {})},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000)
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw Error(`${path}: ${response.status} ${data.code || 'FAILED'}`);
  const session = response.headers.get('set-cookie');
  if (session) cookie = session.split(';')[0];
  return data;
}
try {
  if (!process.env.ADMIN_INITIAL_PASSWORD) throw Error('ADMIN_PASSWORD_UNAVAILABLE');
  await admin('/admin/login', {username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_INITIAL_PASSWORD});
  const {entities} = await admin('/admin/status');
  for (const name of ['EmailLogs', 'AuditLogs']) {
    const entity = entities.find(item => item.name === name);
    if (!entity || entity.bootstrap_state !== 'ready') throw Error(`${name}: IMPORT_REQUIRED`);
    console.log(JSON.stringify({entity: name, previousRetentionDays: entity.retention_days, retentionDays: 0}));
    if (process.argv.includes('--apply') && Number(entity.retention_days) !== 0) {
      await admin('/admin/entities', {name, tabName: entity.tab_name, headers: entity.headers, retentionDays: 0});
      console.log(JSON.stringify({entity: name, updated: true}));
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (cookie) await admin('/admin/logout', {}).catch(() => {});
}
