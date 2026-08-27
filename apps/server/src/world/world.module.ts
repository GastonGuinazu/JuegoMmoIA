import { Global, Module } from '@nestjs/common';
import { WorldSocketBridgeService } from './world-socket-bridge.service';
import { WorldSpatialService } from './world-spatial.service';
import { WorldPresenceService } from './world-presence.service';
import { PendingWorldDropService } from './pending-world-drop.service';

/** Global: un solo `WorldSocketBridgeService` para HTTP (inventario) y el gateway `/world`. */
@Global()
@Module({
  providers: [
    WorldSpatialService,
    WorldSocketBridgeService,
    WorldPresenceService,
    PendingWorldDropService,
  ],
  exports: [
    WorldSpatialService,
    WorldSocketBridgeService,
    WorldPresenceService,
    PendingWorldDropService,
  ],
})
export class WorldModule {}
