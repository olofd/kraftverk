import { expect, test } from 'bun:test';

import { invitationLink, readInvitationLink } from './invitations.ts';

const ID = 'i-01JA8ZK3Q4R7T9V2W5X6Y8Z0AB';
const SECRET = 'Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg';

test('an invitation link: the server, the invitation and its secret after the #, read back from whatever was pasted around it', () => {
  const link = invitationLink('https://home.example.net/api', ID, SECRET);
  expect(link).toBe(`https://home.example.net/join#i=${ID}&s=${SECRET}`);
  expect(readInvitationLink(`Join us: ${link} — see you!`)).toEqual({ serverUrl: 'https://home.example.net/api', invitation: ID, secret: SECRET });
  expect(readInvitationLink(invitationLink('http://192.0.2.10:3334/api/', ID, SECRET))?.serverUrl).toBe('http://192.0.2.10:3334/api');
  expect(readInvitationLink('https://home.example.net/join#i=nonsense&s=x')).toBeNull();
  expect(readInvitationLink('not a link at all')).toBeNull();
});
