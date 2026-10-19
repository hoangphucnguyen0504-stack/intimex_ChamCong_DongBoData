import {loadConfig} from '../src/config.js';
import {poolFor,migrate} from '../src/db.js';
import {environmentSettings,bootstrapSettings} from '../src/bootstrap.js';
import {saveSettings} from '../src/settings.js';
const config=loadConfig(),pool=poolFor(config);
try {
  await migrate(pool);
  const initial=environmentSettings(config);
  if(!initial)throw Error('GOOGLE_ENV_MISSING');
  await saveSettings(pool,config.CONFIG_ENCRYPTION_KEY,initial);
  await bootstrapSettings(pool,config);
  console.log('Google configuration applied. Resource presets initialized. No Sheets import/write was started.');
} catch(error) {console.error(error.code||'GOOGLE_ENV_APPLY_FAILED');process.exitCode=1;}
finally {await pool.end();}
