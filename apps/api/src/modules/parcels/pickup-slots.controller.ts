import { Controller, Get, Put } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { z } from "zod";
import { pickupSlotConfigSchema, pickupSlotsQuerySchema } from "@delivery-fast/shared";
import { CurrentActor, Public, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { PickupSlotsService } from "./pickup-slots.service";

@ApiTags("pickup slots")
@Controller("pickup-slots")
export class PickupSlotsController {
  constructor(private readonly slots: PickupSlotsService) {}

  /** Bookable pickup windows: the next days, or one `date` (YYYY-MM-DD, Dhaka). Capacity is per pickup district when given. */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get()
  @ApiZodQuery(pickupSlotsQuerySchema)
  list(@ZQuery(pickupSlotsQuerySchema) query: z.infer<typeof pickupSlotsQuerySchema>) {
    return this.slots.list(query);
  }

  @RequirePermissions("config:manage")
  @Get("config")
  config() {
    return this.slots.config();
  }

  /** Windows per day, closed weekdays, booking lead time and optional capacity. */
  @RequirePermissions("config:manage")
  @Put("config")
  @ApiZodBody(pickupSlotConfigSchema)
  saveConfig(@CurrentActor() actor: Actor, @ZBody(pickupSlotConfigSchema) body: z.infer<typeof pickupSlotConfigSchema>, @ReqMeta() meta: RequestMeta) {
    return this.slots.saveConfig(actor, body, meta);
  }
}
