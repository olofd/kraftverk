import { hearDirectly } from './listen.ts';
import { relayTo, relayToken } from './relay.ts';

/*
  The relay, as its own process (docs/DOCKER.md): the one service of a
  home's on its home network. It hears what devices announce — broadcasts,
  mDNS, SSDP — for the server in its container, which they do not reach,
  and passes it on over one connection (relay.ts). It opens nothing to a
  device, keeps nothing, and runs no integration's code.

    KRAFTVERK_RELAY_SERVER           where the server listens for it: host:port (127.0.0.1:3334)
    KRAFTVERK_LAN_RELAY_TOKEN_FILE   the token the server made, to prove itself with (/relay/token)
*/

const env = process.env;
const [host, port] = (env.KRAFTVERK_RELAY_SERVER || '127.0.0.1:3334').split(':') as [string, string];
const tokenFile = env.KRAFTVERK_LAN_RELAY_TOKEN_FILE || '/relay/token';
const log = (level: 'info' | 'warn' | 'error', message: string) => console[level === 'info' ? 'log' : level](message);

const hearing = hearDirectly(log);
const stop = relayTo({ host, port: Number(port), token: () => relayToken(tokenFile, false), hearing, log });
log('info', `[relay] Hearing the home network for the server at ${host}:${port}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stop();
    hearing.stop();
    process.exit(0);
  });
}
