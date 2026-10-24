import { useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import type { OrganizationLoginBranding } from '../types';
import { ExperienceModules } from './ExperienceModules';

type AuthScreenProps = {
  branding: OrganizationLoginBranding | null;
  onSignIn: (email: string, password: string) => Promise<void>;
  busy: boolean;
  error: string | null;
};

export function AuthScreen({ branding, onSignIn, busy, error }: AuthScreenProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const style = {
    '--login-primary': branding?.login_primary_color ?? '#0b3d91',
    '--login-accent': branding?.login_accent_color ?? '#ff7a00'
  } as CSSProperties;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    await onSignIn(email.trim(), password);
  }

  return (
    <section className="auth-shell" style={style}>
      <div
        className="auth-card"
        style={branding?.login_background_image_url
          ? { backgroundImage: `linear-gradient(rgba(6, 20, 44, 0.72), rgba(6, 20, 44, 0.86)), url(${branding.login_background_image_url})` }
          : undefined}
      >
        <header className="auth-brand">
          {branding?.login_logo_url ? (
            <img className="auth-brand-logo" src={branding.login_logo_url} alt={`${branding.organization_name} logo`} />
          ) : null}
          <p className="auth-org-chip">{branding?.organization_name ?? 'RealtimeSuite'}</p>
          <h1>{branding?.login_heading ?? 'RealtimeSuite'}</h1>
          <p>{branding?.login_subheading ?? 'Local scheduling, attendance, and task operations.'}</p>
        </header>

        {branding?.login_announcement ? (
          <div className="auth-announcement">
            <span className="announcement-label">Announcement</span>
            <p>{branding.login_announcement}</p>
          </div>
        ) : null}

        <ExperienceModules modules={branding?.login_modules ?? []} />

        <form className="auth-form" onSubmit={handleSubmit}>
          <label>
            {branding?.login_elements.email_label ?? 'Email'}
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label>
            {branding?.login_elements.password_label ?? 'Password'}
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          {error ? <p className="auth-error" role="alert">{error}</p> : null}
          <button type="submit" disabled={busy}>
            {busy ? 'Signing in...' : branding?.login_elements.sign_in_button_label ?? 'Sign In'}
          </button>
        </form>

        <p className="auth-notice">
          Accounts are created by an administrator on this network. Contact your scheduler if you need access.
        </p>
        <p className="auth-notice">Connected to the local RealtimeSuite server.</p>
      </div>
    </section>
  );
}
