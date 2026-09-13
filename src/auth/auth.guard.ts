import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './public.decorator';
import { BridgeTokenVerifier } from './bridge-token.verifier';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: BridgeTokenVerifier,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<{ headers: Record<string, string>; user?: unknown }>();
    const authHeader = req.headers['authorization'];
    if (!authHeader?.startsWith('Bearer ')) throw new UnauthorizedException('Missing token');

    const token = authHeader.slice(7);
    req.user = this.verifier.verify(token);
    return true;
  }
}
