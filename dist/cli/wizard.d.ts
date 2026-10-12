import { type ProjectChoices } from './manage.js';
/** Collect a draft only. CLI applies it through the same coordinator path as Pi. */
export declare function setupWizard(cwd: string, flags: ProjectChoices): Promise<boolean>;
