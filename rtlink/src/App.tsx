import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { AppShell } from './components/AppShell';
import { AuthScreen, LinkRequiredScreen } from './components/AuthScreen';
import { TodayView } from './components/TodayView';
import { ScheduleView } from './components/ScheduleView';
import { TasksView } from './components/TasksView';
import { RequestsView } from './components/RequestsView';
import { MeView } from './components/MeView';
import { fetchWorkspace, signOut, submitAction } from './lib/data';
import { supabase, supabaseConfigured } from './lib/supabase';
import type { ActionKind, ViewMode, Workspace } from './types';

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
  const timers = useRef<number[]>([]);

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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load your schedule.');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (session) void load();
  }, [session, load]);

  // The site pushes changes on its own schedule; a light poll keeps the phone
  // current without realtime publication setup.
  useEffect(() => {
    if (!session) return;
    const timer = window.setInterval(() => void load(true), 30000);
    return () => window.clearInterval(timer);
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
      // The LAN site applies queued actions on a short poll; refresh again so
      // the result shows without the employee pulling to reload.
      [4000, 12000].forEach((ms) => {
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

  if (checking) {
    return <div className="splash">Opening RTLink…</div>;
  }

  if (!session) {
    return <AuthScreen configured={supabaseConfigured} />;
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
      {view === 'today' && <TodayView workspace={workspace} onSubmit={submit} />}
      {view === 'schedule' && <ScheduleView workspace={workspace} onSubmit={submit} />}
      {view === 'tasks' && <TasksView workspace={workspace} onSubmit={submit} />}
      {view === 'requests' && <RequestsView workspace={workspace} onSubmit={submit} />}
      {view === 'me' && (
        <MeView workspace={workspace} email={session.user.email ?? null} onSignOut={() => void handleSignOut()} />
      )}
    </AppShell>
  );
}
