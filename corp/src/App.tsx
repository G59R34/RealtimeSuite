import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { AppShell, type CorpView } from './components/AppShell';
import { AuthScreen, BootstrapScreen } from './components/AuthScreen';
import { OverviewView } from './components/OverviewView';
import { OperationsView } from './components/OperationsView';
import { PayrollView } from './components/PayrollView';
import { PeopleView } from './components/PeopleView';
import { PoliciesView } from './components/PoliciesView';
import { SitesView } from './components/SitesView';
import { SyncView } from './components/SyncView';
import { cancelCommand, fetchCompanyData, fetchScope, queueCommand, signOut } from './lib/data';
import { supabase } from './lib/supabase';
import type { CommandRequest, CorpData, Scope } from './types';

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [scopeLoading, setScopeLoading] = useState(false);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [data, setData] = useState<CorpData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<CorpView>('overview');

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data: result }) => {
      if (!active) return;
      setSession(result.session);
      setChecking(false);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (!next) {
        setScopes([]);
        setData(null);
        setCompanyId(null);
      }
    });
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  const loadScope = useCallback(async () => {
    if (!session) return;
    setScopeLoading(true);
    setScopeError(null);
    try {
      const next = await fetchScope();
      setScopes(next);
      setCompanyId((current) => {
        if (current && next.some((item) => item.company_id === current)) return current;
        return next[0]?.company_id ?? null;
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not load your access.';
      // A stale or revoked session must not look like a brand-new account.
      if (/jwt|token|401/i.test(message)) {
        await signOut();
        setScopeError(`Your session expired. Sign in again to continue. (${message})`);
      } else {
        setScopeError(message);
      }
    } finally {
      setScopeLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void loadScope();
  }, [loadScope]);

  const loadData = useCallback(
    async (id: string, silent = false) => {
      if (!silent) setLoading(true);
      try {
        const next = await fetchCompanyData(id);
        setData(next);
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not load company data.');
      } finally {
        if (!silent) setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (!companyId) {
      setData(null);
      return;
    }
    void loadData(companyId);
  }, [companyId, loadData]);

  useEffect(() => {
    if (!companyId) return;
    const timer = window.setInterval(() => void loadData(companyId, true), 60000);
    return () => window.clearInterval(timer);
  }, [companyId, loadData]);

  const scope = useMemo(
    () => scopes.find((item) => item.company_id === companyId) ?? null,
    [scopes, companyId]
  );

  const canManage = scope?.role === 'corp_admin' || scope?.role === 'corp_manager';

  // Corporate-owned changes are queued for the site, then the console reloads so
  // the new command shows as pending until the site applies it.
  const queueForSite = useCallback(
    async (request: CommandRequest) => {
      if (!companyId) throw new Error('Choose a company first.');
      await queueCommand({ companyId, ...request });
      await loadData(companyId, true);
    },
    [companyId, loadData]
  );

  const cancelQueuedCommand = useCallback(
    async (commandId: string) => {
      if (!companyId) return;
      await cancelCommand(commandId);
      await loadData(companyId, true);
    },
    [companyId, loadData]
  );

  async function handleSignOut() {
    await signOut();
    setData(null);
    setScopes([]);
    setCompanyId(null);
  }

  if (checking) {
    return <div className="splash">Loading RealtimeCorp…</div>;
  }

  if (!session) {
    return <AuthScreen notice={scopeError} />;
  }

  if (scopeLoading && scopes.length === 0) {
    return <div className="splash">Checking your access…</div>;
  }

  if (scopeError) {
    return (
      <div className="auth-shell single">
        <div className="auth-card">
          <h2>Can't load your access</h2>
          <p className="muted small">
            {scopeError} If this keeps happening, ask a corporate administrator to check
            that your account still has a membership.
          </p>
          <div className="button-row">
            <button className="button primary" type="button" onClick={() => void loadScope()}>
              Try again
            </button>
            <button className="button ghost" type="button" onClick={() => void handleSignOut()}>
              Sign out
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (scopes.length === 0) {
    return (
      <BootstrapScreen
        email={session.user.email ?? null}
        onCreated={() => void loadScope()}
      />
    );
  }

  if (!scope) {
    return <div className="splash">Preparing your company…</div>;
  }

  return (
    <>
      {error && (
        <div className="global-error">
          <span>{error}</span>
          <button className="button ghost small" type="button" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}
      <AppShell
        scope={scope}
        scopes={scopes}
        view={view}
        onView={setView}
        onScope={(id) => {
          setCompanyId(id);
          setData(null);
        }}
        onSignOut={() => void handleSignOut()}
        onRefresh={() => void loadData(scope.company_id)}
        refreshing={loading}
        email={session.user.email ?? null}
      >
        {!data ? (
          <div className="splash inline">Loading {scope.company_name}…</div>
        ) : (
          <>
            {view === 'overview' && <OverviewView data={data} scope={scope} />}
            {view === 'sites' && (
              <SitesView
                data={data}
                scope={scope}
                canManage={canManage}
                onChanged={() => loadData(scope.company_id, true)}
              />
            )}
            {view === 'people' && (
              <PeopleView data={data} canManage={canManage} onCommand={queueForSite} />
            )}
            {view === 'operations' && (
              <OperationsView data={data} canManage={canManage} onCommand={queueForSite} />
            )}
            {view === 'payroll' && (
              <PayrollView data={data} canManage={canManage} onCommand={queueForSite} />
            )}
            {view === 'policies' && (
              <PoliciesView
                data={data}
                scope={scope}
                canManage={canManage}
                onCommand={queueForSite}
                onChanged={() => loadData(scope.company_id, true)}
              />
            )}
            {view === 'sync' && (
              <SyncView data={data} canManage={canManage} onCancel={cancelQueuedCommand} />
            )}
          </>
        )}
      </AppShell>
    </>
  );
}
