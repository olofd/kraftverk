import { fakeByteChannel } from '@kraftverk/device-sdk/testing';

import { ed25519Pair, ed25519Sign, ed25519Verify, hkdfSha512, open, seal, x25519Pair, x25519Shared } from '../src/protocol/crypto.ts';
import { FrameType, Framer } from '../src/protocol/frames.ts';
import { pack, unpack, type Opack } from '../src/protocol/opack.ts';
import { randomPrivate, serverPublicOf, serverSide, verifierOf } from '../src/protocol/srp.ts';
import { byte, readTlv, TLV, writeTlv } from '../src/protocol/tlv8.ts';

/*
  An Apple TV, played: the TV's side of Companion, as pyatv's own fake
  device plays it — pair-setup with the PIN it shows, pair-verify against
  the pairings it keeps, then sealed OPACK requests and the events it
  sends unasked. Made-up: an Apple TV 4K at 192.0.2.70.
*/

const encoder = new TextEncoder();
const hex = (bytes: Uint8Array): string => [...bytes].map((each) => each.toString(16).padStart(2, '0')).join('');
const join = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

export const TV_ID = 'B8F2A1C4-0D3E-4F5A-9B6C-7D8E9F0A1B2C';
export const PIN = '1234';

type Message = { readonly [key: string]: Opack };

