import { smoke } from '../client/src/node.js';
smoke().catch(error => { console.error(error); process.exitCode = 1; });
