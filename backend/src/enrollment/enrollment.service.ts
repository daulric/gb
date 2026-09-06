import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { SupabaseService } from '@/supabase/supabase.service';
import { CacheService } from '@/cache/cache.service';
import { EnrollStudentDto } from './dto/enroll-student.dto';
import { BulkEnrollDto } from './dto/bulk-enroll.dto';
import { AssignSubjectsDto } from './dto/assign-subjects.dto';
import { BulkAssignSubjectsDto } from './dto/bulk-assign-subjects.dto';
import { SupabaseClient } from '@supabase/supabase-js';

const ENROLLMENT_TTL = 60 * 60 * 24 * 30;

// Type definitions for internal entities
interface Student {
  id: string;
  first_name: string;
  last_name: string;
  gender: string;
  date_of_birth: string;
  is_active: boolean;
}

interface EnrollmentRecord {
  id: string;
  enrolled_at: string;
  student: Student;
}

interface Subject {
  id: string;
  name: string;
  code: string;
  is_graded?: boolean;
  sort_order?: number;
}

interface StudentSubjectProfile {
  student_id: string;
  subject_id: string;
}

@Injectable()
export class EnrollmentService {
  private readonly logger = new Logger(EnrollmentService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly cache: CacheService,
  ) {}

  async enroll(classId: string, dto: EnrollStudentDto) {
    const supabase = this.supabaseService.getServiceClient();

    await this.assertSameSchool(classId, [dto.studentId]);

    const { data, error } = await supabase
      .schema('student')
      .from('student_group_enrollment')
      .insert({
        student_id: dto.studentId,
        student_group_id: classId,
        enrolled_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        throw new ConflictException(
          'Student is already enrolled in this class',
        );
      }
      this.logger.error(`Failed to enroll student: ${error.message}`);
      throw new BadRequestException('Failed to enroll student');
    }

    await this.cache.deleteByPrefix(`enrolled:${classId}`);
    return data;
  }

  async bulkEnroll(classId: string, dto: BulkEnrollDto) {
    const supabase = this.supabaseService.getServiceClient();

    await this.assertSameSchool(classId, dto.studentIds);

    const rows = dto.studentIds.map((studentId) => ({
      student_id: studentId,
      student_group_id: classId,
      enrolled_at: new Date().toISOString(),
    }));

    const { data, error } = await supabase
      .schema('student')
      .from('student_group_enrollment')
      .insert(rows)
      .select();

    if (error) {
      if (error.code === '23505') {
        throw new ConflictException(
          'One or more students are already enrolled in this class',
        );
      }
      this.logger.error(`Failed to bulk enroll: ${error.message}`);
      throw new BadRequestException('Failed to enroll students');
    }

    await this.cache.deleteByPrefix(`enrolled:${classId}`);
    return { enrolled: data?.length ?? 0, message: 'Students enrolled' };
  }

