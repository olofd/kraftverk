import { NeedsSignIn, NotReachable, randomHex } from '@kraftverk/device-sdk';

import { cookieHeader, cookiesSet, keep, type Cookie } from './cookies.ts';
import { authOptionsOf, type AuthOptions, type TrustedPhone } from './options.ts';
import { passwordKey, srpProofs, srpStart, type SrpProtocol } from './srp.ts';

/*
  Signing in to iCloud as its web client does (pyicloud, MIT; NOTICE):

    1. GET  idmsa …/appleauth/auth/authorize/signin   cookies for what follows
    2. POST …/signin/init      {a, accountName, protocols}   → salt, B, c, iterations, protocol
    3. POST …/signin/complete  {accountName, c, m1, m2, rememberMe, trustTokens}
         200 signed in: a trust token from before was enough
         409 a second factor is asked for
    4. how a code can come (GET …/appleauth/auth: options.ts); a code asked
       for on the trusted devices (PUT …/verify/trusteddevice/securitycode —
       since 2026 Apple shows none until asked) and given back (POST, same
       path), or one sent by text (PUT …/verify/phone, POST
       …/verify/phone/securitycode)
    5. GET  …/2sv/trust        → a trust token: the next sign-in asks no second factor
    6. POST setup.icloud.com/setup/ws/1/accountLogin  → the account: its dsid, its services

  What Apple says in its headers — the session's id and token, the trust
  token, scnt — and in its cookies is kept (IcloudState), so a session can
  carry on, or sign in again with the password and the trust token, with
  no person. A second factor always needs one.
*/

const IDMSA = 'https://idmsa.apple.com';
const AUTH = `${IDMSA}/appleauth/auth`;
const SETUP = 'https://setup.icloud.com/setup/ws/1';
const HOME = 'https://www.icloud.com';
/** iCloud's web client, as Apple knows it. */
const WIDGET_KEY = 'd39ba9916b7251055b22c7f910e2ea796ee65e98b2ddecea8f5dde8d9d1a815d';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15';
const CLIENT = { clientBuildNumber: '2534Project66', clientMasteringNumber: '2534B22' } as const;

/** What a sign-in keeps between requests, and between runs: plain data. */
export type IcloudState = {
  /** This client's id with Apple: made once, and kept. */
  clientId: string;
  accountCountry?: string;
  sessionId?: string;
  sessionToken?: string;
  trustToken?: string;
  scnt?: string;
  authAttributes?: string;
  cookies: Cookie[];
};

/** A new client, as Apple will know it. */
export const newState = (): IcloudState => ({ clientId: `auth-${randomHex(4)}-${randomHex(2)}-${randomHex(2)}-${randomHex(2)}-${randomHex(6)}`, cookies: [] });

/** The account, as accountLogin and validate answer: who it is, and where its services are. */
export type IcloudAccount = {
  dsid: string;
  /** The Find My service's root: `https://p42-fmipweb.icloud.com:443`. */
  findMe: string | null;
  /** Whether this client is trusted: no second factor asked of it. */
  trusted: boolean;
  /** Whether Apple still asks for a second factor before the services answer. */
  challenged: boolean;
};

/** Fetch, as a channel gives it: to the hosts its protocol declared. */
export type IcloudFetch = (url: string, init?: RequestInit & { timeoutMs?: number }) => Promise<Response>;

/** A refusal from Apple, by its status, in words a person acts on. */
export class AppleRefused extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/** How long Apple is left alone after it refuses sign-ins: its block outlasts minutes, and each try lengthens it. */
export const BUSY_MS = 30 * 60_000;

/**
 * Apple refusing sign-ins for a while (503 from its sign-in host): after
 * several tries it suspects them, for hours. Tried again after `until`,
 * never sooner — trying sooner makes it longer.
 */
export class AppleBusy extends NotReachable {
  constructor(readonly until: number) {
    super(`Apple is refusing sign-ins for this Apple ID for a while, usually after several tries. Try once more in about ${Math.max(1, Math.round((until - Date.now()) / 60_000))} minutes: trying sooner makes it longer`, Math.max(0, until - Date.now()));
  }
}

