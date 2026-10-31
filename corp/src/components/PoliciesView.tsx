import { useEffect, useMemo, useState } from 'react';
import type { CommandRequest, CorpData, Policy, Scope } from '../types';
import { deletePolicy, savePolicy } from '../lib/data';
import {
  POLICY_SETTINGS,
  TRAINING_SETTINGS,
  humanizeKey,
  latestCommand
} from '../lib/commands';
import { formatDate, formatDateTime, humanize, toDateInput } from '../lib/format';
import { Badge, Card, Empty, Field, Stat, TableShell } from './ui';
import { CommandError, CommandState } from './CommandControls';

const EMPTY_FORM = {
  id: undefined as string | undefined,
  title: '',
  category: 'general',
  body: '',
  status: 'draft' as Policy['status'],
  effective_on: toDateInput(new Date()),
  owner: ''
};

export function PoliciesView({
  data,
  scope,
  canManage,
  onChanged,
  onCommand
}: {
  data: CorpData;
  scope: Scope;
  canManage: boolean;
  onChanged: () => Promise<void>;
  onCommand: (request: CommandRequest) => Promise<void>;
}) {
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const settingsSites = useMemo(() => {
    const byId = new Map(data.siteSettings.map((row) => [row.site_id, row]));
    return data.sites
      .filter((site) => byId.has(site.id))
      .map((site) => ({ site, settings: byId.get(site.id)! }));
  }, [data.sites, data.siteSettings]);

  const [configSite, setConfigSite] = useState(settingsSites[0]?.site.id ?? '');
  const selectedConfig = settingsSites.find((row) => row.site.id === configSite) ?? settingsSites[0];

  const [flagDraft, setFlagDraft] = useState<Record<string, boolean>>({});
  const [settingsDraft, setSettingsDraft] = useState<Record<string, string>>({});
  const [configBusy, setConfigBusy] = useState<'flags' | 'policy' | null>(null);
  const [configNotice, setConfigNotice] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedConfig) return;
    setFlagDraft({ ...selectedConfig.settings.feature_flags });
    const policy = selectedConfig.settings.policy_settings ?? {};
    const training = (policy.training_mode as Record<string, unknown> | undefined) ?? {};
    const next: Record<string, string> = {};
    for (const { key } of POLICY_SETTINGS) {
      next[key] = policy[key] == null ? '' : String(policy[key]);
    }
    for (const { key } of TRAINING_SETTINGS) {
      next[key] = training[key] == null ? '' : String(training[key]);
    }
    setSettingsDraft(next);
  }, [selectedConfig]);

  async function saveFlags() {
    if (!selectedConfig) return;
    setConfigBusy('flags');
    setConfigError(null);
    setConfigNotice(null);
    try {
      await onCommand({
        kind: 'set_feature_flags',
        siteId: selectedConfig.site.id,
        payload: { flags: flagDraft }
      });
      setConfigNotice(`Feature flags queued for ${selectedConfig.site.name}.`);
    } catch (cause) {
      setConfigError(cause instanceof Error ? cause.message : 'Could not queue the change.');
    } finally {
      setConfigBusy(null);
    }
  }

  async function savePolicySettings() {
    if (!selectedConfig) return;
    setConfigBusy('policy');
    setConfigError(null);
    setConfigNotice(null);
    try {
      const settings: Record<string, unknown> = {};
      const training: Record<string, unknown> = {};
      for (const { key, type } of POLICY_SETTINGS) {
        const raw = settingsDraft[key] ?? '';
        if (raw === '') continue;
        settings[key] = type === 'boolean' ? raw === 'true' : Number(raw);
      }
      for (const { key } of TRAINING_SETTINGS) {
        const raw = settingsDraft[key] ?? '';
        if (raw === '') continue;
        training[key] = Number(raw);
      }
      await onCommand({
        kind: 'set_policy_settings',
        siteId: selectedConfig.site.id,
        payload: { settings, training_mode: training }
      });
      setConfigNotice(`Policy settings queued for ${selectedConfig.site.name}.`);
    } catch (cause) {
      setConfigError(cause instanceof Error ? cause.message : 'Could not queue the change.');
    } finally {
      setConfigBusy(null);
    }
  }

  function reset() {
    setForm({ ...EMPTY_FORM });
    setError(null);
  }

  async function submit() {
    if (!form.title.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await savePolicy({
        id: form.id,
        company_id: scope.company_id,
        title: form.title.trim(),
        category: form.category.trim() || 'general',
        body: form.body,
        status: form.status,
        effective_on: form.effective_on || null,
        owner: form.owner.trim() || null
      });
      await onChanged();
      setNotice(form.id ? 'Policy updated.' : 'Policy created.');
      setForm({ ...EMPTY_FORM });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the policy.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(policy: Policy) {
    if (!window.confirm(`Delete "${policy.title}"? This cannot be undone.`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await deletePolicy(policy.id);
      await onChanged();
      setNotice('Policy deleted.');
      if (form.id === policy.id) reset();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not delete the policy.');
    } finally {
      setBusy(false);
    }
  }

  const active = data.policies.filter((policy) => policy.status === 'active');
  const drafts = data.policies.filter((policy) => policy.status === 'draft');
  const archived = data.policies.filter((policy) => policy.status === 'archived');

  return (
    <div className="view-stack">
      {(error || notice) && (
        <p className={error ? 'banner banner-error' : 'banner banner-ok'}>{error ?? notice}</p>
      )}

      <div className="stat-grid compact">
        <Stat label="Active policies" value={String(active.length)} tone="good" />
        <Stat label="Drafts" value={String(drafts.length)} />
        <Stat label="Archived" value={String(archived.length)} />
        <Stat label="Your access" value={humanize(scope.role)} />
      </div>

      <Card
        title="Site configuration"
        subtitle="Feature flags and scheduling policy are owned here; each site applies them within seconds"
        actions={
          settingsSites.length > 1 ? (
            <select
              value={selectedConfig?.site.id ?? ''}
              onChange={(event) => setConfigSite(event.target.value)}
            >
              {settingsSites.map((row) => (
                <option key={row.site.id} value={row.site.id}>
                  {row.site.name}
                </option>
              ))}
            </select>
          ) : undefined
        }
      >
        {!selectedConfig ? (
          <Empty>
            No site has reported its configuration yet. Connect a RealtimeSuite site and push a
            snapshot first.
          </Empty>
        ) : (
          <>
            {configError ? <p className="banner banner-error">{configError}</p> : null}
            {configNotice ? <p className="banner banner-ok">{configNotice}</p> : null}
            <p className="muted small">
              Last reported {formatDateTime(selectedConfig.settings.synced_at)} ·{' '}
              <CommandState command={latestCommand(data.commands, 'set_feature_flags', null)} />
            </p>

            <h3 className="subhead">Feature flags</h3>
            <div className="flag-grid">
              {Object.entries(flagDraft)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, value]) => (
                  <label key={key} className="inline-field">
                    <input
                      type="checkbox"
                      checked={Boolean(value)}
                      disabled={!canManage || configBusy !== null}
                      onChange={(event) =>
                        setFlagDraft({ ...flagDraft, [key]: event.target.checked })
                      }
                    />
                    <span>{humanizeKey(key)}</span>
                  </label>
                ))}
            </div>
            {canManage ? (
              <button
                className="button primary"
                type="button"
                disabled={configBusy !== null}
                onClick={() => void saveFlags()}
              >
                {configBusy === 'flags' ? 'Queuing…' : 'Save feature flags'}
              </button>
            ) : null}
            <CommandError command={latestCommand(data.commands, 'set_feature_flags', null)} />

            <h3 className="subhead">Scheduling policy</h3>
            <div className="form-row three">
              {POLICY_SETTINGS.map((setting) => (
                <Field key={setting.key} label={setting.label}>
                  {setting.type === 'boolean' ? (
                    <select
                      value={settingsDraft[setting.key] ?? ''}
                      disabled={!canManage}
                      onChange={(event) =>
                        setSettingsDraft({ ...settingsDraft, [setting.key]: event.target.value })
                      }
                    >
                      <option value="true">On</option>
                      <option value="false">Off</option>
                    </select>
                  ) : (
                    <input
                      type="number"
                      value={settingsDraft[setting.key] ?? ''}
                      disabled={!canManage}
                      onChange={(event) =>
                        setSettingsDraft({ ...settingsDraft, [setting.key]: event.target.value })
                      }
                    />
                  )}
                </Field>
              ))}
            </div>

            <h3 className="subhead">Training mode</h3>
            <div className="form-row three">
              {TRAINING_SETTINGS.map((setting) => (
                <Field key={setting.key} label={setting.label}>
                  <input
                    type="number"
                    value={settingsDraft[setting.key] ?? ''}
                    disabled={!canManage}
                    onChange={(event) =>
                      setSettingsDraft({ ...settingsDraft, [setting.key]: event.target.value })
                    }
                  />
                </Field>
              ))}
            </div>
            {canManage ? (
              <button
                className="button primary"
                type="button"
                disabled={configBusy !== null}
                onClick={() => void savePolicySettings()}
              >
                {configBusy === 'policy' ? 'Queuing…' : 'Save policy settings'}
              </button>
            ) : null}
            <CommandError command={latestCommand(data.commands, 'set_policy_settings', null)} />
          </>
        )}
      </Card>

      {canManage && (
        <Card
          title={form.id ? 'Edit policy' : 'New policy'}
          subtitle="Policies are published to corporate readers in this console"
          actions={
            form.id ? (
              <button className="button ghost small" type="button" onClick={reset}>
                New policy
              </button>
            ) : undefined
          }
        >
          <div className="form-row">
            <Field label="Title">
              <input
                value={form.title}
                placeholder="Attendance and punctuality"
                onChange={(event) => setForm({ ...form, title: event.target.value })}
              />
            </Field>
            <Field label="Category">
              <input
                value={form.category}
                placeholder="HR, safety, finance"
                onChange={(event) => setForm({ ...form, category: event.target.value })}
              />
            </Field>
          </div>
          <Field label="Body">
            <textarea
              rows={6}
              value={form.body}
              placeholder="State the policy, who it applies to, and how it is enforced."
              onChange={(event) => setForm({ ...form, body: event.target.value })}
            />
          </Field>
          <div className="form-row three">
            <Field label="Status">
              <select
                value={form.status}
                onChange={(event) =>
                  setForm({ ...form, status: event.target.value as Policy['status'] })
                }
              >
                <option value="draft">Draft</option>
                <option value="active">Active</option>
                <option value="archived">Archived</option>
              </select>
            </Field>
            <Field label="Effective on">
              <input
                type="date"
                value={form.effective_on ?? ''}
                onChange={(event) => setForm({ ...form, effective_on: event.target.value })}
              />
            </Field>
            <Field label="Owner">
              <input
                value={form.owner}
                placeholder="VP of Operations"
                onChange={(event) => setForm({ ...form, owner: event.target.value })}
              />
            </Field>
          </div>
          <button
            className="button primary"
            type="button"
            disabled={busy || !form.title.trim()}
            onClick={submit}
          >
            {busy ? 'Saving…' : form.id ? 'Save changes' : 'Create policy'}
          </button>
        </Card>
      )}

      <Card title="Policy library" subtitle={`${data.policies.length} documents`}>
        {data.policies.length === 0 ? (
          <Empty>
            No policies yet.
            {!canManage && ' Ask a corporate administrator to publish the first one.'}
          </Empty>
        ) : (
          <TableShell>
            <thead>
              <tr>
                <th>Title</th>
                <th>Category</th>
                <th>Status</th>
                <th>Owner</th>
                <th>Effective</th>
                <th>Updated</th>
                {canManage && <th />}
              </tr>
            </thead>
            <tbody>
              {data.policies.map((policy) => (
                <tr key={policy.id}>
                  <td>
                    <strong>{policy.title}</strong>
                    {policy.body && (
                      <p className="muted small clamp">{policy.body.slice(0, 140)}</p>
                    )}
                  </td>
                  <td className="muted">{humanize(policy.category)}</td>
                  <td>
                    <Badge value={policy.status} />
                  </td>
                  <td className="muted">{policy.owner ?? '—'}</td>
                  <td className="muted small">{formatDate(policy.effective_on)}</td>
                  <td className="muted small">{formatDate(policy.updated_at)}</td>
                  {canManage && (
                    <td className="row-actions">
                      <button
                        className="button ghost small"
                        type="button"
                        onClick={() => {
                          setForm({
                            id: policy.id,
                            title: policy.title,
                            category: policy.category,
                            body: policy.body,
                            status: policy.status,
                            effective_on: policy.effective_on ?? '',
                            owner: policy.owner ?? ''
                          });
                          window.scrollTo({ top: 0, behavior: 'smooth' });
                        }}
                      >
                        Edit
                      </button>
                      <button
                        className="button ghost small danger"
                        type="button"
                        disabled={busy}
                        onClick={() => remove(policy)}
                      >
                        Delete
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>
    </div>
  );
}
