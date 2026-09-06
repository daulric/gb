import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '@/supabase/supabase.service';
import { CacheService } from '@/cache/cache.service';
import { ChatSystemService } from '@/chat/chat-system.service';
import { CreateClassDto } from './dto/create-class.dto';
import { UpdateClassDto } from './dto/update-class.dto';
import { AddTeacherDto } from './dto/add-teacher.dto';

const CLASS_TTL = 60 * 60 * 24 * 30;

@Injectable()
export class ClassService {
  private readonly logger = new Logger(ClassService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly cache: CacheService,
    private readonly chatSystem: ChatSystemService,
  ) {}

  async createClass(userId: string, dto: CreateClassDto) {
    const supabase = this.supabaseService.getServiceClient();

    const { data: group, error: groupError } = await supabase
      .from('student_group')
      .insert({
        name: dto.name,
        academic_year_id: dto.academicYearId,
        created_by: userId,
      })
      .select()
      .single();

    if (groupError || !group) {
      this.logger.error(`Failed to create class: ${groupError?.message}`);
      throw new BadRequestException('Failed to create class');
    }

    const { error: assignmentError } = await supabase
      .schema('staff')
      .from('teacher_group_assignment')
      .insert({
        user_profile_id: userId,
        student_group_id: group.id,
        academic_year_id: dto.academicYearId,
        is_class_teacher: true,
      });

    if (assignmentError) {
      this.logger.error(
        `Class ${group.id} created but teacher assignment failed: ${assignmentError.message}`,
      );
    }

    if (dto.subjectIds?.length) {
      const subjectRows = dto.subjectIds.map((subjectId) => ({
        user_profile_id: userId,
        subject_id: subjectId,
        student_group_id: group.id,
        academic_year_id: dto.academicYearId,
      }));

      const { error: subjectError } = await supabase
        .schema('staff')
        .from('teacher_subject_assignment')
        .insert(subjectRows);

      if (subjectError) {
        this.logger.error(
          `Class ${group.id} created but subject assignment failed: ${subjectError.message}`,
        );
      }
    }

    const entry = {
      id: group.id,
      name: group.name,
      academicYearId: dto.academicYearId,
      isClassTeacher: true,
      createdAt: group.created_at ?? null,
    };
    await this.cache.update<any[]>(
      `my-classes:${userId}`,
      (list) => [...list, entry],
      CLASS_TTL,
    );
    await this.cache.update<any[]>(
      `my-classes:${userId}:${dto.academicYearId}`,
      (list) => [...list, entry],
      CLASS_TTL,
    );
    return group;
  }

