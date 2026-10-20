// src/commands/stats.js — /stats — engine metrics dashboard (NEW in 3.0).
import { metrics } from '../core/metrics.js';

export async function run(ctx) {
  await ctx.say(metrics.render());
}
