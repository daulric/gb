import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { SupabaseService } from '@/supabase/supabase.service';
import { CacheService } from '@/cache/cache.service';
import { GradeScaleService } from '@/grade-scale/grade-scale.service';
import { CreateGradeDto } from './dto/create-grade.dto';
import { UpdateGradeDto } from './dto/update-grade.dto';
import { BulkGradeDto } from './dto/bulk-grade.dto';
import { ExcludeDto } from './dto/exclude.dto';

@Injectable()
export class GradeService {
  private readonly logger = new Logger(GradeService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly cache: CacheService,
    private readonly gradeScale: GradeScaleService,
  ) {}

  private async invalidateCalcCaches() {
    await this.cache.deleteByPrefix('calc:');
  }

  async create(
    userId: string,
    dto: CreateGradeDto,
    req: FastifyRequest,
    reply: FastifyReply,
  ) {
    const supabase = this.supabaseService.createUserClient(
      req,
      reply,
      'grading',
    );

    const { data, error } = await supabase
      .from('grade')
      .insert({
        assessment_id: dto.assessmentId,
        student_id: dto.studentId,
        score: dto.score,
        remarks: dto.remarks || null,
        created_by: userId,
        updated_by: userId,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        throw new ConflictException(
          'Grade already exists for this student and assessment',
        );
      }
      if (
        error.code === '42501' ||
        error.message?.includes('row-level security')
      ) {
        throw new ForbiddenException(
          'You are not assigned to enter grades for this subject',
        );
      }
      this.logger.error(`Failed to create grade: ${error.message}`);
      throw new BadRequestException('Failed to create grade');
    }

    await this.invalidateCalcCaches();
    return data;
  }

  async bulkCreate(
    userId: string,
    dto: BulkGradeDto,
    req: FastifyRequest,
    reply: FastifyReply,
  ) {
    const supabase = this.supabaseService.createUserClient(
      req,
      reply,
      'grading',
    );

    const rows = dto.grades.map((entry) => ({
      assessment_id: dto.assessmentId,
      student_id: entry.studentId,
      score: entry.score,
      remarks: entry.remarks || null,
      created_by: userId,
      updated_by: userId,
    }));

    const { error } = await supabase
      .from('grade')
      .upsert(rows, { onConflict: 'assessment_id, student_id' });

    if (error) {
      if (
        error.code === '42501' ||
        error.message?.includes('row-level security')
      ) {
        throw new ForbiddenException(
          'You are not assigned to enter grades for this subject',
        );
      }
      this.logger.error(`Failed to bulk create grades: ${error.message}`);
      throw new BadRequestException('Failed to save grades');
    }

    await this.invalidateCalcCaches();
    return { graded: dto.grades.length, message: 'Grades saved' };
  }

  async findByAssessment(
    assessmentId: string,
    req: FastifyRequest,
    reply: FastifyReply,
  ) {
    const supabase = this.supabaseService.createUserClient(
      req,
      reply,
      'grading',
    );

    const { data: grades, error } = await supabase
      .from('grade')
      .select(
        'id, assessment_id, student_id, score, letter_grade, remarks, is_excluded, exclusion_reason, created_at, updated_at',
      )
      .eq('assessment_id', assessmentId);

    if (error) {
      this.logger.error(`Failed to list grades: ${error.message}`);
      throw new BadRequestException('Failed to list grades');
    }

    if (!grades?.length) return [];

    const { data: assessment } = await supabase
      .from('assessment')
      .select('max_score')
      .eq('id', assessmentId)
      .maybeSingle();
    const maxScore: number = assessment?.max_score;

    const studentIds = [...new Set(grades.map((g) => g.student_id))];
    const serviceClient = this.supabaseService.getServiceClient();

    const { data: students } = await serviceClient
      .schema('student')
      .from('student')
      .select('id, first_name, last_name')
      .in('id', studentIds);

    const studentMap = new Map((students ?? []).map((s) => [s.id, s]));

    const userId = (req as FastifyRequest & { user?: { id: string } }).user?.id;
    const scale = userId
      ? await this.gradeScale.getDefault(userId).catch(() => null)
      : null;

    return grades
      .map((g) => {
        const score: number = g.score;

        return {
          ...g,
          student: studentMap.get(g.student_id) ?? null,
          converted: this.gradeScale.convertScore(scale, score, maxScore),
        };
      })
      .sort((a, b) => {
        const aName = a.student?.last_name ?? '';
        const bName = b.student?.last_name ?? '';
        return aName.localeCompare(bName);
      });
  }

