import { bigOfBytes, bytesOfBig, passwordKey, srpServer } from '../src/protocol/index.ts';

/*
  Apple, played: idmsa's sign-in — SRP with a verifier made from a password,
  so a wrong proof is refused as Apple refuses it — a second factor by a
  trusted device or by text, trust, iCloud's setup and Find My, each with
  the headers and cookies Apple carries its session in. Every name, number,
  id and place here is made up.
*/

export const APPLE_ID = 'someone@example.test';
export const PASSWORD = 'correct horse battery staple';
export const DEVICE_CODE = '123456';
export const TEXT_CODE = '654321';
export const DSID = '10000000001';

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

export function playedApple(options: { protocol?: 's2k' | 's2k_fo'; noTrustedDevices?: boolean } = {}) {
  const salt = Uint8Array.from({ length: 16 }, (_, index) => (index * 37 + 11) % 256);
  const iterations = 1000;
  const protocol = options.protocol ?? 's2k';
  const verifier = srpServer.verifier(passwordKey(PASSWORD, salt, iterations, protocol), salt);
  const b = bigOfBytes(Uint8Array.from({ length: 32 }, (_, index) => (index * 13 + 5) % 256));
  let A: Uint8Array = new Uint8Array(0);
  let B: Uint8Array = new Uint8Array(0);
  let trustToken: string | null = null;
  let sessionToken = 'session-1';
  let webauth = 'webauth-1';
  let trusted = false;
  const asked: string[] = [];
  /** Whether a second factor is asked of a trust token Apple gave: Apple may stop trusting one. */
  const control = { distrust: false, expireWebauth: false };

  const fetch = async (url: string, given: RequestInit = {}): Promise<Response> => {
    const at = new URL(url);
    const init = { ...given, headers: Object.fromEntries(new Headers(given.headers).entries()) as Record<string, string> };
    const route = `${init.method ?? 'GET'} ${at.hostname}${at.pathname}`;
    asked.push(route);
    const body = typeof init.body === 'string' && init.body !== 'null' ? (JSON.parse(init.body) as Record<string, any>) : {};
    const cookie = init.headers.cookie ?? '';
    switch (route) {
      case 'GET idmsa.apple.com/appleauth/auth/authorize/signin':
        return new Response('<html></html>', { headers: { 'Set-Cookie': 'aasp=aasp-1; Domain=.apple.com; Path=/; Secure; HttpOnly' } });
      case 'POST idmsa.apple.com/appleauth/auth/signin/init':
        if (body.accountName !== APPLE_ID || !cookie.includes('aasp=aasp-1')) return json({ serviceErrors: [{ code: '-20101' }] }, 401);
        A = fromBase64(body.a);
        B = srpServer.challenge(verifier, b);
        return json({ iteration: iterations, salt: base64(salt), protocol, b: base64(B), c: 'c-1' });
      case 'POST idmsa.apple.com/appleauth/auth/signin/complete': {
        const m1 = srpServer.expectedM1({ verifier, b, A, B, accountName: APPLE_ID, salt });
        if (body.c !== 'c-1' || body.m1 !== base64(m1)) return json({ serviceErrors: [{ code: '-20101', message: 'Your Apple ID or password was incorrect.' }] }, 401);
        const headers = { 'X-Apple-ID-Session-Id': 'sid-1', scnt: 'scnt-1', 'X-Apple-ID-Account-Country': 'SWE', 'X-Apple-Session-Token': sessionToken };
        if (trustToken && body.trustTokens?.includes(trustToken) && !control.distrust) return json({ authType: 'hsa2' }, 200, headers);
        return json({ authType: 'hsa2' }, 409, headers);
      }
      case 'GET idmsa.apple.com/appleauth/auth':
        return json({
          securityCode: { length: 6, tooManyCodesSent: false },
          noTrustedDevices: options.noTrustedDevices ?? false,
          trustedPhoneNumbers: [{ id: 1, numberWithDialCode: '+46 •• ••• •• 12', pushMode: 'sms' }],
        });
      case 'POST idmsa.apple.com/appleauth/auth/verify/trusteddevice/securitycode':
        if (init.headers.scnt !== 'scnt-1' || init.headers['x-apple-id-session-id'] !== 'sid-1') return json({}, 401);
        return body.securityCode?.code === DEVICE_CODE ? new Response(null, { status: 204 }) : json({ service_errors: [{ code: '-21669' }] }, 400);
      case 'PUT idmsa.apple.com/appleauth/auth/verify/phone':
        return json({ trustedPhoneNumber: { id: body.phoneNumber?.id } });
      case 'POST idmsa.apple.com/appleauth/auth/verify/phone/securitycode':
        return body.securityCode?.code === TEXT_CODE && body.phoneNumber?.id === 1 ? json({}) : json({ service_errors: [{ code: '-21669' }] }, 400);
      case 'GET idmsa.apple.com/appleauth/auth/2sv/trust':
        trustToken = 'trust-1';
        sessionToken = 'session-2';
        trusted = true;
        return new Response(null, { status: 204, headers: { 'X-Apple-TwoSV-Trust-Token': trustToken, 'X-Apple-Session-Token': sessionToken } });
      case 'POST setup.icloud.com/setup/ws/1/accountLogin':
        if (body.dsWebAuthToken !== sessionToken) return json({ error: 'bad token' }, 421);
        webauth = `webauth-${Number(webauth.split('-')[1]) + 1}`;
        return json(
          { dsInfo: { dsid: DSID, fullName: 'Someone Example' }, webservices: { findme: { url: 'https://p42-fmipweb.icloud.com:443', status: 'active' } }, hsaTrustedBrowser: trusted, hsaChallengeRequired: false },
          200,
          { 'Set-Cookie': `X-APPLE-WEBAUTH-TOKEN="${webauth}"; Domain=.icloud.com; Path=/; Secure; HttpOnly` }
        );
      case 'POST setup.icloud.com/setup/ws/1/validate':
        if (control.expireWebauth || !cookie.includes(`X-APPLE-WEBAUTH-TOKEN="${webauth}"`)) return json({ error: 'Missing X-APPLE-WEBAUTH-TOKEN cookie' }, 421);
        return json({ dsInfo: { dsid: DSID }, webservices: { findme: { url: 'https://p42-fmipweb.icloud.com:443' } }, hsaTrustedBrowser: trusted, hsaChallengeRequired: false });
      case 'POST p42-fmipweb.icloud.com/fmipservice/client/web/initClient':
      case 'POST p42-fmipweb.icloud.com/fmipservice/client/web/refreshClient':
        if (!cookie.includes(`X-APPLE-WEBAUTH-TOKEN="${webauth}"`) || at.searchParams.get('dsid') !== DSID) return json({}, 450);
        return json({
          userInfo: { membersInfo: { 'prs-2': { firstName: 'Alex', lastName: 'Example' } } },
          content: [
            { id: 'device-1', name: 'Someone’s iPhone', deviceDisplayName: 'iPhone 15 Pro', rawDeviceModel: 'iPhone16,1', deviceClass: 'iPhone', batteryLevel: 0.81, batteryStatus: 'NotCharging', lostModeCapable: true, prsId: 'prs-1', location: { latitude: 59.33, longitude: 18.06, horizontalAccuracy: 12.5, timeStamp: 1_760_000_000_000, isOld: false } },
            { id: 'device-2', name: 'Alex’s iPhone', deviceDisplayName: 'iPhone 13', deviceClass: 'iPhone', batteryLevel: 0.42, batteryStatus: 'Charging', lostModeCapable: true, prsId: 'prs-2', location: { latitude: 59.31, longitude: 18.02, horizontalAccuracy: 30, timeStamp: 1_760_000_100_000, isOld: false } },
            { id: 'device-3', name: 'Someone’s MacBook', deviceDisplayName: 'MacBook Air', deviceClass: 'MacBookAir', batteryLevel: 0, lostModeCapable: true, location: null },
          ],
        });
      case 'POST p42-fmipweb.icloud.com/fmipservice/client/web/playSound':
      case 'POST p42-fmipweb.icloud.com/fmipservice/client/web/lostDevice':
        return json({ statusCode: '200', content: [] });
      default:
        return json({ error: `not played: ${route}` }, 404);
    }
  };

  return { fetch, asked, control, trustToken: () => trustToken, bytes: { bigOfBytes, bytesOfBig } };
}
