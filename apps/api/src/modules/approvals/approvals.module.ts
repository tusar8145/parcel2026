import { Global, Module } from "@nestjs/common";
import { ApprovalsController } from "./approvals.controller";
import { ApprovalsService } from "./approvals.service";

/** Global so feature modules (pricing, roles) can register their change handlers. */
@Global()
@Module({ controllers: [ApprovalsController], providers: [ApprovalsService], exports: [ApprovalsService] })
export class ApprovalsModule {}
