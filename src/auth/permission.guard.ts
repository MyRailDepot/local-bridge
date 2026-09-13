import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSION_KEY } from './require-permission.decorator';
import type { BridgeTokenPayload } from '../protocol/bridge.types';

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.get<string | undefined>(PERMISSION_KEY, context.getHandler());
    if (!required) return true;

    const user = context.switchToHttp().getRequest<{ user?: BridgeTokenPayload }>().user;
    if (!user?.permissions?.includes(required)) throw new ForbiddenException();
    return true;
  }
}
