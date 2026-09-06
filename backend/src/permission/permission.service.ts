import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '@/supabase/supabase.service';
import { CacheService } from '@/cache/cache.service';
import {
  loadEffectivePermissions,
  PERM_CACHE_PREFIX,
} from './permission.effective';
import {
  defaultsForRole,
  isPermissionKey,
  PERMISSION_CATALOG,
} from './permission.catalog';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';

@Injectable()
export class PermissionService {
  private readonly logger = new Logger(PermissionService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly cache: CacheService,
  ) {}

  /** The code-defined catalog of assignable permissions (for the admin UI). */
  listCatalog() {
    return PERMISSION_CATALOG.map(({ resource, action, key, description }) => ({
      resource,
      action,
      key,
      description,
    }));
  }

  async listRoles(adminUserId: string) {
    const supabase = this.supabaseService.getServiceClient();
    const schoolId = await this.requireAdminSchool(adminUserId);

    const { data, error } = await supabase
      .from('school_role')
      .select('id, name, description, is_system, created_at, updated_at')
      .eq('school_id', schoolId)
      .order('is_system', { ascending: false })
      .order('name', { ascending: true });

    if (error) {
      this.logger.error(`Failed to list roles: ${error.message}`);
      throw new BadRequestException('Failed to list roles');
    }
    return data ?? [];
  }

  async createRole(adminUserId: string, dto: CreateRoleDto) {
    const supabase = this.supabaseService.getServiceClient();
    const schoolId = await this.requireAdminSchool(adminUserId);

    const { data, error } = await supabase
      .from('school_role')
      .insert({
        school_id: schoolId,
        name: dto.name,
        description: dto.description ?? null,
        is_system: false,
      })
      .select('id, name, description, is_system, created_at, updated_at')
      .single();

    if (error || !data) {
      // 23505 = unique_violation (name already used in this school).
      if (error?.code === '23505') {
        throw new BadRequestException(
          'A role with this name already exists in your school',
        );
      }
      this.logger.error(`Failed to create role: ${error?.message}`);
      throw new BadRequestException('Failed to create role');
    }
    return data;
  }

  async updateRole(adminUserId: string, roleId: string, dto: UpdateRoleDto) {
    const supabase = this.supabaseService.getServiceClient();
    const role = await this.requireEditableRole(adminUserId, roleId);

    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.description !== undefined) patch.description = dto.description;

    const { data, error } = await supabase
      .from('school_role')
      .update(patch)
      .eq('id', role.id)
      .select('id, name, description, is_system, created_at, updated_at')
      .single();

    if (error || !data) {
      if (error?.code === '23505') {
        throw new BadRequestException(
          'A role with this name already exists in your school',
        );
      }
      this.logger.error(`Failed to update role ${roleId}: ${error?.message}`);
      throw new BadRequestException('Failed to update role');
    }

