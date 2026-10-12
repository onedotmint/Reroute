import * as sdk from '@earendil-works/pi-coding-agent';
import { registerPi } from '../dist/pi.js';
// Pi's own loader resolves the host SDK; no second agent runtime is launched.
export default function reroute(pi: sdk.ExtensionAPI) { registerPi(pi, sdk); }
