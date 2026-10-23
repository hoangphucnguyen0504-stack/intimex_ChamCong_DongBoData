import '../src/config.js';

const url = new URL('/v1/cham-cong/status', process.env.PUBLIC_ORIGIN);
url.searchParams.set('spreadsheetId', process.env.GOOGLE_SHEET_ID || '');
try {
  const response = await fetch(url, {
    headers: {Authorization: `Bearer ${process.env.API_TOKEN}`},
    signal: AbortSignal.timeout(20000)
  });
  const body = await response.json();
  console.log(JSON.stringify({status: response.status, ready: body.ready, entities: body.entities?.map(({name,bootstrap_state,retention_days,unmapped}) => ({name,bootstrap_state,retention_days,unmapped}))}, null, 2));
  for (const entity of ['EmailLogs','AuditLogs']) {
    const probe = new URL(`/v1/cham-cong/rows/${entity}`, process.env.PUBLIC_ORIGIN);
    probe.searchParams.set('spreadsheetId', process.env.GOOGLE_SHEET_ID || '');
    probe.searchParams.set('limit', '1');
    const result = await fetch(probe, {headers: {Authorization: `Bearer ${process.env.API_TOKEN}`}, signal: AbortSignal.timeout(20000)});
    const data = await result.json();
    console.log(JSON.stringify({entity,status:result.status,ok:data.ok,code:data.code}));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
