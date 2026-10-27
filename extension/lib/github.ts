import { getToken } from "@vercel/connect";

import { createError } from "./errors.js";

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
const SHA = /^[0-9a-f]{40}$/;
/** Content addressed by commit never changes, so one bounded map serves every refresh. */
const MAX_CACHED = 5_000;

/** One entry of a recursive git tree. */
export type TreeEntry = {
  readonly path: string;
  readonly type: "blob" | "tree" | "commit";
  readonly size?: number | undefined;
};

/** How the client authenticates: a Vercel Connect connector, a static token, or anonymous (60 requests per hour). */
export type GitHubCredentials = {
  readonly connector?: string | undefined;
  readonly token?: string | undefined;
};

/** The three GitHub reads the catalog needs: resolve a ref, list a tree, read a file at a commit. */
export class GitHub {
  readonly #credentials: GitHubCredentials;
  readonly #immutable = new Map<string, Promise<unknown>>();

  constructor({ credentials }: { credentials: GitHubCredentials }) {
    this.#credentials = credentials;
  }

  /** Full commit SHA for a branch, tag, or SHA. Not cached: this is the one read that must see new commits. */
  async resolveCommit({ repo, ref }: { repo: string; ref: string | undefined }): Promise<string> {
    if (ref !== undefined && SHA.test(ref)) {
      return ref;
    }
    let target = "HEAD";
    if (ref !== undefined) {
      target = ref;
    }
    const response = await this.#api({ path: `/repos/${repo}/commits/${encodeURIComponent(target)}`, accept: "application/vnd.github.sha" });
    const sha = (await response.text()).trim();
    if (!SHA.test(sha)) {
      throw createError({ status: 502, message: `Could not resolve ${repo}@${target}`, why: "GitHub returned something other than a commit SHA", fix: "Check that the ref exists in the repository" });
    }
    return sha;
  }

  /** Every path in the repo at a commit. */
  tree({ repo, sha }: { repo: string; sha: string }): Promise<readonly TreeEntry[]> {
    return this.#cached({
      key: `tree:${repo}@${sha}`,
      load: async () => {
        const response = await this.#api({ path: `/repos/${repo}/git/trees/${sha}?recursive=1` });
        const json = (await response.json()) as { tree?: TreeEntry[] };
        let entries = json.tree;
        if (entries === undefined) {
          entries = [];
        }
        return entries;
      },
    });
  }

  /** Commits that touched `path`, newest first. Resolves plugin versions in repos without tags. */
  async commitsForPath({ repo, path, sha, limit }: { repo: string; path: string; sha: string; limit: number }): Promise<readonly string[]> {
    const query = new URLSearchParams({ path, sha, per_page: String(limit) });
    const response = await this.#api({ path: `/repos/${repo}/commits?${query}` });
    const json = (await response.json()) as Array<{ sha: string }>;
    return json.map((commit) => commit.sha);
  }

  /** A file at a commit, or null when it does not exist. */
  raw({ repo, sha, path }: { repo: string; sha: string; path: string }): Promise<Uint8Array | null> {
    const url = `${RAW}/${repo}/${sha}/${path.split("/").map(encodeURIComponent).join("/")}`;
    return this.#cached({
      key: url,
      load: async () => {
        const response = await fetch(url, { headers: await this.#headers({}) });
        if (response.status === 404) {
          return null;
        }
        if (!response.ok) {
          throw createError({ status: response.status, message: `GitHub raw read failed for ${path}`, why: `GET ${url} returned ${response.status}`, fix: "Check repository access for the configured GitHub credentials" });
        }
        return new Uint8Array(await response.arrayBuffer());
      },
    });
  }

  /** `raw` decoded as UTF-8. */
  async text({ repo, sha, path }: { repo: string; sha: string; path: string }): Promise<string | null> {
    const bytes = await this.raw({ repo, sha, path });
    if (bytes === null) {
      return null;
    }
    return new TextDecoder().decode(bytes);
  }

  #cached<T>({ key, load }: { key: string; load: () => Promise<T> }): Promise<T> {
    const hit = this.#immutable.get(key);
    if (hit !== undefined) {
      return hit as Promise<T>;
    }
    if (this.#immutable.size >= MAX_CACHED) {
      this.#immutable.clear();
    }
    const pending = load().catch((error: unknown) => {
      this.#immutable.delete(key);
      throw error;
    });
    this.#immutable.set(key, pending);
    return pending;
  }

  async #headers({ accept }: { accept?: string }): Promise<Record<string, string>> {
    const headers: Record<string, string> = { "User-Agent": "eve-marketplace" };
    if (accept !== undefined) {
      headers.Accept = accept;
      headers["X-GitHub-Api-Version"] = "2022-11-28";
    }
    const token = await this.#token();
    if (token !== undefined) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  async #token(): Promise<string | undefined> {
    if (this.#credentials.connector !== undefined) {
      // Same call eve's bundled `git` extension makes: an app-subject token, no user session needed.
      return getToken(this.#credentials.connector, { subject: { type: "app" } });
    }
    return this.#credentials.token;
  }

  async #api({ path, accept }: { path: string; accept?: string }): Promise<Response> {
    let acceptHeader = "application/vnd.github+json";
    if (accept !== undefined) {
      acceptHeader = accept;
    }
    const response = await fetch(`${API}${path}`, { headers: await this.#headers({ accept: acceptHeader }) });
    if (response.ok) {
      return response;
    }
    const isRateLimited = response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
    if (isRateLimited) {
      throw createError({
        status: 429,
        message: `GitHub API rate limit reached on ${path}`,
        why: "Anonymous GitHub access allows 60 requests per hour",
        fix: "Configure github.connector or github.token on the marketplace extension",
      });
    }
    throw createError({ status: response.status, message: "GitHub API request failed", why: `GET ${path} returned ${response.status}`, fix: "Check that the repository exists and the configured GitHub credentials can read it" });
  }
}
