import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type { OnboardingQuestion, OrganizationSettings, ProfileRow } from '../types';

type OnboardingFlowProps = {
  profile: ProfileRow;
  settings: OrganizationSettings;
  initialAnswers: Record<string, unknown>;
  busy: boolean;
  error: string | null;
  onSubmit: (answers: Record<string, unknown>) => Promise<void>;
  onSignOut: () => Promise<void>;
};

type QuestionSection = {
  id: string;
  title: string;
  description: string;
  fields: OnboardingQuestion[];
};

const BASE_SECTIONS: QuestionSection[] = [
  {
    id: 'identity',
    title: 'Identity and Contact',
    description: 'Tell us how to best identify and contact you.',
    fields: [
      { id: 'preferred_name', label: 'Preferred Name', type: 'text', required: true, placeholder: 'Jane', help_text: '', options: [] },
      { id: 'phone_number', label: 'Phone Number', type: 'text', required: true, placeholder: '(555) 555-1212', help_text: '', options: [] },
      { id: 'emergency_contact_name', label: 'Emergency Contact Name', type: 'text', required: true, placeholder: 'Full name', help_text: '', options: [] },
      { id: 'emergency_contact_phone', label: 'Emergency Contact Phone', type: 'text', required: true, placeholder: '(555) 555-0000', help_text: '', options: [] },
      { id: 'home_city', label: 'Home City', type: 'text', required: false, placeholder: 'City, State', help_text: '', options: [] }
    ]
  },
  {
    id: 'work',
    title: 'Work Preferences',
    description: 'Capture scheduling and assignment preferences for better planning.',
    fields: [
      { id: 'preferred_shift_start', label: 'Preferred Shift Start', type: 'text', required: false, placeholder: '06:00', help_text: '', options: [] },
      { id: 'preferred_shift_end', label: 'Preferred Shift End', type: 'text', required: false, placeholder: '14:00', help_text: '', options: [] },
      { id: 'preferred_work_areas', label: 'Preferred Work Areas', type: 'textarea', required: false, placeholder: 'List work areas you are strongest in', help_text: '', options: [] },
      { id: 'transportation_notes', label: 'Transportation Notes', type: 'textarea', required: false, placeholder: 'Any commute constraints', help_text: '', options: [] },
      { id: 'uniform_size', label: 'Uniform/PPE Size', type: 'text', required: false, placeholder: 'Shirt, jacket, boots, etc.', help_text: '', options: [] }
    ]
  },
  {
    id: 'operations',
    title: 'Operations and Readiness',
    description: 'Share information needed for safety, performance, and support.',
    fields: [
      { id: 'certifications', label: 'Certifications and Expiration Dates', type: 'textarea', required: false, placeholder: 'Forklift, CPR, HazMat, etc.', help_text: '', options: [] },
      { id: 'language_preferences', label: 'Language Preferences', type: 'text', required: false, placeholder: 'English, Spanish, etc.', help_text: '', options: [] },
      { id: 'communication_channel', label: 'Preferred Communication Channel', type: 'select', required: true, placeholder: '', help_text: '', options: ['SMS', 'Email', 'In-app'] },
      { id: 'training_goals', label: '30/60/90 Day Goals', type: 'textarea', required: false, placeholder: 'What would make your first 90 days successful?', help_text: '', options: [] },
      { id: 'manager_support_needed', label: 'Support Needed from Leadership', type: 'textarea', required: false, placeholder: 'Tools, schedule, learning support', help_text: '', options: [] }
    ]
  }
];

