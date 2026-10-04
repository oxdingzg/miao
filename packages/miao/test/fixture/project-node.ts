import { CrossSpawnSpawner } from "@miao/core/cross-spawn-spawner"
import { Database } from "@miao/core/database/database"
import { LayerNode } from "@miao/core/effect/layer-node"
import { EventV2 } from "@miao/core/event"
import { FSUtil } from "@miao/core/fs-util"
import { ProjectV2 } from "@miao/core/project"
import { ProjectDirectories } from "@miao/core/project/directories"
import { ProjectMetadata } from "@miao/core/project/metadata"
import { EventForwarder } from "@/server/event-forwarder"

export const projectTestNode = LayerNode.group([
  CrossSpawnSpawner.node,
  Database.node,
  EventV2.node,
  FSUtil.node,
  ProjectV2.node,
  ProjectDirectories.node,
  ProjectMetadata.node,
  EventForwarder.node,
])
