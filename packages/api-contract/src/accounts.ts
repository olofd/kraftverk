/*
  Who signs in to a server: an account, and the sign-in state an app is
  answered.
*/

/** A signed-in account. Every account is an administrator. */
export type Account = { id: string; username: string };
export type AccountDetail = Account & {
  createdAt: string;
  createdBy: string | null;
  lastLoginAt: string | null;
};
/** `GET /api/auth/state`: who this is, from where, and what the app should show. */
export type AuthState = {
  user: Account | null;
  onHomeNetwork: boolean;
  reason: string;
  setupRequired: boolean;
  canSetup: boolean;
};
