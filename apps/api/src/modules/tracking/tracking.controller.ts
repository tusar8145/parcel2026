import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { z } from "zod";
import { CurrentActor, CurrentUser, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor, UserActor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { LocationSettingsService } from "./location-settings";
import { ParcelPositionService } from "./parcel-position.service";
import { VehicleShareService } from "./vehicle-share.service";
import {
  locationSettingsSchema,
  shareableTripsQuerySchema,
  startVehicleShareSchema,
  tripHistoryQuerySchema,
  vehicleLocationsQuerySchema,
  vehiclePointSchema,
  type LocationSettings,
} from "./tracking.schemas";

/** Rider / vehicle location interval, parcel positions for the maps, and "I'm travelling in this vehicle". */
@ApiTags("tracking")
@Controller()
export class TrackingController {
  constructor(
    private readonly settings: LocationSettingsService,
    private readonly positions: ParcelPositionService,
    private readonly vehicles: VehicleShareService,
  ) {}

  /** How often phones send a position while on shift / sharing a vehicle (any signed-in user; the rider app reads it). */
  @Get("settings/location")
  locationSettings() {
    return this.settings.get();
  }

  /** Super admin: "Rider location interval" (2 / 5 / 10 minutes) and the movement threshold. */
  @RequirePermissions("config:manage")
  @Put("settings/location")
  @ApiZodBody(locationSettingsSchema)
  saveLocationSettings(@CurrentActor() actor: Actor, @ZBody(locationSettingsSchema) body: LocationSettings, @ReqMeta() meta: RequestMeta) {
    return this.settings.save(actor, body, meta);
  }

  /**
   * Where the parcel is now: { kind: rider | hub | vehicle | last | none, lat, lng, label, updatedAt, stale, … }.
   * Same visibility as GET /parcels/:id; merchants and customers see the rider only under the "Live rider location" rules.
   */
  @Get("parcels/:trackingId/position")
  position(@CurrentActor() actor: Actor, @Param("trackingId") trackingId: string) {
    return this.positions.forActor(actor, trackingId);
  }

  // ───────────── "I'm travelling in this vehicle" ─────────────

  /** Trips the signed-in rider / hub staff member may share: planned (around today) or departed, from or to their hubs. */
  @Get("vehicle-shares/trips")
  @ApiZodQuery(shareableTripsQuerySchema)
  shareableTrips(@CurrentActor() actor: Actor, @ZQuery(shareableTripsQuerySchema) query: z.infer<typeof shareableTripsQuerySchema>) {
    return this.vehicles.shareableTrips(actor, query);
  }

  /** The user's open share (or null) and the location interval. */
  @Get("vehicle-shares/mine")
  myShare(@CurrentUser() actor: UserActor) {
    return this.vehicles.mine(actor);
  }

  /** "Start sharing vehicle location" for a trip (id or MF-… manifest number). */
  @Post("vehicle-shares")
  @ApiZodBody(startVehicleShareSchema)
  startShare(@CurrentUser() actor: UserActor, @ZBody(startVehicleShareSchema) body: z.infer<typeof startVehicleShareSchema>, @ReqMeta() meta: RequestMeta) {
    return this.vehicles.start(actor, body, meta);
  }

  /** A position from the travelling phone. `{ stopped: true, reason }` once the trip has arrived / closed. */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post("vehicle-shares/:id/location")
  @HttpCode(202)
  @ApiZodBody(vehiclePointSchema)
  shareLocation(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @ZBody(vehiclePointSchema) body: z.infer<typeof vehiclePointSchema>) {
    return this.vehicles.record(actor, id, body);
  }

  @Post("vehicle-shares/:id/stop")
  @HttpCode(200)
  stopShare(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.vehicles.stop(actor, id, meta);
  }

  /** Operations maps: vehicles with a shared position on planned / departed trips. */
  @RequirePermissions("hub:read")
  @Get("vehicle-locations")
  @ApiZodQuery(vehicleLocationsQuerySchema)
  vehicleLocations(@CurrentActor() actor: Actor, @ZQuery(vehicleLocationsQuerySchema) query: z.infer<typeof vehicleLocationsQuerySchema>) {
    return this.vehicles.live(actor, query);
  }

  /** A trip's recent track (bounded history), oldest first. */
  @RequirePermissions("hub:read")
  @Get("vehicle-locations/:trip/history")
  @ApiZodQuery(tripHistoryQuerySchema)
  vehicleHistory(@CurrentActor() actor: Actor, @Param("trip") trip: string, @ZQuery(tripHistoryQuerySchema) query: z.infer<typeof tripHistoryQuerySchema>) {
    return this.vehicles.history(actor, trip, query);
  }
}
