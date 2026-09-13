import { Module } from '@nestjs/common';
import { RegistrationModule } from './registration/registration.module';
import { HealthModule } from './health/health.module';
import { CentralConfigModule } from './central-config/central-config.module';
import { CentralModule } from './central/central.module';
import { GatewayModule } from './gateway/gateway.module';
import { AuthModule } from './auth/auth.module';
import { ProgrammingModule } from './programming/programming.module';
import { DriveSessionModule } from './drive-session/drive-session.module';
import { AutomationModule } from './automation/automation.module';

@Module({
  imports: [AuthModule, RegistrationModule, HealthModule, CentralConfigModule, CentralModule, GatewayModule, ProgrammingModule, DriveSessionModule, AutomationModule],
})
export class AppModule {}