  async getMyClasses(userId: string, academicYearId?: string) {
    const cacheKey = academicYearId
      ? `my-classes:${userId}:${academicYearId}`
      : `my-classes:${userId}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached;

    const supabase = this.supabaseService.getServiceClient();

    let query = supabase
      .schema('staff')
      .from('teacher_group_assignment')
      .select('id, student_group_id, academic_year_id, is_class_teacher')
      .eq('user_profile_id', userId);

    if (academicYearId) {
      query = query.eq('academic_year_id', academicYearId);
    }

    const { data: assignments, error } = await query;

    if (error) {
      this.logger.error(
        `Failed to fetch classes for ${userId}: ${error.message}`,
      );
      return [];
    }

    if (!assignments || assignments.length === 0) {
      return [];
    }

    const groupIds = assignments.map((a: any) => a.student_group_id);
    const { data: groups } = await supabase
      .from('student_group')
      .select('*')
      .in('id', groupIds);

    const groupMap = new Map((groups || []).map((g: any) => [g.id, g]));

    const result = assignments.map((row: any) => {
      const group = groupMap.get(row.student_group_id);
      return {
        id: row.student_group_id,
        name: group?.name ?? null,
        academicYearId: row.academic_year_id,
        isClassTeacher: row.is_class_teacher,
        createdAt: group?.created_at ?? null,
      };
    });

    await this.cache.set(cacheKey, result, CLASS_TTL);
    return result;
  }

  async getClassById(classId: string) {
    const supabase = this.supabaseService.getServiceClient();

    const { data, error } = await supabase
      .from('student_group')
      .select('*')
      .eq('id', classId)
      .single();

    if (error || !data) {
      this.logger.error(`Class not found ${classId}: ${error?.message}`);
      throw new NotFoundException('Class not found');
    }

    return data;
  }

  async updateClass(classId: string, dto: UpdateClassDto) {
    const supabase = this.supabaseService.getServiceClient();

    const { data, error } = await supabase
      .from('student_group')
      .update({ name: dto.name })
      .eq('id', classId)
      .select()
      .single();

    if (error || !data) {
      this.logger.error(`Failed to update class ${classId}: ${error?.message}`);
      throw new BadRequestException('Failed to update class');
    }

    await this.cache.delete(`class-teachers:${classId}`);
    return data;
  }

  async deleteClass(classId: string) {
    const supabase = this.supabaseService.getServiceClient();

    const { error } = await supabase
      .from('student_group')
      .delete()
      .eq('id', classId);

    if (error) {
      this.logger.error(`Failed to delete class ${classId}: ${error.message}`);
      throw new BadRequestException('Failed to delete class');
    }

    await this.cache.delete(`class-teachers:${classId}`);
    return 'Class deleted';
  }

  async getMySubjectsForClass(userId: string, classId: string) {
    const cacheKey = `my-subjects:${classId}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached;

    const supabase = this.supabaseService.getServiceClient();

    const { data: profile } = await supabase
      .from('user_profile')
      .select('role')
      .eq('id', userId)
      .single();

    const isAdmin = profile?.role === 'admin';

    let isClassTeacher = false;
    if (!isAdmin) {
      const { data: groupAssignment } = await supabase
        .schema('staff')
        .from('teacher_group_assignment')
        .select('is_class_teacher')
        .eq('user_profile_id', userId)
        .eq('student_group_id', classId)
        .single();

      isClassTeacher = !!groupAssignment?.is_class_teacher;
    }

    if (isAdmin || isClassTeacher) {
      const { data: studentGroup } = await supabase
        .from('student_group')
        .select('academic_year:academic_year_id(school_id)')
        .eq('id', classId)
        .maybeSingle();

      const schoolId = (studentGroup?.academic_year as any)?.school_id;
      if (!schoolId) return [];

      const { data: subjects } = await supabase
        .from('subject')
        .select('id, name, code, is_graded, sort_order')
        .eq('school_id', schoolId)
        .order('sort_order')
        .order('name');

      const result = subjects ?? [];
      await this.cache.set(cacheKey, result, CLASS_TTL);
      return result;
    }

    const { data: subjectAssignments } = await supabase
      .schema('staff')
      .from('teacher_subject_assignment')
      .select('subject_id')
      .eq('user_profile_id', userId)
      .eq('student_group_id', classId);

    if (!subjectAssignments?.length) return [];

    const subjectIds = subjectAssignments.map((sa) => sa.subject_id);

    const { data: subjects } = await supabase
      .from('subject')
      .select('id, name, code, is_graded, sort_order')
      .in('id', subjectIds)
      .order('sort_order')
      .order('name');

    const result = subjects ?? [];
    await this.cache.set(cacheKey, result, CLASS_TTL);
    return result;
  }

  async getTeachers(classId: string) {
    const cacheKey = `class-teachers:${classId}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached;

    const supabase = this.supabaseService.getServiceClient();

    const { data: assignments, error: assignError } = await supabase
      .schema('staff')
      .from('teacher_group_assignment')
      .select('user_profile_id, is_class_teacher')
      .eq('student_group_id', classId);

    if (assignError) {
      this.logger.error(
        `Failed to fetch teachers for class ${classId}: ${assignError.message}`,
      );
      return [];
    }

    if (!assignments?.length) return [];

    const teacherIds = assignments.map((a: any) => a.user_profile_id);

    const { data: profiles } = await supabase
      .from('user_profile')
      .select('id, first_name, last_name')
      .in('id', teacherIds);

    const profileMap = new Map((profiles ?? []).map((p: any) => [p.id, p]));

    const { data: subjectAssignments } = await supabase
      .schema('staff')
      .from('teacher_subject_assignment')
      .select('user_profile_id, subject_id')
      .eq('student_group_id', classId);

    const subjectIds = [
      ...new Set((subjectAssignments ?? []).map((sa: any) => sa.subject_id)),
    ];
    let subjectMap = new Map<
      string,
      { id: string; name: string; code: string }
    >();

    if (subjectIds.length > 0) {
      const { data: subjects } = await supabase
        .from('subject')
        .select('id, name, code')
        .in('id', subjectIds);
      subjectMap = new Map((subjects ?? []).map((s: any) => [s.id, s]));
    }

    const subjectsByTeacher = new Map<string, any[]>();
    for (const sa of subjectAssignments ?? []) {
      const tid = sa.user_profile_id;
      if (!subjectsByTeacher.has(tid as string))
        subjectsByTeacher.set(tid as string, []);

      const subject = subjectMap.get(sa.subject_id as string);
      if (subject) subjectsByTeacher.get(tid as string)!.push(subject);
    }

    const result = assignments
      .filter((row: any) => profileMap.has(row.user_profile_id))
      .map((row: any) => {
        const profile = profileMap.get(row.user_profile_id);
        return {
          teacherId: row.user_profile_id,
          firstName: profile?.first_name ?? null,
          lastName: profile?.last_name ?? null,
          isClassTeacher: row.is_class_teacher,
          subjects: subjectsByTeacher.get(row.user_profile_id as string) ?? [],
        };
      });

    await this.cache.set(cacheKey, result, CLASS_TTL);
    return result;
  }

  async getSchoolTeachers(userId: string) {
    const supabase = this.supabaseService.getServiceClient();

    const { data: profile } = await supabase
      .from('user_profile')
      .select('school_id')
      .eq('id', userId)
      .single();

    if (!profile?.school_id) return [];

    const cacheKey = `school-teachers:${profile.school_id}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached;

    const { data: teachers, error } = await supabase
      .from('user_profile')
      .select('id, first_name, last_name')
      .eq('school_id', profile.school_id);

    if (error) {
      this.logger.error(`Failed to fetch school teachers: ${error.message}`);
      return [];
    }

    const result = teachers ?? [];
    await this.cache.set(cacheKey, result, CLASS_TTL);
    return result;
  }

