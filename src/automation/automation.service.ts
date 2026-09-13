import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Subscription } from 'rxjs';
import { BlockSessionService } from '../block-session/block-session.service';
import { DriveSessionService } from '../drive-session/drive-session.service';

/**
 * Stub automation engine — subscribes to block and session changes.
 * Epic 9c will replace the no-op handlers with graph traversal logic
 * to compute signal aspects and route recommendations.
 */
@Injectable()
export class AutomationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AutomationService.name);
  private readonly subs = new Subscription();

  constructor(
    private readonly blockSession: BlockSessionService,
    private readonly driveSession: DriveSessionService,
  ) {}

  onModuleInit(): void {
    this.subs.add(
      this.blockSession.change$.subscribe((states) => {
        this.logger.debug(`[stub] block states updated: ${states.length} block(s)`);
      }),
    );

    this.subs.add(
      this.driveSession.change$.subscribe((session) => {
        this.logger.debug(`[stub] session changed: infraId=${session.infraId ?? 'null'}`);
      }),
    );
  }

  onModuleDestroy(): void {
    this.subs.unsubscribe();
  }
}
