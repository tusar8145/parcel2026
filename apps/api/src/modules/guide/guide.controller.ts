import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { systemGuide } from "@paira-express/shared";
import { RequirePermissions } from "../../common/auth/decorators";

/** The System guide (super admin › System guide, Courier Operations › Settings): numbers, statuses, money steps, roles. */
@ApiTags("guide")
@Controller("guide")
export class GuideController {
  /** For staff (anyone who reads parcels network-wide). */
  @RequirePermissions("parcel:read:any")
  @Get()
  guide() {
    return systemGuide();
  }
}
