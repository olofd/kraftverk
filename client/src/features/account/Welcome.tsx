import { useEffect, useState } from 'react';
import { Button, Input, ScrollView, Spinner, Text, XStack, YStack } from 'tamagui';

import { describeError, type AccountMade, type AccountView, type PersonalApi } from '@kraftverk/api-client';
import { base64url, type Linked, type ProviderSignIn } from '@kraftverk/identity';
import { Card, haptic, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { Pressable } from '../../components/Pressable';
import { SIGN_IN } from '../../generated/sign-in';
import { thisNode } from '../../platform/node';
import { LinkThisDevice } from './LinkThisDevice';
import { Recover } from './Recover';

/*
  The app's first screen (docs/PLAN-WORLD-MODEL.md §10.6): an account,
  before anything else — made with a sign-in provider or as a local
  account, both the same, both with no server. Or, where this device keeps
  accounts already, the one to open as: a local account by a tap, one
  linked to a provider by signing in with it again. Making one ends with
  its twelve recovery words, shown once and checked.
*/

type Step =
  | { at: 'start' }
  | { at: 'have' }
  | { at: 'link' }
  | { at: 'recover' }
  | { at: 'name'; linked: Linked | null; name: string }
  | { at: 'words'; made: AccountMade }
  | { at: 'check'; made: AccountMade; asks: [number, number] };

/** Two different places among twelve, in order: the words asked back. */
function twoOf(count: number): [number, number] {
  const first = Math.floor(Math.random() * count);
  const second = (first + 1 + Math.floor(Math.random() * (count - 1))) % count;
  return first < second ? [first, second] : [second, first];
}

export function Welcome({ personal, accounts, onChanged }: { personal: PersonalApi; accounts: AccountView[]; onChanged: () => Promise<void> }) {
  const [step, setStep] = useState<Step>({ at: 'start' });
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const providers = useProviders();

  const doing = async (work: () => Promise<void>, failed: string) => {
    haptic();
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (err) {
      setProblem(describeError(err) || failed);
    } finally {
      setBusy(false);
    }
  };

  /** Signed in with a provider: the account on this device it is linked to, opened — or a new one, its name filled in. */
  const withProvider = (provider: ProviderSignIn) =>
    doing(async () => {
      const answer = await provider.signIn(base64url(crypto.getRandomValues(new Uint8Array(16))));
      if (!answer) return;
      const linked: Linked = { provider: provider.provider.id, subject: answer.subject, email: answer.email };
      const known = accounts.find((account) => account.linked.some((each) => each.provider === linked.provider && each.subject === linked.subject));
      if (known) {
        await personal.activate(known.personId);
        await onChanged();
        return;
      }
      setStep({ at: 'name', linked, name: answer.name ?? '' });
    }, `Signing in with ${provider.provider.name} did not finish`);

  return (
    <ScrollView flex={1} backgroundColor="$background" contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 16 }}>
      <YStack width="100%" maxWidth={440} alignSelf="center" gap="$4" paddingVertical="$6">
        {step.at === 'start' ? (
          <Start
            accounts={accounts}
            providers={providers}
            busy={busy}
            onLocal={() => setStep({ at: 'name', linked: null, name: '' })}
            onProvider={(provider) => void withProvider(provider)}
            onOpen={(account) => void doing(async () => (await personal.activate(account.personId), await onChanged()), 'That account could not open')}
            onHave={() => setStep({ at: 'have' })}
          />
        ) : null}
        {step.at === 'have' ? <Have onLink={() => setStep({ at: 'link' })} onRecover={() => setStep({ at: 'recover' })} onBack={() => setStep({ at: 'start' })} /> : null}
        {step.at === 'link' ? <LinkThisDevice personal={personal} onDone={onChanged} onBack={() => setStep({ at: 'have' })} /> : null}
        {step.at === 'recover' ? <Recover personal={personal} onDone={onChanged} onBack={() => setStep({ at: 'have' })} /> : null}
        {step.at === 'name' ? (
          <Name
            linked={step.linked}
            initial={step.name}
            busy={busy}
            onBack={() => setStep({ at: 'start' })}
            onMake={(name, deviceName) => void doing(async () => setStep({ at: 'words', made: await personal.create({ name, deviceName, linked: step.linked }) }), 'Your account could not be made')}
          />
        ) : null}
        {step.at === 'words' ? (
          <Words
            words={step.made.recoveryWords}
            onWritten={() => setStep({ at: 'check', made: step.made, asks: twoOf(step.made.recoveryWords.length) })}
            onStartOver={() => void doing(async () => (await personal.remove(step.made.account.personId), setStep({ at: 'start' })), 'It could not be undone')}
          />
        ) : null}
        {step.at === 'check' ? (
          <Check
            words={step.made.recoveryWords}
            asks={step.asks}
            busy={busy}
            onAgain={() => setStep({ at: 'words', made: step.made })}
            onRight={() =>
              void doing(async () => {
                await personal.confirmRecovery(step.made.account.personId);
                await personal.activate(step.made.account.personId);
                await onChanged();
              }, 'Your account could not open')
            }
          />
        ) : null}
        {problem ? <ErrorText paddingHorizontal="$1">{problem}</ErrorText> : null}
      </YStack>
    </ScrollView>
  );
}

