import type { BoardFilters } from '../types';
import { DEFAULT_FEATURES } from '../lib/features';
import type { FeatureFlags } from '../lib/features';
import type { ViewMode } from '../lib/views';

type AdminNotificationItem = {
  id: string;
  title: string;
  detail: string;
  createdAt: string;
  unread: boolean;
};

type QuickActionId = 'assign-task' | 'create-shift' | 'send-message' | 'refresh';

type TopBarProps = {
  activeView: ViewMode;
  onViewChange: (view: ViewMode) => void;
  shiftFilter: string;
  onShiftFilterChange: (value: string) => void;
  timelineWindowHours: 2 | 4 | 8;
  onTimelineWindowChange: (value: 2 | 4 | 8) => void;
  filters: BoardFilters;
  onToggleFilter: (key: keyof BoardFilters) => void;
  selectedDate: string;
  onDateChange: (value: string) => void;
  onRefresh: () => Promise<void>;
  onSearch: () => void;
  onSignOut: () => Promise<void>;
  onQuickAction: (actionId: QuickActionId) => void;
  now: Date;
  announcement: string | null;
  notifications: AdminNotificationItem[];
  unreadNotificationCount: number;
  notificationsOpen: boolean;
  onToggleNotifications: () => void;
  onMarkAllNotificationsRead: () => void;
  onClearNotifications: () => void;
  showOrgSettings: boolean;
  managementAccess?: boolean;
  enabledFeatures?: FeatureFlags;
  showRosterTab?: boolean;
  showEmployeePortalTab?: boolean;
  showClockInAuditTab?: boolean;
  showSchedulingTab?: boolean;
  showReportsTab?: boolean;
  onOpenLiveBoard: () => void;
  connectivityState: 'online' | 'syncing' | 'offline';
  userDisplayName: string;
  userEmail: string;
  userRoleLabel: string;
  presence: {
    onDuty: number;
    onBreak: number;
    late: number;
    offShift: number;
  } | null;
};

const BOARD_VIEWS: ViewMode[] = ['operations', 'roster', 'scheduling', 'shift-audit'];

