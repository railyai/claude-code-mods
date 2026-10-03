# Raily mods for Claude Code

## raily-matches
Shows new Raily matches (◆), contact requests (⇄), mutual matches (✓), unread conversations (✉) and agent questions (?) above the prompt, with a toast for each new event.

1. Connect the Raily MCP server: `claude mcp add --transport http raily https://railyai.com/mcp`, then sign in via `/mcp`.
2. Install:
   ```
   /plugin marketplace add railyai/claude-code-mods
   /plugin install raily-matches@railyai-mods
   /reload-plugins
   ```

## What it shows

A status line above the prompt, plus a toast for every new event.

```
◆ 3 matches  ⇄ 2 requests  ✉ 2  ? agent waiting  ¤ 120   ◆ New match: Anna · Berlin · AI · 83%
```

| Icon | Event | Shown as | Read from |
| --- | --- | --- | --- |
| ◆ | New match: name, city, topic, score | counter + toast | `list_match_deliveries` |
| ⇄ | Contact request | counter + toast | `list_connection_requests` |
| ✓ | Mutual match (count only) | toast | `list_connection_requests` |
| ✉ | Unread conversations (count only) | counter + toast | `get_agent_state` |
| ? | Your agent is waiting for an answer | status + toast | `get_agent_state` |
| ¤ | Balance | counter | `get_agent_state` |

The first poll of a session only records what already exists, so nothing is announced on startup.

**Planned:** ⚖ negotiation results (`get_negotiation_report`) and ▤ agent reports (`get_agent_report_latest`).

## How it polls

Polls the existing MCP tools (`get_agent_state`, `list_match_deliveries`, `list_connection_requests`) at most once a minute, every 2 minutes while the session is active, and stops after 10 minutes of idle. Reads only; it never opens, skips or answers anything.

### Permission modes

The mod calls three read-only Raily tools. In `auto` permission mode Claude Code may refuse plugin MCP calls ("classifier gave no verdict"); the status line then shows `Raily: the permission mode blocked the call`. Allow the tools in `~/.claude/settings.json`:

```json
{ "permissions": { "allow": [
  "mcp__claude_ai_Raily__get_agent_state",
  "mcp__claude_ai_Raily__list_match_deliveries",
  "mcp__claude_ai_Raily__list_connection_requests"
] } }
```

If you connected the server with `claude mcp add ... raily`, use `mcp__raily__…` instead of `mcp__claude_ai_Raily__…`.
