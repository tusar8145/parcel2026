import { Module } from "@nestjs/common";
import { PhoneScannerController } from "./phone-scanner.controller";
import { PhoneScannerService } from "./phone-scanner.service";

@Module({
  controllers: [PhoneScannerController],
  providers: [PhoneScannerService],
})
export class PhoneScannerModule {}