function hasMeaningfulAnswer(value: unknown, type: OnboardingQuestion['type']): boolean {
  if (type === 'boolean') {
    return value === true;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  return Boolean(value);
}

export function OnboardingFlow({
  profile,
  settings,
  initialAnswers,
  busy,
  error,
  onSubmit,
  onSignOut
}: OnboardingFlowProps) {
  const [answers, setAnswers] = useState<Record<string, unknown>>(initialAnswers);
  const [acknowledgements, setAcknowledgements] = useState<Record<string, boolean>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const sections = useMemo<QuestionSection[]>(() => {
    const customSection: QuestionSection = {
      id: 'custom',
      title: 'Organization Specific',
      description: 'These questions are configured by your organization.',
      fields: settings.onboarding_custom_questions
    };

    if (customSection.fields.length === 0) {
      return BASE_SECTIONS;
    }

    return [...BASE_SECTIONS, customSection];
  }, [settings.onboarding_custom_questions]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const missing: string[] = [];
    for (const section of sections) {
      for (const field of section.fields) {
        if (!field.required) continue;
        if (!hasMeaningfulAnswer(answers[field.id], field.type)) {
          missing.push(field.label);
        }
      }
    }

    for (let index = 0; index < settings.onboarding_required_acknowledgements.length; index += 1) {
      if (!acknowledgements[`ack_${index}`]) {
        missing.push(`Acknowledgement ${index + 1}`);
      }
    }

    if (missing.length > 0) {
      setFormError(`Please complete required fields before continuing. Missing: ${missing.join(', ')}`);
      return;
    }

    const payload: Record<string, unknown> = {
      ...answers,
      acknowledgements: settings.onboarding_required_acknowledgements.map((text, index) => ({
        id: `ack_${index}`,
        text,
        accepted: Boolean(acknowledgements[`ack_${index}`])
      }))
    };

    await onSubmit(payload);
  }

  function setAnswer(questionId: string, value: unknown) {
    setAnswers((current) => ({ ...current, [questionId]: value }));
  }

  return (
    <section className="onboarding-shell">
      <article className="onboarding-card">
        <header className="onboarding-head">
          <h1>{settings.onboarding_title}</h1>
          <p>{settings.onboarding_description || 'Complete this onboarding once to unlock your workspace.'}</p>
          <p className="onboarding-subtitle">
            <strong>{profile.full_name}</strong> · {profile.email}
          </p>
        </header>

        <form className="onboarding-form" onSubmit={handleSubmit}>
          {sections.map((section) => (
            <section key={section.id} className="onboarding-section">
              <h2>{section.title}</h2>
              <p>{section.description}</p>

              {section.fields.map((field) => {
                const value = answers[field.id];

                if (field.type === 'textarea') {
                  return (
                    <label key={field.id}>
                      {field.label}{field.required ? ' *' : ''}
                      <textarea
                        rows={3}
                        value={typeof value === 'string' ? value : ''}
                        placeholder={field.placeholder}
                        onChange={(event) => setAnswer(field.id, event.target.value)}
                      />
                    </label>
                  );
                }

                if (field.type === 'select') {
                  return (
                    <label key={field.id}>
                      {field.label}{field.required ? ' *' : ''}
                      <select
                        value={typeof value === 'string' ? value : ''}
                        onChange={(event) => setAnswer(field.id, event.target.value)}
                      >
                        <option value="">Select...</option>
                        {field.options.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </label>
                  );
                }

                if (field.type === 'boolean') {
                  return (
                    <label key={field.id} className="onboarding-checkbox">
                      <input
                        type="checkbox"
                        checked={value === true}
                        onChange={(event) => setAnswer(field.id, event.target.checked)}
                      />
                      {field.label}{field.required ? ' *' : ''}
                    </label>
                  );
                }

                return (
                  <label key={field.id}>
                    {field.label}{field.required ? ' *' : ''}
                    <input
                      type="text"
                      value={typeof value === 'string' ? value : ''}
                      placeholder={field.placeholder}
                      onChange={(event) => setAnswer(field.id, event.target.value)}
                    />
                  </label>
                );
              })}
            </section>
          ))}

          <section className="onboarding-section">
            <h2>Required Acknowledgements</h2>
            <p>These acknowledgements are required by your organization.</p>
            {settings.onboarding_required_acknowledgements.map((acknowledgement, index) => (
              <label key={`ack_${index}`} className="onboarding-checkbox">
                <input
                  type="checkbox"
                  checked={Boolean(acknowledgements[`ack_${index}`])}
                  onChange={(event) =>
                    setAcknowledgements((current) => ({
                      ...current,
                      [`ack_${index}`]: event.target.checked
                    }))
                  }
                />
                {acknowledgement}
              </label>
            ))}
          </section>

          {formError ? <div className="onboarding-error">{formError}</div> : null}
          {error ? <div className="onboarding-error">{error}</div> : null}

          <div className="onboarding-actions">
            <button type="button" className="ghost" onClick={() => void onSignOut()} disabled={busy}>
              Sign Out
            </button>
            <button type="submit" disabled={busy}>
              {busy ? 'Saving...' : 'Complete Onboarding'}
            </button>
          </div>
        </form>
      </article>
    </section>
  );
}
