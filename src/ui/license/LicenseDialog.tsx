/**
 * Help → Enter License Key… / View License Info… (desktop app only). Shows this computer's license, or a form to
 * activate one. Activation runs in the main process (electron/license.ts); nothing in the app
 * is locked without a license.
 */
import { useEffect, useState } from 'react';
import { BadgeCheck, KeyRound, ShieldAlert } from 'lucide-react';
import { licenseBridge, type LicenseState } from '../../platform/host';
import { Field, Modal } from '../components';

/** Live formatting as the key is typed or pasted. Does not auto-insert the FE- prefix. */
export function formatKeyInput(raw: string): string {
  let s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const hadFe = s.startsWith('FE');
  if (hadFe) s = s.slice(2);
  s = s.slice(0, 20);
  const groups = s.match(/.{1,5}/g) ?? [];
  if (!groups.length) return '';
  return hadFe ? ['FE', ...groups].join('-') : groups.join('-');
}

const COMPLETE = /^(?:FE-)?[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/;

export function LicenseDialog({ onClose, onActivated }: { onClose: () => void; onActivated?: (state: LicenseState) => void }) {
  const bridge = licenseBridge();
  const [state, setState] = useState<LicenseState | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justActivated, setJustActivated] = useState(false);

  useEffect(() => {
    let live = true;
    bridge?.get().then((s) => live && setState(s)).catch(() => live && setState({ status: 'unlicensed', purchaseUrl: 'https://license.bretttomita.com' }));
    return () => {
      live = false;
    };
  }, [bridge]);

  const activate = async () => {
    if (!bridge) return;
    if (!COMPLETE.test(key)) {
      setError('Enter the whole key from your email: FE- followed by four groups of five characters.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await bridge.activate(key);
      if (res.ok) {
        setState(res.state);
        setJustActivated(true);
        setKey('');
        onActivated?.(res.state);
      } else {
        setError(res.error);
      }
    } catch {
      setError('Activation failed. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const active = state?.status === 'active';
  const showForm = state && !active;
  const revokedNote = state?.status === 'unlicensed' ? state.message : state?.status === 'revoked' ? (state.message ?? 'This license was revoked.') : null;
  const activatedOn = state?.activatedAt ? new Date(state.activatedAt).toLocaleDateString(undefined, { dateStyle: 'medium' }) : null;

  return (
    <Modal
      title={active ? 'License Info' : 'Enter License Key'}
      width={480}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          {showForm ? (
            <>
              <button type="button" className="btn btn-text" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" form="license-form" className="btn btn-primary" disabled={busy || !key}>
                {busy ? 'Activating…' : 'Activate'}
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Done
            </button>
          )}
        </>
      }
    >
      {!bridge ? (
        <p className="dialog-text">Licenses are for the File Editor desktop app on Windows and macOS. The web version doesn't need one.</p>
      ) : !state ? (
        <p className="dialog-text">Checking this computer's license…</p>
      ) : active ? (
        <div className="license-card" role="status">
          <BadgeCheck size={28} className="license-ok" aria-hidden />
          <div>
            <p className="license-title">{justActivated ? 'Activated. Thank you!' : 'File Editor is activated on this computer.'}</p>
            <p className="dialog-text">
              Licensed to <strong>{state.email}</strong>
              <br />
              Key {state.keyHint}
              {activatedOn ? ` · activated ${activatedOn}` : ''}
            </p>
            <p className="dialog-hint">This lifetime license is tied to this computer and can't be moved to another device.</p>
          </div>
        </div>
      ) : (
        <form
          id="license-form"
          onSubmit={(e) => {
            e.preventDefault();
            void activate();
          }}
        >
          {revokedNote && (
            <div className="license-card license-card-warn" role="alert">
              <ShieldAlert size={22} aria-hidden />
              <p className="dialog-text">{revokedNote} You can enter a different key below.</p>
            </div>
          )}
          <p className="dialog-text">
            Enter the license key from your purchase email. Every feature works without a license; activating one supports File Editor's development.
          </p>
          <Field label="License key">
            <div className="license-key-input">
              <KeyRound size={16} aria-hidden />
              <input
                className="input"
                value={key}
                onChange={(e) => {
                  setKey(formatKeyInput(e.target.value));
                  setError(null);
                }}
                placeholder="FE-XXXXX-XXXXX-XXXXX-XXXXX"
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="characters"
                aria-invalid={!!error}
                data-autofocus
              />
            </div>
          </Field>
          {error && (
            <p className="dialog-error" role="alert">
              {error}
            </p>
          )}
          <p className="dialog-hint">
            A license activates on one device only and can't be moved later, so activate it on the computer you'll use. Activation sends the key and an
            anonymous id for this computer to the license server; your documents never leave this computer.
          </p>
          <p className="dialog-hint">
            Don't have a key?{' '}
            <a href={state.purchaseUrl} target="_blank" rel="noopener noreferrer">
              Buy a license
            </a>
          </p>
        </form>
      )}
    </Modal>
  );
}
