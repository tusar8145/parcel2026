import { Module } from "@nestjs/common";
import { PricingModule } from "../pricing/pricing.module";
import { AdminController, SecurityController, SettingsController } from "./admin.controller";
import { OverviewService } from "./overview.service";
import { PlatformConfigService } from "./platform-config.service";
import { RolesService } from "./roles.service";
import { ImpersonationService } from "./impersonation.service";

/** Platform settings (GET/PUT /settings/platform-config), the super admin overview, roles and support access. */
@Module({
  imports: [PricingModule],
  controllers: [SettingsController, AdminController, SecurityController],
  providers: [PlatformConfigService, OverviewService, RolesService, ImpersonationService],
})
export class AdminModule {}