export function TopBar({
  activeView,
  onViewChange,
  shiftFilter,
  onShiftFilterChange,
  timelineWindowHours,
  onTimelineWindowChange,
  filters,
  onToggleFilter,
  selectedDate,
  onDateChange,
  onRefresh,
  onSearch,
  onSignOut,
  onQuickAction,
  now,
  announcement,
  notifications,
  unreadNotificationCount,
  notificationsOpen,
  onToggleNotifications,
  onMarkAllNotificationsRead,
  onClearNotifications,
  showOrgSettings,
  managementAccess = false,
  enabledFeatures = DEFAULT_FEATURES,
  showRosterTab = true,
  showEmployeePortalTab = false,
  showClockInAuditTab = false,
  showSchedulingTab = true,
  showReportsTab = true,
  onOpenLiveBoard,
  connectivityState,
  userDisplayName,
  userEmail,
  userRoleLabel,
  presence
}: TopBarProps) {
  const currentDate = new Intl.DateTimeFormat('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: 'numeric'
  }).format(now);

  const currentTime = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(now);

  const isBoardView = BOARD_VIEWS.includes(activeView);
  const connectivityLabel = connectivityState === 'offline'
    ? 'Offline'
    : connectivityState === 'syncing'
      ? 'Syncing'
      : 'Online';

  return (
    <header className={`top-shell${isBoardView ? ' top-shell-board' : ''}`}>
      <div className="top-mainbar">
        <div className="brand-wrap">
          <span className="brand-united">RealtimeSuite</span>
          <span className="brand-divider" />
          <span className="brand-rt">Scheduling Control</span>
        </div>

        <div className="view-tabs management-navigation" aria-hidden={!managementAccess}>
          {managementAccess && showEmployeePortalTab ? (
            <button
              type="button"
              className={activeView === 'employee-portal' ? 'active' : ''}
              onClick={() => onViewChange('employee-portal')}
            >
              Employee Portal
            </button>
          ) : null}
          {managementAccess ? (
            <button
              type="button"
              className={activeView === 'operations' ? 'active' : ''}
              onClick={() => onViewChange('operations')}
            >
              Operations Board
            </button>
          ) : null}
          {managementAccess && showRosterTab ? (
            <button
              type="button"
              className={activeView === 'roster' ? 'active' : ''}
              onClick={() => onViewChange('roster')}
            >
              Roster
            </button>
          ) : null}
          {managementAccess && showSchedulingTab ? (
            <button
              type="button"
              className={activeView === 'scheduling' ? 'active' : ''}
              onClick={() => onViewChange('scheduling')}
            >
              Scheduling
            </button>
          ) : null}
          {managementAccess && showClockInAuditTab ? (
            <button
              type="button"
              className={activeView === 'shift-audit' ? 'active' : ''}
              onClick={() => onViewChange('shift-audit')}
            >
              Clock-In Audit
            </button>
          ) : null}
          {managementAccess && showReportsTab ? (
            <button
              type="button"
              className={activeView === 'reports' ? 'active' : ''}
              onClick={() => onViewChange('reports')}
            >
              Reports
            </button>
          ) : null}
          {managementAccess && showOrgSettings ? (
            <button
              type="button"
              className={activeView === 'settings' || activeView === 'opsboard-settings' ? 'active' : ''}
              onClick={() => onViewChange('settings')}
            >
              Settings
            </button>
          ) : null}
          {managementAccess && enabledFeatures.live_board !== false ? (
            <button type="button" className="top-liveboard-link" onClick={onOpenLiveBoard}>
              Open Live Board
            </button>
          ) : null}
        </div>

        <div className="top-clock">{currentDate} | {currentTime}</div>
      </div>

      <div className="top-controls">
        <label className="inline-field">
          Date
          <input type="date" value={selectedDate} onChange={(event) => onDateChange(event.target.value)} />
        </label>

        {enabledFeatures.announcements !== false ? (
          <div className="announcement-box" title={announcement ?? 'No active announcements'}>
            <span className="announcement-label">Announcement</span>
            <span className="announcement-text">{announcement ?? 'No active announcements'}</span>
          </div>
        ) : null}

        {isBoardView ? (
          <>
            <select
              aria-label="Employee shift filter"
              value={shiftFilter}
              onChange={(event) => onShiftFilterChange(event.target.value)}
            >
              <option value="all">All Employees</option>
              <option value="current_future">Current + Future</option>
              <option value="future">Future Only</option>
              <option value="06">Early (06:00+)</option>
              <option value="08">Morning (08:00+)</option>
              <option value="10">Midday (10:00+)</option>
              <option value="12">Afternoon (12:00+)</option>
            </select>

            <label className="inline-field">
              Window
              <select
                aria-label="Timeline window"
                value={String(timelineWindowHours)}
                onChange={(event) => onTimelineWindowChange(Number(event.target.value) as 2 | 4 | 8)}
              >
                <option value="2">2 Hour</option>
                <option value="4">4 Hour</option>
                <option value="8">8 Hour</option>
              </select>
            </label>

            <div className="view-filter-group">
              <label>
                <input
                  type="checkbox"
                  checked={filters.resources}
                  onChange={() => onToggleFilter('resources')}
                />
                Work Areas
              </label>
              {enabledFeatures.tasks !== false ? (
                <>
                  <label>
                    <input
                      type="checkbox"
                      checked={filters.events}
                      onChange={() => onToggleFilter('events')}
                    />
                    Tasks
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={filters.unassigned}
                      onChange={() => onToggleFilter('unassigned')}
                    />
                    Unassigned
                  </label>
                </>
              ) : null}
            </div>
          </>
        ) : null}

        <div className="top-actions">
          <span className={`connectivity-badge ${connectivityState}`} title="Realtime connectivity">
            <span className="dot" />
            {connectivityLabel}
          </span>
          <details className="top-menu quick-actions-menu">
            <summary>Quick Actions</summary>
            <div className="top-menu-panel">
              {enabledFeatures.tasks !== false ? (
                <button type="button" onClick={() => onQuickAction('assign-task')}>Assign Task</button>
              ) : null}
              {enabledFeatures.shifts !== false ? (
                <button type="button" onClick={() => onQuickAction('create-shift')}>Create Shift</button>
              ) : null}
              {enabledFeatures.messages !== false ? (
                <button type="button" onClick={() => onQuickAction('send-message')}>Send Message</button>
              ) : null}
              <button type="button" onClick={() => onQuickAction('refresh')}>Refresh Data</button>
            </div>
          </details>
          {managementAccess && enabledFeatures.notifications !== false ? (
          <div className="notifications-wrap">
            <button type="button" aria-label="Notifications" onClick={onToggleNotifications}>
              Notifications
              {unreadNotificationCount > 0 ? <span className="notification-badge">{unreadNotificationCount}</span> : null}
            </button>
            {notificationsOpen ? (
              <div className="notifications-panel">
                <div className="notifications-header">
                  <strong>Activity</strong>
                  <div className="notifications-header-actions">
                    <button type="button" onClick={onMarkAllNotificationsRead}>Mark Read</button>
                    <button type="button" onClick={onClearNotifications}>Clear</button>
                  </div>
                </div>
                <ul>
                  {notifications.length === 0 ? (
                    <li className="notification-empty">No new notifications.</li>
                  ) : (
                    notifications.slice(0, 20).map((notification) => (
                      <li key={notification.id} className={notification.unread ? 'unread' : ''}>
                        <p>{notification.title}</p>
                        <small>{notification.detail}</small>
                        <time dateTime={notification.createdAt}>
                          {new Date(notification.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </time>
                      </li>
                    ))
                  )}
                </ul>
              </div>
            ) : null}
          </div>
          ) : null}
          {managementAccess ? <>
            <button type="button" aria-label="Refresh board" onClick={() => void onRefresh()}>
              {String.fromCharCode(8635)}
            </button>
            <button type="button" aria-label="Search" onClick={onSearch}>Search</button>
          </> : null}
          <details className="top-menu user-menu">
            <summary>{userDisplayName || 'User'}</summary>
            <div className="top-menu-panel user-menu-panel">
              <div className="user-menu-meta">
                <strong>{userDisplayName || userEmail}</strong>
                <small>{userEmail}</small>
                <span>{userRoleLabel}</span>
              </div>
              <button type="button" onClick={() => void onSignOut()}>Sign Out</button>
            </div>
          </details>
        </div>
      </div>
      {managementAccess && presence && enabledFeatures.shifts !== false ? (
        <div className="presence-strip">
          <span>Presence</span>
          <span className="presence-pill">On Duty {presence.onDuty}</span>
          <span className="presence-pill">On Break {presence.onBreak}</span>
          <span className="presence-pill warn">Late {presence.late}</span>
          <span className="presence-pill">Off Shift {presence.offShift}</span>
        </div>
      ) : null}
    </header>
  );
}
