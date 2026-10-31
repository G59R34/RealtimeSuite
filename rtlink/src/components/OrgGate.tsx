import { useState, type FormEvent } from 'react';
import { lookupOrg } from '../lib/data';
import { setOrgCode } from '../lib/supabase';

export function OrgGate({ onSelected }: { onSelected: (code: string) => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const clean = code.trim().toUpperCase();
    if (!clean) return;
    setBusy(true);
    setError(null);
    try {
      const org = await lookupOrg(clean);
      if (!org) {
        setError(`No organization uses the code "${clean}". Check the code with your manager.`);
        return;
      }
      setOrgCode(org.org_code ?? clean);
      onSelected((org.org_code ?? clean).toUpperCase());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not look up that code.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-brand">
        <span className="brand-mark large" aria-hidden="true">RT</span>
        <strong>RTLink</strong>
        <p>Your shifts, tasks and requests — wherever the day takes you.</p>
      </div>

      <form className="card auth-card" onSubmit={(event) => void handleSubmit(event)}>
        <h1>Choose your organization</h1>
        <p className="card-hint">
          Enter the organization code your manager gave you. You only need to do this once on
          this device.
        </p>
        <label className="field">
          <span className="field-label">Organization code</span>
          <input
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            placeholder="e.g. NORTHWIND"
            autoCapitalize="characters"
            autoComplete="organization"
            spellCheck={false}
            required
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="btn primary" type="submit" disabled={busy || !code.trim()}>
          {busy ? 'Looking up…' : 'Continue'}
        </button>
        <p className="fine-print">
          Your code identifies the site your schedule comes from. If you are not sure, ask your
          manager or check your onboarding email.
        </p>
      </form>
    </div>
  );
}
