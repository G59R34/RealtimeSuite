import { useState } from 'react';
import type { CorpData, Location, Scope } from '../types';
import { saveLocation, updateCompanyProfile } from '../lib/data';
import { formatDateTime, humanize, relativeTime } from '../lib/format';
import { syncHealth } from '../lib/metrics';
import { Badge, Card, Empty, Field, TableShell } from './ui';

const TIMEZONES = [
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
  'Europe/London',
  'Europe/Berlin',
  'Australia/Sydney'
];

export function SitesView({
  data,
  scope,
  canManage,
  onChanged
}: {
  data: CorpData;
  scope: Scope;
  canManage: boolean;
  onChanged: () => Promise<void>;
}) {
  const company = data.company;
  const [profile, setProfile] = useState({
    name: company?.name ?? '',
    industry: company?.industry ?? '',
    headquarters: company?.headquarters ?? ''
  });
  const [locationForm, setLocationForm] = useState({
    name: '',
    code: '',
    address: '',
    timezone: TIMEZONES[0],
    status: 'active' as Location['status']
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function run(action: () => Promise<void>, message: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      await onChanged();
      setNotice(message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That change did not save.');
    } finally {
      setBusy(false);
    }
  }

  async function submitProfile() {
    if (!company) return;
    await run(
      () =>
        updateCompanyProfile({
          id: company.id,
          name: profile.name.trim(),
          industry: profile.industry.trim(),
          headquarters: profile.headquarters.trim()
        }),
      'Company profile saved.'
    );
  }

  async function submitLocation() {
    if (!locationForm.name.trim()) return;
    const current = editing ? data.locations.find((row) => row.id === editing) : undefined;
    await run(
      () =>
        saveLocation({
          id: current?.id,
          company_id: scope.company_id,
          name: locationForm.name.trim(),
          code: locationForm.code.trim(),
          address: locationForm.address.trim(),
          timezone: locationForm.timezone,
          status: locationForm.status
        }),
      editing ? 'Location updated.' : 'Location added.'
    );
    setEditing(null);
    setLocationForm({
      name: '',
      code: '',
      address: '',
      timezone: TIMEZONES[0],
      status: 'active'
    });
  }

  return (
    <div className="view-stack">
      {(error || notice) && (
        <p className={error ? 'banner banner-error' : 'banner banner-ok'}>{error ?? notice}</p>
      )}

      <div className="grid-2">
        <Card
          title="Company profile"
          subtitle={canManage ? 'Shown across the corporate console' : 'Read only for your role'}
          actions={<Badge value={scope.role} />}
        >
          <div className="form-row">
            <Field label="Company name">
              <input
                value={profile.name}
                disabled={!canManage}
                onChange={(event) => setProfile({ ...profile, name: event.target.value })}
              />
            </Field>
            <Field label="Industry">
              <input
                value={profile.industry}
                disabled={!canManage}
                placeholder="Retail, logistics, healthcare…"
                onChange={(event) => setProfile({ ...profile, industry: event.target.value })}
              />
            </Field>
          </div>
          <Field label="Headquarters">
            <input
              value={profile.headquarters}
              disabled={!canManage}
              placeholder="City, region"
              onChange={(event) => setProfile({ ...profile, headquarters: event.target.value })}
            />
          </Field>
          {canManage && (
            <button
              className="button primary"
              type="button"
              disabled={busy || !profile.name.trim()}
              onClick={submitProfile}
            >
              Save profile
            </button>
          )}
          <dl className="meta-list">
            <div>
              <dt>Company id</dt>
              <dd className="mono">{scope.company_id}</dd>
            </div>
            <div>
              <dt>Locations</dt>
              <dd>{data.locations.length}</dd>
            </div>
            <div>
              <dt>Connected sites</dt>
              <dd>{data.sites.length}</dd>
            </div>
          </dl>
        </Card>

        <Card
          title={editing ? 'Edit location' : 'Add location'}
          subtitle="Locations group sites for reporting and payroll"
        >
          <div className="form-row">
            <Field label="Name">
              <input
                value={locationForm.name}
                disabled={!canManage}
                placeholder="Downtown store"
                onChange={(event) =>
                  setLocationForm({ ...locationForm, name: event.target.value })
                }
              />
            </Field>
            <Field label="Code">
              <input
                value={locationForm.code}
                disabled={!canManage}
                placeholder="DEN-01"
                onChange={(event) =>
                  setLocationForm({ ...locationForm, code: event.target.value })
                }
              />
            </Field>
          </div>
          <Field label="Address">
            <input
              value={locationForm.address}
              disabled={!canManage}
              placeholder="1600 Wynkoop St, Denver, CO"
              onChange={(event) =>
                setLocationForm({ ...locationForm, address: event.target.value })
              }
            />
          </Field>
          <div className="form-row">
            <Field label="Time zone">
              <select
                value={locationForm.timezone}
                disabled={!canManage}
                onChange={(event) =>
                  setLocationForm({ ...locationForm, timezone: event.target.value })
                }
              >
                {TIMEZONES.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Status">
              <select
                value={locationForm.status}
                disabled={!canManage}
                onChange={(event) =>
                  setLocationForm({
                    ...locationForm,
                    status: event.target.value as Location['status']
                  })
                }
              >
                <option value="active">Active</option>
                <option value="paused">Paused</option>
                <option value="closed">Closed</option>
              </select>
            </Field>
          </div>
          {canManage ? (
            <div className="button-row">
              <button
                className="button primary"
                type="button"
                disabled={busy || !locationForm.name.trim()}
                onClick={submitLocation}
              >
                {editing ? 'Save location' : 'Add location'}
              </button>
              {editing && (
                <button
                  className="button ghost"
                  type="button"
                  onClick={() => {
                    setEditing(null);
                    setLocationForm({
                      name: '',
                      code: '',
                      address: '',
                      timezone: TIMEZONES[0],
                      status: 'active'
                    });
                  }}
                >
                  Cancel
                </button>
              )}
            </div>
          ) : (
            <p className="muted small">Only administrators and managers can edit locations.</p>
          )}
        </Card>
      </div>

      <Card title="Locations" subtitle={`${data.locations.length} configured`}>
        {data.locations.length === 0 ? (
          <Empty>No locations yet.</Empty>
        ) : (
          <TableShell>
            <thead>
              <tr>
                <th>Name</th>
                <th>Code</th>
                <th>Address</th>
                <th>Time zone</th>
                <th>Sites</th>
                <th>Status</th>
                {canManage && <th />}
              </tr>
            </thead>
            <tbody>
              {data.locations.map((location) => (
                <tr key={location.id}>
                  <td>{location.name}</td>
                  <td className="mono">{location.code ?? '—'}</td>
                  <td className="muted">{location.address ?? '—'}</td>
                  <td>{location.timezone}</td>
                  <td>{data.sites.filter((site) => site.location_id === location.id).length}</td>
                  <td>
                    <Badge value={location.status} />
                  </td>
                  {canManage && (
                    <td>
                      <button
                        className="button ghost small"
                        type="button"
                        onClick={() => {
                          setEditing(location.id);
                          setLocationForm({
                            name: location.name,
                            code: location.code ?? '',
                            address: location.address ?? '',
                            timezone: location.timezone,
                            status: location.status
                          });
                        }}
                      >
                        Edit
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>

      <Card
        title="Connected sites"
        subtitle="Each RealtimeSuite installation pushes snapshots to one row here"
      >
        {data.sites.length === 0 ? (
          <Empty>No site has sent a snapshot yet.</Empty>
        ) : (
          <TableShell>
            <thead>
              <tr>
                <th>Site</th>
                <th>Location</th>
                <th>Health</th>
                <th>Last snapshot</th>
                <th>Records</th>
                <th className="mono">Site id</th>
              </tr>
            </thead>
            <tbody>
              {data.sites.map((site) => {
                const health = syncHealth(site);
                const counts = site.record_counts ?? {};
                const total = Object.values(counts).reduce(
                  (sum, value) => sum + Number(value ?? 0),
                  0
                );
                return (
                  <tr key={site.id}>
                    <td>{site.name}</td>
                    <td className="muted">
                      {data.locations.find((row) => row.id === site.location_id)?.name ?? '—'}
                    </td>
                    <td>
                      <span className={`dot dot-${health}`} />{' '}
                      {humanize(health === 'ok' ? 'healthy' : health)}
                    </td>
                    <td>
                      {formatDateTime(site.last_sync_at)}
                      <span className="muted small"> · {relativeTime(site.last_sync_at)}</span>
                    </td>
                    <td>{total} rows</td>
                    <td className="mono small">{site.id}</td>
                  </tr>
                );
              })}
            </tbody>
          </TableShell>
        )}
      </Card>
    </div>
  );
}
