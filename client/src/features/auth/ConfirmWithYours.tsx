import { Field } from './fields';

/**
 * Your own password, asked for again before changing who may use the server.
 * A session alone — a phone left unlocked — is not enough for that.
 */
export function ConfirmWithYours({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <Field label="Your password" kind="current-password" value={value} onChange={onChange} hint="To confirm it is you." />;
}
