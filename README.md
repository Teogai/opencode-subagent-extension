# opencode-subagent-extension

An [OpenCode](https://opencode.ai) plugin that adds an optional `folder` input to OpenCode's built-in `subagent` tool. A child started with that input works in another repo on the same server, with that repo's `AGENTS.md` and skills, and still reports back to the session that started it.

## Why it is needed

OpenCode creates a session either in a folder or under a parent, never both (`core/src/session.ts:98`). The `subagent` tool starts a child in its parent's folder, so a child cannot both report to its caller and work in another repo.

## How it works

The plugin creates the child under the caller, moves it to the folder you asked for, and hands it to the original `subagent` code as an existing child through `sessionID`. OpenCode prompts the child and sends the parent a report each time the child goes idle. OpenCode keeps an undelivered report across a server restart.

## Rules

- The folder must sit in the same parent folder as the caller's project, for example `../other-repo`.
- `folder` applies only to a new child. Never pass it with `sessionID`.
- The plugin denies the `question` tool in the child and gives the child the caller's session permissions.

## Permissions

The plugin starts the child through OpenCode's own `subagent` permission, which checks the agent ID (`core/src/tool/plugin/subagent.ts:138-145`), so your `permissions` rules apply. An agent that may start only `lead` and `general`:

```yaml
permissions:
  - action: subagent
    resource: "*"
    effect: deny
  - action: subagent
    resource: lead
    effect: allow
  - action: subagent
    resource: general
    effect: allow
```

## Nesting

OpenCode's `experimental.subagent_depth` caps how deep children may start children. Its default is 1 (`core/src/tool/plugin/subagent.ts:129`).

## Install

Add the plugin's folder path to the `plugins` list in the global config, `~/.config/opencode/opencode.jsonc`. Every session that starts a child needs the plugin, so a config in one repo is not enough.

```jsonc
{
  "plugins": ["/home/you/projects/opencode-subagent-extension"]
}
```

## Limits

- There are no tests yet.
- Permission rules shape what an agent does, but they are no security boundary. An agent with a shell can still call OpenCode's API.

## Licence

MIT. See `LICENSE`.
