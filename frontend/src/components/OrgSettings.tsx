import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { OrganizationExperienceBuilderConfig, OrganizationSettings } from '../types';
import { ClockInLocationsSettings } from './ClockInLocationsSettings';

type OrgSettingsProps = {
  settings: OrganizationSettings | null;
  busy: boolean;
  onUploadLoginAsset: (file: File, kind: 'logo' | 'background') => Promise<string>;
  onOpenOpsBoardSettings: () => void;
  onSave: (payload: {
    adminPortalLabel: string;
    loginPrimaryColor: string;
    loginAccentColor: string;
    loginLogoUrl: string;
    loginBackgroundImageUrl: string;
    loginAnnouncement: string;
    loginHeading: string;
    loginSubheading: string;
    experienceBuilderConfig: OrganizationExperienceBuilderConfig;
    enableRetailFloorSimulation: boolean;
    enableExtendedLeaveLock: boolean;
    extendedLeaveThresholdDays: number;
    enableAdminRealtimeNotifications: boolean;
    defaultTimelineWindowHours: 2 | 4 | 8;
    defaultShiftBreakMinutes: number;
  }) => Promise<void>;
};

export function OrgSettings({ settings, busy, onUploadLoginAsset, onOpenOpsBoardSettings, onSave }: OrgSettingsProps) {
  const [adminPortalLabel, setAdminPortalLabel] = useState('Scheduling');
  const [loginHeading, setLoginHeading] = useState('RealtimeSuite');
  const [loginSubheading, setLoginSubheading] = useState('Local scheduling, attendance, and task operations.');
  const [loginPrimaryColor, setLoginPrimaryColor] = useState('#0b3d91');
  const [loginAccentColor, setLoginAccentColor] = useState('#ff7a00');
  const [loginLogoUrl, setLoginLogoUrl] = useState('');
  const [loginBackgroundImageUrl, setLoginBackgroundImageUrl] = useState('');
  const [loginAnnouncement, setLoginAnnouncement] = useState('');
  const [timelineWindowHours, setTimelineWindowHours] = useState<2 | 4 | 8>(8);
  const [defaultBreakMinutes, setDefaultBreakMinutes] = useState(30);
  const [experienceBuilderConfig, setExperienceBuilderConfig] = useState<OrganizationExperienceBuilderConfig | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<'logo' | 'background' | null>(null);

  useEffect(() => {
    if (!settings) return;
    setAdminPortalLabel(settings.admin_portal_label || 'Scheduling');
    setLoginHeading(settings.login_heading || 'RealtimeSuite');
    setLoginSubheading(settings.login_subheading || 'Local scheduling, attendance, and task operations.');
    setLoginPrimaryColor(settings.login_primary_color || '#0b3d91');
    setLoginAccentColor(settings.login_accent_color || '#ff7a00');
    setLoginLogoUrl(settings.login_logo_url || '');
    setLoginBackgroundImageUrl(settings.login_background_image_url || '');
    setLoginAnnouncement(settings.login_announcement || '');
    setTimelineWindowHours(settings.default_timeline_window_hours);
    setDefaultBreakMinutes(settings.default_shift_break_minutes);
    setExperienceBuilderConfig(settings.experience_builder_config);
  }, [settings]);

  async function uploadAsset(file: File | null, kind: 'logo' | 'background') {
    if (!file) return;
    setError(null);
    setStatus(null);
    setUploading(kind);
    try {
      const url = await onUploadLoginAsset(file, kind);
      if (kind === 'logo') setLoginLogoUrl(url);
      else setLoginBackgroundImageUrl(url);
      setStatus('Image uploaded. Save settings to publish the change.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploading(null);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings || !experienceBuilderConfig) return;
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      await onSave({
        adminPortalLabel,
        loginPrimaryColor,
        loginAccentColor,
        loginLogoUrl,
        loginBackgroundImageUrl,
        loginAnnouncement,
        loginHeading,
        loginSubheading,
        experienceBuilderConfig,
        enableRetailFloorSimulation: settings.enable_retail_floor_simulation,
        enableExtendedLeaveLock: settings.enable_extended_leave_lock,
        extendedLeaveThresholdDays: settings.extended_leave_threshold_days,
        enableAdminRealtimeNotifications: settings.enable_admin_realtime_notifications,
        defaultTimelineWindowHours: timelineWindowHours,
        defaultShiftBreakMinutes: defaultBreakMinutes
      });
      setStatus('Organization settings saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings.');
    } finally {
      setSaving(false);
    }
  }

  if (!settings) {
    return (
      <section className="roster-shell">
        <p className="empty-state">Loading organization settings...</p>
      </section>
    );
  }

  const disabled = busy || saving;

  return (
    <section className="org-settings-shell">
      <header className="roster-head">
        <h2>Organization Settings</h2>
        <span className="employee-badge neutral">{settings.organization_name}</span>
      </header>

      <form className="weta-admin-form org-settings-form" onSubmit={handleSubmit}>
        <article className="weta-admin-card">
          <h3>Scheduling Defaults</h3>
          <label>
            Admin portal label
            <input value={adminPortalLabel} onChange={(event) => setAdminPortalLabel(event.target.value)} disabled={disabled} />
          </label>
          <label>
            Default timeline window
            <select
              value={timelineWindowHours}
              onChange={(event) => setTimelineWindowHours(Number(event.target.value) as 2 | 4 | 8)}
              disabled={disabled}
            >
              <option value={2}>2 hours</option>
              <option value={4}>4 hours</option>
              <option value={8}>8 hours</option>
            </select>
          </label>
          <label>
            Default shift break (minutes)
            <input
              type="number"
              min={0}
              value={defaultBreakMinutes}
              onChange={(event) => setDefaultBreakMinutes(Number(event.target.value))}
              disabled={disabled}
            />
          </label>
          <div className="ops-editor-actions">
            <button type="button" onClick={onOpenOpsBoardSettings}>Live Board Settings</button>
          </div>
        </article>

        <article className="weta-admin-card">
          <h3>Sign-In Page</h3>
          <label>
            Heading
            <input value={loginHeading} onChange={(event) => setLoginHeading(event.target.value)} disabled={disabled} />
          </label>
          <label>
            Subheading
            <input value={loginSubheading} onChange={(event) => setLoginSubheading(event.target.value)} disabled={disabled} />
          </label>
          <label>
            Announcement
            <textarea
              rows={2}
              value={loginAnnouncement}
              onChange={(event) => setLoginAnnouncement(event.target.value)}
              disabled={disabled}
            />
          </label>
          <label>
            Primary color
            <input type="color" value={loginPrimaryColor} onChange={(event) => setLoginPrimaryColor(event.target.value)} disabled={disabled} />
          </label>
          <label>
            Accent color
            <input type="color" value={loginAccentColor} onChange={(event) => setLoginAccentColor(event.target.value)} disabled={disabled} />
          </label>
          <label>
            Logo
            <input
              type="file"
              accept="image/*"
              onChange={(event) => void uploadAsset(event.target.files?.[0] ?? null, 'logo')}
              disabled={disabled || uploading === 'logo'}
            />
          </label>
          {loginLogoUrl ? <img className="settings-asset-preview" src={loginLogoUrl} alt="Login logo" /> : null}
          <label>
            Background image
            <input
              type="file"
              accept="image/*"
              onChange={(event) => void uploadAsset(event.target.files?.[0] ?? null, 'background')}
              disabled={disabled || uploading === 'background'}
            />
          </label>
          {loginBackgroundImageUrl ? <img className="settings-asset-preview" src={loginBackgroundImageUrl} alt="Login background" /> : null}
        </article>

        <article className="weta-admin-card">
          <h3>Clock-In Locations</h3>
          <ClockInLocationsSettings organizationId={settings.organization_id} busy={disabled} />
        </article>

        {error ? <p className="auth-error">{error}</p> : null}
        {status ? <p className="form-message">{status}</p> : null}
        <div className="ops-editor-actions">
          <button type="submit" disabled={disabled}>{saving ? 'Saving...' : 'Save Settings'}</button>
        </div>
      </form>
    </section>
  );
}
