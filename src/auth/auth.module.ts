import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { BridgeTokenVerifier } from './bridge-token.verifier';
import { AuthGuard } from './auth.guard';
import { PermissionGuard } from './permission.guard';

@Module({
  providers: [
    BridgeTokenVerifier,
    { provide: APP_GUARD, useClass: AuthGuard },
    PermissionGuard,
  ],
  exports: [BridgeTokenVerifier, PermissionGuard],
})
export class AuthModule {}