/** Response headers Apple's session is carried in, and where each is kept. */
const CARRIED: readonly [string, keyof IcloudState][] = [
  ['X-Apple-ID-Account-Country', 'accountCountry'],
  ['X-Apple-ID-Session-Id', 'sessionId'],
  ['X-Apple-Session-Token', 'sessionToken'],
  ['X-Apple-TwoSV-Trust-Token', 'trustToken'],
  ['scnt', 'scnt'],
  ['X-Apple-Auth-Attributes', 'authAttributes'],
];

/** One account's sign-in and its session with Apple. */
export class IcloudAuth {
  constructor(
    private fetcher: IcloudFetch,
    /** What is kept: read and changed in place, and handed back by `state`. */
    private kept: IcloudState,
    /** Told when what is kept changed: a session writes it down. */
    private onChange: (state: IcloudState) => void = () => {},
    /** Told each step of a sign-in, with Apple's answer and its request id — never a password, token or cookie. */
    private trace: (line: string) => void = () => {}
  ) {}

  get state(): IcloudState {
    return this.kept;
  }

  /** A request, with the cookies for its host, and what the answer carries kept. Throws `NotReachable` when Apple does not answer. */
  async request(url: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
    const host = new URL(url).hostname;
    const cookie = cookieHeader(this.kept.cookies, host);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...init,
        headers: { 'User-Agent': USER_AGENT, Origin: HOME, Referer: `${HOME}/`, ...(cookie ? { Cookie: cookie } : {}), ...init.headers },
        timeoutMs: 20_000,
      });
    } catch (error) {
      throw new NotReachable(`Apple did not answer: ${(error as Error).message}`);
    }
    const set = cookiesSet(response.headers, host);
    let changed = set.length > 0;
    this.kept.cookies = keep(this.kept.cookies, set);
    for (const [header, field] of CARRIED) {
      const value = response.headers.get(header);
      if (value && this.kept[field] !== value) {
        (this.kept as Record<string, unknown>)[field] = value;
        changed = true;
      }
    }
    if (changed) this.onChange(this.kept);
    const signingIn = host === new URL(AUTH).hostname;
    if (signingIn || url.includes('/accountLogin')) {
      const id = response.headers.get('X-Apple-I-Request-ID');
      this.trace(`${init.method ?? 'GET'} ${new URL(url).pathname} → ${response.status}${id ? ` (Apple’s request ${id})` : ''}`);
    }
    if (signingIn && response.status === 503) throw new AppleBusy(Date.now() + BUSY_MS);
    if (response.status >= 500) throw new NotReachable(`Apple answered ${response.status}: try again in a while`, 60_000);
    return response;
  }

  /** The headers Apple's sign-in host wants on each request. */
  #authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Accept: 'application/json, text/javascript',
      'Content-Type': 'application/json',
      'X-Apple-OAuth-Client-Id': WIDGET_KEY,
      'X-Apple-OAuth-Client-Type': 'firstPartyAuth',
      'X-Apple-OAuth-Redirect-URI': HOME,
      'X-Apple-OAuth-Require-Grant-Code': 'true',
      'X-Apple-OAuth-Response-Mode': 'web_message',
      'X-Apple-OAuth-Response-Type': 'code',
      'X-Apple-OAuth-State': this.kept.clientId,
      'X-Apple-Frame-Id': this.kept.clientId,
      'X-Apple-Widget-Key': WIDGET_KEY,
      Referer: IDMSA,
      'X-Apple-FD-Client-Info': JSON.stringify({ U: USER_AGENT, L: 'en-US', Z: 'GMT+00:00', V: '1.1', F: '' }),
      ...(this.kept.scnt ? { scnt: this.kept.scnt } : {}),
      ...(this.kept.sessionId ? { 'X-Apple-ID-Session-Id': this.kept.sessionId } : {}),
      ...(this.kept.authAttributes ? { 'X-Apple-Auth-Attributes': this.kept.authAttributes } : {}),
      ...extra,
    };
  }

  /** The query every call to iCloud's own services carries. */
  params(extra: Record<string, string> = {}): string {
    return new URLSearchParams({ ...CLIENT, clientId: this.kept.clientId, ...extra }).toString();
  }

  /**
   * Signs in with the Apple ID and password: 'signed-in' when a trust token
   * kept from before was enough, 'second-factor' when Apple asks for one.
   * Refused with words a person acts on when the password is wrong, or the
   * account is locked or must be looked at first.
   */
  async signIn(accountName: string, password: string): Promise<'signed-in' | 'second-factor'> {
    const query = new URLSearchParams({ frame_id: this.kept.clientId, skVersion: '7', iframeId: this.kept.clientId, client_id: WIDGET_KEY, redirect_uri: HOME, response_type: 'code', response_mode: 'web_message', state: this.kept.clientId, authVersion: 'latest' });
    await this.request(`${AUTH}/authorize/signin?${query}`, { headers: this.#authHeaders({ Accept: 'text/html' }) }).catch((error: unknown) => {
      if (error instanceof NotReachable) throw error;
    });

    const client = srpStart();
    const init = await this.request(`${AUTH}/signin/init`, {
      method: 'POST',
      headers: this.#authHeaders(),
      body: JSON.stringify({ a: base64(client.A), accountName, protocols: ['s2k', 's2k_fo'] }),
    });
    if (!init.ok) throw refusal(init.status, await init.text());
    const challenge = (await init.json()) as { salt: string; b: string; c: unknown; iteration: number; protocol: SrpProtocol };
    const salt = fromBase64(challenge.salt);
    const key = passwordKey(password, salt, challenge.iteration, challenge.protocol);
    const proofs = srpProofs({ client, accountName, key, salt, B: fromBase64(challenge.b) });
    if (!proofs) throw new AppleRefused(400, 'Apple’s sign-in answered with a challenge no sign-in can meet: try again');

    const complete = await this.request(`${AUTH}/signin/complete?isRememberMeEnabled=true`, {
      method: 'POST',
      headers: this.#authHeaders(),
      body: JSON.stringify({ accountName, c: challenge.c, m1: base64(proofs.m1), m2: base64(proofs.m2), rememberMe: true, trustTokens: this.kept.trustToken ? [this.kept.trustToken] : [] }),
    });
    if (complete.status === 409) return 'second-factor';
    if (!complete.ok) throw refusal(complete.status, await complete.text());
    return 'signed-in';
  }

  /**
   * How a second factor can be given, as Apple says for this sign-in: asked
   * for as its sign-in page is (HTML), whose options name every route —
   * the bridge's included — where JSON may name only some.
   */
  async authOptions(): Promise<AuthOptions> {
    const response = await this.request(AUTH, { headers: this.#authHeaders({ Accept: 'text/html' }) });
    if (!response.ok) throw refusal(response.status, await response.text());
    return authOptionsOf(await response.text());
  }

  /** Has Apple show a code on the account's trusted devices: since 2026 it shows none until asked. */
  async requestCode(): Promise<void> {
    const response = await this.request(`${AUTH}/verify/trusteddevice/securitycode`, { method: 'PUT', headers: this.#authHeaders({ Accept: 'application/json' }) });
    if (!response.ok) throw refusal(response.status, await response.text());
  }

  /** Has Apple text a code to a trusted number — or call it, as the number asks. */
  async sendTextCode(phone: TrustedPhone): Promise<void> {
    const response = await this.request(`${AUTH}/verify/phone`, { method: 'PUT', headers: this.#authHeaders({ Accept: 'application/json' }), body: JSON.stringify({ phoneNumber: phoneNumberOf(phone), mode: phone.mode }) });
    if (!response.ok) throw refusal(response.status, await response.text());
  }

  /**
   * Gives the second factor's code — from a trusted device, or sent to
   * `phone` — then has Apple trust this client, and signs in to iCloud.
   * A wrong code is refused, saying so; another can be given.
   */
  async verify(code: string, phone?: TrustedPhone): Promise<IcloudAccount> {
    const response = phone === undefined
      ? await this.request(`${AUTH}/verify/trusteddevice/securitycode`, { method: 'POST', headers: this.#authHeaders({ Accept: 'application/json' }), body: JSON.stringify({ securityCode: { code } }) })
      : await this.request(`${AUTH}/verify/phone/securitycode`, { method: 'POST', headers: this.#authHeaders({ Accept: 'application/json, text/plain' }), body: JSON.stringify({ phoneNumber: phoneNumberOf(phone), securityCode: { code }, mode: phone.mode }) });
    const answered = await response.text();
    if (!response.ok && !(response.status === 409 && acceptedConflict(answered))) {
      if (response.status === 400 || response.status === 401) throw new AppleRefused(response.status, 'That code was not the one Apple sent: try again, or have another sent');
      // A code from the devices Apple will not take this way: its newer route asks for one by text instead.
      if (response.status === 409 && phone === undefined) throw new AppleRefused(409, 'Apple did not take a code from your devices this way: have one texted instead');
      throw refusal(response.status, answered);
    }
    const trusted = await this.request(`${AUTH}/2sv/trust`, { headers: this.#authHeaders() });
    if (!trusted.ok) throw refusal(trusted.status, await trusted.text());
    return this.accountLogin();
  }

  /** Signs in to iCloud with the session Apple's sign-in made: the account, and where its services are. */
  async accountLogin(): Promise<IcloudAccount> {
    const response = await this.request(`${SETUP}/accountLogin?${this.params()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ accountCountryCode: this.kept.accountCountry, dsWebAuthToken: this.kept.sessionToken, extended_login: true, trustToken: this.kept.trustToken ?? '' }),
    });
    if (!response.ok) throw refusal(response.status, await response.text());
    return accountOf(await response.json());
  }

  /** Whether the session kept from before still holds, with no password: the account if it does, null when it must be signed in again. */
  async validate(): Promise<IcloudAccount | null> {
    if (!this.kept.sessionToken) return null;
    const response = await this.request(`${SETUP}/validate?${this.params()}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: 'null' });
    if (!response.ok) return null;
    return accountOf(await response.json());
  }

  /**
   * Carries the session on with no person: what was kept, or a sign-in with
   * the password and the trust token. A second factor asked for again is
   * `NeedsSignIn`: a person signs in on the account's page.
   */
  async resume(accountName: string, password: string): Promise<IcloudAccount> {
    const held = await this.validate();
    if (held && held.trusted && !held.challenged) return held;
    const signedIn = await this.signIn(accountName, password).catch((error: unknown) => {
      if (error instanceof AppleRefused && (error.status === 401 || error.status === 403)) throw new NeedsSignIn(error.message);
      throw error;
    });
    if (signedIn === 'second-factor') throw new NeedsSignIn('Apple asks for a code again: sign in on the account’s page');
    const account = await this.accountLogin();
    if (account.challenged) throw new NeedsSignIn('Apple asks for a code again: sign in on the account’s page');
    return account;
  }
}

/** A refusal, by its status: what a person reads. */
function refusal(status: number, body: string): AppleRefused {
  if (status === 401) return new AppleRefused(status, 'Apple did not accept that Apple ID and password');
  if (status === 403) return new AppleRefused(status, 'Apple has locked this Apple ID for now: unlock it at iforgot.apple.com');
  if (status === 412) return new AppleRefused(status, 'Apple asks you to look at this Apple ID first: sign in at appleid.apple.com, then try again');
  if (status === 421 || status === 450) return new AppleRefused(status, 'iCloud no longer takes this session: sign in again');
  return new AppleRefused(status, `Apple refused (${status})${body.trim() ? `: ${body.trim().slice(0, 200)}` : ''}`);
}

/** A trusted number as Apple's verify calls want it back. */
const phoneNumberOf = (phone: TrustedPhone) => ({ id: phone.id, ...(phone.nonFTEU !== undefined ? { nonFTEU: phone.nonFTEU } : {}) });

/** A 409 to a code that says it was the right one: Apple accepts it so. */
function acceptedConflict(body: string): boolean {
  try {
    return (JSON.parse(body) as { securityCode?: { valid?: boolean } }).securityCode?.valid === true;
  } catch {
    return false;
  }
}

/** The account as Apple answers it. */
function accountOf(data: unknown): IcloudAccount {
  const said = data as { dsInfo?: { dsid?: unknown }; webservices?: { findme?: { url?: unknown } }; hsaTrustedBrowser?: unknown; hsaChallengeRequired?: unknown };
  if (said.dsInfo?.dsid === undefined) throw new AppleRefused(502, 'iCloud answered with no account');
  return {
    dsid: String(said.dsInfo.dsid),
    findMe: typeof said.webservices?.findme?.url === 'string' ? said.webservices.findme.url : null,
    trusted: said.hsaTrustedBrowser === true,
    challenged: said.hsaChallengeRequired === true,
  };
}

const base64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
