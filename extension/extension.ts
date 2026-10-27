import { defineExtension } from "eve/extension";
import { z } from "zod";

/** Config the consuming agent passes at the mount site. */
export const configSchema = z
  .object({
    /** GitHub marketplaces as `owner/repo`, optionally pinned with `@ref`. Every manifest format the repo ships is read. */
    marketplaces: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+(@.+)?$/, "Expected owner/repo or owner/repo@ref")).min(1),
    skills: z
      .object({
        /** Max skills per session. Eve carries them in session state; one skill with its files is a few KB to a few hundred KB. */
        limit: z.number().int().min(1).max(500).default(100),
        /**
         * Plugins to expose, as globs on the plugin name. `"*"` is every plugin at the marketplace commit.
         * `plugin@<semver range>` pins one plugin to the newest manifest version in that range.
         */
        includes: z.array(z.string().min(1)).min(1).default(["*"]),
      })
      .prefault({}),
    /** Catalog refresh interval such as `"5m"` or `"1h"`. */
    refresh: z.string().regex(/^\d+(s|m|h)$/, "Expected a duration such as 5m").default("15m"),
    github: z
      .object({
        /** Vercel Connect connector that mints an app-subject GitHub token, for example `github/my-agent`. */
        connector: z.string().min(1).optional(),
        /** Static token for local development. */
        token: z.string().min(1).optional(),
      })
      .prefault({}),
  })
  .strict();

/** Validated config with defaults applied. */
export type MarketplaceConfig = z.output<typeof configSchema>;

export default defineExtension({ config: configSchema });