export function playedAppleTv(options: { pin?: string } = {}) {
  const pin = options.pin ?? PIN;
  const tvId = encoder.encode(TV_ID);
  const long = ed25519Pair();
  /** The pairings it keeps: each controller's id, and its long-term key. */
  const pairings = new Map<string, { key: Uint8Array; name: string | null }>();
  const asked: { id: string; content: Message }[] = [];
  const interests: string[] = [];
  const state = { attention: 3, volume: 0.3, playing: true };
  /** What can be done now, as the _iMC event says it: pause what plays, play what is paused; its volume, always. */
  const flags = () => (state.playing ? 0x0002 | 0x0004 | 0x0008 : 0x0001) | 0x0100;
  const connections: ReturnType<typeof fakeByteChannel>[] = [];
  const tellers = new Set<(id: string, content: Message) => void>();

  /** A connection to it, its own frames and pairing state; what the TV keeps, shared. */
  const connect = () => {
    let framer = new Framer();
    let setup: {
      salt: Uint8Array;
      b: bigint;
      verifier: bigint;
      K?: Uint8Array;
    } | null = null;
    let verify: {
      pair: ReturnType<typeof x25519Pair>;
      theirs: Uint8Array;
      shared: Uint8Array;
    } | null = null;

    const frame = (type: number, content: Message): Uint8Array => framer.write(type, pack(content));
    const pairingReply = (type: number, items: readonly (readonly [number, Uint8Array])[]): Uint8Array => frame(type, { _pd: writeTlv(items) });

    const pairSetup = (data: Uint8Array): Uint8Array => {
      const items = readTlv(data);
      const step = items.get(TLV.State)?.[0];
      if (step === 1) {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const b = randomPrivate();
        const verifier = verifierOf('Pair-Setup', pin, salt);
        setup = { salt, b, verifier };
        return pairingReply(FrameType.PairSetupNext, [
          [TLV.State, byte(2)],
          [TLV.Salt, salt],
          [TLV.PublicKey, serverPublicOf(verifier, b)],
        ]);
      }
      if (step === 3 && setup) {
        const outcome = serverSide({
          username: 'Pair-Setup',
          verifier: setup.verifier,
          salt: setup.salt,
          b: setup.b,
          A: items.get(TLV.PublicKey)!,
        });
        if (hex(outcome.M1) !== hex(items.get(TLV.Proof)!)) {
          setup = null;
          return pairingReply(FrameType.PairSetupNext, [
            [TLV.State, byte(4)],
            [TLV.Error, byte(2)],
          ]);
        }
        setup.K = outcome.K;
        return pairingReply(FrameType.PairSetupNext, [
          [TLV.State, byte(4)],
          [TLV.Proof, outcome.M2],
        ]);
      }
      if (step === 5 && setup?.K) {
        const key = hkdfSha512(setup.K, 'Pair-Setup-Encrypt-Salt', 'Pair-Setup-Encrypt-Info');
        const inner = readTlv(open(key, 'PS-Msg05', items.get(TLV.EncryptedData)!)!);
        const clientId = inner.get(TLV.Identifier)!;
        const clientKey = inner.get(TLV.PublicKey)!;
        const deviceX = hkdfSha512(setup.K, 'Pair-Setup-Controller-Sign-Salt', 'Pair-Setup-Controller-Sign-Info');
        if (!ed25519Verify(inner.get(TLV.Signature)!, join(deviceX, clientId, clientKey), clientKey))
          return pairingReply(FrameType.PairSetupNext, [
            [TLV.State, byte(6)],
            [TLV.Error, byte(2)],
          ]);
        const named = inner.get(TLV.Name);
        const name = named ? ((unpack(named).value as { name?: string }).name ?? null) : null;
        pairings.set(hex(clientId), { key: clientKey, name });
        const accessoryX = hkdfSha512(setup.K, 'Pair-Setup-Accessory-Sign-Salt', 'Pair-Setup-Accessory-Sign-Info');
        const signature = ed25519Sign(join(accessoryX, tvId, long.public), long.secret);
        const sealed = seal(
          key,
          'PS-Msg06',
          writeTlv([
            [TLV.Identifier, tvId],
            [TLV.PublicKey, long.public],
            [TLV.Signature, signature],
          ]),
        );
        setup = null;
        return pairingReply(FrameType.PairSetupNext, [
          [TLV.State, byte(6)],
          [TLV.EncryptedData, sealed],
        ]);
      }
      return pairingReply(FrameType.PairSetupNext, [
        [TLV.State, byte((step ?? 0) + 1)],
        [TLV.Error, byte(1)],
      ]);
    };

    const pairVerify = (data: Uint8Array): Uint8Array[] => {
      const items = readTlv(data);
      const step = items.get(TLV.State)?.[0];
      if (step === 1) {
        const pair = x25519Pair();
        const theirs = items.get(TLV.PublicKey)!;
        const shared = x25519Shared(pair.secret, theirs);
        verify = { pair, theirs, shared };
        const key = hkdfSha512(shared, 'Pair-Verify-Encrypt-Salt', 'Pair-Verify-Encrypt-Info');
        const signature = ed25519Sign(join(pair.public, tvId, theirs), long.secret);
        const sealed = seal(
          key,
          'PV-Msg02',
          writeTlv([
            [TLV.Identifier, tvId],
            [TLV.Signature, signature],
          ]),
        );
        return [
          pairingReply(FrameType.PairVerifyNext, [
            [TLV.State, byte(2)],
            [TLV.PublicKey, pair.public],
            [TLV.EncryptedData, sealed],
          ]),
        ];
      }
      if (step === 3 && verify) {
        const key = hkdfSha512(verify.shared, 'Pair-Verify-Encrypt-Salt', 'Pair-Verify-Encrypt-Info');
        const opened = open(key, 'PV-Msg03', items.get(TLV.EncryptedData)!);
        const inner = opened ? readTlv(opened) : new Map<number, Uint8Array>();
        const clientId = inner.get(TLV.Identifier);
        const paired = clientId ? pairings.get(hex(clientId)) : undefined;
        const holds = paired && ed25519Verify(inner.get(TLV.Signature)!, join(verify.theirs, clientId!, verify.pair.public), paired.key);
        if (!holds)
          return [
            pairingReply(FrameType.PairVerifyNext, [
              [TLV.State, byte(4)],
              [TLV.Error, byte(2)],
            ]),
          ];
        const reply = pairingReply(FrameType.PairVerifyNext, [[TLV.State, byte(4)]]);
        // Sealed from the next frame on: this side's keys the other way round.
        framer.encrypt({
          output: hkdfSha512(verify.shared, '', 'ServerEncrypt-main'),
          input: hkdfSha512(verify.shared, '', 'ClientEncrypt-main'),
        });
        return [reply];
      }
      return [
        pairingReply(FrameType.PairVerifyNext, [
          [TLV.State, byte(4)],
          [TLV.Error, byte(1)],
        ]),
      ];
    };

    /** What it tells after an answer: what changed, as the TV does. */
    const told: [string, Message][] = [];
    const respond = (id: string, content: Message): Message | { error: string } => {
      asked.push({ id, content });
      switch (id) {
        case '_systemInfo':
          return {};
        case '_sessionStart':
          return { _sid: 0x1234 };
        case '_sessionStop':
          return {};
        case 'FetchAttentionState':
          return { state: state.attention };
        case 'FetchLaunchableApplicationsEvent':
          return {
            'com.apple.TVWatchList': 'TV',
            'com.example.Films': 'Films',
          };
        case '_launchApp':
          return {};
        case '_hidC':
          if (content._hBtS === 2 && (content._hidC === 12 || content._hidC === 13)) {
            state.attention = content._hidC === 12 ? 1 : 3;
            told.push(['SystemStatus', { state: state.attention }]);
          }
          return {};
        case '_mcc':
          if (content._mcc === 1 || content._mcc === 2) {
            state.playing = content._mcc === 1;
            told.push(['_iMC', { _mcF: flags() }]);
          }
          if (content._mcc === 5) return { _vol: state.volume };
          if (content._mcc === 6 && typeof content._vol === 'number') state.volume = content._vol;
          return {};
        default:
          return { error: `No handler for ${id}` };
      }
    };

    const channel = fakeByteChannel((bytes) => {
      const replies: Uint8Array[] = [];
      for (const each of framer.read(bytes)) {
        const content = unpack(each.payload).value as Message;
        if (each.type === FrameType.PairSetupStart || each.type === FrameType.PairSetupNext) replies.push(pairSetup(content._pd as Uint8Array));
        else if (each.type === FrameType.PairVerifyStart || each.type === FrameType.PairVerifyNext) replies.push(...pairVerify(content._pd as Uint8Array));
        else if (each.type === FrameType.SealedOpack) {
          if (content._t === 1) {
            if (content._i === '_interest') {
              const events = (content._c as { _regEvents?: string[] })._regEvents ?? [];
              interests.push(...events);
              // Asked for, it says at once what can be done now.
              if (events.includes('_iMC')) replies.push(frame(FrameType.SealedOpack, { _i: '_iMC', _x: 1, _t: 1, _c: { _mcF: flags() } }));
            }
            continue;
          }
          const answer = respond(String(content._i), (content._c ?? {}) as Message);
          replies.push(
            frame(
              FrameType.SealedOpack,
              'error' in answer
                ? {
                    _i: content._i!,
                    _x: content._x!,
                    _t: 3,
                    _em: answer.error as string,
                  }
                : { _i: content._i!, _x: content._x!, _t: 3, _c: answer },
            ),
          );
          for (const [event, body] of told.splice(0)) replies.push(frame(FrameType.SealedOpack, { _i: event, _x: 1, _t: 1, _c: body }));
        }
      }
      return replies.length ? replies : null;
    });
    connections.push(channel);
    // Its keys were the connection's: dropped, the next one is verified afresh.
    channel.onConnectedChange((connected) => {
      if (!connected) framer = new Framer();
    });
    tellers.add((id, content) => {
      if (framer.encrypted) channel.push(frame(FrameType.SealedOpack, { _i: id, _x: 1, _t: 1, _c: content }));
    });
    return channel;
  };

  return {
    connect,
    connections,
    asked,
    interests,
    state,
    pairings,
    /** It tells of a change, unasked, on every connection, as the TV does. */
    tell(id: string, content: Message) {
      for (const each of tellers) each(id, content);
    },
  };
}
