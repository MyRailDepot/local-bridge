import {
  BadRequestException, Body, Controller, Delete, HttpCode,
  NotFoundException, Param, Patch, Post, Put, UseGuards,
} from '@nestjs/common';
import type { Block } from '../protocol/block.types';
import type { SessionAccessory, Train } from '../protocol/train.types';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CentralManagerService } from '../central/central-manager.service';
import { DriveSessionService } from './drive-session.service';
import { BlockSessionService } from '../block-session/block-session.service';

class SetInfraDto        { infraId!: string; }
class AddTrainDto        { rsId!: string; dccAddress!: number; speedSteps?: 14 | 28 | 128; }
class AddLocoDto         { rsId!: string; dccAddress!: number; speedSteps?: 14 | 28 | 128; }
class SetSpeedDto        { speedStep!: number; direction!: string; }
class SetFunctionDto     { active!: boolean; }
class SetTrackPowerDto   { on!: boolean; }
class PushAccessoriesDto { accessories!: SessionAccessory[]; }
class PushBlocksDto     { blocks!: Block[]; }
class SetAccessoryStateDto {
  position?: 'active' | 'inactive';
  aspectId?: string;
  aspectValue?: number; // required when aspectId is provided; 0–31
}

@Controller('session')
export class DriveSessionController {
  constructor(
    private readonly session: DriveSessionService,
    private readonly centralManager: CentralManagerService,
    private readonly blockSession: BlockSessionService,
  ) {}

  private dccSpeed(speedStep: number, speedSteps: 14 | 28 | 128 = 128): { speed: number; engineSpeedSteps: number } {
    if (speedStep === 0) return { speed: 0, engineSpeedSteps: speedSteps };
    if (speedSteps === 14) return { speed: Math.min(speedStep, 14), engineSpeedSteps: 14 };
    if (speedSteps === 28) return { speed: Math.min(speedStep, 28), engineSpeedSteps: 28 };
    // 128-step: map 1-28 → 2-127 (DCC: 0=stop, 1=estop, 2-127=actual speed)
    return { speed: Math.round((speedStep / 28) * 126) + 1, engineSpeedSteps: 128 };
  }

  private stopTrains(trains: Train[]): void {
    for (const train of trains) {
      for (const loco of (train.locos ?? [])) {
        const { engineSpeedSteps } = this.dccSpeed(0, loco.speedSteps ?? 128);
        this.centralManager.setLocoSpeed(loco.dccAddress, 0, true, engineSpeedSteps);
      }
    }
  }

  // ── Train creation ───────────────────────────────────────────────────────

  @Post('trains')
  @UseGuards(PermissionGuard)
  @RequirePermission('dcc:drive')
  @HttpCode(201)
  addTrain(@Body() body: AddTrainDto) {
    const addr = Number(body.dccAddress);
    if (!body.rsId || typeof body.rsId !== 'string' ||
        !Number.isInteger(addr) || addr < 1 || addr > 10239) {
      throw new BadRequestException('rsId must be a non-empty string; dccAddress must be an integer 1–10239');
    }
    const ss = [14, 28, 128].includes(Number(body.speedSteps)) ? Number(body.speedSteps) as 14 | 28 | 128 : undefined;
    const train = this.session.addTrain(body.rsId, addr, ss);
    return { train };
  }

  // ── Speed control ────────────────────────────────────────────────────────

  @Patch('trains/:id')
  @UseGuards(PermissionGuard)
  @RequirePermission('dcc:drive')
  setSpeed(@Param('id') id: string, @Body() body: SetSpeedDto) {
    const step = Number(body.speedStep);
    if (!Number.isInteger(step) || step < 0 || step > 28) {
      throw new BadRequestException('speedStep must be an integer 0–28');
    }
    const validDirections = ['forward', 'reverse', 'neutral'];
    if (!validDirections.includes(body.direction)) {
      throw new BadRequestException('direction must be "forward", "reverse", or "neutral"');
    }
    const direction = body.direction as 'forward' | 'reverse' | 'neutral';
    const actualStep = direction === 'neutral' ? 0 : step;

    const train = this.session.getSession().trains.find(t => t.id === id);
    if (!train) throw new NotFoundException();

    // DCC hardware only knows forward/reverse + speed; neutral = speed 0, keep last direction
    const dccForward = direction === 'neutral' ? train.direction !== 'reverse' : direction === 'forward';

    this.session.setSpeed(id, actualStep, direction);
    for (const loco of train.locos) {
      const { speed, engineSpeedSteps } = this.dccSpeed(actualStep, loco.speedSteps ?? 128);
      this.centralManager.setLocoSpeed(loco.dccAddress, speed, dccForward, engineSpeedSteps);
    }
    return { speedStep: actualStep, direction };
  }

