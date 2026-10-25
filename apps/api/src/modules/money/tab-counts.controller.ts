import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CurrentActor } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { TabCountsService } from "./tab-counts.service";

@ApiTags("accounts")
@Controller()
export class TabCountsController {
  constructor(private readonly tabCounts: TabCountsService) {}

  /** Courier Operations › Accounts tab badges: what waits in each tab this person sees (count, amount, what it is). */
  @Get("accounts/tab-counts")
  counts(@CurrentActor() actor: Actor) {
    return this.tabCounts.counts(actor);
  }
}
