import type { Profile, Provider } from '../types.js';
import { defaults, validate } from '../config.js';
import { SshProvider } from './ssh.js';
import { SkyPilotProvider } from './skypilot.js';
import { DaytonaProvider } from './daytona.js';
import { ModalProvider } from './modal.js';
import { E2BProvider } from './e2b.js';
export function createProvider(profile: Profile): Provider {
  validate({ ...defaults(), active: 'target', profiles: { target: profile } });
  switch (profile.provider) {
    case 'ssh': return new SshProvider(profile);
    case 'skypilot': return new SkyPilotProvider(profile);
    case 'daytona': return new DaytonaProvider(profile);
    case 'modal': return new ModalProvider(profile);
    case 'e2b': return new E2BProvider(profile);
  }
}
