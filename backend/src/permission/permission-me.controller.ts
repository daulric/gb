import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@/auth/auth.guard';
import { PermissionService } from './permission.service';

/**
 * The caller's own effective permissions. Separate from PermissionController so
 * it is guarded by AuthGuard only (not AdminGuard) - every authenticated user
 * may read what they themselves can do, for client-side UI gating.
 */
@ApiTags('Permissions')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('permissions')
export class PermissionMeController {
  constructor(private readonly permissionService: PermissionService) {}

  @Get('me')
  getMine(@Req() req: any) {
    const userId: string = req.user.id;
    return this.permissionService.getMyPermissions(userId);
  }
}
