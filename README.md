# OpenCode Config

Custom configuration for [OpenCode CLI](https://opencode.ai): agents, skills, plugins, MCP servers.

## Install

```bash
./install.sh
```

The script does everything: creates `opencode.json` from the template, replaces the user path, creates `.env`, and installs plugin dependencies. All you need to do is **fill in your tokens in `.env`**.

## After running the script

1. Open `~/.config/opencode/.env` and fill in your real keys:

```bash
ROUTER_9_API_KEY=sk-xxxx        # Provider API key (required)
NOTION_TOKEN=
FIGMA_ACCESS_TOKEN=
NETLIFY_PERSONAL_ACCESS_TOKEN=
```

2. Update the provider `baseURL` in `opencode.json` if it differs from the default.
3. Run `opencode` — done.

## Manual install (without the script)

```bash
cp opencode.example.json opencode.json   # then edit YOUR_USER + apiKey in this file
cp .env.example .env                     # then fill in tokens
npm install
```

## Notes

- Never commit `opencode.json` and `.env` (already gitignored) — share only via the two `*.example` files.
- To enable/disable an MCP server: edit `"enabled"` in `opencode.json`.
- You can replace tailwind conffig

```json
    "tailwindcss": {
      "type": "local",
      "command": [
        "npx",
        "-y",
        "tailwindcss-mcp-server"
      ],
      "enabled": true
    },
```

````json
    "tailwindcss": {
      "type": "local",
     "command": ["/usr/bin/tailwindcss-server"],
      "enabled": true
    },
````
