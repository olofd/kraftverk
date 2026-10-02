import { Spinner, YStack } from 'tamagui';

import { useAuth } from '../../state/AuthProvider';
import { SignIn } from './SignIn';

/**
 * What stands in for the app when the chosen server wants to know who you are.
 *
 * Three cases, and each says plainly which one it is:
 *
 * - **Sign in** — the server has accounts. Every device signs in, at home too:
 *   devices belong to accounts, and a visitor with no account has no view.
 * - **Create the first administrator** — a fresh server, reached from the home
 *   network. Accounts are what make it reachable from outside.
 * - **Set it up at home** — a fresh server reached from outside. Nothing can be
 *   done from here, deliberately: a server exposed to the internet before
 *   anyone has an account must not be claimable by whoever finds it first.
 *
 * Always with a way out — another saved server, or no server at all — because
 * a login screen you cannot leave is a trap, not a lock.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { applies, loading, allowed, state, generation } = useAuth();
  const blocked = applies && !allowed;

  /*
    Drawn over the app, never instead of it.

    Swapping the navigator out for a sign-in screen unmounts it, and a
    navigator mounted again starts from its home route — so every deep link
    and bookmark to a device, and wherever you were when a session expired, was
    lost. The device list does not poll while this is up, and the server
    enforces access regardless; this is presentation, and presentation should
    not cost the user their place.

    Except when the person changes. Signing out, or another account signing
    in, throws the tree underneath away (`generation`): otherwise the last
    account's devices, readings and account list would stay in memory and in
    the page, readable with the developer tools by whoever sits down next. A
    session that merely expired keeps its place — it is the same person.
  */
  return (
    <YStack flex={1}>
      {/*
        Hidden, not covered: an overlay alone leaves the screen underneath
        readable by a screen reader and reachable with Tab. `display: none`
        keeps it mounted — and the navigator with it — but out of sight,
        focus and the accessibility tree.
      */}
      <YStack key={generation} flex={1} display={blocked ? 'none' : 'flex'}>
        {children}
      </YStack>
      {blocked ? (
        <YStack position="absolute" top={0} right={0} bottom={0} left={0} backgroundColor="$background" zIndex={1000}>
          {loading || !state ? (
            <YStack flex={1} alignItems="center" justifyContent="center">
              <Spinner color="$accent" />
            </YStack>
          ) : (
            <SignIn />
          )}
        </YStack>
      ) : null}
    </YStack>
  );
}
