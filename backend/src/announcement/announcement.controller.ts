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
import { AuthGuard } from '@/auth/auth.guard';
import { PermissionGuard } from '@/permission/permission.guard';
import { RequirePermission } from '@/permission/require-permission.decorator';
import { VersioningService } from '@/versioning/versioning.service';
import { AnnouncementService } from './announcement.service';
import { CreateAnnouncementDto } from './dto/create-announcement.dto';
import { UpdateAnnouncementDto } from './dto/update-announcement.dto';

@ApiTags('Announcements')
@ApiBearerAuth()
@Controller('announcements')
@UseGuards(AuthGuard, PermissionGuard)
export class AnnouncementController {
  constructor(
    private readonly announcementService: AnnouncementService,
    private readonly versioning: VersioningService,
  ) {}

  @RequirePermission('announcement', 'read')
  @Get()
  async findAll(@Req() req: any) {
    const userId: string = req.user.id;
    const raw = await this.announcementService.findAll(userId);
    return this.versioning.resolve(req, 'announcement.list')(raw);
  }

  @RequirePermission('announcement', 'read')
  @Get('unread-count')
  async unreadCount(@Req() req: any) {
    const userId: string = req.user.id;
    const raw = await this.announcementService.getUnreadCount(userId);
    return this.versioning.resolve(req, 'announcement.unreadCount')(raw);
  }

  @RequirePermission('announcement', 'read')
  @Post('mark-read')
  async markRead(@Req() req: any) {
    const userId: string = req.user.id;
    const raw = await this.announcementService.markRead(userId);
    return this.versioning.resolve(req, 'announcement.markRead')(raw);
  }

  @RequirePermission('announcement', 'read')
  @Get(':id')
  async findOne(@Req() req: any, @Param('id') id: string) {
    const userId: string = req.user.id;
    const raw = await this.announcementService.findOne(userId, id);
    return this.versioning.resolve(req, 'announcement.detail')(raw);
  }

  @RequirePermission('announcement', 'create')
  @Post()
  async create(@Req() req: any, @Body() dto: CreateAnnouncementDto) {
    const userId: string = req.user.id;
    const raw = await this.announcementService.create(userId, dto);
    return this.versioning.resolve(req, 'announcement.created')(raw);
  }

  @RequirePermission('announcement', 'update')
  @Patch(':id')
  async update(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateAnnouncementDto,
  ) {
    const userId: string = req.user.id;
    const raw = await this.announcementService.update(userId, id, dto);
    return this.versioning.resolve(req, 'announcement.updated')(raw);
  }

  @RequirePermission('announcement', 'delete')
  @Delete(':id')
  async delete(@Req() req: any, @Param('id') id: string) {
    const userId: string = req.user.id;
    const raw = await this.announcementService.delete(userId, id);
    return this.versioning.resolve(req, 'announcement.deleted')(raw);
  }
}
