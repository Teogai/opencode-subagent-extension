// Agent sessions on one OpenCode server start and message each other across sibling folders. OpenCode's own
// subagent tool starts a child only in the parent's folder, and messages only it.
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Plugin } from "@opencode/plugin"

const META_KEY = "agentMessage"
const MAX_HOPS = 8
const ADMIT_CHECKS = 60
const ADMIT_DELAY_MS = 2000

type StartInput = { folder: string; message: string; role?: string; model?: string; title?: string }
type SendInput = { sessionID: string; message: string }
type CallContext = { sessionID: string; agent: string; messageID: string; id: string }
type Meta = { from: string; hop: number; id: string; expectsReply: boolean }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const parseModel = (value: string) => {
  const [ref = "", variant] = value.split("#")
  const slash = ref.indexOf("/")
  if (slash <= 0 || slash === ref.length - 1) return undefined
  return { providerID: ref.slice(0, slash), id: ref.slice(slash + 1), ...(variant ? { variant } : {}) }
}

export default Plugin.define({
  id: "teogai.agent-messages",
  async setup(ctx) {
    const projectsRoot = path.dirname(ctx.location.project.directory)

    type Message = Awaited<ReturnType<typeof ctx.session.context>>[number]

    const metaOf = (message: Message): Meta | undefined => {
      if (message.type !== "user") return undefined
      const meta = message.metadata?.[META_KEY]
      if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined
      return meta as unknown as Meta
    }

    // A person's message starts a new chain, so its hop count is 0.
    const lastHop = async (sessionID: string) => {
      const messages = await ctx.session.context({ sessionID })
      const last = messages.findLast((message) => message.type === "user")
      const hop = last ? metaOf(last)?.hop : undefined
      return typeof hop === "number" ? hop : 0
    }

    const textOf = (message: Message) =>
      message.type === "assistant"
        ? message.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n")
            .trim()
        : ""

    const sentTo = (message: Message, sessionID: string) =>
      message.type === "assistant" &&
      message.content.some(
        (part) =>
          part.type === "tool" &&
          part.name === "agent_send" &&
          (part.state as { input?: { sessionID?: unknown } }).input?.sessionID === sessionID,
      )

    const post = async (from: string, to: string, text: string, hop: number, expectsReply: boolean) => {
      const sender = await ctx.session.get({ sessionID: from })
      const id = randomUUID()
      const header = expectsReply
        ? [
            `[Message from agent session ${from}, folder ${sender.location.directory}]`,
            `When you finish, your last message goes back to session ${from} as your reply.`,
            `End with the answer, even if you found nothing, or with the question you need answered.`,
          ].join("\n")
        : `[Reply from agent session ${from}, folder ${sender.location.directory}]`
      await ctx.session.prompt({
        sessionID: to,
        text: `${header}\n\n${text}`,
        delivery: "queue",
        metadata: { [META_KEY]: { from, hop, id, expectsReply } },
      })
      return id
    }

    // The target may work in a folder where this plugin is not loaded, so the sender's side waits for it to go idle
    // and forwards its last message, unless it already answered with agent_send.
    const forwardReply = async (from: string, to: string, id: string, hop: number) => {
      for (let check = 0; check < ADMIT_CHECKS; check++) {
        await ctx.session.wait({ sessionID: to })
        const messages = await ctx.session.context({ sessionID: to })
        const start = messages.findIndex((message) => metaOf(message)?.id === id)
        const replies = start < 0 ? [] : messages.slice(start + 1).filter((message) => message.type === "assistant")
        if (replies.length === 0) {
          await sleep(ADMIT_DELAY_MS)
          continue
        }
        if (replies.some((message) => sentTo(message, from))) return
        if (hop + 1 > MAX_HOPS) return
        const text = replies.map(textOf).findLast((value) => value.length > 0)
        const outcome = (await ctx.session.get({ sessionID: to })).outcome ?? "unknown"
        await post(to, from, text ?? `(Session ${to} ended its run, outcome ${outcome}, with no reply text.)`, hop + 1, false)
        return
      }
      await post(to, from, `(No reply found from session ${to} after ${ADMIT_CHECKS} checks.)`, hop + 1, false)
    }

    const deliver = async (from: string, to: string, text: string) => {
      const hop = (await lastHop(from)) + 1
      if (hop > MAX_HOPS) {
        return `Not sent: ${MAX_HOPS} messages have passed between agents since a person last wrote. Ask a person how to go on.`
      }
      const id = await post(from, to, text, hop, true)
      void forwardReply(from, to, id, hop)
        .catch((error) =>
          post(to, from, `(Could not collect the reply from session ${to}: ${String(error)})`, hop + 1, false),
        )
        .catch(() => undefined)
      return undefined
    }

    const permit = (action: string, resource: string, context: CallContext) =>
      ctx.permission.assert({
        sessionID: context.sessionID,
        agent: context.agent,
        action,
        resources: [resource],
        save: [resource],
        source: { type: "tool", messageID: context.messageID, id: context.id },
      })

    const registration = await ctx.tool.transform((editor) => {
      editor.add({
        name: "agent_start",
        description: [
          "Start a new agent session in another folder on this OpenCode server and send it a first message.",
          "Returns at once with the new session's ID. When the session finishes, its last message arrives here as its reply.",
          "Send follow-ups to it with agent_send.",
        ].join(" "),
        input: {
          type: "object",
          properties: {
            folder: { type: "string", description: "Folder the session works in, absolute or relative to this session's folder, for example ../other-repo" },
            message: { type: "string", description: "The task, complete: the new session sees nothing of this conversation" },
            role: { type: "string", description: "Agent ID at that folder; omit it for the folder's default agent" },
            model: { type: "string", description: "Model as provider/model or provider/model#variant, for example claude-agent/opus; omit it for the role's model" },
            title: { type: "string", description: "Short title for the new session" },
          },
          required: ["folder", "message"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, context) => {
          const { folder, message, role, model, title } = input as StartInput
          await permit("agent_start", role ?? "default", context)
          const caller = await ctx.session.get({ sessionID: context.sessionID })
          const directory = path.resolve(caller.location.directory, folder)
          if (path.dirname(directory) !== projectsRoot) {
            return { content: `Not started: ${directory} is not a project folder in ${projectsRoot}.` }
          }
          const chosen = model === undefined ? undefined : parseModel(model)
          if (model !== undefined && !chosen) {
            return { content: `Not started: model ${model} is not provider/model or provider/model#variant.` }
          }
          const created = await ctx.session.create({
            location: { directory },
            title: title ?? `From ${caller.title ?? context.sessionID}`,
            ...(role ? { agent: role } : {}),
            ...(chosen ? { model: chosen } : !role && caller.model ? { model: caller.model } : {}),
          } as Parameters<typeof ctx.session.create>[0])
          const refused = await deliver(context.sessionID, created.id, message)
          if (refused) return { content: refused }
          return { content: `Started session ${created.id} in ${directory}. Its reply will arrive here as a message.` }
        },
      })
      editor.add({
        name: "agent_send",
        description: [
          "Send a message to another agent session on this OpenCode server, by its session ID.",
          "A busy session gets it when its current run ends, and its reply arrives here when it finishes.",
          "Use it to answer a message from another agent session, or to follow up on a session you started.",
          "Do not send a message that only acknowledges.",
        ].join(" "),
        input: {
          type: "object",
          properties: {
            sessionID: { type: "string", description: "The session to send to" },
            message: { type: "string", description: "The message, complete" },
          },
          required: ["sessionID", "message"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, context) => {
          const { sessionID, message } = input as SendInput
          await permit("agent_send", sessionID, context)
          if (sessionID === context.sessionID) return { content: "Not sent: that is this session." }
          const target = await ctx.session.get({ sessionID }).catch(() => undefined)
          if (!target) return { content: `Not sent: no session ${sessionID}.` }
          const refused = await deliver(context.sessionID, sessionID, message)
          return { content: refused ?? `Sent to ${sessionID}.` }
        },
      })
    })
    return () => registration.dispose()
  },
})
