import type { ReactNode } from 'react';
import type { ViewMode, Workspace } from '../types';
import { formatTime } from '../lib/format';

interface Props {
  workspace: Workspace;
  view: ViewMode;
  onView: (view: ViewMode) => void;
  onRefresh: () => void;
  refreshing: boolean;
  email: string | null;
  notice: string | null;
  error: string | null;
  children: ReactNode;
}

const TABS: { id: ViewMode; label: string; path: string }[] = [
  { id: 'today', label: 'Today', path: 'M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4v-5h-6v5H5a1 1 0 0 1-1-1z' },
  { id: 'schedule', label: 'Schedule', path: 'M7 3v3M17 3v3M4 9h16M5 6h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z' },
  { id: 'tasks', label: 'Tasks', path: 'M4 6h3l2 2 4-4M4 14h3l2 2 4-4M14 6h6M14 14h6' },
  { id: 'requests', label: 'Requests', path: 'M4 5h16v11H9l-5 4zM8 9h8M8 12h5' },
  { id: 'me', label: 'Me', path: 'M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4zM4 21a8 8 0 0 1 16 0' }
];

function NavIcon({ path }: { path: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function AppShell({
  workspace,
  view,
  onView,
  onRefresh,
  refreshing,
  email,
  notice,
  error,
  children
}: Props) {
  const organization =
    workspace.settings?.organization_name ?? workspace.site.organization_name ?? workspace.site.name;
  const firstName = (workspace.employee.full_name ?? email ?? 'there').split(' ')[0];

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">RT</span>
          <div className="brand-text">
            <strong>RTLink</strong>
            <span>{organization}</span>
          </div>
        </div>
        <div className="header-actions">
          <button
            className={`icon-button${refreshing ? ' spinning' : ''}`}
            type="button"
            onClick={onRefresh}
            aria-label="Refresh schedule"
            title="Refresh"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <span className="sync-stamp">
            {workspace.site.last_sync_at ? `Updated ${formatTime(workspace.site.last_sync_at)}` : 'Not synced'}
          </span>
        </div>
      </header>

      {(error || notice) && (
        <div className={`banner ${error ? 'banner-error' : 'banner-ok'}`} role="status">
          {error ?? notice}
        </div>
      )}

      <main className="app-main">
        <div className="greeting">Hi {firstName}.</div>
        {children}
      </main>

      <nav className="app-nav" aria-label="Main">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={view === tab.id ? 'active' : undefined}
            aria-current={view === tab.id ? 'page' : undefined}
            onClick={() => onView(tab.id)}
          >
            <NavIcon path={tab.path} />
            <span>{tab.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
