import * as sdk from '@earendil-works/pi-coding-agent';
import * as tui from '@earendil-works/pi-tui';
import { registerPi } from './pi.mjs';

// Static imports are resolved by Pi's loader, not a second local SDK installation.
export default function reroute(pi: sdk.ExtensionAPI) {
  registerPi(pi, sdk, tui);
}
