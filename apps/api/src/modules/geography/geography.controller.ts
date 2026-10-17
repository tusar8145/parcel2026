import type { z } from "zod";
import { Controller, Delete, Get, HttpStatus, Patch, Post } from "@nestjs/common";
import { AppError } from "../../common/errors";
import { ApiTags } from "@nestjs/swagger";
import { CurrentActor, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import {
  addAreasSchema,
  countsQuerySchema,
  createDistrictSchema,
  createZoneSchema,
  placeQuerySchema,
  updateAreaSchema,
  updateDistrictSchema,
  updateZoneSchema,
} from "./geography.schemas";
import { GeographyService } from "./geography.service";

/**
 * Geography admin: the districts, zones and areas of the service catalog. Reading needs hub:read
 * (operations and super admins), changes need config:manage (super admins). Places are named in
 * the body/query (names may contain "/"), matched case-insensitively.
 */
@ApiTags("geography")
@Controller("geography")
export class GeographyController {
  constructor(private readonly geo: GeographyService) {}

  /** The whole hierarchy: districts → zones → areas, with active flags, map points and serving hubs. */
  @RequirePermissions("hub:read")
  @Get()
  tree() {
    return this.geo.tree();
  }

  /** Usage totals per district (no parameters), per zone of `district`, or per area of `zone`. */
  @RequirePermissions("hub:read")
  @Get("counts")
  @ApiZodQuery(countsQuerySchema)
  counts(@ZQuery(countsQuerySchema) query: z.infer<typeof countsQuerySchema>) {
    return this.geo.counts(query);
  }

  /** What references one place (records per kind), e.g. before deleting it. */
  @RequirePermissions("hub:read")
  @Get("usage")
  @ApiZodQuery(placeQuerySchema)
  usage(@ZQuery(placeQuerySchema) query: z.infer<typeof placeQuerySchema>) {
    return this.geo.usage(query);
  }

  @RequirePermissions("config:manage")
  @Post("districts")
  @ApiZodBody(createDistrictSchema)
  createDistrict(@CurrentActor() actor: Actor, @ZBody(createDistrictSchema) body: z.infer<typeof createDistrictSchema>, @ReqMeta() meta: RequestMeta) {
    return this.geo.createDistrict(actor, body, meta);
  }

  /** Rename (updates every record that names it), activate / deactivate, map point. */
  @RequirePermissions("config:manage")
  @Patch("districts")
  @ApiZodBody(updateDistrictSchema)
  updateDistrict(@CurrentActor() actor: Actor, @ZBody(updateDistrictSchema) body: z.infer<typeof updateDistrictSchema>, @ReqMeta() meta: RequestMeta) {
    return this.geo.updateDistrict(actor, body, meta);
  }

  /** Only when nothing uses the district or its zones and areas (409 IN_USE with the usage otherwise). */
  @RequirePermissions("config:manage")
  @Delete("districts")
  @ApiZodQuery(placeQuerySchema)
  deleteDistrict(@CurrentActor() actor: Actor, @ZQuery(placeQuerySchema) query: z.infer<typeof placeQuerySchema>, @ReqMeta() meta: RequestMeta) {
    return this.geo.deleteDistrict(actor, query.district, meta);
  }

  @RequirePermissions("config:manage")
  @Post("zones")
  @ApiZodBody(createZoneSchema)
  createZone(@CurrentActor() actor: Actor, @ZBody(createZoneSchema) body: z.infer<typeof createZoneSchema>, @ReqMeta() meta: RequestMeta) {
    return this.geo.createZone(actor, body, meta);
  }

  @RequirePermissions("config:manage")
  @Patch("zones")
  @ApiZodBody(updateZoneSchema)
  updateZone(@CurrentActor() actor: Actor, @ZBody(updateZoneSchema) body: z.infer<typeof updateZoneSchema>, @ReqMeta() meta: RequestMeta) {
    return this.geo.updateZone(actor, body, meta);
  }

  @RequirePermissions("config:manage")
  @Delete("zones")
  @ApiZodQuery(placeQuerySchema)
  deleteZone(@CurrentActor() actor: Actor, @ZQuery(placeQuerySchema) query: z.infer<typeof placeQuerySchema>, @ReqMeta() meta: RequestMeta) {
    return this.geo.deleteZone(actor, { district: query.district, zone: required(query.zone, "zone") }, meta);
  }

  /** One area or many (pasted lines): `{ added, skipped: [{ line, name, reason }] }`. */
  @RequirePermissions("config:manage")
  @Post("areas")
  @ApiZodBody(addAreasSchema)
  addAreas(@CurrentActor() actor: Actor, @ZBody(addAreasSchema) body: z.infer<typeof addAreasSchema>, @ReqMeta() meta: RequestMeta) {
    return this.geo.addAreas(actor, body, meta);
  }

  @RequirePermissions("config:manage")
  @Patch("areas")
  @ApiZodBody(updateAreaSchema)
  updateArea(@CurrentActor() actor: Actor, @ZBody(updateAreaSchema) body: z.infer<typeof updateAreaSchema>, @ReqMeta() meta: RequestMeta) {
    return this.geo.updateArea(actor, body, meta);
  }

  @RequirePermissions("config:manage")
  @Delete("areas")
  @ApiZodQuery(placeQuerySchema)
  deleteArea(@CurrentActor() actor: Actor, @ZQuery(placeQuerySchema) query: z.infer<typeof placeQuerySchema>, @ReqMeta() meta: RequestMeta) {
    return this.geo.deleteArea(actor, { district: query.district, zone: required(query.zone, "zone"), area: required(query.area, "area") }, meta);
  }
}

function required(value: string | undefined, field: string): string {
  if (!value) throw new AppError("VALIDATION_FAILED", `Give the ${field}`, HttpStatus.UNPROCESSABLE_ENTITY, { field });
  return value;
}
