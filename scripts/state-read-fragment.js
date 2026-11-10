async function prefixLatest(pool,entity,keyPrefix,after,upper,limit){
  const like=keyPrefix.replace(/[\\%_]/g,ch=>'\\'+ch)+'%';
  const [rows]=await pool.query(`SELECT r.id,r.data,m.sheet_row,m.id AS map_id,m.archived_at
    FROM records r
    JOIN row_map m ON m.entity=r.entity AND m.id=r.id
    JOIN (
      SELECT ranked.state_key,ranked.revision FROM (
        SELECT state_key,JSON_UNQUOTE(JSON_EXTRACT(data,'$.Revision')) AS revision,
          ROW_NUMBER() OVER (PARTITION BY state_key ORDER BY updated_at DESC, id DESC) AS rn
        FROM records
        WHERE entity=? AND deleted_at IS NULL AND state_key LIKE ? ESCAPE '\\\\'
      ) ranked WHERE ranked.rn=1
    ) latest ON latest.state_key=r.state_key AND JSON_UNQUOTE(JSON_EXTRACT(r.data,'$.Revision'))=latest.revision
    WHERE r.entity=? AND r.deleted_at IS NULL AND m.deleted_at IS NULL AND m.sheet_row>? AND m.sheet_row<=?
    ORDER BY m.sheet_row LIMIT ?`,[entity,like,entity,after,upper,limit]);
  return rows;
}
const stateSlices={
  weighing:"state_key LIKE 'weighing/%' OR state_key LIKE '%/weighing/%'",
  vgm:"state_key LIKE 'vgm/%' OR state_key LIKE '%/vgm/%'",
  catalogs:"state_key LIKE 'catalogs/%' OR state_key LIKE '%/catalogs/%'",
  'runtime-config':"state_key='runtime-config' OR state_key LIKE '%/runtime-config%'",
  'account-profiles':"state_key LIKE 'account-profiles/%' OR state_key LIKE '%/account-profiles/%'",
  'mail-credentials':"state_key LIKE 'mail-credentials/%' OR state_key LIKE '%/mail-credentials/%'",
  'submission-cooldown-config':"state_key LIKE 'submission-cooldown-config/%' OR state_key LIKE '%/submission-cooldown-config/%'",
  'telegram-notifications':"state_key LIKE '%telegram-notifications%'",
  'zalo-notifications':"state_key LIKE '%zalo-notifications%'",
  'sales-email':"state_key LIKE 'sales-email/%' OR state_key LIKE '%/sales-email/%'",
  sales:"state_key LIKE 'sales/%' OR state_key LIKE '%/sales/%'"
};
export async function revisions(pool,key,spreadsheetId){
  await assertBinding(pool,key,spreadsheetId);
  const [entities]=await pool.query("SELECT entity AS name, CONCAT(COUNT(*), ':', DATE_FORMAT(MAX(updated_at), '%Y-%m-%d %H:%i:%s.%f')) AS revision FROM records GROUP BY entity");
  const token=expr=>`CONCAT(SUM(${expr}), ':', IFNULL(DATE_FORMAT(MAX(CASE WHEN ${expr} THEN updated_at END), '%Y-%m-%d %H:%i:%s.%f'), ''))`;
  const columns=Object.entries(stateSlices).map(([name,expr])=>`${token(expr)} AS \`${name}\``).join(',');
  const [[row]]=await pool.query(`SELECT ${columns} FROM records WHERE entity='ApplicationState'`);
  const values={};
  for(const item of entities)if(item.revision)values[item.name]=item.revision;
  for(const name of Object.keys(stateSlices)){
    const value=row?.[name];
    if(value&&!String(value).startsWith('0:'))values['ApplicationState:'+name]=value;
  }
  return {ok:true,protocol:'cham-cong-revisions-v1',source:spreadsheetId,revisions:values};
}
