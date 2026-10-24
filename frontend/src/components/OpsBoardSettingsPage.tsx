import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { OrganizationSettings } from '../types';

type OpsBoardSettingsPageProps = {
  settings: OrganizationSettings | null;
  busy: boolean;
  onSave: (settings: OrganizationSettings['experience_builder_config']['opsboard_settings']) => Promise<void>;
};

export function OpsBoardSettingsPage({ settings, busy, onSave }: OpsBoardSettingsPageProps) {
  const [layoutPreset, setLayoutPreset] = useState<'ops' | 'shift-heavy' | 'task-heavy' | 'compact'>('ops');
  const [autoFullscreen, setAutoFullscreen] = useState(false);
  const [soundAlerts, setSoundAlerts] = useState(true);
  const [flashAlerts, setFlashAlerts] = useState(true);
  const [brandingTitle, setBrandingTitle] = useState('OpsBoard');
  const [brandingSubtitle, setBrandingSubtitle] = useState('Operations Glance Board');
  const [horizonHours, setHorizonHours] = useState<4 | 8 | 12 | 24>(8);
  const [refreshSeconds, setRefreshSeconds] = useState<15 | 30 | 60 | 120>(30);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!settings) return;
    const row = settings.experience_builder_config.opsboard_settings;
    setLayoutPreset(row.layout_preset);
    setAutoFullscreen(row.auto_fullscreen);
    setSoundAlerts(row.sound_alerts);
    setFlashAlerts(row.flash_alerts);
    setBrandingTitle(row.branding_title);
    setBrandingSubtitle(row.branding_subtitle);
    setHorizonHours(row.default_horizon_hours);
    setRefreshSeconds(row.default_refresh_seconds);
    setStatus(null);
    setError(null);
  }, [settings]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus(null);
    setError(null);
    setSaving(true);
    try {
      await onSave({
        layout_preset: layoutPreset,
        auto_fullscreen: autoFullscreen,
        sound_alerts: soundAlerts,
        flash_alerts: flashAlerts,
        branding_title: brandingTitle.trim() || 'OpsBoard',
        branding_subtitle: brandingSubtitle.trim() || 'Operations Glance Board',
        default_horizon_hours: horizonHours,
        default_refresh_seconds: refreshSeconds
      });
      setStatus('OpsBoard settings saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save OpsBoard settings.');
    } finally {
      setSaving(false);
    }
  }

  if (!settings) {
    return (
      <section className="org-settings-shell">
        <article className="org-settings-card">
          <h2>OpsBoard</h2>
          <p className="empty-state">Loading settings...</p>
        </article>
      </section>
    );
  }

  return (
    <section className="org-settings-shell">
      <article className="org-settings-card">
        <h2>OpsBoard Settings</h2>
        <p className="org-settings-meta">
          <strong>{settings.organization_name}</strong>
          <span>Applies to `/opsboard.html`</span>
        </p>

        {status ? <div className="org-settings-success">{status}</div> : null}
        {error ? <div className="org-settings-error">{error}</div> : null}

        <form className="org-settings-form" onSubmit={submit}>
          <label>
            Layout Preset
            <select value={layoutPreset} onChange={(event) => setLayoutPreset(event.target.value as typeof layoutPreset)}>
              <option value="ops">Ops</option>
              <option value="shift-heavy">Shift-Heavy</option>
              <option value="task-heavy">Task-Heavy</option>
              <option value="compact">Compact</option>
            </select>
          </label>

          <label>
            Branding Title
            <input value={brandingTitle} onChange={(event) => setBrandingTitle(event.target.value)} maxLength={60} />
          </label>

          <label>
            Branding Subtitle
            <input value={brandingSubtitle} onChange={(event) => setBrandingSubtitle(event.target.value)} maxLength={120} />
          </label>

          <label>
            Default Horizon Hours
            <select value={String(horizonHours)} onChange={(event) => setHorizonHours(Number(event.target.value) as typeof horizonHours)}>
              <option value="4">4</option>
              <option value="8">8</option>
              <option value="12">12</option>
              <option value="24">24</option>
            </select>
          </label>

          <label>
            Default Refresh Seconds
            <select value={String(refreshSeconds)} onChange={(event) => setRefreshSeconds(Number(event.target.value) as typeof refreshSeconds)}>
              <option value="15">15</option>
              <option value="30">30</option>
              <option value="60">60</option>
              <option value="120">120</option>
            </select>
          </label>

          <label className="org-settings-checkbox">
            <input type="checkbox" checked={autoFullscreen} onChange={(event) => setAutoFullscreen(event.target.checked)} />
            Auto Fullscreen on Load
          </label>

          <label className="org-settings-checkbox">
            <input type="checkbox" checked={soundAlerts} onChange={(event) => setSoundAlerts(event.target.checked)} />
            Enable Sound Alerts
          </label>

          <label className="org-settings-checkbox">
            <input type="checkbox" checked={flashAlerts} onChange={(event) => setFlashAlerts(event.target.checked)} />
            Enable Flash Alerts
          </label>

          <button type="submit" disabled={busy || saving}>
            {saving ? 'Saving...' : 'Save OpsBoard Settings'}
          </button>
        </form>
      </article>
    </section>
  );
}
