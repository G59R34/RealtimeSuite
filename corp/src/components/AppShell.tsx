import type { ReactNode } from 'react';
import type { Scope } from '../types';
import { humanize } from '../lib/format';

export type CorpView =
  | 'overview'
  | 'sites'
  | 'people'
  | 'operations'
  | 'payroll'
  | 'policies'
  | 'sync';

const NAV: { id: CorpView; label: string; hint: string }[] = [
  { id: 'overview', label: 'Overview', hint: 'Company at a glance' },
  { id: 'sites', label: 'Sites & locations', hint: 'Where work happens' },
  { id: 'people', label: 'People & HR', hint: 'Workforce records' },
  { id: 'operations', label: 'Operations', hint: 'Shifts and tasks' },
  { id: 'payroll', label: 'Payroll & finance', hint: 'Hours and cost' },
  { id: 'policies', label: 'Policies', hint: 'Corporate administration' },
  { id: 'sync', label: 'Sync health', hint: 'Snapshot delivery' }
];

export function AppShell({
  scope,
  scopes,
  view,
  onView,
  onScope,
  onSignOut,
  onRefresh,
  refreshing,
  email,
  children
}: {
  scope: Scope;
  scopes: Scope[];
  view: CorpView;
  onView: (view: CorpView) => void;
  onScope: (companyId: string) => void;
  onSignOut: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  email: string | null;
  children: ReactNode;
}) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark small">RC</span>
          <div>
            <strong>RealtimeCorp</strong>
            <span className="muted small">Corporate console</span>
          </div>
        </div>

        <nav className="sidebar-nav">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className={view === item.id ? 'nav-item active' : 'nav-item'}
              onClick={() => onView(item.id)}
            >
              <span>{item.label}</span>
              <small>{item.hint}</small>
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <span className="muted small">Signed in as</span>
          <strong className="truncate">{email ?? scope.email ?? 'Corporate user'}</strong>
          <span className="badge badge-neutral">{humanize(scope.role)}</span>
          <button className="button ghost small" type="button" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <div>
            <h1>{scope.company_name}</h1>
            <p className="muted small">
              {scope.location_name ? `${scope.location_name} · ` : ''}
              {humanize(scope.role)}
            </p>
          </div>
          <div className="topbar-actions">
            {scopes.length > 1 && (
              <label className="inline-field">
                <span className="muted small">Company</span>
                <select
                  value={scope.company_id}
                  onChange={(event) => onScope(event.target.value)}
                >
                  {scopes.map((item) => (
                    <option key={item.company_id} value={item.company_id}>
                      {item.company_name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button
              className="button"
              type="button"
              onClick={onRefresh}
              disabled={refreshing}
            >
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </header>
        <main className="app-content">{children}</main>
      </div>
    </div>
  );
}
