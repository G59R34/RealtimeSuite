import { useState, type FormEvent } from 'react';
import { signIn } from '../lib/data';

export function AuthScreen({
  configured,
  orgCode,
  onChangeOrg
}: {
  configured: boolean;
  orgCode: string;
  onChangeOrg: () => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not sign in.');
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
        <button className="org-chip" type="button" onClick={onChangeOrg}>
          <span>{orgCode}</span>
          <small>Change organization</small>
        </button>
      </div>

      {!configured && (
        <div className="banner banner-error">
          This build has no Supabase project configured. Set <code>VITE_SUPABASE_URL</code> and{' '}
          <code>VITE_SUPABASE_ANON_KEY</code> in <code>rtlink/.env</code>.
        </div>
      )}

      <form className="card auth-card" onSubmit={(event) => void handleSubmit(event)}>
        <h1>Sign in</h1>
        <p className="card-hint">Use the work email your manager set up for you.</p>
        <label className="field">
          <span className="field-label">Work email</span>
          <input
            type="email"
            autoComplete="email"
            inputMode="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <label className="field">
          <span className="field-label">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="btn primary" type="submit" disabled={busy || !configured}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="fine-print">
          Forgotten your password? Your site administrator can reset it from the RealtimeSuite
          desktop manager.
        </p>
      </form>
    </div>
  );
}

export function LinkRequiredScreen({
  email,
  orgCode,
  onChangeOrg,
  onSignOut,
  onRetry
}: {
  email: string | null;
  orgCode: string;
  onChangeOrg: () => void;
  onSignOut: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="standalone">
      <div className="card">
        <h1>Almost there</h1>
        <p className="muted">
          {email ? <strong>{email}</strong> : 'This account'} signed in, but it is not linked to an
          employee on your site yet.
        </p>
        <p className="muted small">
          Your schedule comes from <strong>{orgCode}</strong>. Ask your manager to check that your
          RealtimeSuite profile uses this same email address, then refresh. The site pushes
          employee records within a few minutes.
        </p>
        <div className="row-gap">
          <button className="btn primary" type="button" onClick={onRetry}>
            Check again
          </button>
          <button className="btn ghost" type="button" onClick={onChangeOrg}>
            Different organization
          </button>
          <button className="btn ghost" type="button" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