  // ── Function toggle ──────────────────────────────────────────────────────

  @Put('trains/:id/functions/:fn')
  @UseGuards(PermissionGuard)
  @RequirePermission('dcc:drive')
  setFunction(
    @Param('id') id: string,
    @Param('fn') fnParam: string,
    @Body() body: SetFunctionDto,
  ) {
    const fn = Number(fnParam);
    if (!Number.isInteger(fn) || fn < 0 || fn > 28) {
      throw new BadRequestException('fn must be an integer 0–28');
    }
    const train = this.session.getSession().trains.find(t => t.id === id);
    if (!train) throw new NotFoundException();

    const active = Boolean(body.active);
    for (const loco of train.locos) {
      this.centralManager.setLocoFunction(loco.dccAddress, fn, active);
    }
    this.session.setFunction(id, fn, active);
    return { fn, active };
  }

  // ── Emergency stop ───────────────────────────────────────────────────────

  @Post('trains/:id/estop')
  @UseGuards(PermissionGuard)
  @RequirePermission('dcc:drive')
  @HttpCode(200)
  estop(@Param('id') id: string) {
    const { trains } = this.session.getSession();
    if (!trains.find(t => t.id === id)) throw new NotFoundException();

    // Reset all trains to speed 0 in session (triggers WS broadcast)
    for (const t of trains) {
      this.session.setSpeed(t.id, 0, t.direction ?? 'forward');
    }

    // Global Z21 emergency stop — all decoders on the track stop immediately
    this.centralManager.emergencyStopAll().catch(() => {});

    return { stopped: true };
  }

  // ── Track power ──────────────────────────────────────────────────────────

  @Post('track-power')
  @UseGuards(PermissionGuard)
  @RequirePermission('dcc:drive')
  @HttpCode(200)
  setTrackPower(@Body() body: SetTrackPowerDto) {
    const on = Boolean(body.on);
    this.centralManager.setTrackPower(on);
    this.session.setTrackPower(on);
    return { trackPower: on };
  }

  // ── UM — add loco ────────────────────────────────────────────────────────

  @Post('trains/:id/locos')
  @UseGuards(PermissionGuard)
  @RequirePermission('dcc:drive')
  @HttpCode(201)
  addLoco(@Param('id') id: string, @Body() body: AddLocoDto) {
    const addr = Number(body.dccAddress);
    if (!body.rsId || typeof body.rsId !== 'string' ||
        !Number.isInteger(addr) || addr < 1 || addr > 10239) {
      throw new BadRequestException('rsId must be a non-empty string; dccAddress must be an integer 1–10239');
    }
    const train = this.session.getSession().trains.find(t => t.id === id);
    if (!train) throw new NotFoundException();

    const ss      = [14, 28, 128].includes(Number(body.speedSteps)) ? Number(body.speedSteps) as 14 | 28 | 128 : undefined;
    const updated = this.session.addLoco(id, body.rsId, addr, ss);
    // Bring new loco to same speed/direction as the train
    const step = train.speedStep ?? 0;
    const dccFwd = train.direction !== 'reverse';
    if (step > 0) {
      const { speed, engineSpeedSteps } = this.dccSpeed(step, ss ?? 128);
      this.centralManager.setLocoSpeed(addr, speed, dccFwd, engineSpeedSteps);
    }
    return { train: updated };
  }

  // ── Accessories ──────────────────────────────────────────────────────────

