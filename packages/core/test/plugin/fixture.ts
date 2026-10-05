import { AgentV2 } from "@miao/core/agent"
import { AISDK } from "@miao/core/aisdk"
import { Catalog } from "@miao/core/catalog"
import { CommandV2 } from "@miao/core/command"
import { Credential } from "@miao/core/credential"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNodePlatform } from "@miao/core/effect/app-node-platform"
import { LayerNode } from "@miao/core/effect/layer-node"
import { EventV2 } from "@miao/core/event"
import { FileSystem } from "@miao/core/filesystem"
import { FSUtil } from "@miao/core/fs-util"
import { Integration } from "@miao/core/integration"
import { Location } from "@miao/core/location"
import { ModelsCatalog } from "@miao/core/models-catalog"
import { Npm } from "@miao/core/npm"
import { PluginV2 } from "@miao/core/plugin"
import { Reference } from "@miao/core/reference"
import { SkillV2 } from "@miao/core/skill"
import { ToolPlugins } from "@miao/core/tool/plugins"
import { Effect, Layer } from "effect"
import { tempLocationLayer } from "../fixture/location"

const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: () => Effect.succeed({ directory: "", entrypoint: undefined }),
    install: () => Effect.void,
    which: () => Effect.succeed(undefined),
  }),
)

export const pluginTestLayer = (replacements: LayerNode.Replacements = []) =>
  AppNodeBuilder.build(
    LayerNode.group([
      FileSystem.node,
      FSUtil.node,
      Location.node,
      Npm.node,
      Credential.node,
      EventV2.node,
      LayerNodePlatform.httpClient,
      PluginV2.node,
      AgentV2.node,
      AISDK.node,
      Catalog.node,
      CommandV2.node,
      Integration.node,
      Reference.node,
      SkillV2.node,
      ToolPlugins.node,
      ModelsCatalog.node,
    ]),
    [[Location.node, tempLocationLayer], [Npm.node, npmLayer], ...replacements],
  )

export const PluginTestLayer = pluginTestLayer()
