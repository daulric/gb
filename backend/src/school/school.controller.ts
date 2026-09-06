import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SchoolService } from './school.service';
import { AuthGuard } from '@/auth/auth.guard';
import { AdminGuard } from '@/auth/admin.guard';
import { VersioningService } from '@/versioning/versioning.service';
import { CreateSchoolDto } from './dto/create-school.dto';
import { CreateJoinRequestDto } from './dto/create-join-request.dto';
import { ApproveJoinRequestDto } from './dto/approve-join-request.dto';

@ApiTags('Schools')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('schools')
export class SchoolController {
  constructor(
    private readonly schoolService: SchoolService,
    private readonly versioning: VersioningService,
  ) {}

  @Get()
  async findAll(@Req() req: any) {
    const raw = await this.schoolService.findAll();
    return this.versioning.resolve(req, 'school.list')(raw);
  }

  @Get('my-pending-request')
  async getMyPendingRequest(@Req() req: any) {
    const userId: string = req.user.id;
    return this.schoolService.getMyPendingRequest(userId);
  }

  @Get('members')
  async getMembers(@Req() req: any) {
    const userId: string = req.user.id;
    return this.schoolService.getMembers(userId);
  }

  @Post('leave')
  async leaveSchool(@Req() req: any) {
    const userId: string = req.user.id;
    return this.schoolService.leaveSchool(userId);
  }

  @Delete('members/:membershipId')
  @UseGuards(AdminGuard)
  async removeMember(
    @Req() req: any,
    @Param('membershipId') membershipId: string,
  ) {
    const userId: string = req.user.id;
    return this.schoolService.removeMember(userId, membershipId);
  }

  // Must be defined before /:schoolId to avoid route conflicts
  @Get('join-requests')
  @UseGuards(AdminGuard)
  async getPendingRequests(@Req() req: any) {
    const userId: string = req.user.id;
    return this.schoolService.getPendingRequests(userId);
  }

  @Patch('join-requests/:requestId/approve')
  @UseGuards(AdminGuard)
  async approveRequest(
    @Req() req: any,
    @Param('requestId') requestId: string,
    @Body() dto: ApproveJoinRequestDto,
  ) {
    const userId: string = req.user.id;
    return this.schoolService.approveRequest(
      userId,
      requestId,
      dto.role,
      dto.customRoleIds,
    );
  }

  @Patch('join-requests/:requestId/reject')
  @UseGuards(AdminGuard)
  async rejectRequest(@Req() req: any, @Param('requestId') requestId: string) {
    const userId: string = req.user.id;
    return this.schoolService.rejectRequest(userId, requestId);
  }

  @Post()
  async create(@Req() req: any, @Body() dto: CreateSchoolDto) {
    const userId: string = req.user.id;
    const raw = await this.schoolService.create(dto, userId);
    return this.versioning.resolve(req, 'school.detail')(raw);
  }

  @Post(':schoolId/join-requests')
  async createJoinRequest(
    @Req() req: any,
    @Param('schoolId') schoolId: string,
    @Body() dto: CreateJoinRequestDto,
  ) {
    const userId: string = req.user.id;
    return this.schoolService.createJoinRequest(userId, schoolId, dto.message);
  }
}
