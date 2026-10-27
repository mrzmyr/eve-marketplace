import semver from "semver";

import { createError } from "./errors.js";
import type { GitHub, TreeEntry } from "./github.js";

/**
 * Marketplace manifests per format, in lookup order. Claude Code, Codex, and Cursor agree on
 * `plugins[]` with `name` and `source`, and on `metadata.pluginRoot` for bare-name sources.
 */
const MARKETPLACE_MANIFESTS = [".cursor-plugin/marketplace.json", ".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"];
/** Plugin manifests per format. `version` lives here. */
const PLUGIN_MANIFESTS = [".cursor-plugin/plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json", "plugin.json"];
/** Eve rejects skill files above this size. */
const MAX_FILE_BYTES = 512 * 1024;

type Manifest = {
  readonly metadata?: { readonly pluginRoot?: string };
  readonly plugins?: ReadonlyArray<{ readonly name: string; readonly description?: string; readonly source: unknown }>;
};

/** One plugin and the GitHub location of its files. */
export type Plugin = {
  readonly name: string;
  readonly description: string | undefined;
  /** GitHub `owner/repo` that holds the plugin; the marketplace repo for relative sources. */
  readonly repo: string;
  /** Commit from the manifest, when it pins one. */
  readonly sha: string | undefined;
  /** Branch or tag from the manifest. Undefined means the default branch. */
  readonly ref: string | undefined;
  /** Directory inside `repo`, without surrounding slashes; empty for the repo root. */
  readonly dir: string;
};

/** A `skills/<slug>/SKILL.md` with its sibling files. Paths are repo-relative. */
export type SkillFiles = {
  readonly slug: string;
  readonly dir: string;
  readonly file: string;
  readonly siblings: readonly string[];
};

/** A `skills.includes` entry: a glob on the plugin name, optionally pinned to a semver range with `@`. */
export type Selector = {
  readonly pattern: RegExp;
  readonly range: string | undefined;
};

/**
 * Plugins from the first marketplace manifest present in the tree.
 *
 * Relative, `local`, and bare-name sources live in the marketplace repo. `github`, `url`, and
 * `git-subdir` sources resolve when they point at github.com. npm, archives, and other hosts are skipped.
 */
export async function readPlugins({ github, repo, sha, tree, warnings }: { github: GitHub; repo: string; sha: string; tree: readonly TreeEntry[]; warnings: string[] }): Promise<Plugin[]> {
  const present = new Set(tree.map((entry) => entry.path));
  const manifestPath = MARKETPLACE_MANIFESTS.find((path) => present.has(path));
  if (manifestPath === undefined) {
    warnings.push(`${repo}@${sha.slice(0, 7)}: no marketplace manifest found`);
    return [];
  }
  const manifest = JSON.parse((await github.text({ repo, sha, path: manifestPath })) as string) as Manifest;
  const pluginRoot = trimSlashes({ path: manifest.metadata?.pluginRoot });
  const plugins: Plugin[] = [];
  let entries = manifest.plugins;
  if (entries === undefined) {
    entries = [];
  }
  for (const plugin of entries) {
    const location = resolveSource({ source: plugin.source, repo, sha, pluginRoot });
    if (location === undefined) {
      warnings.push(`${plugin.name}: unsupported plugin source ${JSON.stringify(plugin.source)}`);
      continue;
    }
    plugins.push({ name: plugin.name, description: plugin.description, ...location });
  }
  return plugins;
}

/** Every `skills/<slug>/SKILL.md` under `dir`, with the sibling files eve can carry. */
export function scanSkills({ tree, dir }: { tree: readonly TreeEntry[]; dir: string }): SkillFiles[] {
  let prefix = "skills/";
  if (dir !== "") {
    prefix = `${dir}/skills/`;
  }
  const blobs = tree.filter((entry) => entry.type === "blob");
  return blobs.flatMap((entry) => {
    const match = /^([^/]+)\/SKILL\.md$/.exec(entry.path.slice(prefix.length));
    if (!entry.path.startsWith(prefix) || !match) {
      return [];
    }
    const skillDir = `${prefix}${match[1]}`;
    const siblings = blobs
      .filter((blob) => blob.path !== entry.path && blob.path.startsWith(`${skillDir}/`) && isCarriable({ blob }))
      .map((blob) => blob.path);
    return [{ slug: match[1] as string, dir: skillDir, file: entry.path, siblings }];
  });
}

/**
 * Parse `skills.includes` entries, most specific first: pinned, then exact, then globs. A plugin
 * takes the first selector that matches it, so `["*", "essentials@0.3.x"]` still pins essentials.
 */
