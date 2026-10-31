import type { ReactNode } from 'react';
import { statusLabel, statusTone } from '../lib/format';

export function Card({
  title,
  hint,
  action,
  children,
  tone
}: {
  title?: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
  tone?: 'plain' | 'accent';
}) {
  return (
    <section className={`card${tone === 'accent' ? ' card-accent' : ''}`}>
      {(title || action) && (
        <div className="card-head">
          <div>
            {title && <h2>{title}</h2>}
            {hint && <p className="card-hint">{hint}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Pill({ status, label }: { status: string | null | undefined; label?: string }) {
  return <span className={`pill pill-${statusTone(status)}`}>{label ?? statusLabel(status)}</span>;
}

export function Empty({ title, body }: { title: string; body?: string }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {body && <p>{body}</p>}
    </div>
  );
}

export function Field({
  label,
  hint,
  children
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function PendingNote({ count }: { count: number }) {
  if (!count) return null;
  return (
    <div className="pending-note">
      <span className="dot" />
      {count === 1 ? 'One action is on its way to your site.' : `${count} actions are on their way to your site.`}
    </div>
  );
}
