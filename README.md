# opencode-agent-messages

An [OpenCode](https://opencode.ai) plugin that lets agent sessions on one OpenCode server start and message each other across sibling folders. OpenCode's own subagent tool starts a child only in its parent's folder and messages only its own children.

It was built for a home-repo setup: a session in one repo hands work to sessions in the repos beside it, and gets their answers back.

## Tools

- `agent_start(folder, message, role?, model?, title?)` starts a session in `folder` and sends it `message`. It returns at once with the new session's ID.
  - `folder` must sit beside the caller's project, for example `../other-repo`.
  - `role` is an agent ID defined at that folder. Without it, the folder's default agent runs.
  - `model` is `provider/model` or `provider/model#variant`, for example `claude-agent/opus`. Without a role or a model, the session takes the caller's model.
- `agent_send(sessionID, message)` sends a message to a session by its ID. A busy session gets it when its current run ends.

## Replies

Every message from these tools tells its receiver that its last message goes back as its reply. After sending, the sender's side waits for the receiver to go idle. If the receiver did not answer with `agent_send`, its last message is forwarded to the sender, headed `[Reply from agent session …]`. A run that ends with no text still sends a note with the run's outcome. Forwarded replies expect no answer, so nothing is forwarded back from them.

A session started with `agent_start` sits one level below the session that started it, and a session a person started is at level 0. `agent_start` refuses to start a session below level 3 and tells the caller so.

Sessions started with `agent_start` have the `question` tool denied. Nobody watches them, so a question goes back in their last message instead.

## Permissions

Both tools ask OpenCode for permission before they act, as built-in tools do, so an agent's `permissions` rules apply to them:

| Action | Resource |
| --- | --- |
| `agent_start` | the role it starts, or `default` when none is given |
| `agent_send` | the target session's ID |

With no rules, both are allowed. For example, an agent that may start only `supervisor` sessions:

```yaml
permissions:
  - action: agent_start
    resource: "*"
    effect: deny
  - action: agent_start
    resource: supervisor
    effect: allow
```

## Install

Add it to a repo as a git subtree, where OpenCode finds it on its own:

```sh
git subtree add --prefix .opencode/plugins/agent-messages https://github.com/Teogai/opencode-agent-messages.git main --squash
```

Update it the same way:

```sh
git subtree pull --prefix .opencode/plugins/agent-messages https://github.com/Teogai/opencode-agent-messages.git main --squash
```

Change the plugin here, not in a repo's copy, so every copy can pull the change.

## Limits

- A server restart drops a wait in progress, so a reply that lands after the restart is not forwarded.
- Only the depth of starts is capped. Two sessions can keep messaging each other with `agent_send`.
- If the receiver's context is compacted before it answers, the sent message can no longer be found, and the sender gets a "no reply found" note.
- Unless a rule denies it, any session can message any session on the server. Permission rules shape what an agent does, but they are no security boundary: an agent with a shell can still call OpenCode's API.
- There are no tests yet.

## Licence

MIT. See `LICENSE`.
