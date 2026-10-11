import { DaytonaProvider } from './daytona.js';
import { SshProvider } from './ssh.js';
import { SkyPilotProvider } from './skypilot.js';
import { ModalProvider } from './modal.js';
import { E2BProvider } from './e2b.js';
/** Composition root is the only place that selects concrete providers. */
export function createProvider(config) {
    const options = config.providers[config.provider] ?? {};
    switch (config.provider) {
        case 'daytona': return new DaytonaProvider(options);
        case 'ssh': return new SshProvider(options);
        case 'skypilot': return new SkyPilotProvider(options);
        case 'modal': return new ModalProvider(options);
        case 'e2b': return new E2BProvider(options);
    }
}