  async addTeacher(inviterId: string, classId: string, dto: AddTeacherDto) {
    const supabase = this.supabaseService.getServiceClient();

    const { data: group, error: groupError } = await supabase
      .from('student_group')
      .select(
        'academic_year_id, name, academic_year:academic_year_id(school_id)',
      )
      .eq('id', classId)
      .single();

    if (groupError || !group) {
      this.logger.error(
        `Class not found for addTeacher ${classId}: ${groupError?.message}`,
      );
      throw new NotFoundException('Class not found');
    }

    const academicYearId = group.academic_year_id;

    const { data: existingAssignment } = await supabase
      .schema('staff')
      .from('teacher_group_assignment')
      .select('id')
      .eq('user_profile_id', dto.teacherId)
      .eq('student_group_id', classId)
      .maybeSingle();

    const wasNewlyAdded = !existingAssignment;

    if (!existingAssignment) {
      const { error: assignError } = await supabase
        .schema('staff')
        .from('teacher_group_assignment')
        .insert({
          user_profile_id: dto.teacherId,
          student_group_id: classId,
          academic_year_id: academicYearId,
          is_class_teacher: false,
        });

      if (assignError) {
        this.logger.error(
          `Failed to add teacher ${dto.teacherId} to class ${classId}: ${assignError.message}`,
        );
        throw new BadRequestException('Failed to add teacher to class');
      }
    }

    await supabase
      .schema('staff')
      .from('teacher_subject_assignment')
      .delete()
      .eq('user_profile_id', dto.teacherId)
      .eq('student_group_id', classId);

    if (dto.subjectIds.length > 0) {
      const subjectRows = dto.subjectIds.map((subjectId) => ({
        user_profile_id: dto.teacherId,
        subject_id: subjectId,
        student_group_id: classId,
        academic_year_id: academicYearId,
      }));

      const { error: subjectError } = await supabase
        .schema('staff')
        .from('teacher_subject_assignment')
        .insert(subjectRows);

      if (subjectError) {
        this.logger.error(
          `Teacher added but subject assignment failed: ${subjectError.message}`,
        );
        throw new BadRequestException('Failed to assign subjects');
      }
    }

    await this.cache.delete(`class-teachers:${classId}`);
    await this.cache.delete(`my-classes:${dto.teacherId}`);
    await this.cache.delete(`my-subjects:${dto.teacherId}:${classId}`);

    // Only greet the teacher the first time they are added to this class.
    if (wasNewlyAdded) {
      const schoolId = (group.academic_year as { school_id?: string } | null)
        ?.school_id;
      if (schoolId) {
        await this.chatSystem.notifyClassInvite(inviterId, dto.teacherId, {
          classId,
          className: group.name ?? 'a class',
          schoolId,
        });
      }
    }

    return { teacherId: dto.teacherId, classId, subjectIds: dto.subjectIds };
  }

  async removeTeacher(classId: string, teacherId: string) {
    const supabase = this.supabaseService.getServiceClient();

    const { data: assignment } = await supabase
      .schema('staff')
      .from('teacher_group_assignment')
      .select('is_class_teacher')
      .eq('user_profile_id', teacherId)
      .eq('student_group_id', classId)
      .single();

    if (assignment?.is_class_teacher) {
      throw new ForbiddenException('Cannot remove the class teacher');
    }

    await supabase
      .schema('staff')
      .from('teacher_subject_assignment')
      .delete()
      .eq('user_profile_id', teacherId)
      .eq('student_group_id', classId);

    const { error } = await supabase
      .schema('staff')
      .from('teacher_group_assignment')
      .delete()
      .eq('user_profile_id', teacherId)
      .eq('student_group_id', classId);

    if (error) {
      this.logger.error(
        `Failed to remove teacher ${teacherId} from class ${classId}: ${error.message}`,
      );
      throw new BadRequestException('Failed to remove teacher');
    }

    await this.cache.delete(`class-teachers:${classId}`);
    await this.cache.delete(`my-classes:${teacherId}`);
    await this.cache.delete(`my-subjects:${teacherId}:${classId}`);
    return 'Teacher removed from class';
  }
}
