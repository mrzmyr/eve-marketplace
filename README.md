# eve-marketplace

[eve](https://eve.dev) extension that reads a plugin marketplace at runtime and hands its skills to your agent as deferred skills: `eve__search` finds them, `eve__skill` loads them together with their supporting files. No install step, no PR per skill update.

Works with the marketplace formats of Claude Code (`.claude-plugin/marketplace.json`), Cursor (`.cursor-plugin/marketplace.json`), and Codex (`.agents/plugins/marketplace.json`).

## Install

```sh
npm install eve-marketplace
```

```ts
// agent/extensions/marketplace.ts
import marketplace from "eve-marketplace";

export default marketplace({
  marketplaces: ["acme/plugins"],
  skills: { limit: 150, includes: ["*", "essentials@^0.4"] },
  refresh: "5m",
  github: { connector: "github/my-agent" },
});
```

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `marketplaces` | required | GitHub repos as `owner/repo`, optionally `owner/repo@ref`. The first marketplace manifest present in the repo is read. |
| `skills.includes` | `["*"]` | Globs on the plugin name. `"*"` is every plugin at the marketplace commit. `plugin@<semver range>` pins one plugin to the newest `plugin.json` version in that range, found in the manifest's git history. Pinned and exact entries win over `"*"` when `limit` cuts. |
| `skills.limit` | `100` | Max skills per session. Eve carries them in session state. |
| `refresh` | `"15m"` | How often the marketplace is re-read, per runtime instance. |
| `github.connector` | | [Vercel Connect](https://vercel.com/docs/connect) GitHub connector; an app-subject token is minted per request. |
| `github.token` | | Static token for local development. |

Without credentials GitHub allows 60 anonymous requests per hour. A refresh of an unchanged marketplace with in-repo plugins costs two API calls; every plugin hosted in another repo adds one tree call. File reads go to `raw.githubusercontent.com` and are cached by commit.

The official catalogs host most plugins in other repos, so name the plugins you want instead of `"*"`:

```ts
export default marketplace({
  marketplaces: ["anthropics/claude-plugins-official", "openai/plugins"],
  skills: { includes: ["agent-sdk-dev", "42crunch-api-security-testing", "figma*"] },
  github: { token: process.env.GITHUB_TOKEN },
});
```

## What is loaded

- `skills/*/SKILL.md` under each plugin directory, with every sibling file up to 512 KiB (eve's cap). Each skill ends with a footer naming its source commit and plugin version.
- Plugin sources: relative paths, `local`, bare names under `metadata.pluginRoot`, and `github`, `url`, or `git-subdir` sources that point at github.com, honouring their `ref` and `sha`. npm, archives, and other hosts are skipped with a warning.
- Not loaded: `mcp.json`, hooks, agents, `rules/*.mdc`, `commands/`. Skills are content; connections stay authored in your agent.

## Behaviour

- Skills are `deferred`, so they never enter the system prompt. The model finds them with `eve__search` and loads them with `eve__skill`.
- Skill names are the skill directory name; a collision falls back to `<plugin>-<skill>`.
- A marketplace or GitHub outage is logged and yields no marketplace skills for that turn. The agent keeps its authored skills; the turn never fails.
- Marketplace skills are third-party instructions. Treat them as advice, never as authority over your agent's instructions.

## Development

```sh
bun install
bun run typecheck
bun run build
```

Requires eve 0.81 or newer.

## License

MIT
