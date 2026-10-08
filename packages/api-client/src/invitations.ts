/*
  An invitation as a person is given it (docs/PLAN-WORLD-MODEL.md §8.3): a
  link — the server's address, the invitation and its secret — to open, to
  scan as a QR code, or to paste into the app. The secret is after the #,
  so a browser opening the link never sends it to the server as part of
  the address.
*/

/** What an invitation link carries: where its family's server answers, which invitation, and its secret. */
export type InvitationLink = { serverUrl: string; invitation: string; secret: string };

/** The link for an invitation made at a server, whose API is at `serverUrl` (…/api). */
export function invitationLink(serverUrl: string, invitation: string, secret: string): string {
  const base = serverUrl.replace(/\/+$/, '').replace(/\/api$/, '');
  return `${base}/join#i=${encodeURIComponent(invitation)}&s=${encodeURIComponent(secret)}`;
}

/** An invitation read from what a person pasted or scanned: the link, with whatever is around it; null for anything else. */
export function readInvitationLink(text: string): InvitationLink | null {
  const found = /https?:\/\/[^\s#]+\/join#[^\s]+/.exec(text.trim());
  if (!found) return null;
  let url: URL;
  try {
    url = new URL(found[0]);
  } catch {
    return null;
  }
  const fields = new URLSearchParams(url.hash.slice(1));
  const invitation = fields.get('i');
  const secret = fields.get('s');
  if (!invitation || !/^i-[0-9A-HJKMNP-TV-Z]{26}$/.test(invitation) || !secret || secret.length < 20) return null;
  const path = url.pathname.replace(/\/join$/, '');
  return { serverUrl: `${url.origin}${path}/api`, invitation, secret };
}