  @Put('blocks')
  @UseGuards(PermissionGuard)
  @RequirePermission('dcc:drive')
  pushBlocks(@Body() body: PushBlocksDto) {
    if (!Array.isArray(body.blocks)) {
      throw new BadRequestException('blocks must be an array');
    }
    this.blockSession.setBlocks(body.blocks);
    // Poll each feedback bus so the bridge gets the current occupation state
    // immediately, rather than waiting for the next train movement to trigger
    // an occupancy event.
    this.centralManager.executePollPlan(this.blockSession.getPollPlan());
    return { blocks: body.blocks.length };
  }

  @Put('accessories')
  @UseGuards(PermissionGuard)
  @RequirePermission('dcc:drive')
  pushAccessories(@Body() body: PushAccessoriesDto) {
    if (!Array.isArray(body.accessories)) {
      throw new BadRequestException('accessories must be an array');
    }
    this.session.setAccessories(body.accessories);
    return { accessories: this.session.getSession().accessories ?? [] };
  }

  @Put('accessories/:id')
  @UseGuards(PermissionGuard)
  @RequirePermission('dcc:drive')
  setAccessoryState(@Param('id') id: string, @Body() body: SetAccessoryStateDto) {
    const hasPosition  = body.position  !== undefined;
    const hasAspectId  = body.aspectId  !== undefined;
    const hasAspectVal = body.aspectValue !== undefined;

    if (hasPosition === hasAspectId) {
      throw new BadRequestException('Exactly one of position or aspectId must be provided');
    }
    if (hasPosition && body.position !== 'active' && body.position !== 'inactive') {
      throw new BadRequestException('position must be "active" or "inactive"');
    }
    if (hasAspectId && !hasAspectVal) {
      throw new BadRequestException('aspectValue (0–31) is required when aspectId is provided');
    }
    if (hasAspectVal) {
      const v = Number(body.aspectValue);
      if (!Number.isInteger(v) || v < 0 || v > 255) {
        throw new BadRequestException('aspectValue must be an integer 0–255');
      }
    }

    let updated: SessionAccessory;
    try {
      updated = this.session.setAccessoryState(id, {
        position:  hasPosition ? body.position : undefined,
        aspectId:  hasAspectId ? body.aspectId : undefined,
      });
    } catch (e) {
      if (e instanceof Error) {
        if (e.message.includes('not found')) throw new NotFoundException(e.message);
        if (e.message.includes('controlModel')) throw new BadRequestException(e.message);
      }
      throw e;
    }

    if (hasPosition) {
      this.centralManager.setAccessoryOutput(updated.dccAddress, body.position === 'active', updated.momentary ?? false);
    } else {
      this.centralManager.setExtendedAccessory(updated.dccAddress, Number(body.aspectValue));
    }

    return updated;
  }

  // ── Infrastructure ───────────────────────────────────────────────────────

  @Post('infra')
  @UseGuards(PermissionGuard)
  @RequirePermission('infra:manage')
  setInfra(@Body() body: SetInfraDto) {
    this.session.setInfra(body.infraId);
    return { infraId: body.infraId };
  }

  // ── Release ──────────────────────────────────────────────────────────────

  @Delete()
  @UseGuards(PermissionGuard)
  @RequirePermission('infra:manage')
  endSession() {
    this.stopTrains(this.session.getSession().trains);
    this.session.endSession();
    return { ended: true };
  }

  @Delete('trains')
  @UseGuards(PermissionGuard)
  @RequirePermission('dcc:drive')
  releaseAllTrains() {
    const { trains } = this.session.getSession();
    this.stopTrains(trains);
    this.session.releaseAll();
    return { released: trains.length };
  }

  @Delete('trains/:id')
  @UseGuards(PermissionGuard)
  @RequirePermission('dcc:drive')
  releaseOneTrain(@Param('id') id: string) {
    const train = this.session.getSession().trains.find(t => t.id === id);
    if (!train) throw new NotFoundException();
    this.stopTrains([train]);
    this.session.removeTrain(id);
    return { released: 1 };
  }
}
