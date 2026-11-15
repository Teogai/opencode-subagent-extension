// Adds a folder input to OpenCode's subagent tool, so a child can work in another repo on the same server.
// OpenCode creates a session either in a folder or under a parent, never both, so the child is created under
// its caller, moved, and then handed to the subagent tool as an existing child.
import path from "node:path"
import { Schema } from "effect"
import { Plugin } from "@opencode/plugin"

type SubagentInput = {
  agent: string
  description: string
  prompt: string
  model?: string
  sessionID?: string
  folder?: string
}

const parseModel = (value: string) => {
  const [ref = "", variant] = value.split("#")
  const slash = ref.indexOf("/")
  if (slash <= 0 || slash === ref.length - 1) return undefined
  return { providerID: ref.slice(0, slash), id: ref.slice(slash + 1), ...(variant ? { variant } : {}) }
}

export default Plugin.define({
  id: "teogai.subagent-extension",
  async setup(ctx) {
    const projectsRoot = path.dirname(ctx.location.project.directory)

    const registration = await ctx.tool.transform((editor) => {
      editor.update("subagent", (tool) => {
        const fields = (tool.input as unknown as { fields?: Schema.Struct.Fields }).fields
        if (!fields) return
        const original = tool.execute
        tool.input = Schema.Struct({
          ...fields,
          folder: Schema.optionalKey(Schema.String).annotate({
            description:
              "Folder the new child works in, absolute or relative to your folder, for example ../other-repo. Omit it to use your own folder, and whenever you pass sessionID.",
          }),
        })
        tool.execute = async (input, context) => {
          const { folder, ...rest } = input as SubagentInput
          if (!folder) return original(rest as typeof input, context)
          if (rest.sessionID) throw new Error("folder applies only to a new child. Omit it when you pass sessionID.")
          const caller = await ctx.session.get({ sessionID: context.sessionID })
          const directory = path.resolve(caller.location.directory, folder)
          if (path.dirname(directory) !== projectsRoot) {
            throw new Error(`${directory} is not a project folder in ${projectsRoot}.`)
          }
          const agent = await ctx.agent.get({ agentID: rest.agent }).catch(() => undefined)
          if (!agent) throw new Error(`Unknown agent: ${rest.agent}`)
          const model = (rest.model ? parseModel(rest.model) : undefined) ?? agent.data.model ?? caller.model
          const child = await ctx.session.create({
            parentID: context.sessionID,
            title: rest.description,
            agent: rest.agent,
            ...(model ? { model } : {}),
            permissions: [...(caller.permissions ?? []), { action: "question", resource: "*", effect: "deny" }],
          } as Parameters<typeof ctx.session.create>[0])
          try {
            await ctx.session.move({ sessionID: child.id, directory })
            return await original({ ...rest, sessionID: child.id } as typeof input, context)
          } catch (error) {
            await ctx.session.wait({ sessionID: child.id }).catch(() => undefined)
            await ctx.session.remove({ sessionID: child.id }).catch(() => undefined)
            throw error
          }
        }
      })
    })
    return () => registration.dispose()
  },
})
