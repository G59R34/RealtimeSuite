import { useState, type FormEvent } from 'react';
import { bootstrapCompany, signIn } from '../lib/data';
import { supabaseConfigured } from '../lib/supabase';
import { Field } from './ui';

export function AuthScreen({ notice }: { notice?: string | null }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign in failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-aside">
        <div className="brand-mark">RC</div>
        <h1>RealtimeCorp</h1>
        <p>
          Corporate oversight for every RealtimeSuite site. Workforce, operations, payroll and
          policy in one place, updated from each location as it works.
        </p>
        <ul className="auth-points">
          <li>Company and location rollups</li>
          <li>People, HR and discipline history</li>
          <li>Hours, rates and payroll estimates</li>
          <li>Corporate policy administration</li>
        </ul>
      </div>

      <div className="auth-panel">
        <form className="auth-card" onSubmit={submit}>
          <h2>Corporate sign in</h2>
          <p className="muted small">Use the corporate account issued to you by your administrator.</p>

          {!supabaseConfigured && (
            <p className="banner banner-warn">
              Supabase is not configured. Set <code>VITE_SUPABASE_URL</code> and{' '}
              <code>VITE_SUPABASE_ANON_KEY</code> in <code>corp/.env</code>.
            </p>
          )}
          {notice && <p className="banner banner-info">{notice}</p>}
          {error && <p className="banner banner-error">{error}</p>}

          <Field label="Work email">
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Field label="Password">
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <button className="button primary wide" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}

export function BootstrapScreen({
  email,
  onCreated
}: {
  email: string | null;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [location, setLocation] = useState('Headquarters');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await bootstrapCompany(name.trim(), location.trim());
      onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create the company.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell single">
      <form className="auth-card" onSubmit={submit}>
        <h2>Set up your company</h2>
        <p className="muted small">
          {email ?? 'This account'} is not attached to a company yet. Create one to start
          collecting snapshots from your RealtimeSuite sites.
        </p>
        {error && <p className="banner banner-error">{error}</p>}
        <Field label="Company name">
          <input
            required
            value={name}
            placeholder="Northwind Retail Group"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="Primary location" hint="You can add more locations later.">
          <input value={location} onChange={(event) => setLocation(event.target.value)} />
        </Field>
        <button className="button primary wide" type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Creating…' : 'Create company'}
        </button>
        <p className="muted small">
          A company is normally created once; afterwards administrators add members and sites.
        </p>
      </form>
    </div>
  );
}
