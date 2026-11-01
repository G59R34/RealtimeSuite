import { useEffect, useState, type ReactNode } from 'react';
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

// Statuses that mean "someone still has to look at this".
const AWAITING = new Set(['pending', 'submitted', 'under_review', 'pending_admin']);

/** "Updated 2 min ago" — reads as freshness, where a bare clock time reads as a timestamp. */
function syncLabel(iso: string | null | undefined, now: number): string {
  if (!iso) return 'Not synced';
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return 'Not synced';
  const minutes = Math.max(0, Math.round((now - at) / 60000));
  if (minutes < 1) return 'Updated just now';
  if (minutes < 60) return `Updated ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Updated ${hours} h ago`;
  return `Updated ${formatTime(iso)}`;
}

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
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  const freshness = syncLabel(workspace.site.last_sync_at, now);
  const waiting =
    workspace.timeOff.filter((row) => AWAITING.has(row.status)).length +
    workspace.overtime.filter((row) => AWAITING.has(row.status)).length +
    workspace.exceptions.filter((row) => AWAITING.has(row.status)).length +
    workspace.swaps.filter((row) => AWAITING.has(row.status)).length +
    workspace.actions.filter((action) => action.status === 'pending').length;

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
          <button
            className="sync-stamp"
            type="button"
            onClick={onRefresh}
            title="Refresh now"
            aria-label={`${freshness}. Refresh now.`}
          >
            {freshness}
          </button>
        </div>
      </header>

      {(error || notice) && (
        <div className={`banner ${error ? 'banner-error' : 'banner-ok'}`} role="status" aria-live="polite">
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
            aria-label={
              tab.id === 'requests' && waiting > 0 ? `Requests, ${waiting} waiting` : undefined
            }
            onClick={() => onView(tab.id)}
          >
            <NavIcon path={tab.path} />
            <span>{tab.label}</span>
            {tab.id === 'requests' && waiting > 0 && (
              <b className="nav-badge" aria-hidden="true">
                {waiting > 9 ? '9+' : waiting}
              </b>
            )}
          </button>
        ))}
      </nav>
    </div>
  );
}
