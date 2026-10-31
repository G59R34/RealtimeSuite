import { supabase } from './supabase';
import type {
  Company,
  CorpCommand,
  CorpCommandKind,
  CorpData,
  DisciplineAction,
  Employee,
  ExceptionRequest,
  Location,
  OvertimeRequest,
  Policy,
  Scope,
  Shift,
  Site,
  SiteSettings,
  SyncEvent,
  TaskRow,
  TimeOffRequest,
  TrainingAssignment
} from '../types';

export class CorpError extends Error {}

function fail(message: string): never {
  throw new CorpError(message);
}

// PostgREST caps a response at 1000 rows by default, so page through results.
const PAGE_SIZE = 1000;

async function selectRows<T>(
  table: string,
  companyId: string,
  order?: { column: string; ascending?: boolean }
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 0; page < 100; page += 1) {
    let query = supabase.from(table).select('*').eq('company_id', companyId);
    if (order) {
      query = query.order(order.column, { ascending: order.ascending ?? false });
    }
    const { data, error } = await query.range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (error) fail(`${table}: ${error.message}`);
    const batch = (data ?? []) as unknown as T[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return rows;
}

export async function getSessionEmail(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user.email ?? null;
}

export async function signIn(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) fail(error.message);
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}

export async function fetchScope(): Promise<Scope[]> {
  const { data, error } = await supabase.rpc('corp_my_scope');
  if (error) fail(error.message);
  return (data ?? []) as unknown as Scope[];
}

export async function bootstrapCompany(name: string, location: string): Promise<string> {
  const { data, error } = await supabase.rpc('corp_bootstrap_company', {
    p_name: name,
    p_location: location || null
  });
  if (error) fail(error.message);
  return data as string;
}

export async function fetchCompanyData(companyId: string): Promise<CorpData> {
  const [
    companyResult,
    locations,
    sites,
    employees,
    shifts,
    tasks,
    timeOff,
    exceptions,
    overtime,
    discipline,
    training,
    syncEvents,
    policies,
    commands,
    siteSettings
  ] = await Promise.all([
    supabase.from('corp_companies').select('*').eq('id', companyId).maybeSingle(),
    selectRows<Location>('corp_locations', companyId, { column: 'name', ascending: true }),
    selectRows<Site>('corp_sites', companyId, { column: 'last_sync_at', ascending: false }),
    selectRows<Employee>('corp_employees', companyId, { column: 'full_name', ascending: true }),
    selectRows<Shift>('corp_shifts', companyId, { column: 'start_at', ascending: false }),
    selectRows<TaskRow>('corp_tasks', companyId, { column: 'start_at', ascending: false }),
    selectRows<TimeOffRequest>('corp_time_off_requests', companyId, {
      column: 'start_date',
      ascending: false
    }),
    selectRows<ExceptionRequest>('corp_exception_requests', companyId, {
      column: 'created_at_local',
      ascending: false
    }),
    selectRows<OvertimeRequest>('corp_overtime_requests', companyId, {
      column: 'start_at',
      ascending: false
    }),
    selectRows<DisciplineAction>('corp_discipline_actions', companyId, {
      column: 'created_at_local',
      ascending: false
    }),
    selectRows<TrainingAssignment>('corp_training_assignments', companyId, {
      column: 'due_at',
      ascending: true
    }),
    selectRows<SyncEvent>('corp_sync_events', companyId, {
      column: 'received_at',
      ascending: false
    }),
    selectRows<Policy>('corp_policies', companyId, { column: 'updated_at', ascending: false }),
    selectRows<CorpCommand>('corp_commands', companyId, {
      column: 'requested_at',
      ascending: false
    }),
    selectRows<SiteSettings>('corp_settings', companyId)
  ]);

  if (companyResult.error) fail(`corp_companies: ${companyResult.error.message}`);

  return {
    company: (companyResult.data as unknown as Company | null) ?? null,
    locations,
    sites,
    employees,
    shifts,
    tasks,
    timeOff,
    exceptions,
    overtime,
    discipline,
    training,
    syncEvents,
    policies,
    commands: commands.slice(0, 200),
    siteSettings
  };
}

export interface CommandInput {
  companyId: string;
  siteId: string;
  kind: CorpCommandKind;
  targetId?: string | null;
  payload: Record<string, unknown>;
  note?: string | null;
}

// The console never writes a site's data directly: it queues an auditable
// command that the site's own server polls and applies.
export async function queueCommand(input: CommandInput): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const { error } = await supabase.from('corp_commands').insert({
    site_id: input.siteId,
    company_id: input.companyId,
    kind: input.kind,
    target_id: input.targetId ?? null,
    payload: input.payload,
    note: input.note ?? null,
    status: 'pending',
    requested_by: userData.user?.id ?? null
  });
  if (error) fail(error.message);
}

export async function cancelCommand(id: string): Promise<void> {
  const { error } = await supabase.rpc('corp_cancel_command', { p_command: id });
  if (error) fail(error.message);
}

export interface PolicyInput {
  id?: string;
  company_id: string;
  title: string;
  category: string;
  body: string;
  status: Policy['status'];
  effective_on: string | null;
  owner: string | null;
}

export async function savePolicy(input: PolicyInput): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id ?? null;
  const payload = {
    company_id: input.company_id,
    title: input.title,
    category: input.category,
    body: input.body,
    status: input.status,
    effective_on: input.effective_on,
    owner: input.owner,
    updated_by: userId
  };
  if (input.id) {
    const { error } = await supabase.from('corp_policies').update(payload).eq('id', input.id);
    if (error) fail(error.message);
    return;
  }
  const { error } = await supabase
    .from('corp_policies')
    .insert({ ...payload, created_by: userId });
  if (error) fail(error.message);
}

export async function deletePolicy(id: string): Promise<void> {
  const { error } = await supabase.from('corp_policies').delete().eq('id', id);
  if (error) fail(error.message);
}

export async function saveLocation(input: {
  id?: string;
  company_id: string;
  name: string;
  code: string;
  address: string;
  timezone: string;
  status: Location['status'];
}): Promise<void> {
  const payload = {
    company_id: input.company_id,
    name: input.name,
    code: input.code || null,
    address: input.address || null,
    timezone: input.timezone,
    status: input.status
  };
  if (input.id) {
    const { error } = await supabase.from('corp_locations').update(payload).eq('id', input.id);
    if (error) fail(error.message);
    return;
  }
  const { error } = await supabase.from('corp_locations').insert(payload);
  if (error) fail(error.message);
}

export async function updateCompanyProfile(input: {
  id: string;
  name: string;
  industry: string;
  headquarters: string;
}): Promise<void> {
  const { error } = await supabase
    .from('corp_companies')
    .update({
      name: input.name,
      industry: input.industry || null,
      headquarters: input.headquarters || null
    })
    .eq('id', input.id);
  if (error) fail(error.message);
}