export function parseSelectors({ includes }: { includes: readonly string[] }): Selector[] {
  const specificity = ({ entry }: { entry: string }): number => {
    if (entry.indexOf("@", 1) !== -1) {
      return 0;
    }
    if (!entry.includes("*")) {
      return 1;
    }
    return 2;
  };
  return [...includes].sort((a, b) => specificity({ entry: a }) - specificity({ entry: b })).map((entry) => {
    const at = entry.indexOf("@", 1);
    let glob = entry;
    let range: string | undefined;
    if (at !== -1) {
      glob = entry.slice(0, at);
      range = entry.slice(at + 1);
      if (semver.validRange(range) === null) {
        throw createError({ status: 400, message: `Invalid semver range in skills.includes entry "${entry}"`, why: "The part after @ did not parse as a semver range", fix: 'Use a range such as "^0.3", "0.3.x", or an exact version' });
      }
    }
    const source = glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    return { pattern: new RegExp(`^${source}$`, "i"), range };
  });
}

/**
 * Newest commit whose plugin manifest version satisfies `range`.
 *
 * Marketplaces rarely tag per plugin, so this walks the manifest's commit history newest-first
 * and stops at the first satisfying version: one commits call plus one raw read per visited commit.
 */
export async function pinPlugin({ github, plugin, sha, range }: { github: GitHub; plugin: Plugin; sha: string; range: string }): Promise<{ sha: string; version: string } | undefined> {
  for (const file of PLUGIN_MANIFESTS) {
    let path = file;
    if (plugin.dir !== "") {
      path = `${plugin.dir}/${file}`;
    }
    const commits = await github.commitsForPath({ repo: plugin.repo, path, sha, limit: 30 });
    for (const commit of commits) {
      const version = await readVersion({ github, repo: plugin.repo, sha: commit, path });
      if (version !== undefined && semver.satisfies(version, range, { includePrerelease: true })) {
        return { sha: commit, version };
      }
    }
  }
  return undefined;
}

async function readVersion({ github, repo, sha, path }: { github: GitHub; repo: string; sha: string; path: string }): Promise<string | undefined> {
  const text = await github.text({ repo, sha, path });
  if (text === null) {
    return undefined;
  }
  try {
    const version = (JSON.parse(text) as { version?: unknown }).version;
    if (typeof version === "string" && semver.valid(version) !== null) {
      return version;
    }
  } catch {
    // A manifest that does not parse at this commit has no version.
  }
  return undefined;
}

type Source = { readonly source: string; readonly path?: unknown; readonly repo?: unknown; readonly url?: unknown; readonly ref?: unknown; readonly sha?: unknown };

function resolveSource({ source, repo, sha, pluginRoot }: { source: unknown; repo: string; sha: string; pluginRoot: string }): Pick<Plugin, "repo" | "sha" | "ref" | "dir"> | undefined {
  if (typeof source === "string") {
    return resolveRelative({ path: source, repo, sha, pluginRoot });
  }
  if (typeof source !== "object" || source === null) {
    return undefined;
  }
  const typed = source as Source;
  if (typed.source === "local" && typeof typed.path === "string") {
    return resolveRelative({ path: typed.path, repo, sha, pluginRoot });
  }
  let reference: unknown = typed.url;
  if (typed.source === "github") {
    reference = typed.repo;
  }
  if ((typed.source !== "github" && typed.source !== "url" && typed.source !== "git-subdir") || typeof reference !== "string") {
    return undefined;
  }
  const remote = parseGitHubRepo({ reference });
  if (remote === undefined) {
    return undefined;
  }
  let dir = "";
  if (typed.source === "git-subdir" && typeof typed.path === "string") {
    dir = trimSlashes({ path: typed.path });
  }
  let ref: string | undefined;
  if (typeof typed.ref === "string") {
    ref = typed.ref;
  }
  let pinned: string | undefined;
  if (typeof typed.sha === "string") {
    pinned = typed.sha;
  }
  return { repo: remote, sha: pinned, ref, dir };
}

function resolveRelative({ path, repo, sha, pluginRoot }: { path: string; repo: string; sha: string; pluginRoot: string }): Pick<Plugin, "repo" | "sha" | "ref" | "dir"> | undefined {
  if (path.includes("..")) {
    return undefined;
  }
  let dir = trimSlashes({ path });
  if (!path.includes("/") && pluginRoot !== "") {
    dir = `${pluginRoot}/${path}`;
  }
  return { repo, sha, ref: undefined, dir };
}

/** `owner/repo` from a shorthand or a github.com https/ssh URL; undefined for other hosts. */
function parseGitHubRepo({ reference }: { reference: string }): string | undefined {
  const match = /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(reference.trim());
  if (!match) {
    return undefined;
  }
  return `${match[1]}/${match[2]}`;
}

function isCarriable({ blob }: { blob: TreeEntry }): boolean {
  const isHidden = blob.path.split("/").some((part) => part.startsWith("."));
  return !isHidden && (blob.size === undefined || blob.size <= MAX_FILE_BYTES);
}

function trimSlashes({ path }: { path: string | undefined }): string {
  if (path === undefined) {
    return "";
  }
  return path.replace(/^\.?\/+|\/+$/g, "");
}
