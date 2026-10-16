import type { z } from "zod";
import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CurrentActor, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import {
  bagItemSchema,
  createBagSchema,
  createTripSchema,
  listBagsQuerySchema,
  listDiscrepanciesQuerySchema,
  listTripsQuerySchema,
  listVehiclesQuerySchema,
  receiveBagSchema,
  resolveDiscrepancySchema,
  sealBagSchema,
  tripBagSchema,
  updateVehicleSchema,
  vehicleSchema,
} from "./linehaul.schemas";
import { LinehaulService } from "./linehaul.service";

/**
 * Linehaul between hubs: vehicles, bags (scan, seal, reopen), trips and manifests (load,
 * depart, arrive, close, cancel), receiving at the destination hub and discrepancies.
 * Hub operators act at their own hubs: the origin to make up bags and dispatch, the
 * destination to receive.
 */
@ApiTags("linehaul")
@Controller("linehaul")
export class LinehaulController {
  constructor(private readonly linehaul: LinehaulService) {}

  // ── vehicles ──

  @RequirePermissions("hub:read")
  @Get("vehicles")
  @ApiZodQuery(listVehiclesQuerySchema)
  vehicles(@ZQuery(listVehiclesQuerySchema) query: z.infer<typeof listVehiclesQuerySchema>) {
    return this.linehaul.listVehicles(query);
  }

  @RequirePermissions("hub:manage")
  @Post("vehicles")
  @ApiZodBody(vehicleSchema)
  createVehicle(@CurrentActor() actor: Actor, @ZBody(vehicleSchema) body: z.infer<typeof vehicleSchema>, @ReqMeta() meta: RequestMeta) {
    return this.linehaul.createVehicle(actor, body, meta);
  }

  @RequirePermissions("hub:manage")
  @Patch("vehicles/:id")
  @ApiZodBody(updateVehicleSchema)
  updateVehicle(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(updateVehicleSchema) body: z.infer<typeof updateVehicleSchema>, @ReqMeta() meta: RequestMeta) {
    return this.linehaul.updateVehicle(actor, id, body, meta);
  }

  // ── bags ──

  @RequirePermissions("hub:read")
  @Get("bags")
  @ApiZodQuery(listBagsQuerySchema)
  bags(@CurrentActor() actor: Actor, @ZQuery(listBagsQuerySchema) query: z.infer<typeof listBagsQuerySchema>) {
    return this.linehaul.listBags(actor, query);
  }

  @RequirePermissions("parcel:dispatch")
  @Post("bags")
  @ApiZodBody(createBagSchema)
  createBag(@CurrentActor() actor: Actor, @ZBody(createBagSchema) body: z.infer<typeof createBagSchema>, @ReqMeta() meta: RequestMeta) {
    return this.linehaul.createBag(actor, body, meta);
  }

  /** A bag by id or number with its parcels and discrepancies. */
  @RequirePermissions("hub:read")
  @Get("bags/:bag")
  bag(@CurrentActor() actor: Actor, @Param("bag") bag: string) {
    return this.linehaul.getBag(actor, bag);
  }

  /** Scans a parcel into an open bag (at the bag's origin hub). */
  @RequirePermissions("parcel:dispatch")
  @Post("bags/:bag/items")
  @HttpCode(200)
  @ApiZodBody(bagItemSchema)
  addItem(@CurrentActor() actor: Actor, @Param("bag") bag: string, @ZBody(bagItemSchema) body: z.infer<typeof bagItemSchema>, @ReqMeta() meta: RequestMeta) {
    return this.linehaul.addItem(actor, bag, body, meta);
  }

  @RequirePermissions("parcel:dispatch")
  @Delete("bags/:bag/items/:trackingId")
  removeItem(@CurrentActor() actor: Actor, @Param("bag") bag: string, @Param("trackingId") trackingId: string, @ReqMeta() meta: RequestMeta) {
    return this.linehaul.removeItem(actor, bag, trackingId, meta);
  }

  @RequirePermissions("parcel:dispatch")
  @Post("bags/:bag/seal")
  @HttpCode(200)
  @ApiZodBody(sealBagSchema)
  seal(@CurrentActor() actor: Actor, @Param("bag") bag: string, @ZBody(sealBagSchema) body: z.infer<typeof sealBagSchema>, @ReqMeta() meta: RequestMeta) {
    return this.linehaul.seal(actor, bag, body, meta);
  }

  @RequirePermissions("parcel:dispatch")
  @Post("bags/:bag/reopen")
  @HttpCode(200)
  reopen(@CurrentActor() actor: Actor, @Param("bag") bag: string, @ReqMeta() meta: RequestMeta) {
    return this.linehaul.reopen(actor, bag, meta);
  }

