import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '@/supabase/supabase.service';
import type { IngestJobData } from '../queue.constants';

/**
 * Creates a file-manager record for an already-stored object (e.g. a generated
 * report PDF). The bytes are trusted internal output, so the record is marked
 * `ready` straight away — no virus scan. Idempotent: a retry that finds the
 * same (bucket, path) already ingested is a no-op.
 */
@Injectable()
export class FileIngestHandler {
  private readonly logger = new Logger(FileIngestHandler.name);

  constructor(private readonly supabase: SupabaseService) {}

  async run(data: IngestJobData): Promise<void> {
    const client = this.supabase.getServiceClient();

    const { data: existing } = await client
      .schema('file_manager')
      .from('file')
      .select('id')
      .eq('bucket', data.bucket)
      .eq('storage_path', data.storagePath)
      .maybeSingle();

    if (existing) {
      this.logger.log(
        `Ingest skipped: ${data.bucket}/${data.storagePath} already a file (${existing.id})`,
      );
      return;
    }

    const { error: functionError } = await client.functions.invoke(
      'file-ingest',
      { body: data },
    );
    if (functionError) {
      this.logger.error(
        `Failed to invoke file-ingest for ${data.storagePath}: ${functionError.message}`,
      );
      throw new Error(functionError.message as string);
    }
    return;
  }
}
