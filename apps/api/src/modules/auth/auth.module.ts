import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { OtpService } from "./otp.service";
import { SessionService } from "./session.service";
import { MfaController } from "./mfa.controller";
import { MfaService } from "./mfa.service";

@Module({
  controllers: [AuthController, MfaController],
  providers: [AuthService, OtpService, SessionService, MfaService],
  exports: [SessionService, MfaService],
})
export class AuthModule {}
