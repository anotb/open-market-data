# Agent Plugin packaging

`open-market-data` is packaged as an **Agent Plugins 1.0.0** portable plugin. The portable package is the primary interoperability layer; MCP remains the tool runtime and Agent Skills remains the workflow/instruction layer.

## Portable layout

```text
open-market-data/
├── plugin.json
├── skills/
│   └── open-market-data/
│       └── SKILL.md
├── mcp.json
├── dist/
│   └── mcp-cli.js
└── ...
```

- `plugin.json` is the closed, vendor-neutral package manifest.
- `skills/open-market-data/SKILL.md` follows the Agent Skills specification.
- `mcp.json` declares the bundled local stdio MCP server.
- `${PLUGIN_ROOT}` resolves to the installed plugin directory.
- Provider credentials are inherited from the client environment or existing local `omd` configuration; the portable manifest contains no secrets.

## Current ChatGPT and Codex compatibility

The package also keeps the current OpenAI compatibility entry points:

```text
.codex-plugin/plugin.json
.mcp.json
.agents/plugins/marketplace.json
```

This is intentionally additive. Portable clients can discover the root `plugin.json`, `skills/`, and `mcp.json`, while current ChatGPT/Codex plugin loaders can use `.codex-plugin/plugin.json` and `.mcp.json`. Both formats point at the same skill and MCP server, so there is one implementation and no duplicated tool logic.

The repo marketplace installs the published npm package. This matters because source checkouts do not commit `dist/`, while the npm package runs `prepack` and contains the compiled MCP server.

After publishing `open-market-data@0.2.0`:

```bash
codex plugin marketplace add anotb/open-market-data
```

Then open the Plugins directory and install **Open Market Data**.

## Direct MCP fallback

Clients that support MCP but not Agent Plugins can still connect directly:

```bash
npx -y open-market-data
```

## Development checkout

Build before pointing an Agent Plugins client at a source checkout:

```bash
pnpm install --frozen-lockfile
pnpm validate:plugin
pnpm build
```

The dependency-free validator checks:

- closed portable manifest fields and canonical Agent Plugins 1.0.0 schema identifiers;
- portable MCP structure, stdio command shape, and reserved variables;
- Agent Skills frontmatter and string-only metadata;
- ChatGPT/Codex compatibility paths;
- marketplace policy and npm source;
- matching versions across npm, portable plugin, OpenAI compatibility, MCP Registry metadata, and skill metadata.

## Distribution boundary

Agent Plugins standardizes the package shape, not a universal installer, permission model, or credential flow. npm, Git marketplaces, local marketplaces, and client-specific public directories remain distribution channels. The local stdio server is the free, self-contained default. A hosted Streamable HTTP server would be a separate optional distribution mode, not a requirement for the portable plugin.
