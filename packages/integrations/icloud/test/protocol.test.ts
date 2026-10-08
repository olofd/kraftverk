import { describe, expect, test } from 'bun:test';

import { memoryKept, needsSignIn, validateProtocol, type SetupContext } from '@kraftverk/device-sdk';

import protocol, { authOptionsOf, cookieHeader, cookiesSet, FindMy, IcloudAuth, keep, newState, passwordKey, srpProofs, srpServer, srpStart, stateOf, usesBridge, type IcloudFetch } from '../src/protocol/index.ts';
import { APPLE_ID, DEVICE_CODE, DSID, PASSWORD, playedApple, TEXT_CODE } from './apple.ts';

/*
  iCloud's protocol (docs/PLAN-INTEGRATIONS.md step 17), against Apple
  played with made-up data (apple.ts): the SRP proof checked by a server
  that knows only a verifier, a second factor in turns through `ask`, the
  trust token kept so the next sign-in asks none, and Find My with a
  family member's device.
*/

const signInAction = protocol.credentials!.actions!.find((action) => action.id === 'signIn')!;

/** The setup context an action is run with, its HTTP Apple's played one. */
const contextFor = (fetch: IcloudFetch, password = PASSWORD): SetupContext => ({
  adding: { typeId: 'icloud.account', kind: 'account' },
  kept: memoryKept(),
  draft: {},
  connection: { appleId: APPLE_ID },
  address: 'https://setup.icloud.com',
  secrets: { get: (field) => (field === 'password' ? password : null) },
  http: (url, init) => fetch(url, init),
  sightings: [],
  log: { info: () => {}, warn: () => {}, error: () => {} },
  signal: AbortSignal.timeout(10_000),
  platform: 'system',
});

describe('SRP, as Apple’s sign-in speaks it', () => {
  test('the proof of a password is what a server holding only its verifier expects — for either way Apple stretches it', () => {
    for (const kind of ['s2k', 's2k_fo'] as const) {
      const salt = new Uint8Array(16).fill(7);
      const key = passwordKey('a password', salt, 50, kind);
      const verifier = srpServer.verifier(key, salt);
      const b = 0x1234567890abcdefn;
      const client = srpStart();
      const B = srpServer.challenge(verifier, b);
      const proofs = srpProofs({ client, accountName: 'someone@example.test', key, salt, B })!;
      expect(proofs.m1).toEqual(srpServer.expectedM1({ verifier, b, A: client.A, B, accountName: 'someone@example.test', salt }));
      // The wrong password proves nothing.
      const wrong = srpProofs({ client, accountName: 'someone@example.test', key: passwordKey('another', salt, 50, kind), salt, B })!;
      expect(wrong.m1).not.toEqual(proofs.m1);
    }
    // The two ways differ.
    expect(passwordKey('pw', new Uint8Array(16), 10, 's2k')).not.toEqual(passwordKey('pw', new Uint8Array(16), 10, 's2k_fo'));
  });

  test('a challenge no honest server sends is refused', () => {
    expect(srpProofs({ client: srpStart(), accountName: 'x', key: new Uint8Array(32), salt: new Uint8Array(16), B: new Uint8Array([0]) })).toBeNull();
  });
});

describe('cookies', () => {
  test('kept by the domain they were set for, sent to it and under it, dropped when they expire', () => {
    const headers = new Headers();
    headers.append('Set-Cookie', 'X-APPLE-WEBAUTH-TOKEN="t-1"; Domain=.icloud.com; Path=/; Secure; HttpOnly');
    headers.append('Set-Cookie', 'aasp=a-1; Path=/; Max-Age=60');
    const jar = keep([], cookiesSet(headers, 'idmsa.apple.com', 0), 0);
    expect(cookieHeader(jar, 'p42-fmipweb.icloud.com', 0)).toBe('X-APPLE-WEBAUTH-TOKEN="t-1"');
    expect(cookieHeader(jar, 'idmsa.apple.com', 0)).toBe('aasp=a-1');
    expect(cookieHeader(jar, 'evil.test', 0)).toBeNull();
    expect(cookieHeader(jar, 'idmsa.apple.com', 120_000)).toBeNull();
    const cleared = new Headers({ 'Set-Cookie': 'aasp=; Path=/; Max-Age=0' });
    expect(keep(jar, cookiesSet(cleared, 'idmsa.apple.com', 0), 0).map((cookie) => cookie.name)).toEqual(['X-APPLE-WEBAUTH-TOKEN']);
  });
});

describe('the protocol', () => {
  test('is a valid protocol, reaching Apple’s sign-in and iCloud’s hosts', () => {
    expect(validateProtocol(protocol)).toEqual([]);
    expect(protocol.bindings.https!.open('https://setup.icloud.com')).toEqual({ alsoOrigins: ['https://idmsa.apple.com', 'https://*.icloud.com'] });
    expect(protocol.credentials?.schema.fields.session).toMatchObject({ presentation: 'secret', kept: 'session' });
  });
});