    await this.invalidate();
    return data;
  }

  async deleteRole(adminUserId: string, roleId: string) {
    const supabase = this.supabaseService.getServiceClient();
    const role = await this.requireEditableRole(adminUserId, roleId);

    const { error } = await supabase
      .from('school_role')
      .delete()
      .eq('id', role.id);

    if (error) {
      this.logger.error(`Failed to delete role ${roleId}: ${error.message}`);
      throw new BadRequestException('Failed to delete role');
    }

    await this.invalidate();
    return { deleted: true };
  }

  async getRolePermissions(adminUserId: string, roleId: string) {
    const supabase = this.supabaseService.getServiceClient();
    const role = await this.requireRoleInSchool(adminUserId, roleId);

    if (role.is_system) {
      return [...defaultsForRole(role.name as string)];
    }

    const { data, error } = await supabase
      .from('school_role_permission')
      .select('permission_catalog:permission_id(key)')
      .eq('school_role_id', roleId);

    if (error) {
      this.logger.error(
        `Failed to read role permissions ${roleId}: ${error.message}`,
      );
      throw new BadRequestException('Failed to read role permissions');
    }

    return (data ?? [])
      .map((r) => (r.permission_catalog as { key?: string } | null)?.key)
      .filter((k): k is string => Boolean(k));
  }

  /** Replace a role's entire permission set with the given catalog keys. */
  async setRolePermissions(
    adminUserId: string,
    roleId: string,
    keys: string[],
  ) {
    const supabase = this.supabaseService.getServiceClient();
    const role = await this.requireEditableRole(adminUserId, roleId);

    const invalid = keys.filter((k) => !isPermissionKey(k));
    if (invalid.length > 0) {
      throw new BadRequestException(
        `Unknown permission key(s): ${invalid.join(', ')}`,
      );
    }

    const uniqueKeys = [...new Set(keys)];

    // Map keys -> catalog ids.
    let permissionIds: string[] = [];
    if (uniqueKeys.length > 0) {
      const { data: catalog, error: catError } = await supabase
        .from('permission_catalog')
        .select('id, key')
        .in('key', uniqueKeys);

      if (catError) {
        this.logger.error(`Failed to read catalog: ${catError.message}`);
        throw new BadRequestException('Failed to set role permissions');
      }
      permissionIds = (catalog ?? []).map((c: { id: string }) => c.id);
    }

    // Replace: clear existing, then insert the new set.
    const { error: delError } = await supabase
      .from('school_role_permission')
      .delete()
      .eq('school_role_id', role.id);

    if (delError) {
      this.logger.error(
        `Failed to clear role permissions ${roleId}: ${delError.message}`,
      );
      throw new BadRequestException('Failed to set role permissions');
    }

    if (permissionIds.length > 0) {
      const rows = permissionIds.map((permission_id) => ({
        school_role_id: role.id,
        permission_id,
      }));
      const { error: insError } = await supabase
        .from('school_role_permission')
        .insert(rows);

      if (insError) {
        this.logger.error(
          `Failed to insert role permissions ${roleId}: ${insError.message}`,
        );
        throw new BadRequestException('Failed to set role permissions');
      }
    }

    await this.invalidate();
    return { keys: uniqueKeys };
  }

  async assignRoleToMember(
    adminUserId: string,
    membershipId: string,
    roleId: string,
  ) {
    const supabase = this.supabaseService.getServiceClient();
    const schoolId = await this.requireAdminSchool(adminUserId);
    await this.requireMembershipInSchool(membershipId, schoolId);
    await this.requireRoleInSchool(adminUserId, roleId);

    const { error } = await supabase
      .from('school_management_role')
      .upsert(
        { school_management_id: membershipId, school_role_id: roleId },
        { onConflict: 'school_management_id,school_role_id' },
      );

    if (error) {
      this.logger.error(`Failed to assign role: ${error.message}`);
      throw new BadRequestException('Failed to assign role');
    }

    await this.invalidate();
    return { assigned: true };
  }

  async changeMemberRole(
    adminUserId: string,
    membershipId: string,
    role: 'admin' | 'member' | 'teacher' | null,
  ) {
    const supabase = this.supabaseService.getServiceClient();
    const schoolId = await this.requireAdminSchool(adminUserId);
    const membership = await this.requireMembershipInSchool(
      membershipId,
      schoolId,
    );
    const { data: school } = await supabase
      .from('school')
      .select('owner_id')
      .eq('id', schoolId)
      .single();
    if (school?.owner_id === membership.user_id) {
      throw new ForbiddenException('The school owner role cannot be changed');
    }

    const { error } = await supabase
      .from('school_management')
      .update({ role, updated_at: new Date().toISOString() })
      .eq('id', membershipId);
    if (error) {
      this.logger.error(
        `Failed to change member role ${membershipId}: ${error.message}`,
      );
      throw new BadRequestException(
        role === null && error.code === '23502'
          ? 'The database must allow members without a default role. Apply the nullable membership role migration first.'
          : `Failed to change member role: ${error.message}`,
      );
    }

    const { error: profileError } = await supabase
      .from('user_profile')
      .update({ role })
      .eq('id', membership.user_id);
    if (profileError) {
      this.logger.error(
        `Failed to mirror member role ${membership.user_id}: ${profileError.message}`,
      );
      throw new BadRequestException('Failed to synchronize member role');
    }
    await this.cache.delete(`profile:${membership.user_id}`);
    await this.invalidate();
    return { role };
  }

  async unassignRoleFromMember(
    adminUserId: string,
    membershipId: string,
    roleId: string,
  ) {
    const supabase = this.supabaseService.getServiceClient();
    const schoolId = await this.requireAdminSchool(adminUserId);
    await this.requireMembershipInSchool(membershipId, schoolId);

    const { error } = await supabase
      .from('school_management_role')
      .delete()
      .eq('school_management_id', membershipId)
      .eq('school_role_id', roleId);

    if (error) {
      this.logger.error(`Failed to unassign role: ${error.message}`);
      throw new BadRequestException('Failed to unassign role');
    }

    await this.invalidate();
    return { unassigned: true };
  }

  /** Custom roles currently assigned to a membership (for the admin UI). */
  async getMemberRoles(adminUserId: string, membershipId: string) {
    const supabase = this.supabaseService.getServiceClient();
    const schoolId = await this.requireAdminSchool(adminUserId);
    await this.requireMembershipInSchool(membershipId, schoolId);

    const { data, error } = await supabase
      .from('school_management_role')
      .select('school_role:school_role_id(id, name, is_system)')
      .eq('school_management_id', membershipId);

    if (error) {
      this.logger.error(`Failed to read member roles: ${error.message}`);
      throw new BadRequestException('Failed to read member roles');
    }

    type Role = { id: string; name: string; is_system: boolean };
    return (data ?? [])
      .map((r) => {
        const sr = r.school_role as Role | Role[] | null;
        return Array.isArray(sr) ? (sr[0] ?? null) : sr;
      })
      .filter((r): r is Role => Boolean(r));
  }

  /**
   * The caller's own effective permissions in their active school. Available to
   * any authenticated user (not admin-only) so the frontend can gate its UI.
   */
  async getMyPermissions(userId: string) {
    const supabase = this.supabaseService.getServiceClient();

    const { data: profile } = await supabase
      .from('user_profile')
      .select('school_id')
      .eq('id', userId)
      .maybeSingle();

    const schoolId: string = profile?.school_id ?? null;
    if (!schoolId) {
      return { schoolId: null, role: null, isAdmin: false, permissions: [] };
    }

    const effective = await loadEffectivePermissions(
      this.supabaseService,
      this.cache,
      userId,
      schoolId,
    );

    return {
      schoolId,
      role: effective.role,
      isAdmin: effective.role === 'admin',
      permissions: effective.keys,
    };
  }

  // --- helpers -------------------------------------------------------------

  private async requireAdminSchool(adminUserId: string): Promise<string> {
    const supabase = this.supabaseService.getServiceClient();
    const { data: profile } = await supabase
      .from('user_profile')
      .select('school_id')
      .eq('id', adminUserId)
      .single();

    if (!profile?.school_id) {
      throw new BadRequestException('You are not assigned to a school');
    }
    return profile.school_id;
  }

  /** Verify the role exists and belongs to the admin's school. */
  private async requireRoleInSchool(adminUserId: string, roleId: string) {
    const supabase = this.supabaseService.getServiceClient();
    const schoolId = await this.requireAdminSchool(adminUserId);

    const { data: role } = await supabase
      .from('school_role')
      .select('id, school_id, is_system, name')
      .eq('id', roleId)
      .maybeSingle();

    if (!role) throw new NotFoundException('Role not found');
    if (role.school_id !== schoolId) {
      throw new ForbiddenException('This role does not belong to your school');
    }
    return role;
  }

  /** Same as requireRoleInSchool, but also rejects system roles (not editable). */
  private async requireEditableRole(adminUserId: string, roleId: string) {
    const role = await this.requireRoleInSchool(adminUserId, roleId);
    if (role.is_system) {
      throw new ForbiddenException('System roles cannot be modified');
    }
    return role;
  }

  private async requireMembershipInSchool(
    membershipId: string,
    schoolId: string,
  ) {
    const supabase = this.supabaseService.getServiceClient();
    const { data: membership } = await supabase
      .from('school_management')
      .select('id, user_id, school_id')
      .eq('id', membershipId)
      .maybeSingle();

    if (!membership) throw new NotFoundException('Membership not found');
    if (membership.school_id !== schoolId) {
      throw new ForbiddenException(
        'This membership does not belong to your school',
      );
    }
    return membership;
  }

  /** Flush cached effective-permission sets after a role/permission change. */
  private async invalidate() {
    await this.cache.deleteByPrefix(PERM_CACHE_PREFIX);
  }
}
