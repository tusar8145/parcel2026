import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AuditLogsController, ProfileController, UsersController } from "./accounts.controller";
import { AuditLogsService } from "./audit-logs.service";
import { ProfileService } from "./profile.service";
import { UsersService } from "./users.service";

@Module({
  imports: [AuthModule], // SessionService: revoke sessions on suspension / role removal
  controllers: [ProfileController, UsersController, AuditLogsController],
  providers: [ProfileService, UsersService, AuditLogsService],
  exports: [UsersService],
})
export class AccountsModule {}