describe('signing in, as setup does', () => {
  test('a code from a trusted device, asked for in a turn of its own; the trust token kept; then Find My, the family’s included', async () => {
    const apple = playedApple();
    const ctx = contextFor(apple.fetch);
    const first = await signInAction.run(ctx, {});
    expect(first).toMatchObject({ ok: true, ask: { schema: { fields: { code: { type: 'string' } } } } });
    // What the next turn needs, never shown: the session half made.
    expect(typeof first.ask!.carry!.state).toBe('string');

    const wrong = await signInAction.run(ctx, { ...first.ask!.carry, code: '000000' });
    expect(wrong).toMatchObject({ ok: false, detail: 'That code was not the one Apple sent: try again, or have another sent' });
    expect(wrong.ask).toBeDefined();

    const done = await signInAction.run(ctx, { ...wrong.ask!.carry, code: DEVICE_CODE });
    expect(done).toMatchObject({ ok: true, detail: 'Signed in to iCloud: 3 devices in Find My, the family’s included.' });
    const kept = stateOf(done.suggestedConfig!.session as string);
    expect(kept.trustToken).toBe('trust-1');
    expect(kept.cookies.some((cookie) => cookie.name === 'X-APPLE-WEBAUTH-TOKEN')).toBe(true);
    // The password was never sent: only proofs of it.
    expect(apple.asked).toContain('POST idmsa.apple.com/appleauth/auth/signin/complete');
  });

  test('with what is typed, nothing saved before: what was typed is kept with the question, so the next turn has it', async () => {
    const apple = playedApple();
    const ctx = { ...contextFor(apple.fetch), connection: {}, secrets: { get: () => null } };
    const first = await signInAction.run(ctx, { appleId: ` ${APPLE_ID} `, password: PASSWORD });
    expect(first).toMatchObject({ ok: true, detail: 'Apple asks for a code', suggestedConfig: { appleId: APPLE_ID, password: PASSWORD } });
    // The code is asked for: Apple shows none on the devices until it is.
    expect(apple.asked).toContain('PUT idmsa.apple.com/appleauth/auth/verify/trusteddevice/securitycode');
    expect(await signInAction.run(ctx, { ...first.ask!.carry, code: '123 456' })).toMatchObject({ ok: true });
    // With nothing typed and nothing kept, it says what is missing, and asks Apple nothing.
    const before = apple.asked.length;
    expect(await signInAction.run(ctx, {})).toEqual({ ok: false, detail: 'Type your Apple ID and its password' });
    expect(apple.asked.length).toBe(before);
  });

  test('by text instead, when asked: a code to the trusted number, sent back as Apple named it', async () => {
    const apple = playedApple();
    const ctx = contextFor(apple.fetch);
    const first = await signInAction.run(ctx, {});
    expect(first.ask!.schema.fields.byText).toMatchObject({ title: 'Text it to +46 •• ••• •• 12 instead' });
    const texted = await signInAction.run(ctx, { ...first.ask!.carry, byText: true });
    expect(texted).toMatchObject({ ok: true, detail: 'A code is on its way by text', ask: { schema: { help: 'Apple sent a code by text to +46 •• ••• •• 12.' } } });
    expect(apple.asked).toContain('PUT idmsa.apple.com/appleauth/auth/verify/phone');
    expect(await signInAction.run(ctx, { ...texted.ask!.carry, code: TEXT_CODE })).toMatchObject({ ok: true });
  });

  test('Apple’s options as its JSON once had them, flat, are read as well', async () => {
    const apple = playedApple({ flat: true });
    const ctx = contextFor(apple.fetch);
    const first = await signInAction.run(ctx, {});
    expect(first.ask!.schema.fields.byText).toBeDefined();
    expect(await signInAction.run(ctx, { ...first.ask!.carry, code: DEVICE_CODE })).toMatchObject({ ok: true });
  });

  test('an Apple ID with no trusted device has a code texted at once; one whose devices show none, too', async () => {
    const apple = playedApple({ noTrustedDevices: true, protocol: 's2k_fo' });
    const first = await signInAction.run(contextFor(apple.fetch), {});
    expect(first).toMatchObject({ ok: true, detail: 'Apple sent a code by text' });
    expect(JSON.parse(first.ask!.carry!.phone as string)).toMatchObject({ id: 1, mode: 'sms' });

    const refusing = playedApple();
    refusing.control.refuseDeviceCode = true;
    expect(await signInAction.run(contextFor(refusing.fetch), {})).toMatchObject({ ok: true, detail: 'Apple sent a code by text' });
  });

  test('a mistyped code keeps its question, with a text still offered', async () => {
    const apple = playedApple();
    const ctx = contextFor(apple.fetch);
    const first = await signInAction.run(ctx, {});
    const typo = await signInAction.run(ctx, { ...first.ask!.carry, code: '12' });
    expect(typo).toMatchObject({ ok: false, detail: 'Type the digits Apple shows', ask: { schema: { fields: { byText: {} } } } });
    const wrong = await signInAction.run(ctx, { ...typo.ask!.carry, code: '000000' });
    expect(wrong.ask!.schema.fields.byText).toBeDefined();
  });

  test('the wrong password is said so, and nothing is kept', async () => {
    const apple = playedApple();
    const refused = await signInAction.run(contextFor(apple.fetch, 'not it'), {});
    expect(refused).toEqual({ ok: false, detail: 'Apple did not accept that Apple ID and password' });
  });

  test('Apple refusing sign-ins for a while is said so, with when to try once more — and each step is in the log', async () => {
    const apple = playedApple();
    apple.control.busy = true;
    const lines: string[] = [];
    const ctx = { ...contextFor(apple.fetch), log: { info: (line: string) => lines.push(line), warn: (line: string) => lines.push(line), error: () => {} } };
    const refused = await signInAction.run(ctx, {});
    expect(refused.ok).toBe(false);
    expect(refused.detail).toMatch(/^Apple is refusing sign-ins for this Apple ID for a while, usually after several tries\. Try once more in about 30 minutes/);
    expect(lines).toContain('iCloud: GET /appleauth/auth/authorize/signin → 503 (Apple’s request req-busy)');
    expect(lines.join('\n')).not.toContain(PASSWORD);
  });
});

