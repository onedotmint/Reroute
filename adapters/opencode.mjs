import { activationEnv } from '../dist/core/activation.js';
/** OpenCode v2's documented native shell boundary. v1 is deliberately not claimed. */
export default {
  id: 'reroute',
  async setup(ctx) {
    if (typeof ctx.shell?.hook !== 'function') throw new Error('Reroute requires OpenCode v2 create.before shell hooks');
    await ctx.shell.hook('create.before', event => {
      event.env = activationEnv({ ...process.env, ...event.env });
    });
  },
};