  async findByTermAndSubject(
    termId: string,
    subjectId: string,
    req: FastifyRequest,
    reply: FastifyReply,
  ) {
    const supabase = this.supabaseService.createUserClient(
      req,
      reply,
      'grading',
    );

    const { data: assessments, error: aErr } = await supabase
      .from('assessment')
      .select(
        'id, title, max_score, assessment_type, weight, is_excluded, sort_order',
      )
      .eq('term_id', termId)
      .eq('subject_id', subjectId)
      .order('sort_order');

    if (aErr) {
      this.logger.error(`Failed to list assessments: ${aErr.message}`);
      throw new BadRequestException('Failed to list assessments');
    }

    if (!assessments?.length) return [];

    const assessmentIds = assessments.map((a) => a.id);

    const { data: grades, error: gErr } = await supabase
      .from('grade')
      .select('id, assessment_id, student_id, score, remarks, is_excluded')
      .in('assessment_id', assessmentIds);

    if (gErr) {
      this.logger.error(`Failed to list grades: ${gErr.message}`);
      throw new BadRequestException('Failed to list grades');
    }

    const studentIds = [...new Set((grades ?? []).map((g) => g.student_id))];
    let studentMap = new Map<
      string,
      { id: string; first_name: string; last_name: string }
    >();

    if (studentIds.length > 0) {
      const serviceClient = this.supabaseService.getServiceClient();
      const { data: students } = await serviceClient
        .schema('student')
        .from('student')
        .select('id, first_name, last_name')
        .in('id', studentIds);

      studentMap = new Map((students ?? []).map((s) => [s.id, s]));
    }

    const gradesByAssessment = new Map<string, typeof grades>();
    for (const g of grades ?? []) {
      const assessment_id: string = g.assessment_id;
      const list = gradesByAssessment.get(assessment_id) ?? [];
      list.push(g);
      gradesByAssessment.set(assessment_id, list);
    }

    const userId = (req as FastifyRequest & { user?: { id: string } }).user?.id;
    const scale = userId
      ? await this.gradeScale.getDefault(userId).catch(() => null)
      : null;

    return assessments.map((a) => {
      const assessmentId = String(a.id);
      const grades = gradesByAssessment.get(assessmentId) ?? [];

      return {
        ...a,
        grades: grades.map((g) => {
          const studentId = String(g.student_id);
          const score: number = g.score;
          const max_score: number = a.max_score;

          return {
            ...g,
            student: studentMap.get(studentId) ?? null,
            converted: this.gradeScale.convertScore(scale, score, max_score),
          };
        }),
      };
    });
  }

  async update(
    gradeId: string,
    userId: string,
    dto: UpdateGradeDto,
    req: FastifyRequest,
    reply: FastifyReply,
  ) {
    const supabase = this.supabaseService.createUserClient(
      req,
      reply,
      'grading',
    );

    const updateData: Record<string, unknown> = { updated_by: userId };
    if (dto.score !== undefined) updateData.score = dto.score;
    if (dto.remarks !== undefined) updateData.remarks = dto.remarks;

    const { data, error } = await supabase
      .from('grade')
      .update(updateData)
      .eq('id', gradeId)
      .select()
      .single();

    if (error) {
      if (
        error.code === '42501' ||
        error.message?.includes('row-level security')
      ) {
        throw new ForbiddenException(
          'You are not assigned to update grades for this subject',
        );
      }
      this.logger.error(`Failed to update grade: ${error.message}`);
      throw new BadRequestException('Failed to update grade');
    }

    await this.invalidateCalcCaches();
    return data;
  }

  async exclude(
    gradeId: string,
    userId: string,
    dto: ExcludeDto,
    req: FastifyRequest,
    reply: FastifyReply,
  ) {
    const supabase = this.supabaseService.createUserClient(
      req,
      reply,
      'grading',
    );

    const { data, error } = await supabase
      .from('grade')
      .update({
        is_excluded: dto.isExcluded,
        exclusion_reason: dto.isExcluded ? dto.exclusionReason : null,
        updated_by: userId,
      })
      .eq('id', gradeId)
      .select()
      .single();

    if (error) {
      if (
        error.code === '42501' ||
        error.message?.includes('row-level security')
      ) {
        throw new ForbiddenException(
          'You are not assigned to update grades for this subject',
        );
      }
      this.logger.error(`Failed to exclude grade: ${error.message}`);
      throw new BadRequestException('Failed to exclude grade');
    }

    await this.invalidateCalcCaches();
    return data;
  }
}
