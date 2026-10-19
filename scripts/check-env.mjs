import {loadConfig} from '../src/config.js';
try {loadConfig();console.log('Environment configuration is valid. No secrets printed.');}
catch(error) {console.error(error.message);process.exitCode=1;}
