# eve-marketplace

**Load plugin marketplace skills into your [eve](https://eve.dev) agent at runtime.** No install step, no PR per skill update.

- **Reads** a Claude Code, Cursor, or Codex marketplace repo on GitHub every few minutes
- **Exposes** every `SKILL.md` as a deferred eve skill, supporting files included
- **Finds and loads** through eve's own `eve__search` and `eve__skill`, nothing new to learn for the model

## Quick start

```sh
npm install eve-marketplace
```

```ts
// agent/extensions/marketplace.ts
import marketplace from "eve-marketplace";

export default marketplace({
  marketplaces: ["acme/plugins"],
  github: { token: process.env.GITHUB_TOKEN },
});
```

Done. Every plugin in `acme/plugins` is now a skill the agent can search and load.

## Pick what you expose

```ts
export default marketplace({
  marketplaces: ["acme/plugins", "anthropics/claude-plugins-official"],
  skills: {
    includes: ["*", "essentials@^0.4", "agent-sdk-dev", "figma*"],
    limit: 150,
  },
  refresh: "5m",
  github: { connector: "github/my-agent" },
});
```

- **`marketplaces`**: GitHub repos as `owner/repo`, or `owner/repo@ref` to read a branch, tag, or commit
- **`skills.includes`**: globs on the **plugin name**, default `["*"]`
  - `"*"`: every plugin at the marketplace's current commit, always latest
  - `"essentials@^0.4"`: **pin** one plugin to the newest `plugin.json` version in that semver range, resolved from git history
  - `"figma*"`: every plugin whose name starts with `figma`
  - **Pinned and exact names win** over `"*"` when `limit` cuts
- **`skills.limit`**: max skills per session, default `100`
- **`refresh`**: how often the marketplace is re-read, default `"15m"`
- **`github.connector`**: a [Vercel Connect](https://vercel.com/docs/connect) GitHub connector, app-subject token minted per request
- **`github.token`**: static token, fine for local development

## What gets loaded

- **Skills**: `skills/*/SKILL.md` under each plugin directory
  - every sibling file up to 512 KiB rides along, so `references/` and templates are in the sandbox when the skill loads
  - each skill ends with a **source footer**: repo, commit, plugin and version
  - skill name is the directory name; on collision it becomes `<plugin>-<skill>`
- **Plugin sources**: relative paths, `local`, bare names under `metadata.pluginRoot`, and `github` / `url` / `git-subdir` sources on github.com, honouring `ref` and `sha`
- **Not loaded**: `mcp.json`, hooks, agents, `rules/*.mdc`, `commands/`. Skills are content; connections stay authored in your agent.
- **Not supported**: npm, archive, and non-GitHub sources. They are skipped with a warning in the server log.

## Good to know

- **Deferred by design.** Skills never enter the system prompt. The model finds them with `eve__search` and loads them with `eve__skill`.
- **Outages do not break turns.** A GitHub or marketplace failure is logged; the agent keeps its authored skills for that turn.
- **Cost per refresh.** Two GitHub API calls for a marketplace with in-repo plugins, plus one per plugin hosted elsewhere. File reads hit `raw.githubusercontent.com`, cached by commit.
- **Anonymous limit is 60 requests per hour.** Set `github.token` or `github.connector` for anything beyond a small repo.
- **Official catalogs host most plugins in other repos.** Name the plugins you want instead of `"*"`:

  ```ts
  marketplaces: ["anthropics/claude-plugins-official", "openai/plugins"],
  skills: { includes: ["agent-sdk-dev", "42crunch-api-security-testing", "figma*"] },
  ```

- **Third-party instructions.** Marketplace skills are advice from other teams. Keep your agent's own instructions in charge.

## Development

```sh
bun install
bun run typecheck
bun run build
```

Requires eve 0.81 or newer.

## License

MIT
