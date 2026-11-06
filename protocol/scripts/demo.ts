import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createNote, deposit, claim, config, getBalance, setProofArtifacts } from '../client/src/index.js';
import { fund } from '../client/src/node.js';
import { fileURLToPath } from 'node:url';

if (config.pool === '0x0000000000000000000000000000000000000000') throw new Error('Run npm run deploy first');
setProofArtifacts(fileURLToPath(new URL('../circuits/build/withdraw.wasm', import.meta.url)), fileURLToPath(new URL('../circuits/build/withdraw_final.zkey', import.meta.url)));
const senderKey = generatePrivateKey(), sender = privateKeyToAccount(senderKey).address;
console.log('sender', sender, 'faucet', await fund(sender));
const note = createNote(config.pool, config.chainId);
console.log('commitment', note.commitment);
const deposited = await deposit(note, { privateKey: senderKey, onStep: step => console.log('deposit step', step) });
console.log('deposit', deposited, `${config.explorer}?tx=${deposited.txHash}`);
const recipientKey = generatePrivateKey(), recipient = privateKeyToAccount(recipientKey).address;
console.log('recipient before', recipient, (await getBalance(recipient)).toString());
const result = await claim(note, { recipientKey, onStep: step => console.log('claim step', step) });
console.log('claim', result, `${config.explorer}?tx=${result.txHash}`);
console.log('recipient after', (await getBalance(recipient)).toString());
