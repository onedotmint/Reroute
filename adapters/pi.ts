import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerPi } from '../src/pi.ts';
// Pi's native jiti loader executes our TypeScript source directly, including a clean Git checkout.
// No duplicated host SDK or generated dist/ tree is required to load this extension.
export default function reroute(pi: ExtensionAPI) { registerPi(pi); }
