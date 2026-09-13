import { SetMetadata } from '@nestjs/common';

export const PERMISSION_KEY = 'require_permission';

export const RequirePermission = (permission: string) =>
  SetMetadata(PERMISSION_KEY, permission);