  async getEnrolledStudents(
    classId: string,
    userId?: string,
    subjectId?: string,
  ) {
    const cacheKey = `enrolled:${classId}:${userId ?? 'all'}:${subjectId ?? 'all'}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached;

    const supabase: SupabaseClient = this.supabaseService.getServiceClient();

    const { data: allEnrolledData, error } = await supabase
      .schema('student')
      .from('student_group_enrollment')
      .select(
        `
        id,
        enrolled_at,
        student:student_id (
          id,
          first_name,
          last_name,
          gender,
          date_of_birth,
          is_active
        )
      `,
      )
      .eq('student_group_id', classId)
      .order('enrolled_at', { ascending: true });

    if (error) {
      this.logger.error(`Failed to get enrolled students: ${error.message}`);
      throw new BadRequestException('Failed to get enrolled students');
    }

    const allEnrolled =
      (allEnrolledData as unknown as EnrollmentRecord[]) ?? [];
    if (!allEnrolled.length) return [];

    const academicYearId = await this.getAcademicYearId(classId);
    const allStudentIds = allEnrolled.map((e) => e.student.id);

    let filtered = allEnrolled;

    if (subjectId) {
      const { data: profiles } = await supabase
        .schema('student')
        .from('student_subject_profile')
        .select('student_id')
        .in('student_id', allStudentIds)
        .eq('subject_id', subjectId)
        .eq('academic_year_id', academicYearId);

      if (!profiles) {
        throw Error(
          `Failed to get student subject profiles for subject ${subjectId}`,
        );
      }

      const assignedIds = new Set<string>(profiles.map((p) => p.student_id));
      filtered = filtered.filter((e) => assignedIds.has(e.student.id));
    }

    if (!userId) {
      const result = await this.attachSubjects(
        supabase,
        filtered,
        academicYearId,
      );
      await this.cache.set(cacheKey, result, ENROLLMENT_TTL);
      return result;
    }

    const { data: profile } = await supabase
      .from('user_profile')
      .select('role')
      .eq('id', userId)
      .single<{ role: string }>();

    if (profile?.role === 'admin') {
      const result = await this.attachSubjects(
        supabase,
        filtered,
        academicYearId,
      );
      await this.cache.set(cacheKey, result, ENROLLMENT_TTL);
      return result;
    }

    const { data: groupAssignment } = await supabase
      .schema('staff')
      .from('teacher_group_assignment')
      .select('is_class_teacher')
      .eq('user_profile_id', userId)
      .eq('student_group_id', classId)
      .single<{ is_class_teacher: boolean }>();

    if (groupAssignment?.is_class_teacher) {
      const result = await this.attachSubjects(
        supabase,
        filtered,
        academicYearId,
      );
      await this.cache.set(cacheKey, result, ENROLLMENT_TTL);
      return result;
    }

    const { data: subjectAssignments } = await supabase
      .schema('staff')
      .from('teacher_subject_assignment')
      .select('subject_id')
      .eq('user_profile_id', userId)
      .eq('student_group_id', classId);

    const typedSubjectAssignments: { subject_id: string }[] =
      subjectAssignments ?? [];

    if (!typedSubjectAssignments.length) return [];

    const teacherSubjectIds = typedSubjectAssignments
      .map((sa: { subject_id: string }) => sa.subject_id)
      .filter(Boolean);

    const studentIds = filtered.map((e) => e.student.id);

    const { data: profiles } = await supabase
      .schema('student')
      .from('student_subject_profile')
      .select('student_id, subject_id')
      .in('student_id', studentIds)
      .in('subject_id', teacherSubjectIds)
      .eq('academic_year_id', academicYearId);

    const typedProfiles: StudentSubjectProfile[] = profiles ?? [];
    const studentIdsWithSubject = new Set(
      typedProfiles.map((p) => p.student_id),
    );

    const filteredBySubject = filtered.filter((e) =>
      studentIdsWithSubject.has(e.student.id),
    );
    const result = await this.attachSubjects(
      supabase,
      filteredBySubject,
      academicYearId,
      teacherSubjectIds,
    );
    await this.cache.set(cacheKey, result, ENROLLMENT_TTL);
    return result;
  }

  private async attachSubjects<
    TEnrolled extends { student: { id: string } },
    TSubject extends Subject = Subject,
  >(
    supabase: SupabaseClient,
    enrolled: TEnrolled[],
    academicYearId: string,
    limitToSubjectIds?: string[],
  ): Promise<(TEnrolled & { subjects: TSubject[] })[]> {
    if (!enrolled.length) return [];

    const studentIds = enrolled.map((e) => e.student.id);

    let query = supabase
      .schema('student')
      .from('student_subject_profile')
      .select('student_id, subject_id')
      .in('student_id', studentIds)
      .eq('academic_year_id', academicYearId);

    if (limitToSubjectIds?.length) {
      query = query.in('subject_id', limitToSubjectIds);
    }

    const { data: profiles } = await query;
    const safeProfiles: StudentSubjectProfile[] = profiles ?? [];

    const subjectIds = [
      ...new Set(safeProfiles.map((p: { subject_id: string }) => p.subject_id)),
    ];

    let subjectMap = new Map<string, TSubject>();

    if (subjectIds.length) {
      const { data: subjects } = await supabase
        .from('subject')
        .select('id, name, code')
        .in('id', subjectIds)
        .order('sort_order')
        .order('name');

      subjectMap = new Map(
        ((subjects as TSubject[] | null) ?? []).map((s) => [s.id, s]),
      );
    }

    const subjectsByStudent = new Map<string, TSubject[]>();

    for (const p of safeProfiles) {
      const subj = subjectMap.get(p.subject_id);
      if (!subj) continue;

      const list = subjectsByStudent.get(p.student_id) ?? [];
      list.push(subj);
      subjectsByStudent.set(p.student_id, list);
    }

    return enrolled.map((e) => ({
      ...e,
      subjects: subjectsByStudent.get(e.student.id) ?? [],
    }));
  }

  async unenroll(classId: string, studentId: string) {
    const supabase = this.supabaseService.getServiceClient();

    const { error: unenrollError } = await supabase
      .schema('student')
      .from('student_group_enrollment')
      .delete()
      .eq('student_id', studentId)
      .eq('student_group_id', classId);

    if (unenrollError) {
      this.logger.error(`Failed to unenroll student: ${unenrollError.message}`);
      throw new BadRequestException('Failed to unenroll student');
    }

    const { data: group } = await supabase
      .from('student_group')
      .select('academic_year_id')
      .eq('id', classId)
      .single<{ academic_year_id: string }>();

    if (group?.academic_year_id) {
      await supabase
        .schema('student')
        .from('student_subject_profile')
        .delete()
        .eq('student_id', studentId)
        .eq('academic_year_id', group.academic_year_id);
    }

    await this.cache.deleteByPrefix(`enrolled:${classId}`);
    await this.cache.delete(`student-subjects:${classId}:${studentId}`);
    return { message: 'Student unenrolled' };
  }

  private async getAcademicYearId(classId: string): Promise<string> {
    const supabase = this.supabaseService.getServiceClient();

    const { data, error } = await supabase
      .from('student_group')
      .select('academic_year_id')
      .eq('id', classId)
      .single<{ academic_year_id: string }>();

    if (error || !data?.academic_year_id) {
      throw new BadRequestException(
        'Could not determine academic year for this class',
      );
    }

    return data.academic_year_id;
  }

  private async assertSameSchool(classId: string, studentIds: string[]) {
    if (studentIds.length === 0) return;
    const supabase = this.supabaseService.getServiceClient();

    const { data: group, error: groupErr } = await supabase
      .from('student_group')
      .select('academic_year:academic_year_id(school_id)')
      .eq('id', classId)
      .maybeSingle<{ academic_year: { school_id: string } | null }>();

    const classSchoolId = group?.academic_year?.school_id;

    if (groupErr || !classSchoolId) {
      throw new BadRequestException(
        'Could not determine school for this class',
      );
    }

    const { data: studentsData, error: studErr } = await supabase
      .schema('student')
      .from('student')
      .select('id, school_id')
      .in('id', studentIds);

    const students: { id: string; school_id: string }[] = studentsData ?? [];

    if (studErr || !students.length) {
      throw new BadRequestException('Could not verify students');
    }

    if (students.length !== studentIds.length) {
      throw new BadRequestException('One or more students do not exist');
    }

    const mismatched = students.filter((s) => s.school_id !== classSchoolId);
    if (mismatched.length > 0) {
      throw new BadRequestException(
        'Students must belong to the same school as the class',
      );
    }
  }

  async assignSubjects(classId: string, dto: AssignSubjectsDto) {
    const academicYearId = await this.getAcademicYearId(classId);
    const supabase = this.supabaseService.getServiceClient();

    const rows = dto.subjectIds.map((subjectId) => ({
      student_id: dto.studentId,
      subject_id: subjectId,
      academic_year_id: academicYearId,
    }));

    const { data, error } = await supabase
      .schema('student')
      .from('student_subject_profile')
      .insert(rows)
      .select();

    if (error) {
      if (error.code === '23505') {
        throw new ConflictException(
          'One or more subjects are already assigned to this student',
        );
      }
      this.logger.error(`Failed to assign subjects: ${error.message}`);
      throw new BadRequestException('Failed to assign subjects');
    }

    await this.cache.deleteByPrefix(`enrolled:${classId}`);
    await this.cache.delete(`student-subjects:${classId}:${dto.studentId}`);
    return { assigned: data?.length ?? 0, message: 'Subjects assigned' };
  }

  async bulkAssignSubjects(classId: string, dto: BulkAssignSubjectsDto) {
    const academicYearId = await this.getAcademicYearId(classId);
    const supabase = this.supabaseService.getServiceClient();

    const rows: {
      student_id: string;
      subject_id: string;
      academic_year_id: string;
    }[] = [];
    for (const studentId of dto.studentIds) {
      for (const subjectId of dto.subjectIds) {
        rows.push({
          student_id: studentId,
          subject_id: subjectId,
          academic_year_id: academicYearId,
        });
      }
    }

    const { data, error } = await supabase
      .schema('student')
      .from('student_subject_profile')
      .insert(rows)
      .select();

    if (error) {
      if (error.code === '23505') {
        throw new ConflictException(
          'One or more subjects are already assigned to these students',
        );
      }
      this.logger.error(`Failed to bulk assign subjects: ${error.message}`);
      throw new BadRequestException('Failed to assign subjects to students');
    }

    await this.cache.deleteByPrefix(`enrolled:${classId}`);
    for (const studentId of dto.studentIds) {
      await this.cache.delete(`student-subjects:${classId}:${studentId}`);
    }
    return {
      assigned: data?.length ?? 0,
      message: 'Subjects assigned to students',
    };
  }

  async getStudentSubjects(classId: string, studentId: string) {
    const cacheKey = `student-subjects:${classId}:${studentId}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached;

    const academicYearId = await this.getAcademicYearId(classId);
    const supabase = this.supabaseService.getServiceClient();

    const { data: profilesData, error: profileError } = await supabase
      .schema('student')
      .from('student_subject_profile')
      .select('id, subject_id')
      .eq('student_id', studentId)
      .eq('academic_year_id', academicYearId);

    if (profileError) {
      this.logger.error(
        `Failed to get student subject profiles: ${profileError.message}`,
      );
      throw new BadRequestException('Failed to get student subjects');
    }

    const profiles: { id: string; subject_id: string }[] = profilesData ?? [];
    if (!profiles.length) return [];

    const subjectIds = profiles.map((p) => p.subject_id).filter(Boolean);
    if (!subjectIds.length) return [];

    const { data: subjectsData, error: subjectError } = await supabase
      .from('subject')
      .select('id, name, code, is_graded, sort_order')
      .in('id', subjectIds)
      .order('sort_order')
      .order('name');

    if (subjectError) {
      this.logger.error(`Failed to get subjects: ${subjectError.message}`);
      throw new BadRequestException('Failed to get student subjects');
    }

    const subjects = (subjectsData as Subject[] | null) ?? [];
    const subjectMap = new Map(subjects.map((s) => [s.id, s]));

    const result = profiles.map((p) => ({
      id: p.id,
      subject: subjectMap.get(p.subject_id) ?? null,
    }));

    await this.cache.set(cacheKey, result, ENROLLMENT_TTL);
    return result;
  }

  async removeSubject(classId: string, studentId: string, subjectId: string) {
    const academicYearId = await this.getAcademicYearId(classId);
    const supabase = this.supabaseService.getServiceClient();

    const { error } = await supabase
      .schema('student')
      .from('student_subject_profile')
      .delete()
      .eq('student_id', studentId)
      .eq('subject_id', subjectId)
      .eq('academic_year_id', academicYearId);

    if (error) {
      if (error.code === '23503') {
        throw new ConflictException(
          'Cannot remove subject - student has existing grades for this subject',
        );
      }
      this.logger.error(`Failed to remove subject: ${error.message}`);
      throw new BadRequestException('Failed to remove subject');
    }

    await this.cache.deleteByPrefix(`enrolled:${classId}`);
    await this.cache.delete(`student-subjects:${classId}:${studentId}`);
    return { message: 'Subject removed from student' };
  }
}
