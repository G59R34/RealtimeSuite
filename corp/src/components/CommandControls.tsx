import { useEffect, useState } from 'react';
import type { CorpCommand } from '../types';
import { formatDateTime, humanize } from '../lib/format';

// A corporate change the site has not applied yet, or one it rejected.
export function CommandState({ command }: { command?: CorpCommand }) {
  if (!command) return null;
  if (command.status === 'failed') {
    return (
      <span className="badge badge-bad" title={command.error ?? 'The site rejected this change.'}>
        failed
      </span>
    );
  }
  if (command.status !== 'pending') return null;
  return (
    <span className="badge badge-warn" title="Waiting for the site to apply this change">
      pending
    </span>
  );
}

export function CommandError({ command }: { command?: CorpCommand }) {
  if (!command || command.status !== 'failed' || !command.error) return null;
  return (
    <p className="muted small">
      {humanize(command.kind)} failed at {formatDateTime(command.requested_at)}: {command.error}
    </p>
  );
}

/**
 * Hourly rate editor. Saving queues a `set_pay_rate` command; the value on
 * screen only changes once the site applies it and mirrors the new rate back.
 */
export function RateEditor({
  rate,
  command,
  disabled,
  onSave
}: {
  rate: number | string | null;
  command?: CorpCommand;
  disabled?: boolean;
  onSave: (rate: number | null) => Promise<void> | void;
}) {
  const [value, setValue] = useState(rate == null ? '' : String(rate));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValue(rate == null ? '' : String(rate));
  }, [rate]);

  async function save() {
    const raw = value.trim();
    const parsed = raw === '' ? null : Number(raw);
    if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) {
      setError('Enter a rate of 0 or more.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await onSave(parsed);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not queue the rate change.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inline-field">
      <input
        type="number"
        min={0}
        step="0.01"
        value={value}
        disabled={disabled || busy}
        onChange={(event) => setValue(event.target.value)}
        aria-label="Hourly rate"
        style={{ width: '92px' }}
      />
      <button
        className="button ghost small"
        type="button"
        disabled={disabled || busy}
        onClick={() => void save()}
      >
        {busy ? '…' : 'Set'}
      </button>
      <CommandState command={command} />
      {error ? <span className="muted small">{error}</span> : null}
    </div>
  );
}
