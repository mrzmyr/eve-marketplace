import { defineDynamic, type SkillDefinition } from "eve/skills";

import extension from "../extension.js";
import { resolveSkills } from "../lib/resolve.js";

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 };

let cached: { readonly bucket: number; readonly skills: Promise<Record<string, SkillDefinition>> } | undefined;

/**
 * Marketplace skills as deferred eve skills: the model finds them with `eve__search` and loads
 * them with `eve__skill`. Resolved once per refresh window per runtime instance.
 */
async function resolve(): Promise<Record<string, SkillDefinition> | null> {
  const config = extension.config;
  const refreshMs = Number(config.refresh.slice(0, -1)) * (UNIT_MS[config.refresh.slice(-1)] as number);
  const bucket = Math.floor(Date.now() / refreshMs);
  if (cached === undefined || cached.bucket !== bucket) {
    cached = { bucket, skills: resolveSkills({ config }) };
  }
  try {
    return await cached.skills;
  } catch (error) {
    // A marketplace outage must not fail the turn; the agent keeps its authored skills.
    console.error("marketplace: skill resolution failed", error);
    cached = undefined;
    return null;
  }
}

export default defineDynamic({
  events: {
    "session.started": resolve,
    "turn.started": resolve,
  },
});
