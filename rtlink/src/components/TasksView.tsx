import { useState } from 'react';
import { formatDay, formatRange, statusLabel } from '../lib/format';
import type { ActionKind, Workspace } from '../types';
import { Card, Empty, Pill } from './ui';

type Submit = (kind: ActionKind, payload: Record<string, unknown>) => Promise<void>;

interface Props {
  workspace: Workspace;
  onSubmit: Submit;
}

const CLOSED_STATUSES = new Set(['done', 'cancelled', 'completed']);

export function TasksView({ workspace, onSubmit }: Props) {
  const { tasks } = workspace;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ordered = [...tasks].sort((a, b) => a.start_at.localeCompare(b.start_at));
  const open = ordered.filter(
    (task) => !task.acknowledged_at && !CLOSED_STATUSES.has(task.status)
  );
  const acknowledged = ordered.filter(
    (task) => task.acknowledged_at || CLOSED_STATUSES.has(task.status)
  );

  async function acknowledge(assignmentId: string, key: string) {
    setBusy(key);
    setError(null);
    try {
      await onSubmit('task.acknowledge', { assignment_id: assignmentId });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not acknowledge that task.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack">
      <div className="summary-row">
        <div>
          <strong>{open.length}</strong>
          <span>Open</span>
        </div>
        <div>
          <strong>{acknowledged.length}</strong>
          <span>Acknowledged</span>
        </div>
        <div>
          <strong>{tasks.filter((task) => task.source_system === 'github').length}</strong>
          <span>From GitHub</span>
        </div>
      </div>

      {error && <p className="form-error">{error}</p>}

      <Card title="Needs you" hint="Acknowledge so your manager knows you saw it">
        {open.length ? (
          <div className="list">
            {open.map((task) => (
              <article className="task-card" key={task.id}>
                <div className="task-card-head">
                  <strong>{task.title}</strong>
                  <Pill status={task.priority} label={statusLabel(task.priority)} />
                </div>
                <span className="muted small">
                  {formatDay(task.start_at)} · {formatRange(task.start_at, task.end_at)}
                  {task.work_area_name ? ` · ${task.work_area_name}` : ''}
                </span>
                {task.description && <p>{task.description}</p>}
                <div className="task-card-foot">
                  <Pill status={task.status} />
                  <button
                    className="btn primary small"
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void acknowledge(task.assignment_id, task.id)}
                  >
                    {busy === task.id ? 'Sending…' : 'Acknowledge'}
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <Empty title="You're all caught up" body="New tasks show up here the moment they are assigned." />
        )}
      </Card>

      <Card title="Recently acknowledged" hint="Last 45 days">
        {acknowledged.length ? (
          <div className="list">
            {acknowledged.slice(0, 12).map((task) => (
              <div className="task-row" key={task.id}>
                <div>
                  <strong>{task.title}</strong>
                  <span className="muted small">
                    {formatDay(task.start_at)} · {formatRange(task.start_at, task.end_at)}
                  </span>
                </div>
                <Pill status={task.acknowledged_at ? 'done' : task.status} label={task.acknowledged_at ? 'Acknowledged' : statusLabel(task.status)} />
              </div>
            ))}
          </div>
        ) : (
          <Empty title="Nothing here yet" />
        )}
      </Card>
    </div>
  );
}
