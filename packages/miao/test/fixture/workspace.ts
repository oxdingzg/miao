import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { Database } from "@miao/core/database/database"
import { FSUtil } from "@miao/core/fs-util"
import { SessionV2 } from "@miao/core/session"
import { SessionExecution } from "@miao/core/session/execution"
import { LocationServiceMap, locationServiceMapLayer } from "@miao/core/location-services"
import { Auth } from "../../src/auth"
import { Workspace } from "../../src/control-plane/workspace"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { Vcs } from "../../src/project/vcs"
import { EventV2Bridge } from "../../src/event-v2-bridge"

export const workspaceLayerWithRuntimeFlags = (overrides: Partial<RuntimeFlags.Info>) =>
  AppNodeBuilder.build(
    LayerNode.group([
      Workspace.node,
      Auth.node,
      SessionV2.node,
      Project.node,
      Vcs.node,
      Database.node,
      EventV2Bridge.node,
      FSUtil.node,
      InstanceStore.node,
    ]),
    [
      [InstanceStore.bootstrapNode, InstanceBootstrap.node],
      [RuntimeFlags.node, RuntimeFlags.layer(overrides)],
      [SessionExecution.node, SessionExecution.noopLayer],
      [LocationServiceMap.node, locationServiceMapLayer],
    ],
  )
