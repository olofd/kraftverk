import { describe, expect, test } from 'bun:test';

import { memoryHeld, memoryKept, needsSignIn, validateProtocol, type SetupContext } from '@kraftverk/device-sdk';

import protocol, { AppleBusy, authOptionsOf, cookieHeader, cookiesSet, FindMy, IcloudAuth, keep, newState, passwordKey, renewalDue, srpProofs, srpServer, srpStart, stateOf, trustUntil, usesBridge, type IcloudFetch } from '../src/protocol/index.ts';
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
  held: memoryHeld(),
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
      expect(proofs.m1).toEqual(srpServer.expected({ verifier, b, A: client.A, B, accountName: 'someone@example.test', salt }).m1);
      // The wrong password proves nothing.
      const wrong = srpProofs({ client, accountName: 'someone@example.test', key: passwordKey('another', salt, 50, kind), salt, B })!;
      expect(wrong.m1).not.toEqual(proofs.m1);
    }
    // The two ways differ.
    expect(passwordKey('pw', new Uint8Array(16), 10, 's2k')).not.toEqual(passwordKey('pw', new Uint8Array(16), 10, 's2k_fo'));
  });

  test('padded as Apple’s own client pads: an A that begins with a zero byte is sent whole, and proves the password still; a name in capitals is the same name', () => {
    const salt = new Uint8Array(16).fill(3);
    const key = passwordKey('a password', salt, 10, 's2k');
    const verifier = srpServer.verifier(key, salt);
    const b = 0xfeedfacecafebeefn;
    const B = srpServer.challenge(verifier, b);
    // About one A in 256 begins with a zero byte: found, as a sign-in may meet it.
    let seed = 0;
    let client = srpStart(new Uint8Array(32).fill(0));
    for (; seed < 5000; seed++) {
      client = srpStart(Uint8Array.from({ length: 32 }, (_, index) => (index * 31 + seed * 7 + (seed >> 8)) % 256));
      if (client.A[0] === 0) break;
    }
    expect(client.A[0]).toBe(0);
    expect(client.A.length).toBe(256);
    const proofs = srpProofs({ client, accountName: 'Someone@Example.TEST', key, salt, B })!;
    const server = srpServer.expected({ verifier, b, A: client.A, B, accountName: 'someone@example.test', salt });
    expect(proofs.m1).toEqual(server.m1);
    // The key both now share: what Apple's escrow step is handed.
    expect(proofs.K).toEqual(server.K);
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
  test('a code shown on the devices, asked for in a turn of its own; the trust token kept; then who is in Find My, the family’s included', async () => {
    const apple = playedApple();
    const ctx = contextFor(apple.fetch);
    const first = await signInAction.run(ctx, {});
    expect(first).toMatchObject({ ok: true, detail: 'Apple asks for a code', ask: { schema: { fields: { code: { type: 'string', presentation: 'code', length: 6, required: true } } } } });
    // The code is asked for: Apple shows none on the devices until it is.
    expect(apple.asked).toContain('PUT idmsa.apple.com/appleauth/auth/verify/trusteddevice/securitycode');
    // What the next turn needs, never shown: the session half made, and how this sign-in may be answered.
    expect(typeof first.ask!.carry!.state).toBe('string');
    expect(typeof first.ask!.carry!.talk).toBe('string');

    const wrong = await signInAction.run(ctx, { ...first.ask!.carry, code: '000000' });
    expect(wrong).toMatchObject({ ok: false, detail: 'That code was not the one Apple sent: try again, or have another sent', ask: { instead: { title: 'Didn’t get a code?' } } });

    const done = await signInAction.run(ctx, { ...wrong.ask!.carry, code: DEVICE_CODE });
    expect(done).toMatchObject({ ok: true, detail: 'Signed in to iCloud: Someone’s iPhone, Alex’s iPhone (Alex), Someone’s MacBook are in its Find My.' });
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
    expect(await signInAction.run(ctx, { ...first.ask!.carry, code: '123 456' })).toMatchObject({ ok: true });
    // With nothing typed and nothing kept, it says what is missing, and asks Apple nothing.
    const before = apple.asked.length;
    expect(await signInAction.run(ctx, {})).toEqual({ ok: false, detail: 'Type your Apple ID and its password' });
    expect(apple.asked.length).toBe(before);
  });

  test('didn’t get a code: shown again, texted, or read out by a call — each waiting longer than the last', async () => {
    const apple = playedApple();
    const ctx = contextFor(apple.fetch);
    const first = await signInAction.run(ctx, {});
    const options = first.ask!.instead!.options;
    expect(options.map((option) => option.label)).toEqual(['Show it on my devices again', 'Text it to +46 •• ••• •• 12', 'Call +46 •• ••• •• 12']);
    const wait = (result: typeof first) => Date.parse(result.ask!.instead!.options[0]!.after!) - Date.now();
    expect(wait(first)).toBeGreaterThan(25_000);
    expect(wait(first)).toBeLessThanOrEqual(30_000);

    const again = await signInAction.run(ctx, { ...first.ask!.carry, ...options[0]!.answer });
    expect(again).toMatchObject({ ok: true, detail: 'Apple shows a new code on your devices' });
    expect(wait(again)).toBeGreaterThan(55_000);

    const texted = await signInAction.run(ctx, { ...again.ask!.carry, ...options[1]!.answer });
    expect(texted).toMatchObject({ ok: true, detail: 'A code is on its way to +46 •• ••• •• 12', ask: { schema: { help: 'Apple sent a code by text to +46 •• ••• •• 12.' } } });
    expect(wait(texted)).toBeGreaterThan(115_000);
    expect(apple.asked).toContain('PUT idmsa.apple.com/appleauth/auth/verify/phone');
    // The code from the text is given back as the text came: to that number.
    expect(await signInAction.run(ctx, { ...texted.ask!.carry, code: TEXT_CODE })).toMatchObject({ ok: true });

    const called = await signInAction.run(contextFor(apple.fetch), { ...first.ask!.carry, ...options[2]!.answer });
    expect(called).toMatchObject({ ok: true, detail: 'Apple is calling +46 •• ••• •• 12', ask: { schema: { help: 'Apple is calling +46 •• ••• •• 12: it reads out a code.' } } });
  });

  test('Apple’s options as its JSON once had them, flat, are read as well', async () => {
    const apple = playedApple({ flat: true });
    const ctx = contextFor(apple.fetch);
    const first = await signInAction.run(ctx, {});
    expect(first.ask!.instead!.options).toHaveLength(3);
    expect(await signInAction.run(ctx, { ...first.ask!.carry, code: DEVICE_CODE })).toMatchObject({ ok: true });
  });

  test('an Apple ID with no trusted device has a code texted at once; one whose devices show none, too', async () => {
    const apple = playedApple({ noTrustedDevices: true, protocol: 's2k_fo' });
    const first = await signInAction.run(contextFor(apple.fetch), {});
    expect(first).toMatchObject({ ok: true, detail: 'Apple sent a code to +46 •• ••• •• 12' });
    // Nothing to show on devices that are not there.
    expect(first.ask!.instead!.options.map((option) => option.label)).toEqual(['Text it to +46 •• ••• •• 12', 'Call +46 •• ••• •• 12']);

    const refusing = playedApple();
    refusing.control.refuseDeviceCode = true;
    expect(await signInAction.run(contextFor(refusing.fetch), {})).toMatchObject({ ok: true, detail: 'Apple sent a code to +46 •• ••• •• 12' });
  });

  test('a mistyped code keeps its question, and its other ways', async () => {
    const apple = playedApple();
    const ctx = contextFor(apple.fetch);
    const first = await signInAction.run(ctx, {});
    const typo = await signInAction.run(ctx, { ...first.ask!.carry, code: '12' });
    expect(typo).toMatchObject({ ok: false, detail: 'Type the 6 digits Apple shows', ask: { schema: { fields: { code: {} } }, instead: {} } });
    expect(await signInAction.run(ctx, { ...typo.ask!.carry, code: DEVICE_CODE })).toMatchObject({ ok: true });
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
    expect(Date.parse(refused.retryAt!) - Date.now()).toBeGreaterThan(29 * 60_000);
    expect(lines).toContain('iCloud: GET /appleauth/auth/authorize/signin → 503 (Apple’s request req-busy)');
    expect(lines.join('\n')).not.toContain(PASSWORD);
  });

  test('Apple’s "not now" is kept for the Apple ID: a sign-in pressed again before then asks Apple nothing', async () => {
    const apple = playedApple();
    apple.control.busy = true;
    const ctx = contextFor(apple.fetch);
    await signInAction.run(ctx, {});
    const asked = apple.asked.length;
    apple.control.busy = false;
    const again = await signInAction.run(ctx, {});
    expect(again).toMatchObject({ ok: false, retryAt: expect.any(String) });
    expect(apple.asked.length).toBe(asked);
  });

  test('a code turn Apple fails to answer for a moment keeps its question; an answer whose sign-in is lost ends, asking Apple nothing', async () => {
    const apple = playedApple();
    const ctx = contextFor(apple.fetch);
    const first = await signInAction.run(ctx, {});
    const carry = { ...first.ask!.carry };
    apple.control.busy = true;
    const hiccup = await signInAction.run(ctx, { ...carry, code: DEVICE_CODE });
    expect(hiccup).toMatchObject({ ok: false, ask: { schema: { fields: { code: {} } } } });
    const asked = apple.asked.length;
    expect(await signInAction.run(ctx, { code: DEVICE_CODE })).toEqual({ ok: false, detail: 'That sign-in has ended: sign in again' });
    expect(apple.asked.length).toBe(asked);
  });

  test('terms Apple asks to be accepted are the person’s to accept: said so, never accepted here', async () => {
    const apple = playedApple();
    apple.control.terms = true;
    const ctx = contextFor(apple.fetch);
    const first = await signInAction.run(ctx, {});
    expect(await signInAction.run(ctx, { ...first.ask!.carry, code: DEVICE_CODE })).toEqual({ ok: false, detail: 'Apple asks you to accept its updated iCloud terms: sign in at icloud.com once and accept them, then sign in here again' });
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

  test('Apple’s escrow step: after the code, and after the trust token, the password proved once more — and no code asked again', async () => {
    const apple = playedApple();
    apple.control.escrow = true;
    const ctx = contextFor(apple.fetch);
    const first = await signInAction.run(ctx, {});
    const done = await signInAction.run(ctx, { ...first.ask!.carry, code: DEVICE_CODE });
    expect(done).toMatchObject({ ok: true });
    expect(apple.escrowed()).toBe(1);

    // Its session gone: signed in again with the password and the trust token — escrowed, never a code.
    apple.control.expireWebauth = true;
    const auth = new IcloudAuth(apple.fetch, stateOf(done.suggestedConfig!.session as string));
    const again = await auth.resume(APPLE_ID, PASSWORD);
    expect(again.dsid).toBe(DSID);
    expect(apple.escrowed()).toBe(2);
    expect(apple.asked.filter((route) => route === 'PUT idmsa.apple.com/appleauth/auth/verify/trusteddevice/securitycode')).toHaveLength(1);
  });

  test('signed in until its trust ends; renewed past half of it with the trust token — no code — and not before', async () => {
    const { apple, state } = await trustedSession();
    const until = trustUntil(state)!;
    expect(Math.round((until - Date.now()) / 86_400_000)).toBe(90);
    const auth = new IcloudAuth(apple.fetch, state);
    const signIns = () => apple.asked.filter((route) => route === 'POST idmsa.apple.com/appleauth/auth/signin/complete').length;
    const before = signIns();

    // A day on: the session holds, nothing renewed.
    await auth.resume(APPLE_ID, PASSWORD, Date.now() + 86_400_000);
    expect(signIns()).toBe(before);
    expect(renewalDue(auth.state, Date.now() + 44 * 86_400_000)).toBe(false);

    // Past half its trust: signed in again with it — Apple takes the trust token, no code — and counted from now.
    const later = Date.now() + 46 * 86_400_000;
    expect(renewalDue(auth.state, later)).toBe(true);
    await auth.resume(APPLE_ID, PASSWORD, later);
    expect(signIns()).toBe(before + 1);
    expect(renewalDue(auth.state, later)).toBe(false);
  });

  test('a renewal Apple answers with a code is put off, never the end of a session that still works', async () => {
    const { apple, state } = await trustedSession();
    apple.control.distrust = true;
    const auth = new IcloudAuth(apple.fetch, state);
    const later = Date.now() + 46 * 86_400_000;
    expect(await auth.resume(APPLE_ID, PASSWORD, later)).toMatchObject({ dsid: DSID, trusted: true });
  });

  test('Apple refusing a silent sign-in is waited out, twice as long each time, and the wait outlives a restart', async () => {
    const { apple, state } = await trustedSession();
    apple.control.expireWebauth = true;
    apple.control.busy = true;
    const now = Date.now();
    const auth = new IcloudAuth(apple.fetch, state);
    const first = await auth.resume(APPLE_ID, PASSWORD, now).catch((error: unknown) => error);
    expect(first).toBeInstanceOf(AppleBusy);
    expect(Math.round(((first as AppleBusy).until - now) / 60_000)).toBe(30);

    // Asked again at once — or after a restart, from what was kept: Apple is not asked.
    const asked = apple.asked.length;
    const restarted = new IcloudAuth(apple.fetch, stateOf(JSON.stringify(auth.state)));
    expect(await restarted.resume(APPLE_ID, PASSWORD, now + 60_000).catch((error: unknown) => error)).toBeInstanceOf(AppleBusy);
    expect(apple.asked.length).toBe(asked + 1); // the session's check, never a sign-in

    // Refused again after its wait: twice as long.
    const second = await restarted.resume(APPLE_ID, PASSWORD, now + 31 * 60_000).catch((error: unknown) => error);
    expect(Math.round(((second as AppleBusy).until - (now + 31 * 60_000)) / 60_000)).toBe(60);

    // Apple taking it again: the count starts over.
    apple.control.busy = false;
    await restarted.resume(APPLE_ID, PASSWORD, now + 92 * 60_000);
    expect(restarted.state.failures).toBe(0);
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
