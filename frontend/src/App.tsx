import { useCallback, useEffect, useMemo, useState } from 'react';
import { TopBar } from './components/TopBar';
import { TimelineBoard } from './components/TimelineBoard';
import { ClockInAudit } from './components/ClockInAudit';
import { EmployeeRoster } from './components/EmployeeRoster';
import { AdminReports } from './components/AdminReports';
import { OrgSettings } from './components/OrgSettings';
import { OpsBoardSettingsPage } from './components/OpsBoardSettingsPage';
import { OnboardingFlow } from './components/OnboardingFlow';
import { AuthScreen } from './components/AuthScreen';
import { EmployeePortal } from './components/EmployeePortal';
import { AdminSchedulingPortal } from './components/AdminSchedulingPortal';
import type {
  AdminDashboardData,
  BoardFilters,
  EmployeePortalData,
  OrganizationLoginBranding,
  OrganizationSettings,
  ProfileRow
} from './types';
import type { AdminRealtimeNotificationEvent } from './lib/api';
import {
  acceptShiftSwapRequest,
  acknowledgeTaskAssignment,
  adminCreateEmployeeAccount,
  applyDisciplineAction,
  assignOvertimeRequestByAdmin,
  assignShiftBreakTask,
  assignTaskToEmployee,
  assignTrainingCourse,
  autoAssignShiftsForDate,
  autoAssignShiftsForMonth,
  claimShiftPoolShift,
  clockInOwnShift,
  clockInShift,
  clockInUnscheduledShift,
  clockOutOwnShift,
  clockOutShift,
  completeTrainingAssignment,
  createDisciplineAction,
  createEmployeeMessage,
  createExceptionRequest,
  createNoteTaskForEmployee,
  createOvertimeRequest,
  createShiftPoolForMonth,
  createShiftSwapRequest,
  createTimeOffRequest,
  createWorkArea,
  deleteExceptionRequestByAdmin,
  deleteMonthShiftsAndReset,
  deleteShift,
  deleteTask,
  deleteTimeOffRequestByAdmin,
  fetchActiveAnnouncement,
  fetchAdminDashboardData,
  fetchCurrentOrganizationSettings,
  fetchEmployeePortalData,
  fetchFeatureFlags,
  fetchLoginBranding,
  fetchMyEffectiveAdminAccess,
  fetchProfile,
  fetchServerNow,
  getCurrentSession,
  markEmployeeMessageRead,
  markMyNotificationRead,
  onAuthStateChanged,
  previewTimeOffCoverageImpact,
  reassignTaskToEmployee,
  revokeDisciplineAction,
  reviewExceptionRequest,
  reviewOvertimeRequest,
  reviewShiftSwapRequest,
  reviewTimeOffRequest,
  saveMyOnboardingState,
  sendOnboardingCredentialsEmail,
  setShiftPoolStatus,
  signIn,
  signOut,
  subscribeToAdminRealtimeNotifications,
  subscribeToAppRealtime,
  updateDisciplineAction,
  updateEmployeePayRate,
  updateExceptionRequestByAdmin,
  updateProfileHelpfulInfo,
  updateShiftWorkArea,
  updateTask,
  updateTimeOffRequestByAdmin,
  unassignTaskAssignment,
  upsertMyWorkPreferences,
  upsertShift,
  uploadOrganizationLoginAsset,
  updateCurrentOrganizationSettings
} from './lib/api';
import { todayDateInputValue } from './lib/time';
import { DEFAULT_FEATURES } from './lib/features';
import type { FeatureFlags } from './lib/features';
import type { ViewMode } from './lib/views';

type NotificationItem = {
  id: string;
  title: string;
  detail: string;
  createdAt: string;
  unread: boolean;
};

