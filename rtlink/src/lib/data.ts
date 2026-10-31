import { supabase } from './supabase';
import type {
  ActionKind,
  ActionRequest,
  Announcement,
  BoardNote,
  DirectoryEntry,
  Employee,
  ExceptionRequest,
  OvertimeRequest,
  OrgSummary,
  Shift,
  Site,
  SiteSettings,
  SwapRequest,
  Task,
  TimeOffRequest,
  TrainingAssignment,
  WorkArea,
  Workspace
} from '../types';

type QueryResult = { data: unknown; error: { message: string } | null };

async function rows<T>(query: PromiseLike<QueryResult>): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as T[];
}

async function single<T>(query: PromiseLike<QueryResult>): Promise<T | null> {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data as T | null) ?? null;
}

export async function lookupOrg(code: string): Promise<OrgSummary | null> {
  const { data, error } = await supabase.rpc('rtlink_lookup_org', { p_code: code.trim() });
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  return (row as OrgSummary | undefined) ?? null;
}

export async function signIn(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password
  });
  if (error) throw new Error(error.message);
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}

export async function fetchWorkspace(): Promise<Workspace | null> {
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError) throw new Error(authError.message);
  if (!auth.user) return null;

  // RLS returns only this employee's own row.
  const employee = await single<Employee>(
    supabase.from('rtlink_employees').select('*').limit(1).maybeSingle()
  );
  if (!employee) return null;

  const site = await single<Site>(
    supabase.from('rtlink_sites').select('*').eq('id', employee.site_id).maybeSingle()
  );
  if (!site) throw new Error('This site has not finished its first sync yet.');

  const employeeFilter = `employee_id.eq.${employee.id}`;
  const [
    settings,
    workAreas,
    shifts,
    tasks,
    announcements,
    boardNotes,
    timeOff,
    overtime,
    exceptions,
    swaps,
    training,
    directory,
    actions
  ] = await Promise.all([
    single<SiteSettings>(
      supabase.from('rtlink_settings').select('*').eq('site_id', employee.site_id).maybeSingle()
    ),
    rows<WorkArea>(
      supabase.from('rtlink_work_areas').select('*').eq('site_id', employee.site_id)
    ),
    rows<Shift>(
      supabase
        .from('rtlink_shifts')
        .select('*')
        .or(`${employeeFilter},is_shift_pool.eq.true`)
        .order('start_at', { ascending: true })
    ),
    rows<Task>(
      supabase
        .from('rtlink_tasks')
        .select('*')
        .eq('assignee_id', employee.id)
        .order('start_at', { ascending: true })
    ),
    rows<Announcement>(
      supabase
        .from('rtlink_announcements')
        .select('*')
        .eq('site_id', employee.site_id)
        .eq('is_active', true)
    ),
    rows<BoardNote>(
      supabase
        .from('rtlink_board_notes')
        .select('*')
        .eq('site_id', employee.site_id)
        .order('note_date', { ascending: false })
        .limit(10)
    ),
    rows<TimeOffRequest>(
      supabase
        .from('rtlink_time_off_requests')
        .select('*')
        .eq('employee_id', employee.id)
        .order('created_at_local', { ascending: false })
    ),
    rows<OvertimeRequest>(
      supabase
        .from('rtlink_overtime_requests')
        .select('*')
        .eq('employee_id', employee.id)
        .order('created_at_local', { ascending: false })
    ),
    rows<ExceptionRequest>(
      supabase
        .from('rtlink_exception_requests')
        .select('*')
        .eq('employee_id', employee.id)
        .order('created_at_local', { ascending: false })
    ),
    rows<SwapRequest>(
      supabase
        .from('rtlink_swap_requests')
        .select('*')
        .or(`requester_id.eq.${employee.id},requested_employee_id.eq.${employee.id}`)
        .order('created_at_local', { ascending: false })
    ),
    rows<TrainingAssignment>(
      supabase.from('rtlink_training_assignments').select('*').eq('employee_id', employee.id)
    ),
    rows<DirectoryEntry>(
      supabase.from('rtlink_directory').select('id, full_name').eq('site_id', employee.site_id)
    ),
    rows<ActionRequest>(
      supabase
        .from('rtlink_requests')
        .select('*')
        .eq('employee_id', employee.id)
        .order('requested_at', { ascending: false })
        .limit(40)
    )
  ]);

  return {
    employee,
    site,
    settings,
    workAreas,
    shifts,
    tasks,
    announcements,
    boardNotes,
    timeOff,
    overtime,
    exceptions,
    swaps,
    training,
    directory,
    actions
  };
}

export async function submitAction(
  employeeId: string,
  siteId: string,
  kind: ActionKind,
  payload: Record<string, unknown>
): Promise<ActionRequest> {
  const { data, error } = await supabase
    .from('rtlink_requests')
    .insert({
      employee_id: employeeId,
      site_id: siteId,
      kind,
      payload,
      status: 'pending'
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as ActionRequest;
}

export function pendingActions(actions: ActionRequest[]): ActionRequest[] {
  return actions.filter((action) => action.status === 'pending');
}
