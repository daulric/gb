import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SupabaseService } from '@/supabase/supabase.service';
import { CacheService } from '@/cache/cache.service';
import { PERMISSION_KEY } from './require-permission.decorator';
import { PermissionKey } from './permission.catalog';
import { loadEffectivePermissions } from './permission.effective';

@Injectable()
export class PermissionGuard implements CanActivate {
  private readonly logger = new Logger(PermissionGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly supabaseService: SupabaseService,
    private readonly cache: CacheService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<PermissionKey>(
      PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Unannotated route: this guard does not apply.
    if (!required) return true;

    const request = context.switchToHttp().getRequest();
    const userId: string = request.user?.id;

    if (!userId) {
      // AuthGuard should have populated request.user; if not, fail closed.
      throw new ForbiddenException('Authentication required');
    }

    const schoolId = await this.resolveSchoolContext(request);
    if (!schoolId) {
      throw new ForbiddenException('Could not resolve school context');
    }

    const effective = await loadEffectivePermissions(
      this.supabaseService,
      this.cache,
      userId,
      schoolId,
    );

    if (!effective.member) {
      this.logger.warn(
        `User ${userId} is not a member of school ${schoolId} (needs ${required})`,
      );
      throw new ForbiddenException('You are not a member of this school');
    }

    if (effective.keys.includes(required)) {
      return true;
    }

    this.logger.warn(
      `User ${userId} denied: missing permission ${required} in school ${schoolId}`,
    );
    throw new ForbiddenException(`Missing permission: ${required}`);
  }

  private async resolveSchoolContext(
    request: any,
  ): Promise<string | undefined> {
    if (request.params?.schoolId) return request.params.schoolId;

    const supabase = this.supabaseService.getServiceClient();

    const classId =
      request.params?.classId ??
      request.body?.studentGroupId ??
      request.query?.studentGroupId ??
      undefined;

    if (classId) {
      const { data: studentGroup } = await supabase
        .from('student_group')
        .select('academic_year:academic_year_id(school_id)')
        .eq('id', classId)
        .maybeSingle();

      const classSchoolId = (
        studentGroup?.academic_year as { school_id?: string } | null
      )?.school_id;
      if (classSchoolId) return classSchoolId;
    }

    // Fallback: the user's active school (denormalized single current school).
    const { data: profile } = await supabase
      .from('user_profile')
      .select('school_id')
      .eq('id', request.user.id)
      .maybeSingle();

    return profile?.school_id ?? undefined;
  }
}
