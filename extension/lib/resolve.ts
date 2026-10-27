import { defineSkill, type SkillDefinition } from "eve/skills";
import { parse } from "yaml";

import type { MarketplaceConfig } from "../extension.js";
import { GitHub } from "./github.js";
import { parseSelectors, pinPlugin, readPlugins, scanSkills, type Plugin, type Selector, type SkillFiles } from "./marketplace.js";

const CONCURRENCY = 8;
/** Upper bound on sibling file bytes per resolution. Skills past it ship without files, never without SKILL.md. */
const FILES_BUDGET_BYTES = 4_000_000;
const FRONTMATTER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

type Candidate = {
  readonly repo: string;
  readonly sha: string;
  readonly plugin: Plugin;
  readonly version: string | undefined;
  readonly skill: SkillFiles;
  /** Position of the matching `includes` selector, most specific first, so pins and exact names survive `limit`. */
  readonly rank: number;
};

/**
 * Read the configured marketplaces and turn the selected skills into eve skill definitions,
 * keyed by a unique eve-safe name.
 *
 * Per refresh window: one commit lookup and one tree per marketplace, one tree per plugin hosted
 * in another repo, one commit walk per pinned plugin, then one raw read per SKILL.md and sibling
 * file. Trees and raw reads are addressed by commit and cached, so an unchanged marketplace of
 * in-repo plugins costs two API calls per refresh.
 */
export async function resolveSkills({ config }: { config: MarketplaceConfig }): Promise<Record<string, SkillDefinition>> {
  const github = new GitHub({ credentials: config.github });
  const selectors = parseSelectors({ includes: config.skills.includes });
  const warnings: string[] = [];
  const candidates: Candidate[] = [];

  async function collect({ plugin }: { plugin: Plugin }): Promise<void> {
    const rank = selectors.findIndex((selector) => selector.pattern.test(plugin.name));
    if (rank === -1) {
      return;
    }
    const selector = selectors[rank] as Selector;
    let sha = plugin.sha;
    if (sha === undefined) {
      sha = await github.resolveCommit({ repo: plugin.repo, ref: plugin.ref });
    }
    let version: string | undefined;
    if (selector.range !== undefined) {
      const pinned = await pinPlugin({ github, plugin, sha, range: selector.range });
      if (pinned === undefined) {
        warnings.push(`${plugin.name}: no version satisfies "${selector.range}"; plugin skipped`);
        return;
      }
      sha = pinned.sha;
      version = pinned.version;
    }
    const tree = await github.tree({ repo: plugin.repo, sha });
    for (const skill of scanSkills({ tree, dir: plugin.dir })) {
      candidates.push({ repo: plugin.repo, sha, plugin, version, skill, rank });
    }
  }

  for (const spec of config.marketplaces) {
    const [repo, ref] = spec.split("@") as [string, string | undefined];
    const sha = await github.resolveCommit({ repo, ref });
    const tree = await github.tree({ repo, sha });
    const plugins = await readPlugins({ github, repo, sha, tree, warnings });
    await mapConcurrent({
      items: plugins,
      fn: async (plugin) => {
        try {
          await collect({ plugin });
        } catch (error) {
          // One unreachable plugin repo must not drop the whole marketplace.
          warnings.push(`${plugin.name}: ${toMessage({ error })}`);
        }
      },
    });
  }

  const selected = candidates.sort((a, b) => a.rank - b.rank || a.skill.slug.localeCompare(b.skill.slug)).slice(0, config.skills.limit);
  const taken = new Set<string>();
  let fileBytes = 0;
  const skills = await mapConcurrent({
    items: selected,
    fn: async (candidate) => {
      const markdown = await github.text({ repo: candidate.repo, sha: candidate.sha, path: candidate.skill.file });
      if (markdown === null) {
        return undefined;
      }
      const files: Record<string, Uint8Array> = {};
      for (const path of candidate.skill.siblings) {
        const bytes = await github.raw({ repo: candidate.repo, sha: candidate.sha, path });
        if (bytes === null || fileBytes + bytes.byteLength > FILES_BUDGET_BYTES) {
          continue;
        }
        fileBytes += bytes.byteLength;
        files[path.slice(candidate.skill.dir.length + 1)] = bytes;
      }
      const name = uniqueName({ taken, candidates: [candidate.skill.slug, `${candidate.plugin.name}-${candidate.skill.slug}`] });
      return [name, defineSkill({ deferred: true, description: describe({ markdown, candidate }), markdown: `${markdown.trimEnd()}\n\n${footer({ candidate })}`, files })] as const;
    },
  });

  if (warnings.length > 0) {
    console.warn(`marketplace: ${warnings.join("; ")}`);
  }
  return Object.fromEntries(skills.filter((entry) => entry !== undefined));
}

function describe({ markdown, candidate }: { markdown: string; candidate: Candidate }): string {
  const match = FRONTMATTER.exec(markdown);
  if (match) {
    const description = readDescription({ frontmatter: match[1] as string });
    if (description !== undefined) {
      return description.slice(0, 1_024);
    }
  }
  if (candidate.plugin.description !== undefined) {
    return candidate.plugin.description;
  }
  return `Skill "${candidate.skill.slug}" from ${candidate.repo}`;
}

/** `description` from YAML frontmatter. Authors often write `Use when: ...` unquoted, which is not YAML, so fall back to the raw line. */
function readDescription({ frontmatter }: { frontmatter: string }): string | undefined {
  try {
    const data = parse(frontmatter) as { description?: unknown } | null;
    if (data !== null && typeof data.description === "string" && data.description !== "") {
      return data.description;
    }
  } catch {
    const line = /^description:[ \t]*(.+)$/m.exec(frontmatter);
    if (line) {
      return (line[1] as string).trim().replace(/^["']|["']$/g, "");
    }
  }
  return undefined;
}

function footer({ candidate }: { candidate: Candidate }): string {
  let plugin = candidate.plugin.name;
  if (candidate.version !== undefined) {
    plugin = `${plugin}@${candidate.version}`;
  }
  return `---\nSource: https://github.com/${candidate.repo}/tree/${candidate.sha.slice(0, 12)}/${candidate.skill.dir} (plugin ${plugin}).`;
}

/** Eve skill name: ASCII letters, digits, `_`, `-`; at most 64 chars. First free candidate, else a numeric suffix. */
function uniqueName({ taken, candidates }: { taken: Set<string>; candidates: readonly string[] }): string {
  const clean = candidates.map((raw) => raw.normalize("NFKD").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64));
  let name = clean.find((candidate) => candidate !== "" && !taken.has(candidate));
  for (let suffix = 2; name === undefined; suffix += 1) {
    const base = `${clean[clean.length - 1]}`.slice(0, 60);
    if (!taken.has(`${base}-${suffix}`)) {
      name = `${base}-${suffix}`;
    }
  }
  taken.add(name);
  return name;
}

function toMessage({ error }: { error: unknown }): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function mapConcurrent<T, R>({ items, fn }: { items: readonly T[]; fn: (item: T) => Promise<R> }): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}
