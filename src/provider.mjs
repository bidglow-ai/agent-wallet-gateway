import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync, realpathSync} from 'node:fs';
import {isAbsolute, dirname, resolve} from 'node:path';
const execute = promisify(execFile);
const READ_COMMANDS = [
  ['status'],
  ['address', '--chain', 'base'],
  ['balance', '--chain', 'base', '--asset', 'usdc'],
];

export class WalletError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// No shell, npx downloads, arbitrary CLI arguments, auth, transfer or trading tool.
export class AwalProvider {
  constructor(cliPath, executor = execute) {
    if (!cliPath || !isAbsolute(cliPath)) throw new WalletError('AWAL_PATH_REQUIRED');
    this.cliPath = realpathSync(cliPath);
    const metadata = JSON.parse(readFileSync(resolve(dirname(this.cliPath), '../package.json'), 'utf8'));
    if (metadata.name !== 'awal' || metadata.version !== '2.12.2') throw new WalletError('AWAL_VERSION_UNVERIFIED');
    this.execute = executor;
  }
  async run(args) {
    const command = Array.isArray(args) && READ_COMMANDS.find(candidate =>
      candidate.length === args.length && candidate.every((value, index) => value === args[index]));
    if (!command) {
      throw new WalletError('READ_ONLY_COMMAND_REQUIRED');
    }
    // Never iterate or re-read caller-controlled input after validation.
    const safeArgs = [...command];
    let output;
    try {
      output = await this.execute(process.execPath, [this.cliPath, ...safeArgs, '--json'], {
        timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true,
        env: {PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NO_COLOR: '1'},
      });
    } catch { throw new WalletError('PROVIDER_OUTCOME_UNCONFIRMED'); }
    try {
      const value = JSON.parse(output.stdout);
      if (!value || typeof value !== 'object' || value.success === false) throw new Error();
      return value;
    } catch { throw new WalletError('PROVIDER_RESPONSE_UNVERIFIED'); }
  }
  async status() {
    const value = await this.run(['status']);
    return {running: value.server?.running === true, authenticated: value.auth?.authenticated === true};
  }
  async address() {
    const value = await this.run(['address', '--chain', 'base']);
    if (typeof value.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value.address)) throw new WalletError('WALLET_ADDRESS_UNVERIFIED');
    return value.address.toLowerCase();
  }
  async balance() {
    const value = await this.run(['balance', '--chain', 'base', '--asset', 'usdc']);
    const raw = value.balances?.USDC?.raw;
    if (typeof raw !== 'string' || !/^(0|[1-9][0-9]{0,30})$/.test(raw)) throw new WalletError('BALANCE_UNVERIFIED');
    return {network: 'base', asset: 'USDC', amountAtomic: raw};
  }
}