/** The providers this place can sign in with: asked once. */
function useProviders(): ProviderSignIn[] {
  const [available, setAvailable] = useState<ProviderSignIn[]>([]);
  useEffect(() => {
    let current = true;
    void Promise.all(SIGN_IN.map(async (each) => ((await each.available().catch(() => false)) ? each : null))).then((found) => current && setAvailable(found.filter((each): each is ProviderSignIn => each !== null)));
    return () => {
      current = false;
    };
  }, []);
  return available;
}

function Title({ children, detail }: { children: string; detail: string }) {
  return (
    <YStack gap="$2">
      <Text role="heading" fontSize={26} fontWeight="800" color="$color">
        {children}
      </Text>
      <Text fontSize={14} color="$muted" lineHeight={20}>
        {detail}
      </Text>
    </YStack>
  );
}

/** The ways to begin: an account this device keeps, a provider, a local account. */
function Start({ accounts, providers, busy, onLocal, onProvider, onOpen, onHave }: { accounts: AccountView[]; providers: ProviderSignIn[]; busy: boolean; onLocal: () => void; onProvider: (provider: ProviderSignIn) => void; onOpen: (account: AccountView) => void; onHave: () => void }) {
  return (
    <>
      {accounts.length ? (
        <>
          <Title detail="Choose your account. Each one keeps its own families on this device.">Who is using kraftverk?</Title>
          <Card inset>
            {accounts.map((account, index) => {
              const linked = account.linked.length > 0;
              return (
                <YStack key={account.personId}>
                  {index ? <RowSeparator /> : null}
                  <Pressable disabled={busy || linked} onPress={() => onOpen(account)} label={`Continue as ${account.name}`}>
                    <Row
                      title={account.name}
                      subtitle={[
                        linked ? `Sign in with ${account.linked.map((each) => providers.find((provider) => provider.provider.id === each.provider)?.provider.name ?? each.provider).join(', ')} to continue` : 'Tap to continue',
                        account.recoveryConfirmed ? null : 'Its recovery words were never checked',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    />
                  </Pressable>
                </YStack>
              );
            })}
          </Card>
          <SectionLabel>Or add an account</SectionLabel>
        </>
      ) : (
        <Title detail="Your devices, your homes and what runs on its own — kept on this device, for you and the people you share them with. Begin with an account: it lives here, and needs no server.">Welcome to kraftverk</Title>
      )}
      <YStack gap="$3">
        {providers.map((provider) => (
          <Button key={provider.provider.id} size="$5" minHeight={52} backgroundColor="$color" color="$background" fontWeight="700" disabled={busy} onPress={() => onProvider(provider)}>
            {busy ? <Spinner size="small" /> : provider.label}
          </Button>
        ))}
        <Button size="$5" minHeight={52} backgroundColor={providers.length ? '$background' : '$accent'} color={providers.length ? '$color' : '$background'} borderColor="$borderColor" borderWidth={providers.length ? 1 : 0} fontWeight="700" disabled={busy} onPress={onLocal}>
          Create a local account
        </Button>
        <Button size="$4" minHeight={48} chromeless disabled={busy} onPress={onHave}>
          I have an account
        </Button>
        <Text fontSize={12} color="$muted" lineHeight={17}>
          {providers.length
            ? 'Signing in with a provider only links who you are there to your account, as a way back in. Your account and its key stay on this device either way.'
            : 'Your account and its key stay on this device. Twelve recovery words, shown next, are your way back in.'}
        </Text>
      </YStack>
    </>
  );
}

/** An account you have already: on another device, or back with its words. */
function Have({ onLink, onRecover, onBack }: { onLink: () => void; onRecover: () => void; onBack: () => void }) {
  return (
    <>
      <Title detail="Your account lives on your devices. Bring it to this one from another, or — every device lost — with your twelve recovery words.">You have an account</Title>
      <Card inset>
        <Pressable onPress={onLink} label="From my other device">
          <Row title="From my other device" subtitle="A code each way: this device's, and your other one's answer" />
        </Pressable>
        <RowSeparator />
        <Pressable onPress={onRecover} label="With my recovery words">
          <Row title="With my recovery words" subtitle="Every device lost: the words, and your family's server" />
        </Pressable>
      </Card>
      <XStack>
        <Button size="$4" minHeight={44} chromeless onPress={onBack}>
          Back
        </Button>
      </XStack>
    </>
  );
}

/** Their name, and what this device is called. */
function Name({ linked, initial, busy, onBack, onMake }: { linked: Linked | null; initial: string; busy: boolean; onBack: () => void; onMake: (name: string, deviceName: string) => void }) {
  const [name, setName] = useState(initial);
  const [deviceName, setDeviceName] = useState(thisNode().name);
  const ready = name.trim().length > 0 && deviceName.trim().length > 0;
  return (
    <>
      <Title detail={linked ? `Signed in${linked.email ? ` as ${linked.email}` : ''}. This is what your family will see.` : 'This is what your family will see. You can change it later.'}>What should we call you?</Title>
      <Card gap="$3">
        <YStack gap="$1.5">
          <Text fontSize={13} fontWeight="600" color="$color">
            Your name
          </Text>
          <Input size="$4" aria-label="Your name" autoFocus autoComplete="name" maxLength={100} value={name} onChangeText={setName} placeholder="Anna Example" onSubmitEditing={() => ready && onMake(name.trim(), deviceName.trim())} />
        </YStack>
        <YStack gap="$1.5">
          <Text fontSize={13} fontWeight="600" color="$color">
            This device
          </Text>
          <Input size="$4" aria-label="What this device is called" maxLength={60} value={deviceName} onChangeText={setDeviceName} />
          <Text fontSize={12} color="$muted" lineHeight={17}>
            How you will tell it from your other devices.
          </Text>
        </YStack>
      </Card>
      <XStack gap="$2" justifyContent="space-between">
        <Button size="$4" minHeight={44} chromeless onPress={onBack} disabled={busy}>
          Back
        </Button>
        <Button size="$4" minHeight={44} backgroundColor="$accent" color="$background" disabled={!ready || busy} opacity={ready && !busy ? 1 : 0.5} onPress={() => onMake(name.trim(), deviceName.trim())}>
          {busy ? <Spinner size="small" /> : 'Continue'}
        </Button>
      </XStack>
    </>
  );
}

/** The twelve words, shown this once. */
function Words({ words, onWritten, onStartOver }: { words: string[]; onWritten: () => void; onStartOver: () => void }) {
  return (
    <>
      <Title detail="If this device is ever lost, these twelve words bring your account back. Write them down, in order, and keep them somewhere safe. They are shown this once, and kept nowhere — not even here.">Your recovery words</Title>
      <Card>
        <XStack flexWrap="wrap" rowGap="$2.5" role="list" aria-label="Your twelve recovery words, in order">
          {words.map((word, index) => (
            <XStack key={index} width="50%" gap="$2" alignItems="baseline" role="listitem">
              <Text width={24} textAlign="right" fontSize={12} color="$muted">
                {index + 1}
              </Text>
              <Text fontSize={17} fontWeight="700" color="$color" userSelect="text">
                {word}
              </Text>
            </XStack>
          ))}
        </XStack>
      </Card>
      <Button size="$5" minHeight={52} backgroundColor="$accent" color="$background" fontWeight="700" onPress={() => (haptic(), onWritten())}>
        I have written them down
      </Button>
      <Button size="$3" minHeight={44} chromeless color="$muted" onPress={onStartOver}>
        Start over
      </Button>
    </>
  );
}

/** Two of the words asked back: written down, not just seen. */
function Check({ words, asks, busy, onAgain, onRight }: { words: string[]; asks: [number, number]; busy: boolean; onAgain: () => void; onRight: () => void }) {
  const [typed, setTyped] = useState<[string, string]>(['', '']);
  const [wrong, setWrong] = useState<number | null>(null);
  const check = () => {
    const miss = asks.findIndex((index, at) => typed[at]!.trim().toLowerCase() !== words[index]);
    if (miss >= 0) return setWrong(asks[miss]!);
    setWrong(null);
    onRight();
  };
  return (
    <>
      <Title detail="To be sure they were written down: type two of them from your paper.">Check your words</Title>
      <Card gap="$3">
        {asks.map((index, at) => (
          <YStack key={index} gap="$1.5">
            <Text fontSize={13} fontWeight="600" color="$color">
              Word {index + 1}
            </Text>
            <Input
              size="$4"
              aria-label={`Word ${index + 1}`}
              autoFocus={at === 0}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              spellCheck={false}
              value={typed[at]}
              onChangeText={(value) => setTyped((was) => (at === 0 ? [value, was[1]] : [was[0], value]))}
              onSubmitEditing={check}
            />
          </YStack>
        ))}
        {wrong !== null ? <ErrorText>That is not word {wrong + 1}: look at your paper again.</ErrorText> : null}
      </Card>
      <XStack gap="$2" justifyContent="space-between">
        <Button size="$4" minHeight={44} chromeless onPress={onAgain} disabled={busy}>
          Show them again
        </Button>
        <Button size="$4" minHeight={44} backgroundColor="$accent" color="$background" disabled={busy || typed.some((each) => !each.trim())} opacity={busy || typed.some((each) => !each.trim()) ? 0.5 : 1} onPress={check}>
          {busy ? <Spinner size="small" /> : 'Done'}
        </Button>
      </XStack>
    </>
  );
}
