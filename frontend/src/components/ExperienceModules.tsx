import type { ExperienceModule } from '../types';

type ExperienceModulesProps = {
  modules: ExperienceModule[];
  className?: string;
};

export function ExperienceModules({ modules, className = '' }: ExperienceModulesProps) {
  const visible = modules.filter((module) => module.enabled);
  if (visible.length === 0) return null;

  return (
    <section className={`experience-modules ${className}`.trim()}>
      {visible.map((module) => (
        <article key={module.id} className={`experience-module module-${module.type}`}>
          {module.title ? <h3>{module.title}</h3> : null}
          {module.body ? <p>{module.body}</p> : null}
          {(module.type === 'image' || module.type === 'hero') && module.image_url ? (
            <img src={module.image_url} alt={module.title || 'Module image'} />
          ) : null}
          {module.type === 'hero' && module.cta_label && module.cta_url ? (
            <a href={module.cta_url} target="_blank" rel="noreferrer">{module.cta_label}</a>
          ) : null}
        </article>
      ))}
    </section>
  );
}
