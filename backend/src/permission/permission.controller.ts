import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@/auth/auth.guard';
import { AdminGuard } from '@/auth/admin.guard';
import { PermissionService } from './permission.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { SetRolePermissionsDto } from './dto/set-role-permissions.dto';
import { AssignRoleDto } from './dto/assign-role.dto';
import { ChangeMemberRoleDto } from './dto/change-member-role.dto';

/**
 * Admin-only management of per-school custom roles and permission grants.
 * Guarded by AdminGuard (not PermissionGuard) - admins are the authority over
 * roles; gating this with PermissionGuard would be circular.
 */
@ApiTags('Permissions')
@ApiBearerAuth()
@UseGuards(AuthGuard, AdminGuard)
@Controller('permissions')
export class PermissionController {
  constructor(private readonly permissionService: PermissionService) {}

  @Get('catalog')
  getCatalog() {
    return this.permissionService.listCatalog();
  }

  @Get('roles')
  listRoles(@Req() req: any) {
    const userId: string = req.user.id;
    return this.permissionService.listRoles(userId);
  }

  @Post('roles')
  createRole(@Req() req: any, @Body() dto: CreateRoleDto) {
    const userId: string = req.user.id;
    return this.permissionService.createRole(userId, dto);
  }

  @Patch('roles/:roleId')
  updateRole(
    @Req() req: any,
    @Param('roleId') roleId: string,
    @Body() dto: UpdateRoleDto,
  ) {
    const userId: string = req.user.id;
    return this.permissionService.updateRole(userId, roleId, dto);
  }

  @Delete('roles/:roleId')
  deleteRole(@Req() req: any, @Param('roleId') roleId: string) {
    const userId: string = req.user.id;
    return this.permissionService.deleteRole(userId, roleId);
  }

  @Get('roles/:roleId/permissions')
  getRolePermissions(@Req() req: any, @Param('roleId') roleId: string) {
    const userId: string = req.user.id;
    return this.permissionService.getRolePermissions(userId, roleId);
  }

  @Put('roles/:roleId/permissions')
  setRolePermissions(
    @Req() req: any,
    @Param('roleId') roleId: string,
    @Body() dto: SetRolePermissionsDto,
  ) {
    const userId: string = req.user.id;
    return this.permissionService.setRolePermissions(userId, roleId, dto.keys);
  }

  @Get('members/:membershipId/roles')
  getMemberRoles(@Req() req: any, @Param('membershipId') membershipId: string) {
    const userId: string = req.user.id;
    return this.permissionService.getMemberRoles(userId, membershipId);
  }

  @Patch('members/:membershipId/base-role')
  changeMemberRole(
    @Req() req: any,
    @Param('membershipId') membershipId: string,
    @Body() dto: ChangeMemberRoleDto,
  ) {
    const userId: string = req.user.id;
    return this.permissionService.changeMemberRole(
      userId,
      membershipId,
      dto.role,
    );
  }

  @Post('members/:membershipId/roles')
  assignRole(
    @Req() req: any,
    @Param('membershipId') membershipId: string,
    @Body() dto: AssignRoleDto,
  ) {
    const userId: string = req.user.id;
    return this.permissionService.assignRoleToMember(
      userId,
      membershipId,
      dto.roleId,
    );
  }

  @Delete('members/:membershipId/roles/:roleId')
  unassignRole(
    @Req() req: any,
    @Param('membershipId') membershipId: string,
    @Param('roleId') roleId: string,
  ) {
    const userId: string = req.user.id;
    return this.permissionService.unassignRoleFromMember(
      userId,
      membershipId,
      roleId,
    );
  }
}
