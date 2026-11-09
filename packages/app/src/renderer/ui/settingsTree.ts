import { fold, PARAM_RUBRICS, PARAM_SPECS, type ParamSpec } from '@cirrus/view';

/** A rubric of the settings panel, its groups in order, each with its main settings and its advanced ones. */
export interface RubricView { title: string; groups: { name: string; main: ParamSpec[]; advanced: ParamSpec[] }[] }

/**
 * The settings panel's tree (PARAM_RUBRICS): every setting under its rubric and group. A search keeps the settings whose
 * rubric, group and label together hold each of its words, accents and case aside; a rubric or a group left empty goes.
 */
export function settingsTree(query: string): RubricView[] {
  const words = fold(query).split(/\s+/).filter((w) => w !== '');
  const out: RubricView[] = [];
  for (const r of PARAM_RUBRICS) {
    const groups: RubricView['groups'] = [];
    for (const name of r.groups) {
      const specs = PARAM_SPECS.filter((s) => s.group === name && words.every((w) => fold(`${r.title} ${name} ${s.label}`).includes(w)));
      if (specs.length === 0) continue;
      groups.push({ name, main: specs.filter((s) => s.section === 'graphique'), advanced: specs.filter((s) => s.section === 'avancé') });
    }
    if (groups.length > 0) out.push({ title: r.title, groups });
  }
  return out;
}