  /** Receives an in-transit bag at its destination hub (whole bag, or the parcels scanned out of it). */
  @RequirePermissions("parcel:dispatch")
  @Post("bags/:bag/receive")
  @HttpCode(200)
  @ApiZodBody(receiveBagSchema)
  receive(@CurrentActor() actor: Actor, @Param("bag") bag: string, @ZBody(receiveBagSchema) body: z.infer<typeof receiveBagSchema>, @ReqMeta() meta: RequestMeta) {
    return this.linehaul.receive(actor, bag, body, meta);
  }

  // ── trips & manifests ──

  @RequirePermissions("hub:read")
  @Get("trips")
  @ApiZodQuery(listTripsQuerySchema)
  trips(@CurrentActor() actor: Actor, @ZQuery(listTripsQuerySchema) query: z.infer<typeof listTripsQuerySchema>) {
    return this.linehaul.listTrips(actor, query);
  }

  @RequirePermissions("parcel:dispatch")
  @Post("trips")
  @ApiZodBody(createTripSchema)
  createTrip(@CurrentActor() actor: Actor, @ZBody(createTripSchema) body: z.infer<typeof createTripSchema>, @ReqMeta() meta: RequestMeta) {
    return this.linehaul.createTrip(actor, body, meta);
  }

  /** The manifest: trip, vehicle, bags with parcels, totals and discrepancies. */
  @RequirePermissions("hub:read")
  @Get("trips/:trip")
  trip(@CurrentActor() actor: Actor, @Param("trip") trip: string) {
    return this.linehaul.getTrip(actor, trip);
  }

  @RequirePermissions("parcel:dispatch")
  @Post("trips/:trip/bags")
  @HttpCode(200)
  @ApiZodBody(tripBagSchema)
  loadBag(@CurrentActor() actor: Actor, @Param("trip") trip: string, @ZBody(tripBagSchema) body: z.infer<typeof tripBagSchema>, @ReqMeta() meta: RequestMeta) {
    return this.linehaul.addBagToTrip(actor, trip, body, meta);
  }

  @RequirePermissions("parcel:dispatch")
  @Delete("trips/:trip/bags/:bag")
  unloadBag(@CurrentActor() actor: Actor, @Param("trip") trip: string, @Param("bag") bag: string, @ReqMeta() meta: RequestMeta) {
    return this.linehaul.removeBagFromTrip(actor, trip, bag, meta);
  }

  @RequirePermissions("parcel:dispatch")
  @Post("trips/:trip/depart")
  @HttpCode(200)
  depart(@CurrentActor() actor: Actor, @Param("trip") trip: string, @ReqMeta() meta: RequestMeta) {
    return this.linehaul.depart(actor, trip, meta);
  }

  @RequirePermissions("parcel:dispatch")
  @Post("trips/:trip/arrive")
  @HttpCode(200)
  arrive(@CurrentActor() actor: Actor, @Param("trip") trip: string, @ReqMeta() meta: RequestMeta) {
    return this.linehaul.arrive(actor, trip, meta);
  }

  @RequirePermissions("parcel:dispatch")
  @Post("trips/:trip/close")
  @HttpCode(200)
  close(@CurrentActor() actor: Actor, @Param("trip") trip: string, @ReqMeta() meta: RequestMeta) {
    return this.linehaul.close(actor, trip, meta);
  }

  @RequirePermissions("parcel:dispatch")
  @Post("trips/:trip/cancel")
  @HttpCode(200)
  cancel(@CurrentActor() actor: Actor, @Param("trip") trip: string, @ReqMeta() meta: RequestMeta) {
    return this.linehaul.cancel(actor, trip, meta);
  }

  // ── discrepancies ──

  @RequirePermissions("hub:read")
  @Get("discrepancies")
  @ApiZodQuery(listDiscrepanciesQuerySchema)
  discrepancies(@CurrentActor() actor: Actor, @ZQuery(listDiscrepanciesQuerySchema) query: z.infer<typeof listDiscrepanciesQuerySchema>) {
    return this.linehaul.listDiscrepancies(actor, query);
  }

  @RequirePermissions("parcel:dispatch")
  @Post("discrepancies/:id/resolve")
  @HttpCode(200)
  @ApiZodBody(resolveDiscrepancySchema)
  resolve(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(resolveDiscrepancySchema) body: z.infer<typeof resolveDiscrepancySchema>, @ReqMeta() meta: RequestMeta) {
    return this.linehaul.resolveDiscrepancy(actor, id, body, meta);
  }
}
