import type { Position } from '@kraftverk/device-sdk';

import { AppleRefused, type IcloudAccount, type IcloudAuth } from './auth.ts';

/*
  Find My, as iCloud's web client asks it (pyicloud's findmyiphone, MIT;
  NOTICE): every device of the account — and, with the family, of its
  Family Sharing members — where it is and how charged; a sound played on
  one; lost mode. People's own locations (Find My Friends) are not on the
  web any more: only their devices.
*/

/** One device as Find My lists it. */
export type FoundDevice = {
  /** Find My's id for it: what a sound or lost mode is asked for. Stable for as long as it is in Find My. */
  id: string;
  /** What its owner calls it: "Olof's iPhone". */
  name: string;
  /** What it is, as people say: "iPhone 15 Pro". */
  model: string;
  /** What it is, as Apple codes it: "iPhone16,1". */
  rawModel: string | null;
  /** Its kind: iPhone, iPad, Mac, Watch, AirPods, Accessory. */
  deviceClass: string | null;
  /** Its charge, 0–100, when it says. */
  battery: number | null;
  /** Charging, Charged, NotCharging — or Unknown. */
  batteryStatus: string | null;
  /** Where it is, and when it was there; null when Find My does not know. */
  location: (Position & { at: string; old: boolean }) | null;
  /** Who it belongs to, when it is a family member's: their first name. */
  owner: string | null;
  /** Whether it can be put in lost mode. */
  lostModeCapable: boolean;
};

const CONTEXT = { appName: 'iCloud Find (Web)', appVersion: '2.0', apiVersion: '3.0', deviceListVersion: 1, fmly: true, timezone: 'UTC', inactiveTime: 0 } as const;

type RawDevice = {
  id?: unknown;
  name?: unknown;
  deviceDisplayName?: unknown;
  rawDeviceModel?: unknown;
  deviceClass?: unknown;
  batteryLevel?: unknown;
  batteryStatus?: unknown;
  lostModeCapable?: unknown;
  prsId?: unknown;
  location?: { latitude?: unknown; longitude?: unknown; horizontalAccuracy?: unknown; timeStamp?: unknown; isOld?: unknown } | null;
};

/** A device as Find My answers it, read into what a session uses. */
export function deviceOf(raw: RawDevice, members: Readonly<Record<string, string>> = {}): FoundDevice | null {
  if (typeof raw.id !== 'string') return null;
  const location = raw.location;
  const placed = location && typeof location.latitude === 'number' && typeof location.longitude === 'number';
  return {
    id: raw.id,
    name: typeof raw.name === 'string' ? raw.name : 'A device',
    model: typeof raw.deviceDisplayName === 'string' ? raw.deviceDisplayName : 'Apple device',
    rawModel: typeof raw.rawDeviceModel === 'string' ? raw.rawDeviceModel : null,
    deviceClass: typeof raw.deviceClass === 'string' ? raw.deviceClass : null,
    // Find My says a charge as 0–1.
    battery: typeof raw.batteryLevel === 'number' && raw.batteryLevel > 0 ? Math.round(raw.batteryLevel * 100) : null,
    batteryStatus: typeof raw.batteryStatus === 'string' ? raw.batteryStatus : null,
    location: placed
      ? {
          latitude: location.latitude as number,
          longitude: location.longitude as number,
          accuracy: typeof location.horizontalAccuracy === 'number' ? location.horizontalAccuracy : null,
          at: new Date(typeof location.timeStamp === 'number' ? location.timeStamp : Date.now()).toISOString(),
          // A place Find My gives no time for is not taken as fresh: when it was is not known.
          old: location.isOld === true || typeof location.timeStamp !== 'number',
        }
      : null,
    owner: typeof raw.prsId === 'string' ? (members[raw.prsId] ?? null) : null,
    lostModeCapable: raw.lostModeCapable === true,
  };
}

/** Find My for one account, over its session. */
export class FindMy {
  #started = false;

  constructor(
    private auth: IcloudAuth,
    private account: IcloudAccount
  ) {}

  #url(call: string): string {
    if (!this.account.findMe) throw new AppleRefused(404, 'This Apple ID has no Find My');
    return `${this.account.findMe.replace(/:443$/, '')}/fmipservice/client/web/${call}?${this.auth.params({ dsid: this.account.dsid })}`;
  }

  async #post(call: string, body: object): Promise<unknown> {
    const response = await this.auth.request(this.#url(call), { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
    if ([401, 421, 450, 500].includes(response.status)) throw new AppleRefused(response.status, 'iCloud no longer takes this session: sign in again');
    if (!response.ok) throw new AppleRefused(response.status, `Find My refused (${response.status})`);
    return response.json();
  }

  /** Every device of the account and its family, where each is now: located afresh. */
  async devices(): Promise<FoundDevice[]> {
    const said = (await this.#post(this.#started ? 'refreshClient' : 'initClient', { clientContext: { ...CONTEXT, shouldLocate: true, selectedDevice: 'all' } })) as {
      content?: RawDevice[];
      userInfo?: { membersInfo?: Record<string, { firstName?: string }> };
    };
    this.#started = true;
    const members = Object.fromEntries(Object.entries(said.userInfo?.membersInfo ?? {}).flatMap(([id, member]) => (member.firstName ? [[id, member.firstName]] : [])));
    return (said.content ?? []).map((raw) => deviceOf(raw, members)).filter((device) => device !== null);
  }

  /** Plays a sound on a device, wherever it is: what finding one nearby is. */
  async playSound(id: string, subject = 'Find My: a sound played from kraftverk'): Promise<void> {
    await this.#post('playSound', { device: id, subject, clientContext: { fmly: true } });
  }

  /** Puts a device in lost mode: locked, showing a message and a number to call. Someone's phone stops being usable until it is found. */
  async lostMode(id: string, options: { text: string; phone: string; passcode?: string }): Promise<void> {
    await this.#post('lostDevice', { device: id, text: options.text, userText: true, ownerNbr: options.phone, lostModeEnabled: true, trackingEnabled: true, emailUpdates: false, ...(options.passcode ? { passcode: options.passcode } : {}) });
  }
}
