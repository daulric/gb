import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import archiver from 'archiver';
import { AuthGuard } from '@/auth/auth.guard';
import { PermissionGuard } from '@/permission/permission.guard';
import { RequirePermission } from '@/permission/require-permission.decorator';
import { ClassTeacherGuard } from '@/class/class-teacher.guard';
import { ReportFilesService } from './report-files.service';
import { PersistClassSummaryDto } from './dto/persist-class-summary.dto';
import type { GeneratedFile } from './generation/types';

@ApiTags('Report files')
@ApiBearerAuth()
@Controller('reports/files')
@UseGuards(AuthGuard, PermissionGuard)
export class ReportFilesController {
  private readonly logger = new Logger(ReportFilesController.name);

  constructor(private readonly reportFiles: ReportFilesService) {}

  private send(reply: FastifyReply, file: GeneratedFile) {
    reply
      .header('Content-Type', file.contentType)
      .header('Content-Disposition', `attachment; filename="${file.filename}"`)
      .header('Content-Length', file.buffer.length)
      .send(file.buffer);
  }

  @RequirePermission('reporting', 'read')
  @Get('student-term.pdf')
  @UseGuards(ClassTeacherGuard)
  async studentTermPdf(
    @Query('studentId') studentId: string,
    @Query('termId') termId: string,
    @Query('studentGroupId') studentGroupId: string,
    @Res() reply: FastifyReply,
  ) {
    const file = await this.reportFiles.getStudentTermPdf(
      studentId,
      termId,
      studentGroupId,
    );
    this.send(reply, file);
  }

  @RequirePermission('reporting', 'read')
  @Get('student-year.pdf')
  @UseGuards(ClassTeacherGuard)
  async studentYearPdf(
    @Query('studentId') studentId: string,
    @Query('academicYearId') academicYearId: string,
    @Query('studentGroupId') studentGroupId: string,
    @Res() reply: FastifyReply,
  ) {
    const file = await this.reportFiles.getStudentYearPdf(
      studentId,
      academicYearId,
      studentGroupId,
    );
    this.send(reply, file);
  }

  @RequirePermission('reporting', 'read')
  @Get('student-report-card.pdf')
  @UseGuards(ClassTeacherGuard)
  async studentReportCard(
    @Query('studentId') studentId: string,
    @Query('termId') termId: string,
    @Query('studentGroupId') studentGroupId: string,
    @Res() reply: FastifyReply,
  ) {
    const file = await this.reportFiles.getStudentReportCard(
      studentId,
      termId,
      studentGroupId,
    );
    this.send(reply, file);
  }

  @RequirePermission('reporting', 'read')
  @Get('exam-report.pdf')
  @UseGuards(ClassTeacherGuard)
  async examReport(
    @Query('studentGroupId') studentGroupId: string,
    @Query('termId') termId: string,
    @Query('reportType') reportType: string,
    @Res() reply: FastifyReply,
  ) {
    const file = await this.reportFiles.getExamReport(
      studentGroupId,
      termId,
      reportType,
    );
    this.send(reply, file);
  }

  @RequirePermission('reporting', 'read')
  @Get('class-summary')
  @UseGuards(ClassTeacherGuard)
  async classSummary(
    @Query('studentGroupId') studentGroupId: string,
    @Query('termId') termId: string,
    @Query('reportType') reportType: string,
    @Query('format') format: string,
    @Res() reply: FastifyReply,
  ) {
    if (format !== 'pdf' && format !== 'csv' && format !== 'xlsx') {
      throw new BadRequestException('format must be one of pdf, csv, xlsx');
    }
    const file = await this.reportFiles.getClassSummaryFile(
      studentGroupId,
      termId,
      reportType,
      format,
    );
    this.send(reply, file);
  }

  @RequirePermission('reporting', 'read')
  @Get('class-zip')
  @UseGuards(ClassTeacherGuard)
  async classZip(
    @Query('studentGroupId') studentGroupId: string,
    @Query('termId') termId: string,
    @Query('reportType') reportType: string,
    @Res() reply: FastifyReply,
  ) {
    // Fetch data + plan entries BEFORE hijacking, so any auth/404/calc error
    // still returns a clean JSON error response.
    const { zipFilename, entries } = await this.reportFiles.prepareClassZip(
      studentGroupId,
      termId,
      reportType,
    );

    reply.raw.setHeader('Content-Type', 'application/zip');
    reply.raw.setHeader(
      'Content-Disposition',
      `attachment; filename="${zipFilename}"`,
    );
    // Hijacking bypasses the framework CORS layer, so set the cross-origin
    // headers manually (mirrors createApp.ts) - otherwise the browser blocks
    // the response and can't read the download filename.
    reply.raw.setHeader(
      'Access-Control-Allow-Origin',
      process.env.FRONTEND_URL || 'http://localhost:3000',
    );
    reply.raw.setHeader('Access-Control-Allow-Credentials', 'true');
    reply.raw.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    reply.hijack(); // we own reply.raw from here

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => {
      this.logger.error(`class-zip archive error: ${err.message}`);
      reply.raw.destroy(err);
    });
    archive.pipe(reply.raw);

    // If the client disconnects mid-download, stop rendering/buffering the
    // remaining PDFs instead of running the whole class to completion for a
    // connection that's already gone.
    let aborted = false;
    reply.raw.on('close', () => {
      if (aborted || reply.raw.writableEnded) return;
      aborted = true;
      archive.abort();
    });

    // Generate one PDF at a time: append the next entry only after the previous
    // one has been consumed by the archiver, so at most one PDF buffer is live.
    let i = 0;
    const appendNext = () => {
      if (aborted) return;
      if (i >= entries.length) {
        void archive.finalize();
        return;
      }
      const entry = entries[i++];
      try {
        archive.append(entry.render(), { name: entry.filename });
      } catch (err) {
        this.logger.error(
          `class-zip failed generating ${entry.filename}: ${(err as Error).message}`,
        );
        archive.abort();
        reply.raw.destroy(err as Error);
      }
    };
    archive.on('entry', appendNext);
    appendNext();
  }

  @RequirePermission('reporting', 'create')
  @Post('class-summary/persist')
  @UseGuards(ClassTeacherGuard)
  async persistClassSummary(
    @Req() req: any,
    @Body() dto: PersistClassSummaryDto,
  ) {
    const userId: string = req.user.id;
    return this.reportFiles.generateAndPersistClassSummary(
      dto.studentGroupId,
      dto.termId,
      dto.reportType,
      userId,
    );
  }
}