function notificationLabel(event: AdminRealtimeNotificationEvent): { title: string; detail: string } {
  switch (event.kind) {
    case 'clock_in':
      return { title: 'Employee clocked in', detail: `Shift ${event.shiftId.slice(0, 8)} started at ${new Date(event.occurredAt).toLocaleTimeString()}` };
    case 'clock_out':
      return { title: 'Employee clocked out', detail: `Shift ${event.shiftId.slice(0, 8)} ended at ${new Date(event.occurredAt).toLocaleTimeString()}` };
    case 'time_off_request_submitted':
      return { title: 'Time-off request', detail: `${event.startDate} to ${event.endDate}` };
    case 'exception_request_submitted':
      return { title: 'Exception submitted', detail: `Request ${event.requestId.slice(0, 8)}` };
    default:
      return { title: 'Realtime update', detail: 'Scheduling data changed' };
  }
}

export default function App() {
  const [authLoading, setAuthLoading] = useState(true);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [branding, setBranding] = useState<OrganizationLoginBranding | null>(null);
  const [settings, setSettings] = useState<OrganizationSettings | null>(null);
  const [adminData, setAdminData] = useState<AdminDashboardData | null>(null);
  const [employeeData, setEmployeeData] = useState<EmployeePortalData | null>(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataBusy, setDataBusy] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<ViewMode>('operations');
  const [selectedDate, setSelectedDate] = useState(todayDateInputValue());
  const [timelineWindowHours, setTimelineWindowHours] = useState<2 | 4 | 8>(8);
  const [filters, setFilters] = useState<BoardFilters>({ resources: true, events: true, unassigned: true });
  const [features, setFeatures] = useState<FeatureFlags>(DEFAULT_FEATURES);
  const [shiftFilter, setShiftFilter] = useState('all');
  const [rosterSearch, setRosterSearch] = useState('');
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [connectivity, setConnectivity] = useState<'online' | 'syncing' | 'offline'>('online');
  const [onboardingBusy, setOnboardingBusy] = useState(false);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [messageOpen, setMessageOpen] = useState(false);
  const [messageRecipient, setMessageRecipient] = useState('');
  const [messageSubject, setMessageSubject] = useState('');
  const [messageBody, setMessageBody] = useState('');

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    void fetchLoginBranding().then(setBranding).catch(() => undefined);
    void fetchServerNow().then((value) => {
      if (value) setNow(new Date(value));
    }).catch(() => undefined);
  }, []);

  const loadProfile = useCallback(async (userId: string) => {
    const nextProfile = await fetchProfile(userId);
    setProfile(nextProfile);
    const effectiveAdmin = nextProfile.role === 'admin'
      ? true
      : await fetchMyEffectiveAdminAccess().catch(() => false);
    setIsAdmin(effectiveAdmin);
    const nextSettings = await fetchCurrentOrganizationSettings().catch(() => null);
    setSettings(nextSettings);
    if (nextSettings) {
      setTimelineWindowHours(nextSettings.default_timeline_window_hours);
    }
    const nextFeatures = await fetchFeatureFlags().catch(() => null);
    if (nextFeatures) setFeatures(nextFeatures);
    setAnnouncement(await fetchActiveAnnouncement().catch(() => null));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const existing = await getCurrentSession();
        if (existing?.user.id) {
          await loadProfile(existing.user.id);
        }
      } catch {
        // no valid session
      } finally {
        if (!cancelled) setAuthLoading(false);
      }
    })();

    const subscription = onAuthStateChanged((session) => {
      if (!session) {
        setProfile(null);
        setAdminData(null);
        setEmployeeData(null);
      }
    });
    return () => {
      cancelled = true;
      subscription.data.subscription.unsubscribe();
    };
  }, [loadProfile]);

  const reloadData = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!profile) return;
    if (!options.silent) {
      setDataLoading(true);
      setConnectivity('syncing');
    }
    try {
      if (isAdmin) {
        const next = await fetchAdminDashboardData(selectedDate);
        setAdminData(next);
      } else {
        const next = await fetchEmployeePortalData(profile.id, selectedDate);
        setEmployeeData(next);
      }
      setDataError(null);
      setConnectivity('online');
    } catch (error) {
      setDataError(error instanceof Error ? error.message : 'Failed to load data.');
      setConnectivity('offline');
    } finally {
      setDataLoading(false);
    }
  }, [profile, isAdmin, selectedDate]);

  useEffect(() => {
    if (!profile) return;
    void reloadData();
  }, [profile, isAdmin, selectedDate, reloadData]);

  useEffect(() => {
    if (!profile) return;
    const timer = window.setInterval(() => {
      void reloadData({ silent: true });
    }, 20000);
    return () => window.clearInterval(timer);
  }, [profile, reloadData]);

  useEffect(() => {
    if (!profile) return;
    const unsubscribe = subscribeToAppRealtime(() => {
      void reloadData({ silent: true });
    });
    return unsubscribe;
  }, [profile, reloadData]);

  useEffect(() => {
    if (!profile || !isAdmin) return;
    const unsubscribe = subscribeToAdminRealtimeNotifications((event) => {
      const label = notificationLabel(event);
      setNotifications((current) => [
        {
          id: `${event.kind}-${Date.now()}`,
          title: label.title,
          detail: label.detail,
          createdAt: new Date().toISOString(),
          unread: true
        },
        ...current
      ].slice(0, 50));
    });
    return unsubscribe;
  }, [profile, isAdmin]);

  async function handleSignIn(email: string, password: string) {
    setAuthBusy(true);
    setAuthError(null);
    try {
      await signIn(email, password);
      const session = await getCurrentSession();
      if (!session?.user.id) throw new Error('Sign-in succeeded but the session is missing.');
      await loadProfile(session.user.id);
      setAuthLoading(false);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Sign-in failed.');
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleSignOut() {
    await signOut();
    setProfile(null);
    setAdminData(null);
    setEmployeeData(null);
    setActiveView('operations');
    const nextBranding = await fetchLoginBranding().catch(() => null);
    setBranding(nextBranding);
  }

  async function runMutation<T>(action: () => Promise<T>): Promise<T> {
    setDataBusy(true);
    setDataError(null);
    try {
      const result = await action();
      await reloadData({ silent: true });
      return result;
    } catch (error) {
      setDataError(error instanceof Error ? error.message : 'Request failed.');
      throw error;
    } finally {
      setDataBusy(false);
    }
  }

  function handleSearch() {
    if (!adminData) return;
    const term = window.prompt('Search employees, tasks, shifts, or work areas');
    if (term === null) return;
    const query = term.trim();
    if (!query) return;
    setRosterSearch(query);
    setActiveView('roster');
  }

  function handleQuickAction(actionId: 'assign-task' | 'create-shift' | 'send-message' | 'refresh') {
    if (actionId === 'refresh') {
      void reloadData();
      return;
    }
    if (actionId === 'create-shift') {
      if (!features.shifts) return;
      setActiveView('scheduling');
      return;
    }
    if (actionId === 'assign-task') {
      if (!features.tasks) return;
      setActiveView('operations');
      return;
    }
    if (!features.messages) return;
    const first = adminData?.employees[0];
    setMessageRecipient(first?.id ?? '');
    setMessageSubject('');
    setMessageBody('');
    setMessageOpen(true);
  }

  const onboardingRequired = useMemo(() => {
    if (!profile || !settings?.enable_onboarding || !features.onboarding) return false;
    const completedVersion = profile.onboarding_completed_version ?? 0;
    return !profile.onboarding_completed_at || completedVersion < settings.onboarding_version;
  }, [profile, settings, features.onboarding]);

  const schedulingEnabled = features.shifts || features.shift_pool || features.auto_assign;

  useEffect(() => {
    if (!isAdmin) return;
    const allowed: Record<ViewMode, boolean> = {
      operations: true,
      roster: features.roster,
      scheduling: schedulingEnabled,
      reports: features.reports,
      'shift-audit': features.clock_in_audit,
      settings: true,
      'opsboard-settings': true,
      'employee-portal': features.employee_portal
    };
    if (!allowed[activeView]) setActiveView('operations');
  }, [activeView, features, isAdmin, schedulingEnabled]);

  async function handleCompleteOnboarding(answers: Record<string, unknown>) {
    if (!profile || !settings) return;
    setOnboardingBusy(true);
    setOnboardingError(null);
    try {
      await saveMyOnboardingState({
        answers,
        completed: true,
        completedVersion: settings.onboarding_version
      });
      await loadProfile(profile.id);
      await reloadData({ silent: true });
    } catch (error) {
      setOnboardingError(error instanceof Error ? error.message : 'Failed to save onboarding.');
    } finally {
      setOnboardingBusy(false);
    }
  }

  if (authLoading) {
    return (
      <section className="auth-shell">
        <div className="auth-card">
          <h1>RealtimeSuite</h1>
          <p>Connecting to the local scheduling server...</p>
        </div>
      </section>
    );
  }

  if (!profile) {
    return (
      <AuthScreen
        branding={branding}
        onSignIn={handleSignIn}
        busy={authBusy}
        error={authError}
      />
    );
  }

  if (onboardingRequired && settings) {
    return (
      <OnboardingFlow
        profile={profile}
        settings={settings}
        initialAnswers={profile.onboarding_answers ?? {}}
        busy={onboardingBusy}
        error={onboardingError}
        onSubmit={handleCompleteOnboarding}
        onSignOut={handleSignOut}
      />
    );
  }

  if (!isAdmin && employeeData) {
    return (
      <div className="app-shell">
        {dataError ? <div className="global-error">{dataError}</div> : null}
        <EmployeePortal
          data={employeeData}
          dateValue={selectedDate}
          onDateChange={setSelectedDate}
          onSignOut={handleSignOut}
          onAcknowledgeTask={(assignmentId, note) => runMutation(() => acknowledgeTaskAssignment(assignmentId, note))}
          onClockInShift={(shiftId, location) => runMutation(() => clockInOwnShift(shiftId, location))}
          onClockInUnscheduledShift={(note, location) => runMutation(() => clockInUnscheduledShift(note, location))}
          onClockOutShift={(shiftId) => runMutation(() => clockOutOwnShift(shiftId))}
          onCreateTimeOffRequest={(payload) => runMutation(() => createTimeOffRequest(payload))}
          onCreateExceptionRequest={(payload) => runMutation(() => createExceptionRequest(payload))}
          onCreateOvertimeRequest={(payload) => runMutation(() => createOvertimeRequest(payload))}
          onRespondToAssignedOvertimeRequest={({ requestId, accept, note }) => runMutation(() => reviewOvertimeRequest({
            requestId,
            status: accept ? 'approved' : 'denied',
            reviewNotes: note ?? ''
          }))}
          onCreateShiftSwapRequest={(payload) => runMutation(async () => { await createShiftSwapRequest(payload); })}
          onAcceptShiftSwapRequest={(requestId, note) => runMutation(async () => { await acceptShiftSwapRequest(requestId, note); })}
          onPreviewTimeOffCoverageImpact={(payload) => previewTimeOffCoverageImpact(payload)}
          onUpdateHelpfulInfo={(helpfulInfo) => runMutation(() => updateProfileHelpfulInfo(profile.id, helpfulInfo))}
          onSendMessage={(payload) => runMutation(() => createEmployeeMessage(payload))}
          onMarkMessageRead={(messageId) => runMutation(() => markEmployeeMessageRead(messageId))}
          onMarkNotificationRead={(notificationId) => runMutation(() => markMyNotificationRead(notificationId))}
          onUpdateWorkPreferences={(payload) => runMutation(() => upsertMyWorkPreferences(payload))}
          onClaimShiftPool={(shiftId) => runMutation(() => claimShiftPoolShift(shiftId))}
          onCompleteTraining={(assignmentId, notes) => runMutation(() => completeTrainingAssignment(assignmentId, notes))}
          employeeExperienceModules={settings?.experience_builder_config.employee_modules ?? []}
          employeeExperienceElements={settings?.experience_builder_config.employee_elements}
          enabledFeatures={features}
          busy={dataBusy}
        />
      </div>
    );
  }

  if (isAdmin && !adminData) {
    return (
      <section className="auth-shell">
        <div className="auth-card">
          <h1>RealtimeSuite</h1>
          <p>{dataError ?? 'Loading scheduling data...'}</p>
          {dataError ? <button type="button" onClick={() => void reloadData()}>Retry</button> : null}
        </div>
      </section>
    );
  }

  const employees = adminData?.employees ?? [];
  const effectiveNow = now;
  const presence = adminData ? {
    onDuty: adminData.shifts.filter((shift) => shift.status === 'on_duty').length,
    onBreak: adminData.shifts.filter((shift) => shift.status === 'break').length,
    late: adminData.shifts.filter((shift) => shift.status === 'scheduled' && shift.clocked_in_at
      && new Date(shift.clocked_in_at).getTime() > new Date(shift.start_at).getTime() + 5 * 60000).length,
    offShift: employees.length - new Set(adminData.shifts
      .filter((shift) => shift.status === 'on_duty' || shift.status === 'break')
      .map((shift) => shift.employee_id)).size
  } : null;

  return (
    <div className="app-shell admin-ops-shell">
      <TopBar
        activeView={activeView}
        onViewChange={setActiveView}
        shiftFilter={shiftFilter}
        onShiftFilterChange={setShiftFilter}
        timelineWindowHours={timelineWindowHours}
        onTimelineWindowChange={setTimelineWindowHours}
        filters={filters}
        onToggleFilter={(key) => setFilters((current) => ({ ...current, [key]: !current[key] }))}
        selectedDate={selectedDate}
        onDateChange={setSelectedDate}
        onRefresh={() => reloadData()}
        onSearch={handleSearch}
        onSignOut={handleSignOut}
        onQuickAction={handleQuickAction}
        now={effectiveNow}
        announcement={announcement}
        notifications={notifications}
        unreadNotificationCount={notifications.filter((entry) => entry.unread).length}
        notificationsOpen={notificationsOpen}
        onToggleNotifications={() => setNotificationsOpen((open) => !open)}
        onMarkAllNotificationsRead={() => setNotifications((current) => current.map((entry) => ({ ...entry, unread: false })))}
        onClearNotifications={() => setNotifications([])}
        showOrgSettings={isAdmin}
        enabledFeatures={features}
        showRosterTab={isAdmin && features.roster}
        showEmployeePortalTab={isAdmin && features.employee_portal}
        showClockInAuditTab={isAdmin && features.clock_in_audit}
        showSchedulingTab={isAdmin && schedulingEnabled}
        showReportsTab={isAdmin && features.reports}
        onOpenLiveBoard={() => window.open('/opsboard.html', '_blank', 'noopener')}
        connectivityState={connectivity}
        userDisplayName={profile.full_name || profile.email}
        userEmail={profile.email}
        userRoleLabel={profile.role === 'admin' ? 'Administrator' : 'Scheduler'}
        presence={presence}
      />

      {dataError ? <div className="global-error">{dataError}</div> : null}

      <main className="content-shell">
        {adminData && (activeView === 'operations' || activeView === 'employee-portal') ? (
          activeView === 'employee-portal' && employeeData ? (
            <EmployeePortal
              data={employeeData}
              dateValue={selectedDate}
              onDateChange={setSelectedDate}
              onSignOut={handleSignOut}
              onAcknowledgeTask={(assignmentId, note) => runMutation(() => acknowledgeTaskAssignment(assignmentId, note))}
              onClockInShift={(shiftId, location) => runMutation(() => clockInOwnShift(shiftId, location))}
              onClockInUnscheduledShift={(note, location) => runMutation(() => clockInUnscheduledShift(note, location))}
              onClockOutShift={(shiftId) => runMutation(() => clockOutOwnShift(shiftId))}
              onCreateTimeOffRequest={(payload) => runMutation(() => createTimeOffRequest(payload))}
              onCreateExceptionRequest={(payload) => runMutation(() => createExceptionRequest(payload))}
              onCreateOvertimeRequest={(payload) => runMutation(() => createOvertimeRequest(payload))}
              onRespondToAssignedOvertimeRequest={({ requestId, accept, note }) => runMutation(() => reviewOvertimeRequest({
                requestId,
                status: accept ? 'approved' : 'denied',
                reviewNotes: note ?? ''
              }))}
              onCreateShiftSwapRequest={(payload) => runMutation(async () => { await createShiftSwapRequest(payload); })}
              onAcceptShiftSwapRequest={(requestId, note) => runMutation(async () => { await acceptShiftSwapRequest(requestId, note); })}
              onPreviewTimeOffCoverageImpact={(payload) => previewTimeOffCoverageImpact(payload)}
              onUpdateHelpfulInfo={(helpfulInfo) => runMutation(() => updateProfileHelpfulInfo(profile.id, helpfulInfo))}
              onSendMessage={(payload) => runMutation(() => createEmployeeMessage(payload))}
              onMarkMessageRead={(messageId) => runMutation(() => markEmployeeMessageRead(messageId))}
              onMarkNotificationRead={(notificationId) => runMutation(() => markMyNotificationRead(notificationId))}
              onUpdateWorkPreferences={(payload) => runMutation(() => upsertMyWorkPreferences(payload))}
              onClaimShiftPool={(shiftId) => runMutation(() => claimShiftPoolShift(shiftId))}
              onCompleteTraining={(assignmentId, notes) => runMutation(() => completeTrainingAssignment(assignmentId, notes))}
              employeeExperienceModules={settings?.experience_builder_config.employee_modules ?? []}
              employeeExperienceElements={settings?.experience_builder_config.employee_elements}
              enabledFeatures={features}
              busy={dataBusy}
            />
          ) : (
            <TimelineBoard
              employees={employees}
              workAreas={adminData.workAreas}
              shifts={adminData.shifts}
              tasks={adminData.tasks}
              taskAssignments={adminData.taskAssignments}
              filters={filters}
              selectedDate={selectedDate}
              timelineWindowHours={timelineWindowHours}
              defaultShiftBreakMinutes={settings?.default_shift_break_minutes ?? 30}
              features={features}
              nowDate={effectiveNow}
              actorId={profile.id}
              busy={dataBusy}
              onUpsertShift={(payload) => runMutation(() => upsertShift(payload))}
              onDeleteShift={(shiftId) => runMutation(() => deleteShift(shiftId))}
              onUpdateShiftWorkArea={(shiftId, workAreaId) => runMutation(() => updateShiftWorkArea(shiftId, workAreaId))}
              onCreateWorkArea={(payload) => runMutation(() => createWorkArea(payload))}
              onClockInShift={(shiftId, actorId) => runMutation(() => clockInShift(shiftId, actorId))}
              onClockOutShift={(shiftId, actorId) => runMutation(() => clockOutShift(shiftId, actorId))}
              onAssignBreak={(shiftId, breakMinutes, note) => runMutation(async () => { await assignShiftBreakTask(shiftId, breakMinutes, note); })}
              onAssignTask={(payload) => runMutation(() => assignTaskToEmployee(payload))}
              onUpdateTask={(payload) => runMutation(() => updateTask(payload))}
              onDeleteTask={(taskId) => runMutation(() => deleteTask(taskId))}
              onReassignTaskAssignment={(taskId, employeeId) => runMutation(() => reassignTaskToEmployee(taskId, employeeId))}
              onUnassignTaskAssignment={(taskId) => runMutation(() => unassignTaskAssignment(taskId))}
              onSendMessage={(payload) => runMutation(() => createEmployeeMessage({
                senderId: profile.id,
                recipientId: payload.recipientId,
                subject: payload.subject,
                message: payload.message
              }))}
              onSendNoteTask={(payload) => runMutation(() => createNoteTaskForEmployee({
                employeeId: payload.employeeId,
                actorId: profile.id,
                note: payload.note
              }))}
            />
          )
        ) : null}

        {adminData && activeView === 'roster' ? (
          <EmployeeRoster
            employees={employees}
            shifts={adminData.shifts}
            taskAssignments={adminData.taskAssignments}
            workAreas={adminData.workAreas}
            searchOverride={rosterSearch}
          />
        ) : null}

        {adminData && activeView === 'shift-audit' ? (
          <ClockInAudit employees={employees} shifts={adminData.shifts} />
        ) : null}

        {adminData && activeView === 'reports' ? (
          <AdminReports
            employees={employees}
            shifts={adminData.shifts}
            tasks={adminData.tasks}
            taskAssignments={adminData.taskAssignments}
            workAreas={adminData.workAreas}
            selectedDate={selectedDate}
          />
        ) : null}

        {adminData && activeView === 'scheduling' ? (
          <AdminSchedulingPortal
            employees={employees}
            workAreas={adminData.workAreas}
            shifts={adminData.shifts}
            monthShifts={adminData.monthShifts}
            tasks={adminData.tasks}
            timeOffRequests={adminData.timeOffRequests}
            exceptionRequests={adminData.exceptionRequests}
            overtimeRequests={adminData.overtimeRequests}
            shiftSwapRequests={adminData.shiftSwapRequests}
            shiftIntelligence={adminData.shiftIntelligence}
            disciplineActions={adminData.disciplineActions}
            organizationName={settings?.organization_name ?? 'RealtimeSuite'}
            onboardingEmailSubjectTemplate={settings?.onboarding_email_subject ?? ''}
            onboardingEmailBodyTemplate={settings?.onboarding_email_body ?? ''}
            selectedDate={selectedDate}
            actorId={profile.id}
            defaultShiftBreakMinutes={settings?.default_shift_break_minutes ?? 30}
            enabledFeatures={features}
            busy={dataBusy}
            onUpsertShift={(payload) => runMutation(() => upsertShift(payload))}
            onAutoAssignShifts={(payload) => runMutation(() => autoAssignShiftsForDate(payload))}
            onAutoAssignMonthShifts={(payload) => runMutation(() => autoAssignShiftsForMonth(payload))}
            onCreateShiftPoolMonth={(payload) => runMutation(() => createShiftPoolForMonth(payload))}
            onDeleteMonthShiftsAndReset={(payload) => runMutation(() => deleteMonthShiftsAndReset(payload))}
            onDeleteShift={(shiftId) => runMutation(() => deleteShift(shiftId))}
            onSetShiftPool={(shiftId, enabled) => runMutation(() => setShiftPoolStatus(shiftId, enabled))}
            onReviewTimeOff={(payload) => runMutation(() => reviewTimeOffRequest(payload))}
            onUpdateTimeOffRequest={(payload) => runMutation(() => updateTimeOffRequestByAdmin(payload))}
            onDeleteTimeOffRequest={(requestId) => runMutation(() => deleteTimeOffRequestByAdmin(requestId))}
            onCreateExceptionRequest={(payload) => runMutation(() => createExceptionRequest(payload))}
            onReviewExceptionRequest={(payload) => runMutation(() => reviewExceptionRequest(payload))}
            onUpdateExceptionRequest={(payload) => runMutation(() => updateExceptionRequestByAdmin(payload))}
            onDeleteExceptionRequest={(requestId) => runMutation(() => deleteExceptionRequestByAdmin(requestId))}
            onReviewOvertimeRequest={(payload) => runMutation(() => reviewOvertimeRequest(payload))}
            onAssignOvertimeRequest={(payload) => runMutation(() => assignOvertimeRequestByAdmin(payload))}
            onReviewShiftSwapRequest={(payload) => runMutation(() => reviewShiftSwapRequest(payload))}
            onCreateDisciplineAction={(payload) => runMutation(() => createDisciplineAction(payload))}
            onApplyDisciplineAction={(actionId, notes) => runMutation(() => applyDisciplineAction(actionId, notes))}
            onRevokeDisciplineAction={(actionId, notes) => runMutation(() => revokeDisciplineAction(actionId, notes))}
            onUpdateDisciplineAction={(payload) => runMutation(() => updateDisciplineAction(payload))}
            onUpdateEmployeePayRate={(employeeId, rate) => runMutation(() => updateEmployeePayRate(employeeId, rate))}
            onCreateEmployeeAccount={(payload) => runMutation(() => adminCreateEmployeeAccount(payload))}
            onSendOnboardingEmail={(payload) => runMutation(async () => {
              await sendOnboardingCredentialsEmail(payload);
            })}
          />
        ) : null}

        {activeView === 'settings' ? (
          <OrgSettings
            settings={settings}
            busy={dataBusy}
            onUploadLoginAsset={uploadOrganizationLoginAsset}
            onOpenOpsBoardSettings={() => setActiveView('opsboard-settings')}
            onSave={async (payload) => {
              const updated = await runMutation(() => updateCurrentOrganizationSettings(payload));
              setSettings(updated);
            }}
          />
        ) : null}

        {activeView === 'opsboard-settings' ? (
          <OpsBoardSettingsPage
            settings={settings}
            busy={dataBusy}
            onSave={async (opsboardSettings) => {
              if (!settings) return;
              const updated = await runMutation(() => updateCurrentOrganizationSettings({
                adminPortalLabel: settings.admin_portal_label,
                loginPrimaryColor: settings.login_primary_color,
                loginAccentColor: settings.login_accent_color,
                loginLogoUrl: settings.login_logo_url,
                loginBackgroundImageUrl: settings.login_background_image_url,
                loginAnnouncement: settings.login_announcement,
                loginHeading: settings.login_heading,
                loginSubheading: settings.login_subheading,
                experienceBuilderConfig: { ...settings.experience_builder_config, opsboard_settings: opsboardSettings },
                enableRetailFloorSimulation: settings.enable_retail_floor_simulation,
                enableExtendedLeaveLock: settings.enable_extended_leave_lock,
                extendedLeaveThresholdDays: settings.extended_leave_threshold_days,
                enableAdminRealtimeNotifications: settings.enable_admin_realtime_notifications,
                defaultTimelineWindowHours: settings.default_timeline_window_hours,
                defaultShiftBreakMinutes: settings.default_shift_break_minutes,
                enableOnboarding: settings.enable_onboarding,
                onboardingVersion: settings.onboarding_version,
                onboardingTitle: settings.onboarding_title,
                onboardingDescription: settings.onboarding_description,
                onboardingRequiredAcknowledgements: settings.onboarding_required_acknowledgements,
                onboardingCustomQuestions: settings.onboarding_custom_questions,
                onboardingEmailSubject: settings.onboarding_email_subject,
                onboardingEmailBody: settings.onboarding_email_body
              }));
              setSettings(updated);
            }}
          />
        ) : null}
      </main>

      <footer className="app-statusbar">
        <span>RealtimeSuite · {settings?.organization_name ?? 'Local Network'}</span>
        <span>{dataLoading ? 'Loading...' : dataBusy ? 'Saving...' : connectivity === 'online' ? 'Live' : connectivity}</span>
      </footer>

      {messageOpen ? (
        <div className="ops-editor-backdrop" onClick={() => setMessageOpen(false)}>
          <form
            className="ops-editor-modal"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              void runMutation(() => createEmployeeMessage({
                senderId: profile.id,
                recipientId: messageRecipient,
                subject: messageSubject,
                message: messageBody
              })).then(() => {
                setMessageOpen(false);
                setMessageBody('');
              }).catch(() => undefined);
            }}
          >
            <header className="ops-editor-head">
              <h3>Send Message</h3>
              <button type="button" onClick={() => setMessageOpen(false)}>Close</button>
            </header>
            <div className="ops-editor-body">
              <label>
                Recipient
                <select value={messageRecipient} onChange={(event) => setMessageRecipient(event.target.value)} required>
                  <option value="">Select employee</option>
                  {employees.map((employee) => (
                    <option key={employee.id} value={employee.id}>{employee.full_name || employee.email}</option>
                  ))}
                </select>
              </label>
              <label>
                Subject
                <input value={messageSubject} onChange={(event) => setMessageSubject(event.target.value)} />
              </label>
              <label style={{ gridColumn: '1 / -1' }}>
                Message
                <textarea rows={4} value={messageBody} onChange={(event) => setMessageBody(event.target.value)} required />
              </label>
              <div className="ops-editor-actions" style={{ gridColumn: '1 / -1' }}>
                <button type="submit" disabled={dataBusy || !messageRecipient || !messageBody.trim()}>Send</button>
              </div>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