describe('Apple’s options for a second factor', () => {
  test('from its page’s boot_args, nested; flat JSON; and the bridge it may name', () => {
    const phone = { id: 3, obfuscatedNumber: '•• 34', pushMode: 'voice', nonFTEU: true };
    const page = `<html><script class="boot_args" type="application/json">${JSON.stringify({ direct: { authInitialRoute: 'auth/bridge/step', hasTrustedDevices: true, twoSV: { sourceAppId: 1159, bridgeInitiateData: { apnsTopic: 'com.apple.idmsauthwidget', phoneNumberVerification: { trustedPhoneNumbers: [phone] } } } } })}</script></html>`;
    const nested = authOptionsOf(page);
    expect(nested).toMatchObject({ route: 'auth/bridge/step', devices: true, sourceAppId: '1159', phones: [{ id: 3, number: '•• 34', mode: 'voice', nonFTEU: true }] });
    expect(usesBridge(nested)).toBe(true);

    const flat = authOptionsOf(JSON.stringify({ noTrustedDevices: true, securityCode: { length: 6 }, trustedPhoneNumbers: [{ id: 1, numberWithDialCode: '+46 12' }], keyNames: ['YubiKey'] }));
    expect(flat).toMatchObject({ devices: false, route: null, bridge: null, phones: [{ id: 1, number: '+46 12', mode: 'sms' }], securityKeys: ['YubiKey'] });
    expect(usesBridge(flat)).toBe(false);

    // A page with nothing readable is no options at all, not a failure.
    expect(authOptionsOf('<html></html>')).toMatchObject({ length: 6, devices: true, phones: [] });
  });
});

describe('a session carried on', () => {
  /** A session Apple trusts: signed in once, with a code. */
  const trustedSession = async () => {
    const apple = playedApple();
    const ctx = contextFor(apple.fetch);
    const first = await signInAction.run(ctx, {});
    const done = await signInAction.run(ctx, { ...first.ask!.carry, code: DEVICE_CODE });
    return { apple, state: stateOf(done.suggestedConfig!.session as string) };
  };

  test('with no person: what was kept holds, and when it does not, the password and the trust token sign in again, no code asked', async () => {
    const { apple, state } = await trustedSession();
    let written = 0;
    const auth = new IcloudAuth(apple.fetch, state, () => void written++);
    expect(await auth.resume(APPLE_ID, PASSWORD)).toMatchObject({ dsid: DSID, trusted: true });

    apple.control.expireWebauth = true;
    const again = await auth.resume(APPLE_ID, PASSWORD);
    expect(again.dsid).toBe(DSID);
    expect(written).toBeGreaterThan(0);
    apple.control.expireWebauth = false;

    const findMy = new FindMy(auth, again);
    const devices = await findMy.devices();
    expect(devices.map((device) => [device.name, device.owner, device.battery])).toEqual([
      ['Someone’s iPhone', null, 81],
      ['Alex’s iPhone', 'Alex', 42],
      ['Someone’s MacBook', null, null],
    ]);
    expect(devices[0]!.location).toEqual({ latitude: 59.33, longitude: 18.06, accuracy: 12.5, at: new Date(1_760_000_000_000).toISOString(), old: false });
    expect(devices[2]!.location).toBeNull();
    await findMy.playSound('device-2');
    await findMy.lostMode('device-2', { text: 'Found it? Call me', phone: '+46 70 000 00 00' });
    expect(apple.asked).toContain('POST p42-fmipweb.icloud.com/fmipservice/client/web/lostDevice');
  });

  test('when Apple asks for a code again, a person must sign in: NeedsSignIn', async () => {
    const { apple, state } = await trustedSession();
    apple.control.expireWebauth = true;
    apple.control.distrust = true;
    const thrown = await new IcloudAuth(apple.fetch, state).resume(APPLE_ID, PASSWORD).catch((error: unknown) => error);
    expect(needsSignIn(thrown)).toBe(true);
  });

  test('a new client is made once, and read back as it was kept', () => {
    const state = newState();
    expect(state.clientId).toMatch(/^auth-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(stateOf(JSON.stringify(state))).toEqual(state);
    expect(stateOf('not json').clientId).not.toBe(state.clientId);
  });
});
