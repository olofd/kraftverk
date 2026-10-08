/*
  How Apple will take a second factor, as it says once the password is
  proved: GET idmsa …/appleauth/auth. Asked for as HTML, Apple answers its
  sign-in page with the options in a `<script class="boot_args">` — the shape
  that names its newer route (the "bridge"); asked for as JSON it may answer
  them flat. Both are read, and either nesting: at the top, or under
  `direct` and `direct.twoSV` (pyicloud, MIT; NOTICE).
*/

/** A trusted number a code can be texted, or read out, to. */
export type TrustedPhone = {
  id: number;
  /** As Apple shows it: the digits mostly hidden. */
  number: string;
  /** How Apple sends to it: a text, or a call. */
  mode: 'sms' | 'voice';
  /** Apple's flag for numbers it treats apart; sent back as it came. */
  nonFTEU?: boolean;
};

/** How a second factor can be given, for this sign-in. */
export type AuthOptions = {
  /** The length of the code. */
  length: number;
  /** Whether a trusted device can show a code. */
  devices: boolean;
  /** Where Apple's own page goes next: `auth/bridge/step` is the bridge. */
  route: string | null;
  /** The bridge's starting data, when Apple offers it. */
  bridge: Record<string, unknown> | null;
  /** The app Apple names for the bridge's steps. */
  sourceAppId: string | null;
  /** The trusted numbers, the one Apple prefers first. */
  phones: TrustedPhone[];
  /** Security keys the account signs in with instead of a code. */
  securityKeys: string[];
};

type Said = Record<string, unknown>;

const record = (value: unknown): Said | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Said) : null);

/** The JSON in Apple's page's `boot_args` script, or null when there is none. */
export function bootArgsOf(html: string): Said | null {
  const found = /<script\b[^>]*\bclass\s*=\s*["'][^"']*\bboot_args\b[^"']*["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!found?.[1]?.trim()) return null;
  try {
    return record(JSON.parse(found[1]));
  } catch {
    return null;
  }
}

function phoneOf(value: unknown): TrustedPhone | null {
  const said = record(value);
  if (!said || (typeof said.id !== 'number' && typeof said.id !== 'string')) return null;
  const id = Number(said.id);
  if (!Number.isFinite(id)) return null;
  const number = [said.numberWithDialCode, said.obfuscatedNumber, said.lastTwoDigits && `•• ${said.lastTwoDigits}`].find((each) => typeof each === 'string' && each) as string | undefined;
  return {
    id,
    number: number ?? `number ${id}`,
    mode: said.pushMode === 'voice' ? 'voice' : 'sms',
    ...(typeof said.nonFTEU === 'boolean' ? { nonFTEU: said.nonFTEU } : {}),
  };
}

/** Apple's answer, as text, read whichever shape it came in. */
export function authOptionsOf(text: string): AuthOptions {
  let said: Said | null = null;
  try {
    said = record(JSON.parse(text));
  } catch {
    said = bootArgsOf(text);
  }
  said ??= {};
  const direct = record(said.direct) ?? said;
  const twoSV = record(direct.twoSV) ?? direct;
  const bridge = record(twoSV.bridgeInitiateData);
  const verification = record(twoSV.phoneNumberVerification) ?? record(bridge?.phoneNumberVerification) ?? record(said.phoneNumberVerification) ?? said;

  // The one Apple prefers first, then the rest, each once.
  const phones: TrustedPhone[] = [];
  for (const candidate of [verification.trustedPhoneNumber, ...(Array.isArray(verification.trustedPhoneNumbers) ? verification.trustedPhoneNumbers : []), ...(Array.isArray(said.trustedPhoneNumbers) ? said.trustedPhoneNumbers : [])]) {
    const phone = phoneOf(candidate);
    if (phone && !phones.some((each) => each.id === phone.id)) phones.push(phone);
  }

  const code = record(verification.securityCode) ?? record(said.securityCode);
  const noDevices = said.noTrustedDevices === true || verification.noTrustedDevices === true || direct.hasTrustedDevices === false;
  const keys = said.keyNames ?? twoSV.keyNames;
  return {
    length: typeof code?.length === 'number' ? code.length : 6,
    devices: !noDevices,
    route: typeof direct.authInitialRoute === 'string' ? direct.authInitialRoute : typeof said.authInitialRoute === 'string' ? said.authInitialRoute : null,
    bridge,
    sourceAppId: twoSV.sourceAppId !== undefined && twoSV.sourceAppId !== null ? String(twoSV.sourceAppId) : null,
    phones,
    securityKeys: Array.isArray(keys) ? keys.filter((each): each is string => typeof each === 'string') : [],
  };
}

/** Whether Apple routes this sign-in's code through the bridge. */
export const usesBridge = (options: AuthOptions): boolean => options.route === 'auth/bridge/step' && options.devices && options.bridge !== null;
