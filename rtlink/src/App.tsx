import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { AppShell } from './components/AppShell';
import { AuthScreen, LinkRequiredScreen } from './components/AuthScreen';
import { OrgGate } from './components/OrgGate';
import { TodayView } from './components/TodayView';
import { ScheduleView } from './components/ScheduleView';
import { TasksView } from './components/TasksView';
import { RequestsView } from './components/RequestsView';
import { MeView } from './components/MeView';
import { fetchSyncStamp, fetchWorkspace, signOut, submitAction } from './lib/data';
import { clearOrgCode, getOrgCode, supabase, supabaseConfigured } from './lib/supabase';
import type { ActionKind, ViewMode, Workspace } from './types';

// How often to ask the site whether a new snapshot arrived, and how often to
// reload anyway in case a stamp was missed.
const STAMP_POLL_MS = 2000;
const FULL_REFRESH_MS = 60000;
// Used when the stamp check itself keeps failing (a site that has not applied the
// stamp migration yet): slower, but the app still refreshes on its own.
const FALLBACK_REFRESH_MS = 15000;

const ACTION_NOTICES: Record<ActionKind, string> = {
  'time_off.create': 'Time off request sent to your manager.',
  'overtime.create': 'Overtime request sent to your manager.',
  'exception.create': 'Exception request sent to your manager.',
  'swap.create': 'Swap request posted.',
  'task.acknowledge': 'Task acknowledged.',
  'shift.claim': 'Shift claimed. Your schedule updates in a moment.',
  'shift.clock_in': 'Clock-in sent to your site.',
  'shift.clock_out': 'Clock-out sent to your site.',
  'shift.clock_in_unscheduled': 'Unscheduled clock-in sent to your site.'
};

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>('today');
  const [notice, setNotice] = useState<string | null>(null);
  const [orgCode, setOrgCodeState] = useState<string>(() => getOrgCode());
  const timers = useRef<number[]>([]);
  const stampRef = useRef<string | null>(null);
  const lastFullRef = useRef(0);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setChecking(false);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (!next) {
        setWorkspace(null);
        setView('today');
      }
    });
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const next = await fetchWorkspace();
      setWorkspace(next);
      setError(null);
      lastFullRef.current = Date.now();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load your schedule.');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (session) void load();
  }, [session, load]);

  // Every delivered snapshot bumps a stamp in rtlink_sync_events, so checking it
  // is one tiny request. Poll it often and reload the workspace only when the
  // data actually moved; a slow full refresh covers a missed stamp.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    let inFlight = false;
    let failures = 0;

    const poll = async () => {
      if (cancelled || inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      try {
        const stamp = await fetchSyncStamp();
        const stale =
          Date.now() - lastFullRef.current >=
          (failures >= 3 ? FALLBACK_REFRESH_MS : FULL_REFRESH_MS);
        failures = 0;
        if (stale || (stamp && stamp !== stampRef.current)) {
          stampRef.current = stamp ?? stampRef.current;
          await load(true);
        }
      } catch {
        failures += 1;
        // Keep showing the last good workspace; the next tick retries.
      } finally {
        inFlight = false;
      }
    };

    const timer = window.setInterval(() => void poll(), STAMP_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void poll();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [session, load]);

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((id) => window.clearTimeout(id));
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const submit = useCallback(
    async (kind: ActionKind, payload: Record<string, unknown>) => {
      if (!workspace) throw new Error('Your schedule is still loading.');
      await submitAction(workspace.employee.id, workspace.site.id, kind, payload);
      setNotice(ACTION_NOTICES[kind]);
      await load(true);
      // The stamp poll usually shows the applied result within a couple of
      // seconds; these refreshes cover the first push landing slightly later.
      [1500, 5000].forEach((ms) => {
        timers.current.push(window.setTimeout(() => void load(true), ms));
      });
    },
    [workspace, load]
  );

  async function handleSignOut() {
    await signOut();
    setWorkspace(null);
    setView('today');
    setNotice(null);
  }

  async function handleChangeOrg() {
    clearOrgCode();
    setOrgCodeState('');
    setWorkspace(null);
    setView('today');
    await signOut();
  }

  if (!orgCode) {
    return <OrgGate onSelected={(code) => setOrgCodeState(code)} />;
  }

  if (checking) {
    return <div className="splash">Opening RTLink…</div>;
  }

  if (!session) {
    return (
      <AuthScreen
        configured={supabaseConfigured}
        orgCode={orgCode}
        onChangeOrg={() => void handleChangeOrg()}
      />
    );
  }

  if (!workspace) {
    if (loading) return <div className="splash">Loading your schedule…</div>;
    if (error) {
      return (
        <div className="standalone">
          <div className="card">
            <h1>Can't load your schedule</h1>
            <p className="muted">{error}</p>
            <div className="row-gap">
              <button className="btn primary" type="button" onClick={() => void load()}>
                Try again
              </button>
              <button className="btn ghost" type="button" onClick={() => void handleSignOut()}>
                Sign out
              </button>
            </div>
          </div>
        </div>
      );
    }
    return (
      <LinkRequiredScreen
        email={session.user.email ?? null}
        orgCode={orgCode}
        onChangeOrg={() => void handleChangeOrg()}
        onSignOut={() => void handleSignOut()}
        onRetry={() => void load()}
      />
    );
  }

  return (
    <AppShell
      workspace={workspace}
      view={view}
      onView={setView}
      onRefresh={() => void load()}
      refreshing={loading}
      email={session.user.email ?? null}
      notice={notice}
      error={error}
    >
      {view === 'today' && (
        <TodayView workspace={workspace} onSubmit={submit} onNavigate={setView} />
      )}
      {view === 'schedule' && <ScheduleView workspace={workspace} onSubmit={submit} />}
      {view === 'tasks' && <TasksView workspace={workspace} onSubmit={submit} />}
      {view === 'requests' && <RequestsView workspace={workspace} onSubmit={submit} />}
      {view === 'me' && (
        <MeView
          workspace={workspace}
          email={session.user.email ?? null}
          orgCode={orgCode}
          onChangeOrg={() => void handleChangeOrg()}
          onSignOut={() => void handleSignOut()}
        />
      )}
    </AppShell>
  );
}
