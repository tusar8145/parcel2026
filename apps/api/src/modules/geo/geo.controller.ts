import type { z } from "zod";
import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { geoReverseQuerySchema, geoSearchQuerySchema } from "@delivery-fast/shared";
import { Public } from "../../common/auth/decorators";
import { ApiZodQuery, ZQuery } from "../../common/zod";
import { GeoService } from "./geo.service";

/** Address autocomplete and map-pin lookup (OpenStreetMap Nominatim, cached). */
@ApiTags("places")
@Controller("geo")
export class GeoController {
  constructor(private readonly geo: GeoService) {}

  /** Places in Bangladesh matching typed text. 503 GEO_UNAVAILABLE when the upstream is busy. */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get("search")
  @ApiZodQuery(geoSearchQuerySchema)
  async search(@ZQuery(geoSearchQuerySchema) query: z.infer<typeof geoSearchQuerySchema>) {
    return { items: await this.geo.search(query.q, query.limit) };
  }

  /** The address at a map pin, or `{ place: null }`. */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get("reverse")
  @ApiZodQuery(geoReverseQuerySchema)
  async reverse(@ZQuery(geoReverseQuerySchema) query: z.infer<typeof geoReverseQuerySchema>) {
    return { place: await this.geo.reverse(query.lat, query.lng) };
  }
}
