import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '@/supabase/supabase.service';
import type { ShareNotifyJobData } from '../queue.constants';

@Injectable()
export class FileShareNotifyHandler {
  private readonly logger = new Logger(FileShareNotifyHandler.name);

  constructor(private readonly supabase: SupabaseService) {}

  async run(data: ShareNotifyJobData): Promise<void> {
    const client = this.supabase.getServiceClient();

    const { data: share } = await client
      .schema('file_manager')
      .from('file_share')
      .select(
        'id, file_id, school_id, principal_type, principal_id, can_download',
      )
      .eq('id', data.shareId)
      .maybeSingle();

    if (!share) {
      this.logger.warn(`Share-notify skipped: share ${data.shareId} not found`);
      return;
    }

    const { data: file } = await client
      .schema('file_manager')
      .from('file')
      .select('id, name, owner_id')
      .eq('id', share.file_id)
      .maybeSingle();

    if (!file) {
      this.logger.warn(`Share-notify skipped: file ${share.file_id} gone`);
      return;
    }

    const { error } = await client.functions.invoke('file-share-notify', {
      body: { shareId: share.id },
    });
    if (error) {
      this.logger.error(
        `Failed to invoke file-share-notify for ${share.id}: ${error.message}`,
      );
      throw new Error(error.message as string);
    }
  }
}
